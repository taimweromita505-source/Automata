"""Storage for Automata.

A small async document store on SQLite. Documents are JSON blobs in one table;
the handful of fields we actually query on (device, active, trigger, schedule,
delivery flag) are promoted to real columns and indexed. This replaces the
MongoDB dependency so the backend runs on a single file with no external
service to provision.

Nothing here is Mongo-specific: every call site passes a collection name and a
plain dict, and gets plain dicts back (including their "id").
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    collection   TEXT NOT NULL,
    id           TEXT NOT NULL,
    device_id    TEXT,
    created_at   TEXT,
    updated_at   TEXT,
    active       INTEGER NOT NULL DEFAULT 0,
    trigger_type TEXT,
    next_run_at  TEXT,
    delivered    INTEGER NOT NULL DEFAULT 1,
    data         TEXT NOT NULL,
    PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS ix_documents_device  ON documents(collection, device_id);
CREATE INDEX IF NOT EXISTS ix_documents_sort    ON documents(collection, device_id, updated_at);
CREATE INDEX IF NOT EXISTS ix_documents_sched   ON documents(collection, active, trigger_type, next_run_at);
CREATE INDEX IF NOT EXISTS ix_documents_pending ON documents(collection, device_id, delivered);
CREATE INDEX IF NOT EXISTS ix_documents_name    ON documents(collection, device_id, json_extract(data,'$.name'));

CREATE TABLE IF NOT EXISTS usage (
    device_id TEXT NOT NULL,
    day       TEXT NOT NULL,
    agent     INTEGER NOT NULL DEFAULT 0,
    llm       INTEGER NOT NULL DEFAULT 0,
    code      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, day)
);
"""

# Columns that callers are allowed to sort by, mapped to their SQL expression.
SORT_COLUMNS = {
    "updated_at": "updated_at",
    "created_at": "created_at",
    "started_at": "created_at",
    "next_run_at": "next_run_at",
}

# Fields lifted out of the JSON blob into real columns, per collection, so the
# scheduler and the pending-action delivery loop can query them directly.
PROMOTED = ("created_at", "updated_at", "active", "trigger_type", "next_run_at", "delivered")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex


class Store:
    """Thin async wrapper over one SQLite connection."""

    def __init__(self, path: str):
        self.path = path
        self._db: Optional[aiosqlite.Connection] = None

    # ------------------------------------------------------------ lifecycle
    async def connect(self) -> None:
        directory = os.path.dirname(os.path.abspath(self.path))
        if directory:
            os.makedirs(directory, exist_ok=True)
        self._db = await aiosqlite.connect(self.path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA journal_mode=WAL")
        await self._db.execute("PRAGMA synchronous=NORMAL")
        await self._db.executescript(SCHEMA)
        await self._db.commit()

    async def close(self) -> None:
        if self._db is not None:
            await self._db.close()
            self._db = None

    @property
    def db(self) -> aiosqlite.Connection:
        if self._db is None:
            raise RuntimeError("Store.connect() was not awaited")
        return self._db

    # ------------------------------------------------------------ helpers
    @staticmethod
    def _row_to_doc(row: aiosqlite.Row) -> dict:
        doc = json.loads(row["data"])
        doc["id"] = row["id"]
        return doc

    @staticmethod
    def _promoted(doc: dict) -> dict:
        trigger = doc.get("trigger") or {}
        return {
            "created_at": doc.get("created_at"),
            "updated_at": doc.get("updated_at") or doc.get("started_at") or doc.get("created_at"),
            "active": 1 if doc.get("active") else 0,
            "trigger_type": trigger.get("type") if isinstance(trigger, dict) else None,
            "next_run_at": doc.get("next_run_at"),
            "delivered": 0 if doc.get("device_delivered") is False else 1,
        }

    async def _write(self, collection: str, doc_id: str, device_id: Optional[str], doc: dict) -> None:
        cols = self._promoted(doc)
        await self.db.execute(
            """INSERT INTO documents (collection, id, device_id, created_at, updated_at, active,
                                      trigger_type, next_run_at, delivered, data)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(collection, id) DO UPDATE SET
                 device_id=excluded.device_id, created_at=excluded.created_at,
                 updated_at=excluded.updated_at, active=excluded.active,
                 trigger_type=excluded.trigger_type, next_run_at=excluded.next_run_at,
                 delivered=excluded.delivered, data=excluded.data""",
            (collection, doc_id, device_id, cols["created_at"], cols["updated_at"], cols["active"],
             cols["trigger_type"], cols["next_run_at"], cols["delivered"],
             json.dumps(doc, default=str)),
        )

    # ------------------------------------------------------------ writes
    async def insert(self, collection: str, doc: dict) -> dict:
        doc = dict(doc)
        doc_id = str(doc.get("id") or new_id())
        doc["id"] = doc_id
        await self._write(collection, doc_id, doc.get("device_id"), doc)
        await self.db.commit()
        return doc

    async def replace(self, collection: str, doc: dict) -> dict:
        """Full-document update; the document must already carry its id."""
        return await self.insert(collection, doc)

    async def update(self, collection: str, doc_id: str, patch: dict,
                     device_id: Optional[str] = None) -> Optional[dict]:
        current = await self.get(collection, doc_id, device_id)
        if current is None:
            return None
        merged = {**current, **patch, "id": doc_id}
        await self._write(collection, doc_id, merged.get("device_id") or device_id, merged)
        await self.db.commit()
        return merged

    async def delete(self, collection: str, doc_id: str, device_id: Optional[str] = None) -> bool:
        sql = "DELETE FROM documents WHERE collection=? AND id=?"
        args: list[Any] = [collection, doc_id]
        if device_id is not None:
            sql += " AND device_id=?"
            args.append(device_id)
        cur = await self.db.execute(sql, args)
        await self.db.commit()
        return cur.rowcount > 0

    async def delete_many(self, collection: str, device_id: str) -> int:
        cur = await self.db.execute(
            "DELETE FROM documents WHERE collection=? AND device_id=?", (collection, device_id))
        await self.db.commit()
        return cur.rowcount

    # ------------------------------------------------------------ reads
    async def get(self, collection: str, doc_id: str, device_id: Optional[str] = None) -> Optional[dict]:
        sql = "SELECT * FROM documents WHERE collection=? AND id=?"
        args: list[Any] = [collection, doc_id]
        if device_id is not None:
            sql += " AND device_id=?"
            args.append(device_id)
        async with self.db.execute(sql, args) as cur:
            row = await cur.fetchone()
        return self._row_to_doc(row) if row else None

    async def find_by_name(self, collection: str, device_id: str, name: str) -> Optional[dict]:
        async with self.db.execute(
                "SELECT * FROM documents WHERE collection=? AND device_id=? AND json_extract(data,'$.name')=?",
                (collection, device_id, name)) as cur:
            row = await cur.fetchone()
        return self._row_to_doc(row) if row else None

    async def find(self, collection: str, device_id: str, limit: int = 500,
                   order_by: str = "updated_at", desc: bool = True) -> list[dict]:
        col = SORT_COLUMNS.get(order_by, "updated_at")
        direction = "DESC" if desc else "ASC"
        async with self.db.execute(
            f"SELECT * FROM documents WHERE collection=? AND device_id=? ORDER BY {col} {direction} LIMIT ?",
            (collection, device_id, limit)) as cur:
            rows = await cur.fetchall()
        return [self._row_to_doc(r) for r in rows]

    async def find_older_than(self, collection: str, device_id: str, limit: int = 20,
                              order_by: str = "created_at") -> list[dict]:
        """Oldest first — used to build the agent's conversation history."""
        return await self.find(collection, device_id, limit=limit, order_by=order_by, desc=True)

    async def count(self, collection: str, device_id: str) -> int:
        async with self.db.execute(
                "SELECT COUNT(*) AS n FROM documents WHERE collection=? AND device_id=?",
                (collection, device_id)) as cur:
            row = await cur.fetchone()
        return int(row["n"]) if row else 0

    # ------------------------------------------------------------ scheduler / delivery
    async def due_scheduled(self, now: str, limit: int = 50) -> list[dict]:
        async with self.db.execute(
            """SELECT * FROM documents
               WHERE collection='workflows' AND active=1 AND trigger_type='schedule'
                 AND next_run_at IS NOT NULL AND next_run_at <= ?
               ORDER BY next_run_at ASC LIMIT ?""", (now, limit)) as cur:
            rows = await cur.fetchall()
        return [self._row_to_doc(r) for r in rows]

    async def take_pending_actions(self, device_id: str) -> list[dict]:
        """Phone actions from background runs, each handed out exactly once."""
        async with self.db.execute(
            """SELECT * FROM documents
               WHERE collection='runs' AND device_id=? AND delivered=0
               ORDER BY created_at ASC LIMIT 50""", (device_id,)) as cur:
            rows = await cur.fetchall()
        if not rows:
            return []
        docs = [self._row_to_doc(r) for r in rows]
        ids = [d["id"] for d in docs]
        await self.db.executemany(
            "UPDATE documents SET delivered=1, data=json_set(data,'$.device_delivered',1) WHERE collection='runs' AND id=?",
            [(i,) for i in ids])
        await self.db.commit()
        return [a for d in docs for a in (d.get("device_actions") or [])]

    # ------------------------------------------------------------ usage counters
    async def usage(self, device_id: str, day: str) -> dict:
        async with self.db.execute(
                "SELECT agent, llm, code FROM usage WHERE device_id=? AND day=?", (device_id, day)) as cur:
            row = await cur.fetchone()
        return {"agent": int(row["agent"]), "llm": int(row["llm"]), "code": int(row["code"])} if row \
            else {"agent": 0, "llm": 0, "code": 0}

    async def usage_inc(self, device_id: str, day: str, kind: str) -> int:
        """Atomically add one to today's counter and return the new value."""
        assert kind in ("agent", "llm", "code")
        await self.db.execute(
            "INSERT INTO usage (device_id, day, agent, llm, code) VALUES (?, ?, 0, 0, 0) "
            "ON CONFLICT(device_id, day) DO NOTHING", (device_id, day))
        await self.db.execute(f"UPDATE usage SET {kind} = {kind} + 1 WHERE device_id=? AND day=?",
                              (device_id, day))
        await self.db.commit()
        return (await self.usage(device_id, day))[kind]

    async def usage_dec(self, device_id: str, day: str, kind: str) -> None:
        await self.db.execute(f"UPDATE usage SET {kind} = MAX(0, {kind} - 1) WHERE device_id=? AND day=?",
                              (device_id, day))
        await self.db.commit()
