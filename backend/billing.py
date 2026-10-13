"""Server-side plan enforcement: RevenueCat 'pro' entitlement check, free-tier limits, daily cost caps.

The app's paywall is only a convenience; this module is what actually protects paid features and
the server's LLM / code-execution budget. Every limit here mirrors frontend/src/revenuecat.tsx.
"""
import logging
import os
import time
from datetime import datetime, timezone
from typing import Iterable, Optional
from urllib.parse import quote

import httpx
from fastapi import HTTPException
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

logger = logging.getLogger("billing")

ENTITLEMENT = "pro"
PRO_STEPS = {"code", "telegram", "slack", "discord", "email", "sheets", "gmail", "drive", "calendar"}
PRO_TRIGGERS = {"schedule", "location"}


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def free_workflow_limit() -> int:
    return _int_env("FREE_WORKFLOW_LIMIT", 3)


def free_agent_daily() -> int:
    return _int_env("FREE_AGENT_DAILY", 10)


def daily_llm_cap() -> int:
    """Hard cap on server-paid LLM calls per device per day, for every plan (cost protection)."""
    return _int_env("DAILY_LLM_CAP", 300)


def daily_code_cap() -> int:
    """Hard cap on Python code executions per device per day, for every plan (cost protection)."""
    return _int_env("DAILY_CODE_CAP", 200)


def cache_seconds() -> int:
    return _int_env("PRO_CACHE_SECONDS", 300)


class ProRequired(HTTPException):
    """HTTP 402: the feature needs Automata Pro. The app opens the paywall on this status."""

    def __init__(self, feature: str):
        super().__init__(402, f"{feature} requires Automata Pro. Upgrade in the app to unlock it.")
        self.feature = feature


class DailyCapReached(HTTPException):
    def __init__(self, what: str, cap: int):
        super().__init__(429, f"Daily limit reached: {cap} {what} per day. It resets at midnight UTC.")


# ---------------------------------------------------------------- RevenueCat
_cache: dict = {}  # device_id -> (expires_at_monotonic, is_pro)
_warned_missing_key = False


def clear_cache() -> None:
    _cache.clear()


def _parse_date(v: Optional[str]) -> Optional[datetime]:
    if not v:
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def entitlement_active(subscriber: dict, now: Optional[datetime] = None) -> bool:
    ent = (subscriber.get("entitlements") or {}).get(ENTITLEMENT)
    if not ent:
        return False
    now = now or datetime.now(timezone.utc)
    expires = _parse_date(ent.get("expires_date"))
    grace = _parse_date(ent.get("grace_period_expires_date"))
    if ent.get("expires_date") is None:
        return True  # lifetime / non-expiring
    return (expires is not None and expires > now) or (grace is not None and grace > now)


async def is_pro(device_id: str) -> bool:
    """True when this install's RevenueCat app user id has an active 'pro' entitlement.

    Fails closed: without REVENUECAT_SECRET_KEY, or when RevenueCat cannot be reached, the device is free.
    Results are cached for PRO_CACHE_SECONDS (default 5 minutes); errors only for 30 seconds.
    """
    global _warned_missing_key
    key = os.environ.get("REVENUECAT_SECRET_KEY", "").strip()
    if not key:
        if not _warned_missing_key:
            logger.warning("REVENUECAT_SECRET_KEY is not set: every device is treated as Free (Pro features are blocked).")
            _warned_missing_key = True
        return False
    hit = _cache.get(device_id)
    now = time.monotonic()
    if hit and hit[0] > now:
        return hit[1]
    base = os.environ.get("REVENUECAT_API_BASE", "https://api.revenuecat.com").rstrip("/")
    ttl = cache_seconds()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=4.0)) as hc:
            r = await hc.get(f"{base}/v1/subscribers/{quote(device_id, safe='')}",
                             headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
        if r.status_code == 404:
            result = False
        elif r.status_code >= 400:
            logger.warning("RevenueCat lookup failed (%s) for %s: treating as Free", r.status_code, device_id[:12])
            result, ttl = False, 30
        else:
            result = entitlement_active((r.json() or {}).get("subscriber") or {})
    except Exception as e:  # network error, bad JSON
        logger.warning("RevenueCat lookup error for %s: %s (treating as Free)", device_id[:12], e)
        result, ttl = False, 30
    _cache[device_id] = (now + ttl, result)
    return result


# ---------------------------------------------------------------- Feature gating
def step_uses_credentials(step_type: str, config: dict) -> bool:
    if (config or {}).get("credential"):
        return True
    return any(isinstance(v, str) and "{{" in v and "cred." in v for v in (config or {}).values())


def check_step(step_type: str, config: dict, pro: bool) -> None:
    if pro:
        return
    if step_type in PRO_STEPS:
        raise ProRequired(f"The '{step_type}' step")
    if step_uses_credentials(step_type, config):
        raise ProRequired("The credentials vault")


def check_workflow(trigger_type: str, steps: Iterable, pro: bool) -> None:
    """steps: iterable of objects with .type/.config or dicts with 'type'/'config'."""
    if pro:
        return
    if trigger_type in PRO_TRIGGERS:
        raise ProRequired("Schedule triggers" if trigger_type == "schedule" else "Location triggers")
    for s in steps:
        t = s.get("type") if isinstance(s, dict) else s.type
        c = s.get("config", {}) if isinstance(s, dict) else s.config
        check_step(t, c or {}, pro)


def check_local_llm(provider: str, pro: bool) -> None:
    if provider == "local" and not pro:
        raise ProRequired("Local LLM")


# ---------------------------------------------------------------- Daily counters (MongoDB)
def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


async def get_usage(db, device_id: str) -> dict:
    doc = await db.usage.find_one({"device_id": device_id, "day": today()}, {"_id": 0})
    return {"agent": 0, "llm": 0, "code": 0, **(doc or {})}


async def consume(db, device_id: str, kind: str, limit: int, error: HTTPException) -> int:
    """Atomically add one to today's counter; if that exceeds `limit`, roll back and raise `error`."""
    q = {"device_id": device_id, "day": today()}
    try:
        doc = await db.usage.find_one_and_update(q, {"$inc": {kind: 1}}, upsert=True, return_document=ReturnDocument.AFTER)
    except DuplicateKeyError:  # two first-of-the-day upserts raced; the document exists now
        doc = await db.usage.find_one_and_update(q, {"$inc": {kind: 1}}, return_document=ReturnDocument.AFTER)
    n = int((doc or {}).get(kind, 0))
    if n > limit:
        await db.usage.update_one(q, {"$inc": {kind: -1}})
        raise error
    return n


async def consume_agent_message(db, device_id: str, pro: bool) -> None:
    if pro:
        return
    limit = free_agent_daily()
    await consume(db, device_id, "agent", limit,
                  ProRequired(f"More than {limit} agent messages a day"))


async def consume_llm(db, device_id: str) -> None:
    cap = daily_llm_cap()
    await consume(db, device_id, "llm", cap, DailyCapReached("AI calls", cap))


async def consume_code(db, device_id: str) -> None:
    cap = daily_code_cap()
    await consume(db, device_id, "code", cap, DailyCapReached("code runs", cap))
