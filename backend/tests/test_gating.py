"""Server-side Pro gating, free limits and daily cost caps.

Runs in-process: FastAPI TestClient over a throwaway SQLite file and a mocked RevenueCat
API (httpx.MockTransport). Nothing leaves the machine and no service is needed.
"""
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

import httpx
import pytest
from cryptography.fernet import Fernet

os.environ.setdefault("CREDS_SECRET", Fernet.generate_key().decode())
os.environ.setdefault("BILLING_MODE", "revenuecat")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

import billing  # noqa: E402
import server  # noqa: E402

PRO_DEVICE = "dev-pro-0000000001"
REAL_ASYNC_CLIENT = httpx.AsyncClient


@pytest.fixture
def rc_calls(monkeypatch):
    """Mock RevenueCat: PRO_DEVICE has an active 'pro' entitlement, everyone else has none."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.headers["Authorization"] == "Bearer sk_test_mock"
        device = request.url.path.rsplit("/", 1)[-1]
        ents = {}
        if device == PRO_DEVICE:
            ents = {"pro": {"expires_date": "2999-01-01T00:00:00Z", "product_identifier": "monthly"}}
        elif device == "dev-expired-000001":
            ents = {"pro": {"expires_date": "2001-01-01T00:00:00Z"}}
        elif device == "dev-rcdown-0000001":
            return httpx.Response(500, json={"message": "boom"})
        return httpx.Response(200, json={"subscriber": {"entitlements": ents}})

    def fake_client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return REAL_ASYNC_CLIENT(*args, **kwargs)

    monkeypatch.setattr(billing.httpx, "AsyncClient", fake_client)
    monkeypatch.setenv("REVENUECAT_SECRET_KEY", "sk_test_mock")
    monkeypatch.setenv("BILLING_MODE", "revenuecat")
    billing.clear_cache()
    yield calls
    billing.clear_cache()


@pytest.fixture
def client(tmp_path, monkeypatch, rc_calls):
    store = server.Store(str(tmp_path / "test.db"))
    asyncio.run(store.connect())
    monkeypatch.setattr(server, "store", store)
    # Never call a real LLM or run real code from these tests.
    async def fake_complete(self, text):
        return "fake reply"

    async def fake_stream(self, text):
        yield "fake reply"

    async def fake_run_code(code, input_text, prev, steps):
        return "1024"

    monkeypatch.setattr(server.LLMSession, "complete", fake_complete)
    monkeypatch.setattr(server.LLMSession, "stream", fake_stream)
    monkeypatch.setattr(server.connectors, "run_code", fake_run_code)
    yield TestClient(server.app)
    asyncio.run(store.close())


def H(device):
    return {"X-Device-Id": device}


def free_dev():
    return "dev-free-" + uuid.uuid4().hex[:10]


def wf(name="w", trigger="manual", steps=None):
    return {"name": name, "trigger": {"type": trigger}, "steps": steps or [{"type": "set", "config": {"value": "hi"}}]}


# ------------------------------------------------------------------ is_pro
class TestIsPro:
    def test_active_entitlement(self, rc_calls):
        assert asyncio.run(billing.is_pro(PRO_DEVICE)) is True

    def test_no_entitlement(self, rc_calls):
        assert asyncio.run(billing.is_pro(free_dev())) is False

    def test_expired_entitlement(self, rc_calls):
        assert asyncio.run(billing.is_pro("dev-expired-000001")) is False

    def test_revenuecat_error_fails_closed(self, rc_calls):
        assert asyncio.run(billing.is_pro("dev-rcdown-0000001")) is False

    def test_result_is_cached(self, rc_calls):
        asyncio.run(billing.is_pro(PRO_DEVICE))
        asyncio.run(billing.is_pro(PRO_DEVICE))
        assert len(rc_calls) == 1

    def test_missing_key_means_free_without_calling_revenuecat(self, rc_calls, monkeypatch):
        monkeypatch.delenv("REVENUECAT_SECRET_KEY")
        assert asyncio.run(billing.is_pro(PRO_DEVICE)) is False
        assert rc_calls == []

    def test_lifetime_entitlement(self):
        assert billing.entitlement_active({"entitlements": {"pro": {"expires_date": None}}})

    def test_grace_period(self):
        assert billing.entitlement_active({"entitlements": {"pro": {
            "expires_date": "2001-01-01T00:00:00Z", "grace_period_expires_date": "2999-01-01T00:00:00Z"}}})


# ------------------------------------------------------------------ workflows
class TestWorkflowGating:
    def test_free_workflow_limit(self, client):
        d = free_dev()
        for i in range(3):
            assert client.post("/api/workflows", json=wf(f"w{i}"), headers=H(d)).status_code == 200
        r = client.post("/api/workflows", json=wf("w4"), headers=H(d))
        assert r.status_code == 402
        assert "Pro" in r.json()["detail"]

    def test_pro_has_no_workflow_limit(self, client):
        for i in range(5):
            assert client.post("/api/workflows", json=wf(f"w{i}"), headers=H(PRO_DEVICE)).status_code == 200

    @pytest.mark.parametrize("step", sorted(billing.PRO_STEPS))
    def test_free_cannot_create_pro_step(self, client, step):
        r = client.post("/api/workflows", json=wf(steps=[{"type": step, "config": {}}]), headers=H(free_dev()))
        assert r.status_code == 402

    @pytest.mark.parametrize("trigger", ["schedule", "location"])
    def test_free_cannot_use_pro_trigger(self, client, trigger):
        assert client.post("/api/workflows", json=wf(trigger=trigger), headers=H(free_dev())).status_code == 402

    def test_free_can_use_webhook_and_manual(self, client):
        d = free_dev()
        assert client.post("/api/workflows", json=wf(trigger="webhook"), headers=H(d)).status_code == 200
        assert client.post("/api/workflows", json=wf(trigger="manual"), headers=H(d)).status_code == 200

    def test_free_cannot_use_credentials_in_http_step(self, client):
        steps = [{"type": "http", "config": {"url": "https://example.com", "credential": "mykey"}}]
        assert client.post("/api/workflows", json=wf(steps=steps), headers=H(free_dev())).status_code == 402
        steps = [{"type": "set", "config": {"value": "{{cred.mykey.token}}"}}]
        assert client.post("/api/workflows", json=wf(steps=steps), headers=H(free_dev())).status_code == 402

    def test_pro_can_create_pro_features(self, client):
        body = wf(trigger="schedule", steps=[{"type": "code", "config": {"code": "result=1"}}])
        assert client.post("/api/workflows", json=body, headers=H(PRO_DEVICE)).status_code == 200

    def test_free_update_to_pro_step_rejected(self, client):
        d = free_dev()
        w = client.post("/api/workflows", json=wf(), headers=H(d)).json()
        r = client.put(f"/api/workflows/{w['id']}", json=wf(steps=[{"type": "code", "config": {"code": "x"}}]), headers=H(d))
        assert r.status_code == 402

    def test_run_rejects_pro_workflow_after_downgrade(self, client, monkeypatch):
        body = wf(steps=[{"type": "code", "config": {"code": "result = 2**10"}}])
        w = client.post("/api/workflows", json=body, headers=H(PRO_DEVICE)).json()
        r = client.post(f"/api/workflows/{w['id']}/run", json={}, headers=H(PRO_DEVICE))
        assert r.status_code == 200 and r.json()["status"] == "success"
        # subscription lapses
        billing._cache[PRO_DEVICE] = (float("inf"), False)
        r = client.post(f"/api/workflows/{w['id']}/run", json={}, headers=H(PRO_DEVICE))
        assert r.status_code == 402

    def test_free_basic_run_works(self, client):
        d = free_dev()
        w = client.post("/api/workflows", json=wf(), headers=H(d)).json()
        r = client.post(f"/api/workflows/{w['id']}/run", json={}, headers=H(d))
        assert r.status_code == 200 and r.json()["output"] == "hi"

    def test_webhook_rejects_pro_workflow_for_free_device(self, client):
        body = {**wf(trigger="webhook", steps=[{"type": "code", "config": {"code": "x"}}]), "active": True}
        w = client.post("/api/workflows", json=body, headers=H(PRO_DEVICE)).json()
        billing._cache[PRO_DEVICE] = (float("inf"), False)
        assert client.post(f"/api/hooks/{w['id']}", content="x").status_code == 402

    def test_activating_schedule_requires_pro(self, client):
        w = client.post("/api/workflows", json=wf(trigger="schedule"), headers=H(PRO_DEVICE)).json()
        billing._cache[PRO_DEVICE] = (float("inf"), False)
        r = client.post(f"/api/workflows/{w['id']}/active", json={"active": True}, headers=H(PRO_DEVICE))
        assert r.status_code == 402
        r = client.post(f"/api/workflows/{w['id']}/active", json={"active": False}, headers=H(PRO_DEVICE))
        assert r.status_code == 200

    def test_scheduler_skips_free_device(self, client):
        body = {**wf(trigger="schedule"), "active": True}
        w = client.post("/api/workflows", json=body, headers=H(PRO_DEVICE)).json()
        billing._cache[PRO_DEVICE] = (float("inf"), False)
        wf_obj = asyncio.run(server.load_wf(w["id"]))
        asyncio.run(server.scheduled_run(wf_obj))
        doc = client.get(f"/api/workflows/{w['id']}", headers=H(PRO_DEVICE)).json()
        assert doc["last_status"] == "needs_pro"
        assert client.get("/api/runs", headers=H(PRO_DEVICE)).json() == []


# ------------------------------------------------------------------ credentials, settings
class TestCredentialsAndSettings:
    def test_free_cannot_create_credential(self, client):
        r = client.post("/api/credentials", json={"name": "k", "type": "bearer", "data": {"token": "t"}}, headers=H(free_dev()))
        assert r.status_code == 402

    def test_pro_can_create_credential(self, client):
        r = client.post("/api/credentials", json={"name": "k", "type": "bearer", "data": {"token": "secret123"}}, headers=H(PRO_DEVICE))
        assert r.status_code == 200 and "secret123" not in r.text

    def test_free_cannot_enable_local_llm(self, client):
        s = client.get("/api/settings", headers=H(free_dev())).json()
        r = client.put("/api/settings", json={**s, "provider": "local"}, headers=H(free_dev()))
        assert r.status_code == 402

    def test_pro_can_enable_local_llm(self, client):
        s = client.get("/api/settings", headers=H(PRO_DEVICE)).json()
        assert client.put("/api/settings", json={**s, "provider": "local"}, headers=H(PRO_DEVICE)).status_code == 200


# ------------------------------------------------------------------ agent
def _chat(client, device, msg="hi"):
    return client.post("/api/agent/chat", json={"message": msg}, headers=H(device))


def _events(resp):
    return [json.loads(l[5:]) for l in resp.text.split("\n\n") if l.startswith("data:")]


class TestAgentGating:
    def test_free_agent_daily_limit(self, client):
        d = free_dev()
        for _ in range(10):
            assert _chat(client, d).status_code == 200
        r = _chat(client, d)
        assert r.status_code == 402
        assert client.get("/api/plan", headers=H(d)).json()["usage_today"]["agent"] == 10

    def test_pro_agent_not_limited_to_10(self, client):
        for _ in range(12):
            assert _chat(client, PRO_DEVICE).status_code == 200

    def test_agent_rejects_local_llm_for_free(self, client):
        d = free_dev()
        asyncio.run(server.store.insert("settings", {"id": d, "device_id": d, "provider": "local"}))
        assert _chat(client, d).status_code == 402

    def test_agent_run_code_tool_blocked_for_free(self, client):
        with pytest.raises(billing.ProRequired):
            asyncio.run(server.exec_tool("run_code", {"code": "result = 1"}, free_dev()))

    def test_agent_run_step_pro_step_blocked_for_free(self, client):
        with pytest.raises(billing.ProRequired):
            asyncio.run(server.exec_tool("run_step", {"type": "telegram", "config": {"credential": "x"}}, free_dev()))

    def test_agent_create_workflow_tool_respects_limits(self, client):
        with pytest.raises(billing.ProRequired):
            asyncio.run(server.exec_tool("create_workflow", wf(trigger="schedule"), free_dev()))

    def test_agent_run_code_tool_allowed_for_pro(self, client):
        out = asyncio.run(server.exec_tool("run_code", {"code": "result = 2**10"}, PRO_DEVICE))
        assert out["output"] == "1024"

    def test_agent_tool_paywall_event_streamed(self, client, monkeypatch):
        replies = iter(['<tool>{"name": "run_code", "args": {"code": "result=1"}}</tool>', "done"])

        async def stream(self, text):
            yield next(replies)

        monkeypatch.setattr(server.LLMSession, "stream", stream)
        r = _chat(client, free_dev())
        assert r.status_code == 200
        ev = _events(r)
        assert any(e["type"] == "paywall" for e in ev)


# ------------------------------------------------------------------ cost caps (all plans)
class TestDailyCaps:
    def test_code_cap_applies_to_pro(self, client, monkeypatch):
        monkeypatch.setenv("DAILY_CODE_CAP", "2")
        for _ in range(2):
            asyncio.run(server.exec_tool("run_code", {"code": "result=1"}, PRO_DEVICE))
        with pytest.raises(billing.DailyCapReached):
            asyncio.run(server.exec_tool("run_code", {"code": "result=1"}, PRO_DEVICE))

    def test_llm_cap_applies_to_pro(self, client, monkeypatch):
        monkeypatch.setenv("DAILY_LLM_CAP", "3")
        for _ in range(3):
            assert client.post("/api/llm/test", headers=H(PRO_DEVICE)).status_code == 200
        assert client.post("/api/llm/test", headers=H(PRO_DEVICE)).status_code == 429

    def test_llm_cap_stops_agent_mid_stream(self, client, monkeypatch):
        monkeypatch.setenv("DAILY_LLM_CAP", "0")
        r = _chat(client, PRO_DEVICE)
        assert r.status_code == 200
        assert any(e["type"] == "error" and "Daily limit" in e["text"] for e in _events(r))

    def test_llm_step_in_workflow_counts(self, client, monkeypatch):
        monkeypatch.setenv("DAILY_LLM_CAP", "1")
        d = free_dev()
        w = client.post("/api/workflows", json=wf(steps=[{"type": "llm", "config": {"prompt": "x"}}]), headers=H(d)).json()
        assert client.post(f"/api/workflows/{w['id']}/run", json={}, headers=H(d)).json()["status"] == "success"
        r = client.post(f"/api/workflows/{w['id']}/run", json={}, headers=H(d)).json()
        assert r["status"] == "failed" and "Daily limit" in r["logs"][0]["error"]

    def test_plan_endpoint(self, client):
        assert client.get("/api/plan", headers=H(PRO_DEVICE)).json()["pro"] is True
        p = client.get("/api/plan", headers=H(free_dev())).json()
        assert p["pro"] is False and p["limits"]["workflows"] == 3 and p["limits"]["agent_daily"] == 10
