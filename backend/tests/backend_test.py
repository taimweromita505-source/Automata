"""Backend tests for Automata (iteration 2: X-Device-Id, credentials vault, new step types, agent tools)."""
# End-to-end tests against a running backend (default http://localhost:8001; set EXPO_PUBLIC_BACKEND_URL).
# Skipped automatically when no backend is reachable. Run the server with a RevenueCat key (or a mock)
# that grants Pro, otherwise the Pro-only cases correctly return 402.
import json
import os
import uuid
import requests
import pytest

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
API = f"{BASE_URL}/api"


def _backend_up() -> bool:
    try:
        requests.get(f"{API}/", timeout=3)
        return True
    except requests.RequestException:
        return False


pytestmark = pytest.mark.skipif(not _backend_up(), reason=f"no backend running at {BASE_URL}")

DEVICE_A = "test-device-" + uuid.uuid4().hex[:10]
DEVICE_B = "test-device-" + uuid.uuid4().hex[:10]


def _sess(device: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json", "X-Device-Id": device})
    return s


@pytest.fixture(scope="session")
def api():
    return _sess(DEVICE_A)


@pytest.fixture(scope="session")
def api_b():
    return _sess(DEVICE_B)


# ============================================================ Device ID requirement
class TestDeviceIdRequirement:
    def test_missing_device_header_400(self):
        r = requests.get(f"{API}/workflows")
        assert r.status_code == 400

    def test_invalid_device_header_400(self):
        r = requests.get(f"{API}/workflows", headers={"X-Device-Id": "bad id!"})
        assert r.status_code == 400

    def test_short_device_id_400(self):
        r = requests.get(f"{API}/workflows", headers={"X-Device-Id": "short"})
        assert r.status_code == 400

    def test_valid_device_header_ok(self, api):
        r = api.get(f"{API}/workflows")
        assert r.status_code == 200


# ============================================================ Credentials vault
class TestCredentials:
    created: list = []

    def test_create_telegram_cred_missing_field_400(self, api):
        r = api.post(f"{API}/credentials", json={"name": "TEST_tg_bad", "type": "telegram",
                                                  "data": {"bot_token": "123:ABC"}})
        assert r.status_code == 400

    def test_create_unknown_type_400(self, api):
        r = api.post(f"{API}/credentials", json={"name": "TEST_bad_type", "type": "nope", "data": {"x": "y"}})
        assert r.status_code == 400

    def test_create_bearer_cred_masked(self, api):
        r = api.post(f"{API}/credentials", json={"name": "TEST_bearer_cred", "type": "bearer",
                                                  "data": {"token": "super_secret_token_12345"}})
        assert r.status_code == 200, r.text
        d = r.json()
        TestCredentials.created.append(d["id"])
        # masked
        assert "fields" in d and "token" in d["fields"]
        assert "super_secret_token_12345" not in json.dumps(d), "raw secret leaked in create response"

    def test_list_credentials_masked(self, api):
        r = api.get(f"{API}/credentials")
        assert r.status_code == 200
        creds = r.json()
        assert any(c["name"] == "TEST_bearer_cred" for c in creds)
        for c in creds:
            assert "super_secret_token_12345" not in json.dumps(c)

    def test_duplicate_name_400(self, api):
        r = api.post(f"{API}/credentials", json={"name": "TEST_bearer_cred", "type": "bearer",
                                                  "data": {"token": "x"}})
        assert r.status_code == 400

    def test_sanitize_name(self, api):
        r = api.post(f"{API}/credentials", json={"name": "weird name!!@#", "type": "bearer",
                                                  "data": {"token": "abc"}})
        assert r.status_code == 200
        d = r.json()
        TestCredentials.created.append(d["id"])
        assert d["name"] == "weird_name____"[:40] or "weird_name" in d["name"]

    def test_delete_credential(self, api):
        # delete all created
        for cid in TestCredentials.created:
            r = api.delete(f"{API}/credentials/{cid}")
            assert r.status_code == 200


# ============================================================ Device isolation
class TestDeviceIsolation:
    def test_workflow_isolation(self, api, api_b):
        wf = {"name": "TEST_isolated_A", "description": "", "active": False,
              "trigger": {"type": "manual", "interval_minutes": 60},
              "steps": [{"id": "s1", "type": "set", "name": "x", "config": {"value": "A"}}]}
        r = api.post(f"{API}/workflows", json=wf)
        assert r.status_code == 200
        wid = r.json()["id"]
        # Device B must not see it
        wfs_b = api_b.get(f"{API}/workflows").json()
        assert not any(w["id"] == wid for w in wfs_b)
        # Direct access by id from Device B -> 404
        g = api_b.get(f"{API}/workflows/{wid}")
        assert g.status_code == 404
        api.delete(f"{API}/workflows/{wid}")

    def test_credential_isolation(self, api, api_b):
        r = api.post(f"{API}/credentials", json={"name": "TEST_iso_cred", "type": "bearer",
                                                  "data": {"token": "tokA"}})
        assert r.status_code == 200
        cid = r.json()["id"]
        creds_b = api_b.get(f"{API}/credentials").json()
        assert not any(c["id"] == cid for c in creds_b)
        api.delete(f"{API}/credentials/{cid}")


# ============================================================ Step types
def _create_run(api, steps, trigger=None, name_suffix=""):
    wf = {"name": "TEST_steps_" + (name_suffix or uuid.uuid4().hex[:6]), "description": "",
          "active": False, "trigger": trigger or {"type": "manual", "interval_minutes": 60},
          "steps": steps}
    r = api.post(f"{API}/workflows", json=wf)
    assert r.status_code == 200, r.text
    wid = r.json()["id"]
    rr = api.post(f"{API}/workflows/{wid}/run", json={"input": "", "trigger": "manual"}, timeout=60)
    assert rr.status_code == 200, rr.text
    data = rr.json()
    api.delete(f"{API}/workflows/{wid}")
    return data


class TestStepTypes:
    def test_code_result(self, api):
        d = _create_run(api, [{"id": "c", "type": "code", "name": "pow", "config": {"code": "result = 2**10"}}])
        assert d["status"] == "success", d
        assert "1024" in d["output"]

    def test_code_error_fails_gracefully(self, api):
        d = _create_run(api, [{"id": "c", "type": "code", "name": "boom", "config": {"code": "raise ValueError('nope')"}}])
        assert d["status"] == "failed"
        assert d["logs"][0]["status"] == "failed"
        assert d["logs"][0]["error"]

    def test_scrape_hn(self, api):
        d = _create_run(api, [{"id": "s", "type": "scrape", "name": "hn",
                                "config": {"url": "https://news.ycombinator.com", "selector": ".titleline > a"}}])
        assert d["status"] == "success", d
        assert len(d["output"]) > 20

    def test_search(self, api):
        d = _create_run(api, [{"id": "s", "type": "search", "name": "q", "config": {"query": "python language", "limit": 3}}])
        # search may fail if bing blocks, so accept both outcomes but prefer success
        if d["status"] == "success":
            assert "[" in d["output"] or "title" in d["output"].lower()
        else:
            assert d["logs"][0]["error"]

    def test_if_stop(self, api):
        d = _create_run(api, [
            {"id": "a", "type": "set", "name": "seed", "config": {"value": "hello"}},
            {"id": "b", "type": "if", "name": "has_x", "config": {"operator": "contains", "left": "{{prev}}",
                                                                    "right": "xyz", "on_false": "stop"}},
            {"id": "c", "type": "set", "name": "never", "config": {"value": "SHOULD_NOT"}},
        ])
        assert d["status"] == "stopped", d
        statuses = [l["status"] for l in d["logs"]]
        assert "stopped" in statuses
        assert all("SHOULD_NOT" not in (l.get("output") or "") for l in d["logs"])

    def test_if_skip(self, api):
        d = _create_run(api, [
            {"id": "a", "type": "set", "name": "seed", "config": {"value": "hello"}},
            {"id": "b", "type": "if", "name": "cond", "config": {"operator": "contains", "left": "{{prev}}",
                                                                   "right": "xyz", "on_false": "skip",
                                                                   "skip_count": 1}},
            {"id": "c", "type": "set", "name": "skipped", "config": {"value": "SKIPPED"}},
            {"id": "d", "type": "set", "name": "after", "config": {"value": "AFTER"}},
        ])
        assert d["status"] == "success", d
        skipped = [l for l in d["logs"] if l["status"] == "skipped"]
        assert skipped, d["logs"]
        assert d["output"] == "AFTER"

    def test_loop(self, api):
        d = _create_run(api, [
            {"id": "a", "type": "set", "name": "seed", "config": {"value": "[1,2,3]"}},
            {"id": "b", "type": "loop", "name": "forEach", "config": {"source": "{{prev}}", "max_items": 10}},
            {"id": "c", "type": "set", "name": "item", "config": {"value": "x={{item}}"}},
        ])
        assert d["status"] == "success", d
        assert "x=1" in d["output"] and "x=2" in d["output"] and "x=3" in d["output"]

    def test_device_notify(self, api):
        d = _create_run(api, [
            {"id": "a", "type": "set", "name": "seed", "config": {"value": "hello world"}},
            {"id": "b", "type": "device", "name": "notify", "config": {"action": "notify", "title": "T", "text": "{{prev}}"}},
        ])
        assert d["status"] == "success", d
        assert d.get("device_actions"), d
        assert d["device_actions"][0]["action"] == "notify"

    def test_http_bearer_cred(self, api):
        # Create a bearer cred then use via http step
        c = api.post(f"{API}/credentials", json={"name": "TEST_bearer_http", "type": "bearer",
                                                   "data": {"token": "abc_test_123"}})
        assert c.status_code == 200
        cid = c.json()["id"]
        try:
            d = _create_run(api, [{"id": "h", "type": "http", "name": "hb", "config": {
                "method": "GET", "url": "https://httpbin.org/headers", "credential": "TEST_bearer_http"}}])
            assert d["status"] == "success", d
            assert "Bearer abc_test_123" in d["output"]
        finally:
            api.delete(f"{API}/credentials/{cid}")

    def test_telegram_fake_fails_gracefully(self, api):
        c = api.post(f"{API}/credentials", json={"name": "TEST_tg_fake", "type": "telegram",
                                                   "data": {"bot_token": "123:FAKEABC", "chat_id": "0"}})
        cid = c.json()["id"]
        try:
            d = _create_run(api, [{"id": "t", "type": "telegram", "name": "tg", "config": {
                "credential": "TEST_tg_fake", "text": "hi"}}])
            assert d["status"] == "failed"
            assert d["logs"][0]["error"]
        finally:
            api.delete(f"{API}/credentials/{cid}")

    def test_missing_credential_clear_error(self, api):
        d = _create_run(api, [{"id": "t", "type": "telegram", "name": "tg", "config": {"credential": "nope_x", "text": "hi"}}])
        assert d["status"] == "failed"
        assert "not found" in (d["logs"][0]["error"] or "").lower() or "credential" in (d["logs"][0]["error"] or "").lower()

    def test_template_cred_resolves_in_set(self, api):
        c = api.post(f"{API}/credentials", json={"name": "TEST_tpl_cred", "type": "bearer",
                                                   "data": {"token": "MY_TOKEN_777"}})
        cid = c.json()["id"]
        try:
            d = _create_run(api, [{"id": "s", "type": "set", "name": "s", "config": {
                "value": "val={{cred.TEST_tpl_cred.token}}"}}])
            assert d["status"] == "success", d
            assert "MY_TOKEN_777" in d["output"]
        finally:
            api.delete(f"{API}/credentials/{cid}")


# ============================================================ Location trigger
class TestLocationTrigger:
    def test_location_trigger_saves(self, api):
        wf = {"name": "TEST_loc", "description": "", "active": True,
              "trigger": {"type": "location", "latitude": 37.7749, "longitude": -122.4194,
                          "radius": 300, "event": "enter", "interval_minutes": 60},
              "steps": [{"id": "s1", "type": "set", "name": "x", "config": {"value": "arrived"}}]}
        r = api.post(f"{API}/workflows", json=wf)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["trigger"]["type"] == "location"
        assert d["trigger"]["latitude"] == 37.7749
        # run with location trigger
        rr = api.post(f"{API}/workflows/{d['id']}/run", json={"input": "", "trigger": "location"}, timeout=20)
        assert rr.status_code == 200
        assert rr.json()["trigger"] == "location"
        api.delete(f"{API}/workflows/{d['id']}")


# ============================================================ Device pending
class TestDevicePending:
    def test_pending_webhook_actions(self, api):
        wf = {"name": "TEST_pending_wh", "description": "", "active": True,
              "trigger": {"type": "webhook", "interval_minutes": 60},
              "steps": [{"id": "d", "type": "device", "name": "notify",
                         "config": {"action": "notify", "title": "T", "text": "ping"}}]}
        r = api.post(f"{API}/workflows", json=wf)
        wid = r.json()["id"]
        try:
            hr = api.post(f"{API}/hooks/{wid}", data="x")
            assert hr.status_code == 200
            # pending should return at least one action
            p = api.get(f"{API}/device/pending")
            assert p.status_code == 200
            actions = p.json()
            assert any(a.get("action") == "notify" for a in actions), actions
            # second call -> empty
            p2 = api.get(f"{API}/device/pending")
            assert p2.json() == []
        finally:
            api.delete(f"{API}/workflows/{wid}")


# ============================================================ Agent SSE with new tools
class TestAgentTools:
    def test_agent_runs_code_and_device_action(self, api):
        api.delete(f"{API}/agent/messages")
        prompt = ("Use the run_code tool to compute 2**10 and then use run_step to send a phone 'notify' "
                  "action with the result in the text.")
        with requests.post(f"{API}/agent/chat", json={"message": prompt},
                           headers={"Content-Type": "application/json", "X-Device-Id": DEVICE_A},
                           stream=True, timeout=240) as r:
            assert r.status_code == 200
            events = []
            visible = ""
            for raw in r.iter_lines(decode_unicode=True):
                if not raw or not raw.startswith("data:"):
                    continue
                try:
                    ev = json.loads(raw[5:].strip())
                except Exception:
                    continue
                events.append(ev)
                if ev.get("type") == "delta":
                    visible += ev.get("text", "")
                if ev.get("type") == "done":
                    break
        types = [e["type"] for e in events]
        assert "done" in types
        assert "<tool>" not in visible, "tool blocks leaked into visible content"
        tool_names = [e["call"]["name"] for e in events if e["type"] == "tool_result"]
        assert "run_code" in tool_names, f"Expected run_code tool. Got: {tool_names}"
        # device_action event OR a run_step with notify action
        has_device_action = any(e["type"] == "device_action" for e in events)
        has_run_step_notify = any(
            e["type"] == "tool_result" and e["call"]["name"] == "run_step"
            and isinstance(e["call"].get("result"), dict)
            and e["call"]["result"].get("device_actions")
            for e in events
        )
        assert has_device_action or has_run_step_notify, f"Expected device_action event or run_step with device_actions. Events: {types}"


# ============================================================ Regression: list, toggle, LLM test
class TestRegression:
    def test_workflow_list(self, api):
        r = api.get(f"{API}/workflows")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_llm_test_connection(self, api):
        # Ensure emergent provider
        api.put(f"{API}/settings", json={
            "provider": "emergent", "emergent_provider": "openai", "emergent_model": "gpt-5.4",
            "local_base_url": "", "local_model": "", "local_api_key": "",
            "n8n_url": "", "n8n_api_key": "",
        })
        r = api.post(f"{API}/llm/test", timeout=60)
        assert r.status_code == 200
        assert r.json().get("ok") is True

    def test_toggle_active(self, api):
        wf = {"name": "TEST_regr_toggle", "description": "", "active": False,
              "trigger": {"type": "schedule", "interval_minutes": 1440},
              "steps": [{"id": "s1", "type": "set", "name": "x", "config": {"value": "x"}}]}
        r = api.post(f"{API}/workflows", json=wf)
        wid = r.json()["id"]
        try:
            t = api.post(f"{API}/workflows/{wid}/active", json={"active": True})
            assert t.status_code == 200
            assert t.json()["active"] is True
            assert t.json()["next_run_at"]
        finally:
            api.delete(f"{API}/workflows/{wid}")


# ============================================================ Final cleanup
def test_zzz_cleanup(api, api_b):
    for ses in (api, api_b):
        wfs = ses.get(f"{API}/workflows").json()
        for w in wfs:
            if w["name"].startswith("TEST_"):
                ses.delete(f"{API}/workflows/{w['id']}")
        creds = ses.get(f"{API}/credentials").json()
        for c in creds:
            if c["name"].startswith("TEST_") or "weird_name" in c["name"]:
                ses.delete(f"{API}/credentials/{c['id']}")
        ses.delete(f"{API}/agent/messages")
        ses.delete(f"{API}/runs")
