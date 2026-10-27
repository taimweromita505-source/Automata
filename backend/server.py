"""Automata API.

FastAPI backend for the Automata app: workflow engine, scheduler, webhook
triggers, SSE agent and the encrypted credentials vault.

Self-contained by design: SQLite for storage (db.py), plain HTTP for LLM calls
(llm.py). No vendor SDKs and no external services are needed to run it.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI, APIRouter, HTTPException, Request, Depends, Header
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import os
import re
import json
import uuid
import time
import asyncio
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Any, Literal, AsyncIterator
from datetime import datetime, timezone, timedelta
import httpx

import billing
import connectors
import llm
import vault
from billing import ProRequired
from db import Store, new_id, now_iso

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

DATA_DIR = os.environ.get("DATA_DIR", str(ROOT_DIR / "data"))
store = Store(os.environ.get("DB_PATH", os.path.join(DATA_DIR, "automata.db")))

@asynccontextmanager
async def lifespan(_: FastAPI):
    await store.connect()
    logger.info("storage ready at %s (billing mode: %s)", store.path, billing.mode())
    if billing.paid_mode() and not os.environ.get("REVENUECAT_SECRET_KEY"):
        await billing.is_pro("startup-check")  # logs the 'everyone is Free' warning once
    scheduler = asyncio.create_task(scheduler_loop())
    try:
        yield
    finally:
        scheduler.cancel()
        await store.close()


app = FastAPI(title="Automata API", lifespan=lifespan)
api_router = APIRouter(prefix="/api")
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------- Models
class BaseDocument(BaseModel):
    id: Optional[str] = None

    @classmethod
    def from_doc(cls, doc: dict):
        return cls.model_validate(doc)

    def to_doc(self) -> dict:
        return self.model_dump()

    def out(self) -> dict:
        return self.model_dump()


StepType = Literal["http", "llm", "delay", "set", "filter", "code", "scrape", "search", "if", "loop",
                   "telegram", "slack", "discord", "email", "sheets", "gmail", "drive", "calendar", "device"]


class Step(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    type: StepType
    name: str = ""
    config: dict = Field(default_factory=dict)


class Trigger(BaseModel):
    type: Literal["manual", "schedule", "webhook", "location"] = "manual"
    interval_minutes: int = 60
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    radius: int = 200
    event: Literal["enter", "exit"] = "enter"


class WorkflowIn(BaseModel):
    name: str
    description: str = ""
    active: bool = False
    trigger: Trigger = Field(default_factory=Trigger)
    steps: List[Step] = Field(default_factory=list)


class Workflow(BaseDocument):
    device_id: str = ""
    name: str
    description: str = ""
    active: bool = False
    trigger: Trigger = Field(default_factory=Trigger)
    steps: List[Step] = Field(default_factory=list)
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)
    last_run_at: Optional[str] = None
    last_status: Optional[str] = None
    next_run_at: Optional[str] = None


class StepLog(BaseModel):
    step_id: str
    name: str
    type: str
    status: str
    output: str = ""
    error: Optional[str] = None
    duration_ms: int = 0


class Run(BaseDocument):
    device_id: str = ""
    workflow_id: str
    workflow_name: str
    trigger: str
    status: str = "running"
    input: str = ""
    output: str = ""
    logs: List[StepLog] = Field(default_factory=list)
    device_actions: List[dict] = Field(default_factory=list)
    device_delivered: bool = True
    started_at: str = Field(default_factory=now_iso)
    finished_at: Optional[str] = None


class Settings(BaseModel):
    # "emergent" is the legacy wire name for "cloud provider using the server's key".
    provider: Literal["emergent", "local"] = "emergent"
    emergent_provider: Literal["openai", "anthropic", "gemini"] = "openai"
    emergent_model: str = ""
    local_base_url: str = ""
    local_model: str = ""
    local_api_key: str = ""
    n8n_url: str = ""
    n8n_api_key: str = ""


class ToolCall(BaseModel):
    id: str
    name: str
    args: dict = Field(default_factory=dict)
    status: str = "running"
    result: Any = None


class ChatMessage(BaseDocument):
    device_id: str = ""
    role: Literal["user", "assistant"]
    content: str
    tool_calls: List[ToolCall] = Field(default_factory=list)
    created_at: str = Field(default_factory=now_iso)


class ChatIn(BaseModel):
    message: str


class RunIn(BaseModel):
    input: str = ""
    trigger: Literal["manual", "app", "location"] = "manual"


class ActiveIn(BaseModel):
    active: bool


class CredentialIn(BaseModel):
    name: str
    type: str
    data: dict


async def get_device(x_device_id: Optional[str] = Header(None)) -> str:
    if not x_device_id or not re.fullmatch(r"[A-Za-z0-9\-]{8,64}", x_device_id):
        raise HTTPException(400, "Missing or invalid X-Device-Id header")
    return x_device_id


# ---------------------------------------------------------------- Settings
async def get_settings(device: str) -> Settings:
    doc = await store.get("settings", device, device)
    if not doc:
        return Settings(emergent_model=llm.default_model("openai"))
    doc = {k: v for k, v in doc.items() if k not in ("id", "device_id")}
    s = Settings(**doc)
    if not s.emergent_model:
        s.emergent_model = llm.default_model(s.emergent_provider)
    return s


async def guard_llm(settings: Settings, device: str, pro: bool) -> None:
    """Call before every LLM request: Local LLM is Pro-only; server-paid calls count toward the daily cap."""
    billing.check_local_llm(settings.provider, pro)
    if settings.provider == "emergent":
        await billing.consume_llm(store, device)


@api_router.get("/settings")
async def read_settings(device: str = Depends(get_device)):
    return (await get_settings(device)).model_dump()


@api_router.put("/settings")
async def update_settings(s: Settings, device: str = Depends(get_device)):
    billing.check_local_llm(s.provider, await billing.is_pro(device))
    if not s.emergent_model:
        s.emergent_model = llm.default_model(s.emergent_provider)
    await store.insert("settings", {"id": device, "device_id": device, **s.model_dump()})
    return s.model_dump()


# ---------------------------------------------------------------- LLM layer
class LLMSession:
    """Multi-turn session over the server's provider key or a local OpenAI-compatible endpoint.

    The system prompt and the prior conversation are resend on every turn, so
    the session holds no provider-side state and works with any backend.
    """

    def __init__(self, settings: Settings, system: str, history: Optional[List[dict]] = None):
        self.s = settings
        self.system = system
        self.messages: List[dict] = list(history or [])

    async def stream(self, text: str) -> AsyncIterator[str]:
        turns = self.messages + [{"role": "user", "content": text}]
        if self.s.provider == "emergent":
            gen = llm.stream(self.system, turns, self.s.emergent_provider, self.s.emergent_model)
        else:
            gen = llm.stream_local(self.s.local_base_url, self.s.local_model, self.s.local_api_key,
                                   self.system, turns)
        full = ""
        async for delta in gen:
            full += delta
            yield delta
        self.messages.append({"role": "user", "content": text})
        self.messages.append({"role": "assistant", "content": full})

    async def complete(self, text: str) -> str:
        out = ""
        async for d in self.stream(text):
            out += d
        return out


# ---------------------------------------------------------------- Workflow engine
TEMPLATE_RE = re.compile(r"\{\{\s*([\w\.\-]+)\s*\}\}")


def render(tpl: Any, ctx: dict) -> str:
    def rep(m):
        key = m.group(1)
        if key.startswith("cred."):
            parts = key.split(".")
            c = ctx.get("_creds", {}).get(parts[1]) if len(parts) >= 2 else None
            if c is None:
                return m.group(0)
            return json.dumps(c["data"]) if len(parts) == 2 else str(c["data"].get(parts[2], m.group(0)))
        if key in ctx and not key.startswith("_"):
            return str(ctx[key])
        return m.group(0)
    return TEMPLATE_RE.sub(rep, str(tpl if tpl is not None else ""))


def get_cred(ctx: dict, name: str, expected: tuple = ()) -> dict:
    if not name:
        raise RuntimeError("Select a credential for this step (Settings > Credentials vault)")
    c = ctx.get("_creds", {}).get(name)
    if not c:
        raise RuntimeError(f"Credential '{name}' not found in vault")
    if expected and c["type"] not in expected:
        raise RuntimeError(f"Credential '{name}' is '{c['type']}', expected {'/'.join(expected)}")
    return c["data"]


def evaluate(op: str, left: str, right: str) -> bool:
    l, r = left.strip(), right.strip()
    if op == "contains":
        return r.lower() in l.lower()
    if op == "not_contains":
        return r.lower() not in l.lower()
    if op == "equals":
        return l == r
    if op == "not_equals":
        return l != r
    if op == "regex":
        return re.search(r, l) is not None
    if op == "empty":
        return l == ""
    if op == "not_empty":
        return l != ""
    if op in ("gt", "lt"):
        try:
            a, b = float(l), float(r)
        except ValueError:
            raise RuntimeError(f"'{l[:40]}' or '{r[:40]}' is not a number")
        return a > b if op == "gt" else a < b
    raise RuntimeError(f"Unknown operator {op}")


def parse_items(text: str, limit: int) -> list:
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            data = next((v for v in data.values() if isinstance(v, list)), [data])
        if not isinstance(data, list):
            data = [data]
    except Exception:
        data = [l for l in text.splitlines() if l.strip()]
    return data[:limit]


def split_list(v: str) -> list:
    return [x.strip() for x in re.split(r"[,;\n]", v or "") if x.strip()]


async def exec_step(step: Step, ctx: dict, settings: Settings) -> tuple[str, bool, int]:
    """Returns (output, continue_flag, steps_to_skip)."""
    billing.check_step(step.type, step.config, bool(ctx.get("_pro")))
    c = {k: (render(v, ctx) if isinstance(v, str) else v) for k, v in step.config.items()}
    prev = str(ctx.get("prev", ""))
    t = step.type
    if t == "http":
        method = (c.get("method") or "GET").upper()
        url = c.get("url", "")
        if not url.startswith("http"):
            raise RuntimeError("HTTP step needs a valid URL")
        headers = {}
        if c.get("headers"):
            try:
                headers = json.loads(c["headers"])
            except Exception:
                raise RuntimeError("Headers must be valid JSON")
        kwargs: dict = {}
        if c.get("credential"):
            cr = ctx.get("_creds", {}).get(c["credential"])
            if not cr:
                raise RuntimeError(f"Credential '{c['credential']}' not found in vault")
            d = cr["data"]
            if cr["type"] == "bearer":
                headers["Authorization"] = f"Bearer {d.get('token', '')}"
            elif cr["type"] in ("api_key", "custom") and d.get("header"):
                headers[d["header"]] = d.get("value", "")
            elif cr["type"] == "basic":
                kwargs["auth"] = (d.get("username", ""), d.get("password", ""))
            elif cr["type"] == "google":
                headers["Authorization"] = f"Bearer {await connectors.google_token(d)}"
        body = c.get("body", "")
        if body and method != "GET":
            try:
                kwargs["json"] = json.loads(body)
            except Exception:
                kwargs["content"] = body
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as hc:
            r = await hc.request(method, url, headers=headers, **kwargs)
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
        return r.text[:8000], True, 0
    if t == "llm":
        await guard_llm(settings, ctx["_device"], bool(ctx.get("_pro")))
        sess = LLMSession(settings, step.config.get("system") or "You are a concise automation assistant. Reply with the result only.")
        return (await sess.complete(c.get("prompt") or prev)).strip(), True, 0
    if t == "delay":
        await asyncio.sleep(max(0, min(int(step.config.get("seconds", 1) or 0), 60)))
        return prev, True, 0
    if t == "set":
        return c.get("value", ""), True, 0
    if t == "filter":
        needle = c.get("contains", "")
        ok = needle.lower() in prev.lower()
        return (prev if ok else f"Filter stopped: output does not contain '{needle}'"), ok, 0
    if t == "code":
        await billing.consume_code(store, ctx["_device"])
        steps_out = [ctx.get(f"step_{i}", "") for i in range(1, 100) if f"step_{i}" in ctx]
        return await connectors.run_code(step.config.get("code", ""), str(ctx.get("input", "")), prev, steps_out), True, 0
    if t == "scrape":
        return await connectors.scrape(c.get("url", ""), c.get("selector", "")), True, 0
    if t == "search":
        res = await connectors.web_search(c.get("query") or prev, int(step.config.get("limit", 8) or 8))
        return json.dumps(res, ensure_ascii=False), True, 0
    if t == "if":
        ok = evaluate(c.get("operator", "contains"), c.get("left") or prev, c.get("right", ""))
        if ok:
            return prev, True, 0
        if c.get("on_false", "stop") == "skip":
            return prev, True, max(1, int(step.config.get("skip_count", 1) or 1))
        return "Condition false: workflow stopped", False, 0
    if t == "telegram":
        d = get_cred(ctx, c.get("credential", ""), ("telegram",))
        return await connectors.telegram(d.get("bot_token", ""), c.get("chat_id") or d.get("chat_id", ""), c.get("text") or prev), True, 0
    if t in ("slack", "discord"):
        d = get_cred(ctx, c.get("credential", ""), (t,))
        fn = connectors.slack if t == "slack" else connectors.discord
        return await fn(d.get("webhook_url", ""), c.get("text") or prev), True, 0
    if t == "email":
        d = get_cred(ctx, c.get("credential", ""), ("resend",))
        return await connectors.resend_email(d.get("api_key", ""), c.get("from") or d.get("from", ""),
                                             split_list(c.get("to", "")), c.get("subject", ""), c.get("text") or prev), True, 0
    if t in ("sheets", "gmail", "drive", "calendar"):
        d = get_cred(ctx, c.get("credential", ""), ("google",))
        if t == "sheets":
            if c.get("action", "read") == "append":
                raw = c.get("values") or prev
                try:
                    rows = json.loads(raw)
                    rows = rows if isinstance(rows, list) and rows and isinstance(rows[0], list) else [rows if isinstance(rows, list) else [rows]]
                except Exception:
                    rows = [split_list(raw) or [raw]]
                return await connectors.sheets_append(d, c.get("spreadsheet_id", ""), c.get("range", "Sheet1"), rows), True, 0
            return json.dumps(await connectors.sheets_read(d, c.get("spreadsheet_id", ""), c.get("range", "Sheet1"))), True, 0
        if t == "gmail":
            return await connectors.gmail_send(d, c.get("to", ""), c.get("subject", ""), c.get("text") or prev), True, 0
        if t == "drive":
            return json.dumps(await connectors.drive_list(d, c.get("query", ""))), True, 0
        if c.get("action", "list") == "create":
            return await connectors.calendar_create(d, c.get("calendar_id") or "primary", c.get("summary", ""), c.get("start", ""), c.get("end", "")), True, 0
        return json.dumps(await connectors.calendar_list(d, c.get("calendar_id") or "primary")), True, 0
    if t == "device":
        action = {"action": c.get("action", "notify"), "title": c.get("title") or ctx.get("workflow", "Automata"),
                  "text": (c.get("text") or prev)[:2000], "url": c.get("url", "")}
        ctx.setdefault("_device_actions", []).append(action)
        return f"Phone action queued: {action['action']}", True, 0
    if t == "loop":
        raise RuntimeError("Loop must be followed by the step to repeat")
    raise RuntimeError(f"Unknown step type {t}")


async def run_workflow(wf: Workflow, trigger: str, input_text: str = "") -> Run:
    """Raises ProRequired (HTTP 402) before anything runs if the workflow uses Pro features on a Free device."""
    pro = await billing.is_pro(wf.device_id)
    billing.check_workflow(wf.trigger.type, wf.steps, pro)
    settings = await get_settings(wf.device_id)
    creds = await vault.load_creds(store, wf.device_id) if pro else {}
    run = Run(device_id=wf.device_id, workflow_id=wf.id, workflow_name=wf.name, trigger=trigger, input=input_text)
    saved = await store.insert("runs", run.to_doc())
    run.id = saved["id"]
    ctx: dict = {"input": input_text, "prev": input_text, "now": now_iso(), "workflow": wf.name,
                 "_creds": creds, "_device_actions": [], "_device": wf.device_id, "_pro": pro}
    status = "success"
    steps = wf.steps
    i = 0

    def log(step: Step, st: str, t0: float, out: str = "", err: Optional[str] = None):
        run.logs.append(StepLog(step_id=step.id, name=step.name or step.type, type=step.type, status=st,
                                output=out[:8000], error=err[:1000] if err else None,
                                duration_ms=int((time.time() - t0) * 1000)))

    while i < len(steps):
        step = steps[i]
        t0 = time.time()
        try:
            if step.type == "loop":
                if i + 1 >= len(steps):
                    raise RuntimeError("Loop needs a step after it to repeat")
                limit = max(1, min(int(step.config.get("max_items", 25) or 25), 50))
                items = parse_items(render(step.config.get("source") or "{{prev}}", ctx), limit)
                body = steps[i + 1]
                results = []
                for k, item in enumerate(items):
                    ctx["item"] = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
                    ctx["index"] = k
                    out, _, _ = await exec_step(body, ctx, settings)
                    results.append(out)
                out = json.dumps(results, ensure_ascii=False)
                log(step, "success", t0, f"{len(items)} item(s)")
                log(body, "success", t0, out)
                ctx["prev"] = ctx[f"step_{i + 1}"] = ctx[f"step_{i + 2}"] = out
                i += 2
                continue
            out, cont, skip = await exec_step(step, ctx, settings)
            log(step, "success" if cont else "stopped", t0, out)
            ctx["prev"] = ctx[f"step_{i + 1}"] = out
            if not cont:
                status = "stopped"
                break
            for j in range(i + 1, min(i + 1 + skip, len(steps))):
                log(steps[j], "skipped", time.time(), "Skipped by condition")
            i += 1 + skip
        except Exception as e:
            log(step, "failed", t0, err=str(e))
            status = "failed"
            break
    run.status = status
    run.output = str(ctx.get("prev", ""))[:8000]
    run.device_actions = ctx["_device_actions"]
    run.device_delivered = not run.device_actions or trigger not in ("schedule", "webhook")
    run.finished_at = now_iso()
    await store.replace("runs", run.to_doc())
    upd = {"last_run_at": run.finished_at, "last_status": status}
    if wf.trigger.type == "schedule" and wf.active:
        upd["next_run_at"] = (datetime.now(timezone.utc) + timedelta(minutes=max(1, wf.trigger.interval_minutes))).isoformat()
    await store.update("workflows", wf.id, upd)
    return run


def compute_next(wf_in: WorkflowIn) -> Optional[str]:
    if wf_in.active and wf_in.trigger.type == "schedule":
        return (datetime.now(timezone.utc) + timedelta(minutes=max(1, wf_in.trigger.interval_minutes))).isoformat()
    return None


async def load_wf(wf_id: str, device: Optional[str] = None) -> Workflow:
    if not wf_id:
        raise HTTPException(404, "Workflow not found")
    doc = await store.get("workflows", wf_id, device)
    if not doc:
        raise HTTPException(404, "Workflow not found")
    return Workflow.from_doc(doc)


async def check_wf_allowed(data: WorkflowIn, device: str, creating: bool) -> None:
    """Free plan: at most FREE_WORKFLOW_LIMIT workflows, no Pro steps/triggers/credentials."""
    pro = await billing.is_pro(device)
    billing.check_workflow(data.trigger.type, data.steps, pro)
    if creating and not pro:
        limit = billing.free_workflow_limit()
        if await store.count("workflows", device) >= limit:
            raise ProRequired(f"More than {limit} workflows")


async def create_wf(data: WorkflowIn, device: str) -> Workflow:
    await check_wf_allowed(data, device, creating=True)
    wf = Workflow(**data.model_dump(), device_id=device, next_run_at=compute_next(data))
    saved = await store.insert("workflows", wf.to_doc())
    wf.id = saved["id"]
    return wf


async def set_active(wf_id: str, active: bool, device: str) -> Workflow:
    wf = await load_wf(wf_id, device)
    wf.active = active
    data = WorkflowIn(**wf.model_dump(include={"name", "description", "active", "trigger", "steps"}))
    if active:
        await check_wf_allowed(data, device, creating=False)
    nxt = compute_next(data)
    await store.update("workflows", wf_id, {"active": active, "next_run_at": nxt, "updated_at": now_iso()})
    wf.next_run_at = nxt
    return wf


# ---------------------------------------------------------------- Workflow routes
@api_router.get("/")
async def root():
    return {"message": "Automata API", "billing_mode": billing.mode()}


@api_router.get("/workflows")
async def list_workflows(device: str = Depends(get_device)):
    docs = await store.find("workflows", device, limit=500)
    return [Workflow.from_doc(d).out() for d in docs]


@api_router.post("/workflows")
async def create_workflow(data: WorkflowIn, device: str = Depends(get_device)):
    return (await create_wf(data, device)).out()


@api_router.get("/workflows/{wf_id}")
async def get_workflow(wf_id: str, device: str = Depends(get_device)):
    return (await load_wf(wf_id, device)).out()


@api_router.put("/workflows/{wf_id}")
async def update_workflow(wf_id: str, data: WorkflowIn, device: str = Depends(get_device)):
    await load_wf(wf_id, device)
    await check_wf_allowed(data, device, creating=False)
    upd = {**data.model_dump(), "updated_at": now_iso(), "next_run_at": compute_next(data)}
    await store.update("workflows", wf_id, upd)
    return (await load_wf(wf_id, device)).out()


@api_router.delete("/workflows/{wf_id}")
async def delete_workflow(wf_id: str, device: str = Depends(get_device)):
    await load_wf(wf_id, device)
    await store.delete("workflows", wf_id, device)
    return {"ok": True}


@api_router.post("/workflows/{wf_id}/active")
async def toggle_workflow(wf_id: str, body: ActiveIn, device: str = Depends(get_device)):
    return (await set_active(wf_id, body.active, device)).out()


@api_router.post("/workflows/{wf_id}/run")
async def run_workflow_route(wf_id: str, body: RunIn, device: str = Depends(get_device)):
    wf = await load_wf(wf_id, device)
    return (await run_workflow(wf, body.trigger, body.input)).out()


@api_router.post("/hooks/{wf_id}")
async def webhook_trigger(wf_id: str, request: Request):
    wf = await load_wf(wf_id)
    if wf.trigger.type != "webhook" or not wf.active:
        raise HTTPException(400, "Workflow is not an active webhook workflow")
    raw = (await request.body()).decode(errors="ignore")
    return (await run_workflow(wf, "webhook", raw)).out()


@api_router.get("/runs")
async def list_runs(workflow_id: Optional[str] = None, limit: int = 50, device: str = Depends(get_device)):
    docs = await store.find("runs", device, limit=min(limit, 200), order_by="started_at")
    if workflow_id:
        docs = [d for d in docs if d.get("workflow_id") == workflow_id]
    return [Run.from_doc(d).out() for d in docs]


@api_router.delete("/runs")
async def clear_runs(device: str = Depends(get_device)):
    await store.delete_many("runs", device)
    return {"ok": True}


@api_router.get("/device/pending")
async def device_pending(device: str = Depends(get_device)):
    """Phone actions produced by background (schedule/webhook) runs, delivered once."""
    return await store.take_pending_actions(device)


# ---------------------------------------------------------------- Credentials vault
def cred_out(d: dict) -> dict:
    try:
        data = vault.decrypt(d["data_enc"])
    except Exception:
        data = {}
    return {"id": d["id"], "name": d["name"], "type": d["type"], "created_at": d.get("created_at"),
            "fields": {k: vault.mask(v) for k, v in data.items()}}


def validate_cred(body: CredentialIn) -> CredentialIn:
    name = re.sub(r"[^A-Za-z0-9_]", "_", body.name.strip())[:40]
    if not name:
        raise HTTPException(400, "Credential name is required")
    if body.type not in vault.CRED_TYPES:
        raise HTTPException(400, f"Unknown credential type {body.type}")
    data = {str(k).strip(): str(v).strip() for k, v in body.data.items() if str(k).strip()}
    missing = [f for f in vault.CRED_TYPES[body.type] if not data.get(f)]
    if missing:
        raise HTTPException(400, f"Missing field(s): {', '.join(missing)}")
    if body.type == "custom" and not data:
        raise HTTPException(400, "Add at least one field")
    return CredentialIn(name=name, type=body.type, data=data)


@api_router.get("/credentials")
async def list_credentials(device: str = Depends(get_device)):
    docs = await store.find("credentials", device, limit=200, order_by="created_at")
    return [cred_out(d) for d in docs]


@api_router.post("/credentials")
async def create_credential(body: CredentialIn, device: str = Depends(get_device)):
    if not await billing.is_pro(device):
        raise ProRequired("The credentials vault")
    body = validate_cred(body)
    if await store.find_by_name("credentials", device, body.name):
        raise HTTPException(400, f"A credential named '{body.name}' already exists")
    doc = {"device_id": device, "name": body.name, "type": body.type,
           "data_enc": vault.encrypt(body.data), "created_at": now_iso()}
    saved = await store.insert("credentials", doc)
    return cred_out(saved)


@api_router.delete("/credentials/{cred_id}")
async def delete_credential(cred_id: str, device: str = Depends(get_device)):
    if not await store.delete("credentials", cred_id, device):
        raise HTTPException(404, "Credential not found")
    return {"ok": True}


# ---------------------------------------------------------------- External n8n
async def n8n_request(method: str, path: str, device: str):
    s = await get_settings(device)
    if not s.n8n_url or not s.n8n_api_key:
        raise HTTPException(400, "n8n instance not configured")
    url = s.n8n_url.rstrip("/") + "/api/v1" + path
    try:
        async with httpx.AsyncClient(timeout=20) as hc:
            r = await hc.request(method, url, headers={"X-N8N-API-KEY": s.n8n_api_key, "accept": "application/json"})
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Could not reach n8n: {e}")
    if r.status_code >= 400:
        raise HTTPException(r.status_code if r.status_code < 500 else 502, f"n8n error: {r.text[:300]}")
    return r.json()


async def n8n_list(device: str):
    data = await n8n_request("GET", "/workflows?limit=100", device)
    items = data.get("data", data if isinstance(data, list) else [])
    return [{"id": str(w.get("id")), "name": w.get("name"), "active": bool(w.get("active")),
             "updated_at": w.get("updatedAt"), "nodes": len(w.get("nodes") or [])} for w in items]


@api_router.get("/n8n/workflows")
async def n8n_workflows(device: str = Depends(get_device)):
    return await n8n_list(device)


@api_router.post("/n8n/workflows/{n8n_id}/active")
async def n8n_toggle(n8n_id: str, body: ActiveIn, device: str = Depends(get_device)):
    await n8n_request("POST", f"/workflows/{n8n_id}/{'activate' if body.active else 'deactivate'}", device)
    return {"ok": True, "active": body.active}


# ---------------------------------------------------------------- Agent
AGENT_SYSTEM = """You are Automata, an autonomous automation agent inside a mobile app with a built-in n8n-style workflow engine.
You can do tasks DIRECTLY with tools (search the web, read pages, call APIs, run Python, send messages, use Google, act on the user's phone)
and you can save repeatable tasks as WORKFLOWS (scheduled, webhook, location or manual).

To call a tool, output EXACTLY one block per call (no markdown fences):
<tool>{"name": "TOOL_NAME", "args": {...}}</tool>
After emitting tool blocks, STOP and wait for TOOL RESULTS, then continue. You may chain several rounds.
Never invent tool results. Do not call tools for plain questions.

TOOLS:
- web_search {"query"} -> top results (title, url, snippet)
- fetch_url {"url", "selector"?} -> readable page text
- http_request {"method", "url", "headers"?: JSON string, "body"?: str, "credential"?: vault name}
- run_code {"code", "input"?} -> Python 3 (set `result = ...` or print). Vars: input, prev, data (parsed JSON of prev). httpx available.
- run_step {"type", "config", "input"?} -> execute any single STEP TYPE below immediately (e.g. send Telegram, append to Sheets, phone notify)
- list_credentials {} -> names/types of the user's saved credentials (never ask for raw secrets; ask the user to add them in Settings > Credentials)
- list_workflows {}
- create_workflow {"name", "description", "active": bool, "trigger": {...}, "steps": [ {"type", "name", "config"} ]}
- update_workflow {"workflow_id", plus any of name/description/active/trigger/steps}
- run_workflow {"workflow_id", "input": str}
- set_workflow_active {"workflow_id", "active": bool}
- list_runs {"limit": int}
- n8n_list_workflows {} -> workflows on the user's external n8n instance (if configured)

TRIGGERS: {"type": "manual"} | {"type": "schedule", "interval_minutes": int} (daily=1440, hourly=60) | {"type": "webhook"} |
{"type": "location", "latitude", "longitude", "radius": meters, "event": "enter"|"exit"} (phone geofence).

STEP TYPES and config (all strings support templates):
- http {method, url, headers (JSON string), body, credential}
- llm {prompt, system}  (AI step: summarize, classify, extract, write)
- code {code}  (Python; set result)
- scrape {url, selector}
- search {query, limit}
- if {left (default {{prev}}), operator: contains|not_contains|equals|not_equals|regex|gt|lt|empty|not_empty, right, on_false: stop|skip, skip_count}
- loop {source (default {{prev}}; JSON array, object with a list, or lines), max_items} -> repeats the NEXT step for each {{item}} ({{index}})
- filter {contains}
- delay {seconds <= 60}
- set {value}
- telegram {credential, chat_id?, text} | slack {credential, text} | discord {credential, text}
- email {credential (resend), from?, to (comma list), subject, text}
- sheets {credential (google), action: read|append, spreadsheet_id, range, values (JSON rows or comma text)}
- gmail {credential (google), to, subject, text} | drive {credential (google), query} | calendar {credential (google), action: list|create, calendar_id, summary, start, end (ISO)}
- device {action: notify|clipboard|open_url|share|vibrate, title, text, url}  (runs on the user's phone)
Templates: {{input}}, {{prev}}, {{step_1}}..., {{item}}, {{index}}, {{now}}, {{cred.NAME.FIELD}}.
Before using a messaging/Google step, call list_credentials to find the right credential name. If none exists, tell the user which credential type to add.
Prefer doing one-off tasks directly; offer to save as a workflow when it is repeatable. Schedules you create should be active: true.
Keep replies short, clear and practical. No emoji."""

TOOL_RE = re.compile(r"<tool>(.*?)</tool>", re.S)


async def exec_tool(name: str, args: dict, device: str) -> Any:
    if name == "list_workflows":
        docs = await store.find("workflows", device, limit=200)
        return [{"id": d["id"], "name": d["name"], "active": d.get("active"),
                 "trigger": d.get("trigger"), "steps": [s.get("type") for s in d.get("steps", [])]} for d in docs]
    if name == "create_workflow":
        wf = await create_wf(WorkflowIn(**args), device)
        return {"id": wf.id, "name": wf.name, "active": wf.active, "steps": len(wf.steps), "trigger": wf.trigger.model_dump()}
    if name == "update_workflow":
        wf = await load_wf(str(args.get("workflow_id", "")), device)
        merged = {**wf.model_dump(include={"name", "description", "active", "trigger", "steps"}),
                  **{k: v for k, v in args.items() if k in ("name", "description", "active", "trigger", "steps")}}
        data = WorkflowIn(**merged)
        await check_wf_allowed(data, device, creating=False)
        await store.update("workflows", wf.id, {**data.model_dump(), "updated_at": now_iso(), "next_run_at": compute_next(data)})
        return {"id": wf.id, "name": data.name, "active": data.active, "steps": len(data.steps)}
    if name == "run_workflow":
        wf = await load_wf(str(args.get("workflow_id", "")), device)
        run = await run_workflow(wf, "agent", str(args.get("input", "")))
        return {"run_id": run.id, "status": run.status, "output": run.output[:2000],
                "errors": [l.error for l in run.logs if l.error], "device_actions": run.device_actions}
    if name == "set_workflow_active":
        wf = await set_active(str(args.get("workflow_id", "")), bool(args.get("active")), device)
        return {"id": wf.id, "active": wf.active, "next_run_at": wf.next_run_at}
    if name == "list_runs":
        docs = await store.find("runs", device, limit=int(args.get("limit", 10)), order_by="started_at")
        return [{"workflow": d["workflow_name"], "status": d["status"], "at": d["started_at"],
                 "output": (d.get("output") or "")[:300]} for d in docs]
    if name == "n8n_list_workflows":
        return await n8n_list(device)
    if name == "list_credentials":
        docs = await store.find("credentials", device, limit=200, order_by="created_at")
        return [{"name": d["name"], "type": d["type"]} for d in docs]
    if name == "web_search":
        return await connectors.web_search(str(args.get("query", "")))
    if name in ("fetch_url", "http_request", "run_code", "run_step"):
        if name == "fetch_url":
            step = Step(type="scrape", config={"url": args.get("url", ""), "selector": args.get("selector", "")})
        elif name == "http_request":
            step = Step(type="http", config={k: args.get(k, "") for k in ("method", "url", "headers", "body", "credential")})
        elif name == "run_code":
            step = Step(type="code", config={"code": args.get("code", "")})
        else:
            if args.get("type") == "loop":
                raise ValueError("Use a workflow for loops")
            step = Step(type=args.get("type"), config=args.get("config") or {})
        settings = await get_settings(device)
        pro = await billing.is_pro(device)
        billing.check_step(step.type, step.config, pro)
        inp = str(args.get("input", ""))
        ctx = {"input": inp, "prev": inp, "now": now_iso(), "workflow": "Agent",
               "_creds": await vault.load_creds(store, device) if pro else {}, "_device_actions": [],
               "_device": device, "_pro": pro}
        out, cont, _ = await exec_step(step, ctx, settings)
        return {"output": out[:4000], "continued": cont, "device_actions": ctx["_device_actions"]}
    raise ValueError(f"Unknown tool: {name}")


class ToolFilter:
    """Streams visible text while hiding <tool>...</tool> blocks."""

    OPEN, CLOSE = "<tool>", "</tool>"

    def __init__(self):
        self.buf = ""
        self.inside = False

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        out = ""
        while True:
            if not self.inside:
                i = self.buf.find(self.OPEN)
                if i >= 0:
                    out += self.buf[:i]
                    self.buf = self.buf[i + len(self.OPEN):]
                    self.inside = True
                    continue
                keep = 0
                for k in range(1, len(self.OPEN)):
                    if self.buf.endswith(self.OPEN[:k]):
                        keep = k
                out += self.buf[:len(self.buf) - keep]
                self.buf = self.buf[len(self.buf) - keep:]
                return out
            j = self.buf.find(self.CLOSE)
            if j < 0:
                return out
            self.buf = self.buf[j + len(self.CLOSE):]
            self.inside = False

    def flush(self) -> str:
        rest = "" if self.inside else self.buf
        self.buf = ""
        return rest


def sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, default=str)}\n\n"


@api_router.get("/agent/messages")
async def agent_messages(device: str = Depends(get_device)):
    docs = await store.find("messages", device, limit=500, order_by="created_at", desc=False)
    return [ChatMessage.from_doc(d).out() for d in docs]


@api_router.delete("/agent/messages")
async def clear_messages(device: str = Depends(get_device)):
    await store.delete_many("messages", device)
    return {"ok": True}


@api_router.post("/agent/chat")
async def agent_chat(body: ChatIn, device: str = Depends(get_device)):
    settings_obj = await get_settings(device)
    pro = await billing.is_pro(device)
    billing.check_local_llm(settings_obj.provider, pro)  # 402 before streaming starts
    await billing.consume_agent_message(store, device, pro)  # Free: FREE_AGENT_DAILY messages/day
    prior = await store.find("messages", device, limit=20, order_by="created_at")
    history = [{"role": d["role"], "content": d["content"]} for d in reversed(prior) if d.get("content")]
    await store.insert("messages", ChatMessage(device_id=device, role="user", content=body.message).to_doc())

    async def gen():
        visible = ""
        calls: List[ToolCall] = []
        try:
            session = LLMSession(settings_obj, AGENT_SYSTEM, history)
            prompt = body.message
            for _ in range(6):
                raw = ""
                flt = ToolFilter()
                await guard_llm(settings_obj, device, pro)  # each agent round is one LLM call
                async for d in session.stream(prompt):
                    raw += d
                    shown = flt.feed(d)
                    if shown:
                        visible += shown
                        yield sse({"type": "delta", "text": shown})
                tail = flt.flush()
                if tail:
                    visible += tail
                    yield sse({"type": "delta", "text": tail})
                blocks = TOOL_RE.findall(raw)
                if not blocks:
                    break
                results = []
                for b in blocks:
                    tc = ToolCall(id=uuid.uuid4().hex[:8], name="unknown")
                    try:
                        parsed = json.loads(b.strip())
                        tc.name = parsed.get("name", "unknown")
                        tc.args = parsed.get("args", {}) or {}
                        yield sse({"type": "tool_start", "call": tc.model_dump()})
                        tc.result = await exec_tool(tc.name, tc.args, device)
                        tc.status = "success"
                    except ProRequired as e:
                        tc.status, tc.result = "failed", str(e.detail)
                        yield sse({"type": "paywall", "feature": e.feature, "text": str(e.detail)})
                    except HTTPException as e:
                        tc.status, tc.result = "failed", str(e.detail)
                    except Exception as e:
                        tc.status, tc.result = "failed", str(e)[:500]
                    calls.append(tc)
                    yield sse({"type": "tool_result", "call": tc.model_dump()})
                    if isinstance(tc.result, dict) and tc.result.get("device_actions"):
                        yield sse({"type": "device_action", "actions": tc.result["device_actions"]})
                    results.append({"tool": tc.name, "status": tc.status, "result": tc.result})
                if visible and not visible.endswith("\n"):
                    visible += "\n\n"
                    yield sse({"type": "delta", "text": "\n\n"})
                prompt = "TOOL RESULTS:\n" + json.dumps(results, default=str, ensure_ascii=False)[:8000] + "\nContinue. Give the user a brief final answer, or call more tools if truly needed."
        except HTTPException as e:  # daily cap reached mid-conversation
            visible += f"\n[{e.detail}]"
            yield sse({"type": "error", "text": str(e.detail)})
        except Exception as e:
            logger.exception("agent error")
            visible += f"\n[Agent error] {str(e)[:300]}"
            yield sse({"type": "error", "text": str(e)[:300]})
        saved_msg = ChatMessage(device_id=device, role="assistant", content=visible.strip(), tool_calls=calls)
        saved = await store.insert("messages", saved_msg.to_doc())
        saved_msg.id = saved["id"]
        yield sse({"type": "done", "message": saved_msg.out()})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@api_router.post("/llm/test")
async def llm_test(device: str = Depends(get_device)):
    settings_obj = await get_settings(device)
    await guard_llm(settings_obj, device, await billing.is_pro(device))
    try:
        out = await LLMSession(settings_obj, "Reply with exactly: OK").complete("ping")
        return {"ok": True, "reply": out.strip()[:200]}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


@api_router.get("/plan")
async def plan(device: str = Depends(get_device)):
    """The device's plan as the server sees it, with today's usage and limits."""
    pro = await billing.is_pro(device)
    usage = await billing.get_usage(store, device)
    return {"pro": pro,
            "billing_mode": billing.mode(),
            "workflows": await store.count("workflows", device),
            "usage_today": {k: usage[k] for k in ("agent", "llm", "code")},
            "limits": {"workflows": None if pro else billing.free_workflow_limit(),
                       "agent_daily": None if pro else billing.free_agent_daily(),
                       "llm_daily": billing.daily_llm_cap(), "code_daily": billing.daily_code_cap()}}


# ---------------------------------------------------------------- Scheduler
async def scheduled_run(wf: Workflow):
    try:
        await run_workflow(wf, "schedule")
    except ProRequired as e:
        logger.info("skipped scheduled workflow %s: %s", wf.id, e.detail)
        await store.update("workflows", wf.id, {"last_status": "needs_pro", "last_run_at": now_iso()})
    except Exception:
        logger.exception("scheduled run failed")


async def scheduler_loop():
    while True:
        try:
            docs = await store.due_scheduled(now_iso())
            for d in docs:
                wf = Workflow.from_doc(d)
                # bump next_run first to avoid double execution
                nxt = (datetime.now(timezone.utc) + timedelta(minutes=max(1, wf.trigger.interval_minutes))).isoformat()
                await store.update("workflows", wf.id, {"next_run_at": nxt})
                asyncio.create_task(scheduled_run(wf))
        except Exception:
            logger.exception("scheduler error")
        await asyncio.sleep(20)


app.include_router(api_router)
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()] or ["*"]
app.add_middleware(CORSMiddleware, allow_credentials=CORS_ORIGINS != ["*"], allow_origins=CORS_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])
