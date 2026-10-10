from fastapi import FastAPI, APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from bson import ObjectId
import os
import re
import json
import uuid
import time
import asyncio
import logging
from pathlib import Path
from pydantic import BaseModel, Field, BeforeValidator, ConfigDict
from typing import List, Optional, Any, Annotated, Literal, AsyncIterator
from datetime import datetime, timezone, timedelta
import httpx
from emergentintegrations.llm.chat import LlmChat, UserMessage, TextDelta, StreamDone

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]
EMERGENT_LLM_KEY = os.environ.get('EMERGENT_LLM_KEY', '')

app = FastAPI()
api_router = APIRouter(prefix="/api")
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------- Models
PyObjectId = Annotated[str, BeforeValidator(lambda v: str(v) if isinstance(v, ObjectId) else v)]


class BaseDocument(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: Optional[PyObjectId] = Field(default=None, alias="_id")

    @classmethod
    def from_mongo(cls, doc: dict):
        return cls.model_validate(doc)

    def to_mongo(self) -> dict:
        data = self.model_dump(by_alias=True, exclude={"id"})
        data.pop("_id", None)
        return data

    def out(self) -> dict:
        return self.model_dump(by_alias=False)


StepType = Literal["http", "llm", "delay", "set", "filter"]


class Step(BaseModel):
    id: str = Field(default_factory=lambda: uuid.uuid4().hex[:8])
    type: StepType
    name: str = ""
    config: dict = Field(default_factory=dict)


class Trigger(BaseModel):
    type: Literal["manual", "schedule", "webhook"] = "manual"
    interval_minutes: int = 60


class WorkflowIn(BaseModel):
    name: str
    description: str = ""
    active: bool = False
    trigger: Trigger = Field(default_factory=Trigger)
    steps: List[Step] = Field(default_factory=list)


class Workflow(BaseDocument):
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
    workflow_id: str
    workflow_name: str
    trigger: str
    status: str = "running"
    input: str = ""
    output: str = ""
    logs: List[StepLog] = Field(default_factory=list)
    started_at: str = Field(default_factory=now_iso)
    finished_at: Optional[str] = None


class Settings(BaseModel):
    provider: Literal["emergent", "local"] = "emergent"
    emergent_provider: Literal["openai", "anthropic", "gemini"] = "openai"
    emergent_model: str = "gpt-5.4"
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
    role: Literal["user", "assistant"]
    content: str
    tool_calls: List[ToolCall] = Field(default_factory=list)
    created_at: str = Field(default_factory=now_iso)


class ChatIn(BaseModel):
    message: str


class RunIn(BaseModel):
    input: str = ""


class ActiveIn(BaseModel):
    active: bool


# ---------------------------------------------------------------- Settings
async def get_settings() -> Settings:
    doc = await db.settings.find_one({"key": "main"}, {"_id": 0, "key": 0})
    return Settings(**(doc or {}))


@api_router.get("/settings")
async def read_settings():
    return (await get_settings()).model_dump()


@api_router.put("/settings")
async def update_settings(s: Settings):
    await db.settings.update_one({"key": "main"}, {"$set": s.model_dump()}, upsert=True)
    return s.model_dump()


# ---------------------------------------------------------------- LLM layer
class LLMSession:
    """Multi-turn session over Emergent universal key or a local OpenAI-compatible endpoint."""

    def __init__(self, settings: Settings, system: str, history: Optional[List[dict]] = None):
        self.s = settings
        self.system = system
        self.messages: List[dict] = [{"role": "system", "content": system}] + (history or [])
        if settings.provider == "emergent":
            sys_full = system
            if history:
                transcript = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in history)
                sys_full += f"\n\n# Conversation so far\n{transcript}"
            self.chat = LlmChat(api_key=EMERGENT_LLM_KEY, session_id=uuid.uuid4().hex,
                                system_message=sys_full).with_model(settings.emergent_provider, settings.emergent_model)

    async def stream(self, text: str) -> AsyncIterator[str]:
        if self.s.provider == "emergent":
            async for ev in self.chat.stream_message(UserMessage(text=text)):
                if isinstance(ev, TextDelta):
                    yield ev.content
                elif isinstance(ev, StreamDone):
                    break
            return
        if not self.s.local_base_url or not self.s.local_model:
            raise RuntimeError("Local LLM is not configured. Set base URL and model in Settings.")
        self.messages.append({"role": "user", "content": text})
        url = self.s.local_base_url.rstrip("/") + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if self.s.local_api_key:
            headers["Authorization"] = f"Bearer {self.s.local_api_key}"
        full = ""
        async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=15)) as hc:
            async with hc.stream("POST", url, headers=headers, json={
                "model": self.s.local_model, "messages": self.messages, "stream": True}) as r:
                if r.status_code >= 400:
                    body = (await r.aread()).decode(errors="ignore")[:300]
                    raise RuntimeError(f"Local LLM error {r.status_code}: {body}")
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        delta = json.loads(data)["choices"][0].get("delta", {}).get("content") or ""
                    except Exception:
                        delta = ""
                    if delta:
                        full += delta
                        yield delta
        self.messages.append({"role": "assistant", "content": full})

    async def complete(self, text: str) -> str:
        out = ""
        async for d in self.stream(text):
            out += d
        return out


# ---------------------------------------------------------------- Workflow engine
TEMPLATE_RE = re.compile(r"\{\{\s*([\w\.]+)\s*\}\}")


def render(tpl: str, ctx: dict) -> str:
    def rep(m):
        key = m.group(1)
        return str(ctx.get(key, m.group(0)))
    return TEMPLATE_RE.sub(rep, tpl or "")


async def exec_step(step: Step, ctx: dict, settings: Settings) -> tuple[str, bool]:
    """Returns (output, continue_flag)."""
    c = step.config
    if step.type == "http":
        method = (c.get("method") or "GET").upper()
        url = render(c.get("url", ""), ctx)
        if not url.startswith("http"):
            raise RuntimeError("HTTP step needs a valid URL")
        headers = {}
        if c.get("headers"):
            try:
                headers = json.loads(render(c["headers"], ctx))
            except Exception:
                raise RuntimeError("Headers must be valid JSON")
        body = render(c.get("body", ""), ctx)
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as hc:
            kwargs: dict = {"headers": headers}
            if body and method != "GET":
                try:
                    kwargs["json"] = json.loads(body)
                except Exception:
                    kwargs["content"] = body
            r = await hc.request(method, url, **kwargs)
        text = r.text[:8000]
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code}: {text[:300]}")
        return text, True
    if step.type == "llm":
        prompt = render(c.get("prompt", "{{prev}}"), ctx)
        sess = LLMSession(settings, c.get("system") or "You are a concise automation assistant. Reply with the result only.")
        return (await sess.complete(prompt)).strip(), True
    if step.type == "delay":
        secs = max(0, min(int(c.get("seconds", 1) or 0), 60))
        await asyncio.sleep(secs)
        return ctx.get("prev", ""), True
    if step.type == "set":
        return render(c.get("value", ""), ctx), True
    if step.type == "filter":
        needle = render(c.get("contains", ""), ctx)
        ok = needle.lower() in str(ctx.get("prev", "")).lower()
        return (ctx.get("prev", "") if ok else f"Filter stopped: output does not contain '{needle}'"), ok
    raise RuntimeError(f"Unknown step type {step.type}")


async def run_workflow(wf: Workflow, trigger: str, input_text: str = "") -> Run:
    settings = await get_settings()
    run = Run(workflow_id=wf.id, workflow_name=wf.name, trigger=trigger, input=input_text)
    res = await db.runs.insert_one(run.to_mongo())
    run.id = str(res.inserted_id)
    ctx = {"input": input_text, "prev": input_text, "now": now_iso(), "workflow": wf.name}
    status = "success"
    for i, step in enumerate(wf.steps, start=1):
        t0 = time.time()
        try:
            out, cont = await exec_step(step, ctx, settings)
            run.logs.append(StepLog(step_id=step.id, name=step.name or step.type, type=step.type,
                                    status="success" if cont else "stopped", output=out[:8000],
                                    duration_ms=int((time.time() - t0) * 1000)))
            ctx["prev"] = out
            ctx[f"step_{i}"] = out
            if not cont:
                status = "stopped"
                break
        except Exception as e:
            run.logs.append(StepLog(step_id=step.id, name=step.name or step.type, type=step.type,
                                    status="failed", error=str(e)[:1000],
                                    duration_ms=int((time.time() - t0) * 1000)))
            status = "failed"
            break
    run.status = status
    run.output = str(ctx.get("prev", ""))[:8000]
    run.finished_at = now_iso()
    await db.runs.update_one({"_id": ObjectId(run.id)}, {"$set": run.to_mongo()})
    upd = {"last_run_at": run.finished_at, "last_status": status}
    if wf.trigger.type == "schedule" and wf.active:
        upd["next_run_at"] = (datetime.now(timezone.utc) + timedelta(minutes=max(1, wf.trigger.interval_minutes))).isoformat()
    await db.workflows.update_one({"_id": ObjectId(wf.id)}, {"$set": upd})
    return run


def compute_next(wf_in: WorkflowIn) -> Optional[str]:
    if wf_in.active and wf_in.trigger.type == "schedule":
        return (datetime.now(timezone.utc) + timedelta(minutes=max(1, wf_in.trigger.interval_minutes))).isoformat()
    return None


async def load_wf(wf_id: str) -> Workflow:
    if not ObjectId.is_valid(wf_id):
        raise HTTPException(404, "Workflow not found")
    doc = await db.workflows.find_one({"_id": ObjectId(wf_id)})
    if not doc:
        raise HTTPException(404, "Workflow not found")
    return Workflow.from_mongo(doc)


async def create_wf(data: WorkflowIn) -> Workflow:
    wf = Workflow(**data.model_dump(), next_run_at=compute_next(data))
    res = await db.workflows.insert_one(wf.to_mongo())
    wf.id = str(res.inserted_id)
    return wf


async def set_active(wf_id: str, active: bool) -> Workflow:
    wf = await load_wf(wf_id)
    wf.active = active
    nxt = compute_next(WorkflowIn(**wf.model_dump(include={"name", "description", "active", "trigger", "steps"})))
    await db.workflows.update_one({"_id": ObjectId(wf_id)}, {"$set": {"active": active, "next_run_at": nxt, "updated_at": now_iso()}})
    wf.next_run_at = nxt
    return wf


# ---------------------------------------------------------------- Workflow routes
@api_router.get("/")
async def root():
    return {"message": "Automata API"}


@api_router.get("/workflows")
async def list_workflows():
    docs = await db.workflows.find().sort("updated_at", -1).to_list(500)
    return [Workflow.from_mongo(d).out() for d in docs]


@api_router.post("/workflows")
async def create_workflow(data: WorkflowIn):
    return (await create_wf(data)).out()


@api_router.get("/workflows/{wf_id}")
async def get_workflow(wf_id: str):
    return (await load_wf(wf_id)).out()


@api_router.put("/workflows/{wf_id}")
async def update_workflow(wf_id: str, data: WorkflowIn):
    await load_wf(wf_id)
    upd = {**data.model_dump(), "updated_at": now_iso(), "next_run_at": compute_next(data)}
    await db.workflows.update_one({"_id": ObjectId(wf_id)}, {"$set": upd})
    return (await load_wf(wf_id)).out()


@api_router.delete("/workflows/{wf_id}")
async def delete_workflow(wf_id: str):
    await load_wf(wf_id)
    await db.workflows.delete_one({"_id": ObjectId(wf_id)})
    return {"ok": True}


@api_router.post("/workflows/{wf_id}/active")
async def toggle_workflow(wf_id: str, body: ActiveIn):
    return (await set_active(wf_id, body.active)).out()


@api_router.post("/workflows/{wf_id}/run")
async def run_workflow_route(wf_id: str, body: RunIn):
    wf = await load_wf(wf_id)
    return (await run_workflow(wf, "manual", body.input)).out()


@api_router.post("/hooks/{wf_id}")
async def webhook_trigger(wf_id: str, request: Request):
    wf = await load_wf(wf_id)
    if wf.trigger.type != "webhook" or not wf.active:
        raise HTTPException(400, "Workflow is not an active webhook workflow")
    raw = (await request.body()).decode(errors="ignore")
    return (await run_workflow(wf, "webhook", raw)).out()


@api_router.get("/runs")
async def list_runs(workflow_id: Optional[str] = None, limit: int = 50):
    q = {"workflow_id": workflow_id} if workflow_id else {}
    docs = await db.runs.find(q).sort("started_at", -1).to_list(min(limit, 200))
    return [Run.from_mongo(d).out() for d in docs]


@api_router.delete("/runs")
async def clear_runs():
    await db.runs.delete_many({})
    return {"ok": True}


# ---------------------------------------------------------------- External n8n
async def n8n_request(method: str, path: str):
    s = await get_settings()
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


@api_router.get("/n8n/workflows")
async def n8n_workflows():
    data = await n8n_request("GET", "/workflows?limit=100")
    items = data.get("data", data if isinstance(data, list) else [])
    return [{"id": str(w.get("id")), "name": w.get("name"), "active": bool(w.get("active")),
             "updated_at": w.get("updatedAt"), "nodes": len(w.get("nodes") or [])} for w in items]


@api_router.post("/n8n/workflows/{n8n_id}/active")
async def n8n_toggle(n8n_id: str, body: ActiveIn):
    await n8n_request("POST", f"/workflows/{n8n_id}/{'activate' if body.active else 'deactivate'}")
    return {"ok": True, "active": body.active}


# ---------------------------------------------------------------- Agent
AGENT_SYSTEM = """You are Automata, an automation agent inside a mobile app with a built-in n8n-style workflow engine.
You can chat normally, and you can manage workflows using TOOLS.

To call a tool, output EXACTLY one block per call in this format (no markdown fences):
<tool>{"name": "TOOL_NAME", "args": {...}}</tool>
After emitting tool blocks, STOP and wait. You will receive TOOL RESULTS, then continue and give the user a short final answer.
Never invent tool results. Do not call tools for plain questions.

TOOLS:
- list_workflows {} -> all workflows with ids
- create_workflow {"name", "description", "active": bool, "trigger": {"type": "manual"|"schedule"|"webhook", "interval_minutes": int}, "steps": [ {"type", "name", "config"} ]}
- run_workflow {"workflow_id", "input": str}
- set_workflow_active {"workflow_id", "active": bool}
- list_runs {"limit": int}
- n8n_list_workflows {} -> workflows on the user's external n8n instance (if configured)

STEP TYPES and config:
- http: {"method": "GET|POST|PUT|DELETE", "url": str, "headers": JSON string, "body": str}
- llm: {"prompt": str, "system": str}  (AI step: summarize, classify, extract...)
- delay: {"seconds": int <= 60}
- set: {"value": str}  (compose text)
- filter: {"contains": str}  (stop the workflow unless previous output contains the text)
Templates usable in any string: {{input}} (trigger input), {{prev}} (previous step output), {{step_1}}, {{step_2}}... and {{now}}.
For "every morning"/"daily" use schedule with interval_minutes 1440; "hourly" = 60. Schedules created by you should be active: true.
Use public, keyless APIs when the user gives no URL (e.g. https://hn.algolia.com/api/v1/search?tags=front_page, https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current_weather=true).
Keep replies short, clear and practical. No emoji."""

TOOL_RE = re.compile(r"<tool>(.*?)</tool>", re.S)


async def exec_tool(name: str, args: dict) -> Any:
    if name == "list_workflows":
        docs = await db.workflows.find().to_list(200)
        return [{"id": str(d["_id"]), "name": d["name"], "active": d.get("active"),
                 "trigger": d.get("trigger"), "steps": len(d.get("steps", []))} for d in docs]
    if name == "create_workflow":
        wf = await create_wf(WorkflowIn(**args))
        return {"id": wf.id, "name": wf.name, "active": wf.active, "steps": len(wf.steps), "trigger": wf.trigger.model_dump()}
    if name == "run_workflow":
        wf = await load_wf(str(args.get("workflow_id", "")))
        run = await run_workflow(wf, "agent", str(args.get("input", "")))
        return {"run_id": run.id, "status": run.status, "output": run.output[:2000],
                "errors": [l.error for l in run.logs if l.error]}
    if name == "set_workflow_active":
        wf = await set_active(str(args.get("workflow_id", "")), bool(args.get("active")))
        return {"id": wf.id, "active": wf.active, "next_run_at": wf.next_run_at}
    if name == "list_runs":
        docs = await db.runs.find().sort("started_at", -1).to_list(int(args.get("limit", 10)))
        return [{"workflow": d["workflow_name"], "status": d["status"], "at": d["started_at"],
                 "output": (d.get("output") or "")[:300]} for d in docs]
    if name == "n8n_list_workflows":
        return await n8n_workflows()
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
async def agent_messages():
    docs = await db.messages.find().sort("created_at", 1).to_list(500)
    return [ChatMessage.from_mongo(d).out() for d in docs]


@api_router.delete("/agent/messages")
async def clear_messages():
    await db.messages.delete_many({})
    return {"ok": True}


@api_router.post("/agent/chat")
async def agent_chat(body: ChatIn):
    settings = await get_settings()
    prior = await db.messages.find().sort("created_at", -1).to_list(20)
    history = [{"role": d["role"], "content": d["content"]} for d in reversed(prior) if d.get("content")]
    await db.messages.insert_one(ChatMessage(role="user", content=body.message).to_mongo())

    async def gen():
        visible = ""
        calls: List[ToolCall] = []
        try:
            session = LLMSession(settings, AGENT_SYSTEM, history)
            prompt = body.message
            for _ in range(4):
                raw = ""
                flt = ToolFilter()
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
                        tc.result = await exec_tool(tc.name, tc.args)
                        tc.status = "success"
                    except HTTPException as e:
                        tc.status, tc.result = "failed", str(e.detail)
                    except Exception as e:
                        tc.status, tc.result = "failed", str(e)[:500]
                    calls.append(tc)
                    yield sse({"type": "tool_result", "call": tc.model_dump()})
                    results.append({"tool": tc.name, "status": tc.status, "result": tc.result})
                if visible and not visible.endswith("\n"):
                    visible += "\n\n"
                    yield sse({"type": "delta", "text": "\n\n"})
                prompt = "TOOL RESULTS:\n" + json.dumps(results, default=str)[:6000] + "\nContinue. Give the user a brief final answer, or call more tools if truly needed."
        except Exception as e:
            logger.exception("agent error")
            msg = f"\n[Agent error] {str(e)[:300]}"
            visible += msg
            yield sse({"type": "error", "text": str(e)[:300]})
        saved = ChatMessage(role="assistant", content=visible.strip(), tool_calls=calls)
        res = await db.messages.insert_one(saved.to_mongo())
        saved.id = str(res.inserted_id)
        yield sse({"type": "done", "message": saved.out()})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@api_router.post("/llm/test")
async def llm_test():
    settings = await get_settings()
    try:
        out = await LLMSession(settings, "Reply with exactly: OK").complete("ping")
        return {"ok": True, "reply": out.strip()[:200]}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


# ---------------------------------------------------------------- Scheduler
async def scheduler_loop():
    while True:
        try:
            now = now_iso()
            docs = await db.workflows.find({"active": True, "trigger.type": "schedule",
                                            "next_run_at": {"$ne": None, "$lte": now}}).to_list(50)
            for d in docs:
                wf = Workflow.from_mongo(d)
                # bump next_run first to avoid double execution
                nxt = (datetime.now(timezone.utc) + timedelta(minutes=max(1, wf.trigger.interval_minutes))).isoformat()
                await db.workflows.update_one({"_id": d["_id"]}, {"$set": {"next_run_at": nxt}})
                asyncio.create_task(run_workflow(wf, "schedule"))
        except Exception:
            logger.exception("scheduler error")
        await asyncio.sleep(20)


@app.on_event("startup")
async def startup():
    asyncio.create_task(scheduler_loop())


app.include_router(api_router)
app.add_middleware(CORSMiddleware, allow_credentials=True, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
