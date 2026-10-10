"""Backend tests for Automata (built-in n8n style workflow + agent app)."""
import json
import os
import time
import uuid
import requests
import pytest

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://pocket-automation.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="session")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# -------------------- Settings
class TestSettings:
    def test_get_settings(self, api):
        r = api.get(f"{API}/settings")
        assert r.status_code == 200
        data = r.json()
        assert "provider" in data and "emergent_provider" in data

    def test_put_settings_roundtrip(self, api):
        payload = {
            "provider": "emergent", "emergent_provider": "openai", "emergent_model": "gpt-5.4",
            "local_base_url": "", "local_model": "", "local_api_key": "",
            "n8n_url": "", "n8n_api_key": "",
        }
        r = api.put(f"{API}/settings", json=payload)
        assert r.status_code == 200
        assert r.json()["emergent_model"] == "gpt-5.4"


# -------------------- LLM test
class TestLLM:
    def test_llm_test_emergent_ok(self, api):
        # ensure emergent
        api.put(f"{API}/settings", json={
            "provider": "emergent", "emergent_provider": "openai", "emergent_model": "gpt-5.4",
            "local_base_url": "", "local_model": "", "local_api_key": "",
            "n8n_url": "", "n8n_api_key": "",
        })
        r = api.post(f"{API}/llm/test", timeout=60)
        assert r.status_code == 200
        data = r.json()
        assert data.get("ok") is True, f"Expected ok True, got: {data}"
        assert "reply" in data

    def test_llm_test_local_invalid(self, api):
        # Switch to local with invalid url
        api.put(f"{API}/settings", json={
            "provider": "local", "emergent_provider": "openai", "emergent_model": "gpt-5.4",
            "local_base_url": "http://127.0.0.1:1/v1", "local_model": "fake", "local_api_key": "",
            "n8n_url": "", "n8n_api_key": "",
        })
        try:
            r = api.post(f"{API}/llm/test", timeout=60)
            assert r.status_code == 200
            data = r.json()
            assert data.get("ok") is False
            assert "error" in data
        finally:
            # restore
            api.put(f"{API}/settings", json={
                "provider": "emergent", "emergent_provider": "openai", "emergent_model": "gpt-5.4",
                "local_base_url": "", "local_model": "", "local_api_key": "",
                "n8n_url": "", "n8n_api_key": "",
            })


# -------------------- Workflows CRUD + Run
class TestWorkflows:
    created_ids: list = []

    def test_crud_and_run_set_step(self, api):
        wf = {
            "name": "TEST_set_wf",
            "description": "set step test",
            "active": False,
            "trigger": {"type": "manual", "interval_minutes": 60},
            "steps": [{"id": "s1", "type": "set", "name": "echo", "config": {"value": "Hello {{input}}"}}],
        }
        r = api.post(f"{API}/workflows", json=wf)
        assert r.status_code == 200, r.text
        wf_id = r.json()["id"]
        TestWorkflows.created_ids.append(wf_id)

        # GET
        g = api.get(f"{API}/workflows/{wf_id}")
        assert g.status_code == 200 and g.json()["name"] == "TEST_set_wf"

        # Run with input
        rr = api.post(f"{API}/workflows/{wf_id}/run", json={"input": "World"}, timeout=30)
        assert rr.status_code == 200
        run = rr.json()
        assert run["status"] == "success"
        assert run["output"] == "Hello World"
        assert len(run["logs"]) == 1 and run["logs"][0]["status"] == "success"

    def test_run_http_step(self, api):
        wf = {
            "name": "TEST_http_wf", "description": "", "active": False,
            "trigger": {"type": "manual", "interval_minutes": 60},
            "steps": [{"id": "h1", "type": "http", "name": "hn", "config": {
                "method": "GET", "url": "https://hn.algolia.com/api/v1/search?tags=front_page"}}],
        }
        r = api.post(f"{API}/workflows", json=wf); assert r.status_code == 200
        wf_id = r.json()["id"]; TestWorkflows.created_ids.append(wf_id)
        rr = api.post(f"{API}/workflows/{wf_id}/run", json={"input": ""}, timeout=60)
        assert rr.status_code == 200
        run = rr.json()
        assert run["status"] == "success", run
        assert "hits" in run["output"] or len(run["output"]) > 10

    def test_run_http_invalid(self, api):
        wf = {
            "name": "TEST_bad_http", "description": "", "active": False,
            "trigger": {"type": "manual", "interval_minutes": 60},
            "steps": [{"id": "h1", "type": "http", "name": "bad", "config": {"method": "GET", "url": "not-a-url"}}],
        }
        r = api.post(f"{API}/workflows", json=wf); wf_id = r.json()["id"]
        TestWorkflows.created_ids.append(wf_id)
        rr = api.post(f"{API}/workflows/{wf_id}/run", json={"input": ""}, timeout=30)
        assert rr.status_code == 200
        assert rr.json()["status"] == "failed"
        assert rr.json()["logs"][0]["status"] == "failed"

    def test_run_filter_stops(self, api):
        wf = {
            "name": "TEST_filter_wf", "description": "", "active": False,
            "trigger": {"type": "manual", "interval_minutes": 60},
            "steps": [
                {"id": "s1", "type": "set", "name": "seed", "config": {"value": "apple"}},
                {"id": "f1", "type": "filter", "name": "needs-banana", "config": {"contains": "banana"}},
                {"id": "s2", "type": "set", "name": "never", "config": {"value": "SHOULD_NOT_SET"}},
            ],
        }
        r = api.post(f"{API}/workflows", json=wf); wf_id = r.json()["id"]
        TestWorkflows.created_ids.append(wf_id)
        rr = api.post(f"{API}/workflows/{wf_id}/run", json={"input": ""}, timeout=30)
        assert rr.status_code == 200
        data = rr.json()
        assert data["status"] == "stopped"
        assert len(data["logs"]) == 2
        assert data["logs"][1]["status"] == "stopped"

    def test_run_llm_step(self, api):
        wf = {
            "name": "TEST_llm_wf", "description": "", "active": False,
            "trigger": {"type": "manual", "interval_minutes": 60},
            "steps": [{"id": "l1", "type": "llm", "name": "say", "config": {
                "prompt": "Reply with exactly: PONG", "system": "You are terse. Reply only with the requested word."}}],
        }
        r = api.post(f"{API}/workflows", json=wf); wf_id = r.json()["id"]
        TestWorkflows.created_ids.append(wf_id)
        rr = api.post(f"{API}/workflows/{wf_id}/run", json={"input": ""}, timeout=120)
        assert rr.status_code == 200
        d = rr.json()
        assert d["status"] == "success", d
        assert len(d["output"]) > 0

    def test_schedule_active_sets_next_run(self, api):
        wf = {
            "name": "TEST_sched_wf", "description": "", "active": True,
            "trigger": {"type": "schedule", "interval_minutes": 1440},
            "steps": [{"id": "s1", "type": "set", "name": "ok", "config": {"value": "ok"}}],
        }
        r = api.post(f"{API}/workflows", json=wf); assert r.status_code == 200
        d = r.json(); TestWorkflows.created_ids.append(d["id"])
        assert d["next_run_at"], f"Expected next_run_at, got: {d}"

    def test_toggle_active(self, api):
        wf = {"name": "TEST_toggle", "description": "", "active": False,
              "trigger": {"type": "schedule", "interval_minutes": 60},
              "steps": [{"id": "s1", "type": "set", "name": "x", "config": {"value": "x"}}]}
        r = api.post(f"{API}/workflows", json=wf); wf_id = r.json()["id"]
        TestWorkflows.created_ids.append(wf_id)
        t = api.post(f"{API}/workflows/{wf_id}/active", json={"active": True})
        assert t.status_code == 200
        assert t.json()["active"] is True
        assert t.json()["next_run_at"] is not None

    def test_webhook_requires_active_webhook_trigger(self, api):
        # Manual wf should not accept webhook POST
        wf = {"name": "TEST_hook_manual", "description": "", "active": True,
              "trigger": {"type": "manual", "interval_minutes": 60},
              "steps": [{"id": "s1", "type": "set", "name": "x", "config": {"value": "x"}}]}
        r = api.post(f"{API}/workflows", json=wf); wf_id = r.json()["id"]
        TestWorkflows.created_ids.append(wf_id)
        hr = api.post(f"{API}/hooks/{wf_id}", data="hello")
        assert hr.status_code == 400

        # webhook + active -> ok
        wf2 = {"name": "TEST_hook_wh", "description": "", "active": True,
               "trigger": {"type": "webhook", "interval_minutes": 60},
               "steps": [{"id": "s1", "type": "set", "name": "echo", "config": {"value": "got {{input}}"}}]}
        r2 = api.post(f"{API}/workflows", json=wf2); wf_id2 = r2.json()["id"]
        TestWorkflows.created_ids.append(wf_id2)
        hr2 = api.post(f"{API}/hooks/{wf_id2}", data="payload-abc")
        assert hr2.status_code == 200
        assert "got payload-abc" in hr2.json()["output"]

    def test_zz_cleanup_workflows(self, api):
        for wid in TestWorkflows.created_ids:
            api.delete(f"{API}/workflows/{wid}")


# -------------------- Runs
class TestRuns:
    def test_list_runs(self, api):
        r = api.get(f"{API}/runs")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_delete_runs(self, api):
        r = api.delete(f"{API}/runs")
        assert r.status_code == 200
        assert r.json().get("ok") is True
        g = api.get(f"{API}/runs")
        assert g.json() == []


# -------------------- Agent messages
class TestAgentMessages:
    def test_list_messages(self, api):
        r = api.get(f"{API}/agent/messages")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_delete_messages(self, api):
        r = api.delete(f"{API}/agent/messages")
        assert r.status_code == 200
        assert r.json().get("ok") is True


# -------------------- Agent chat SSE
class TestAgentChat:
    def test_chat_create_and_run_workflow_via_tools(self, api):
        # Clear history first
        api.delete(f"{API}/agent/messages")
        prompt = ("Create a workflow named TEST_AGENT_WF with trigger manual and one set step "
                  "that outputs the text 'agent made this', then run it. Keep it simple.")
        with requests.post(f"{API}/agent/chat", json={"message": prompt},
                           stream=True, timeout=180) as r:
            assert r.status_code == 200
            events = []
            visible_text = ""
            for raw in r.iter_lines(decode_unicode=True):
                if not raw or not raw.startswith("data:"):
                    continue
                try:
                    ev = json.loads(raw[5:].strip())
                except Exception:
                    continue
                events.append(ev)
                if ev.get("type") == "delta":
                    visible_text += ev.get("text", "")
                if ev.get("type") == "done":
                    break
        types = [e["type"] for e in events]
        assert "delta" in types, f"No delta events: {types}"
        assert "done" in types, f"No done event: {types}"
        assert "<tool>" not in visible_text, "tool blocks leaked into visible text"
        # tool should have been called
        tool_results = [e for e in events if e["type"] == "tool_result"]
        assert any(t["call"]["name"] in ("create_workflow", "run_workflow") for t in tool_results), \
            f"Expected tool_start/result for create_workflow or run_workflow, got: {[t['call']['name'] for t in tool_results]}"

        # Verify workflow persisted
        wfs = api.get(f"{API}/workflows").json()
        made = [w for w in wfs if "TEST_AGENT" in w["name"].upper()]
        assert made, f"Agent didn't create workflow. Workflows: {[w['name'] for w in wfs]}"
        # cleanup
        for w in made:
            api.delete(f"{API}/workflows/{w['id']}")


# -------------------- n8n external
class TestN8N:
    def test_n8n_not_configured(self, api):
        # Ensure n8n not set
        api.put(f"{API}/settings", json={
            "provider": "emergent", "emergent_provider": "openai", "emergent_model": "gpt-5.4",
            "local_base_url": "", "local_model": "", "local_api_key": "",
            "n8n_url": "", "n8n_api_key": "",
        })
        r = api.get(f"{API}/n8n/workflows")
        assert r.status_code == 400

    def test_n8n_fake_returns_502(self, api):
        api.put(f"{API}/settings", json={
            "provider": "emergent", "emergent_provider": "openai", "emergent_model": "gpt-5.4",
            "local_base_url": "", "local_model": "", "local_api_key": "",
            "n8n_url": "http://127.0.0.1:1", "n8n_api_key": "fakekey",
        })
        try:
            r = api.get(f"{API}/n8n/workflows", timeout=30)
            assert r.status_code == 502, f"Expected 502, got {r.status_code}: {r.text}"
        finally:
            # restore
            api.put(f"{API}/settings", json={
                "provider": "emergent", "emergent_provider": "openai", "emergent_model": "gpt-5.4",
                "local_base_url": "", "local_model": "", "local_api_key": "",
                "n8n_url": "", "n8n_api_key": "",
            })


# -------------------- Final cleanup / restore
def test_zzz_final_restore(api):
    api.put(f"{API}/settings", json={
        "provider": "emergent", "emergent_provider": "openai", "emergent_model": "gpt-5.4",
        "local_base_url": "", "local_model": "", "local_api_key": "",
        "n8n_url": "", "n8n_api_key": "",
    })
    s = api.get(f"{API}/settings").json()
    assert s["provider"] == "emergent" and s["emergent_provider"] == "openai" and s["emergent_model"] == "gpt-5.4"
