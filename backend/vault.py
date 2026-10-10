"""Encrypted per-device credentials vault (user-supplied keys)."""
import json
import os

from cryptography.fernet import Fernet

CRED_TYPES = {
    "bearer": ["token"],
    "api_key": ["header", "value"],
    "basic": ["username", "password"],
    "telegram": ["bot_token", "chat_id"],
    "slack": ["webhook_url"],
    "discord": ["webhook_url"],
    "resend": ["api_key", "from"],
    "google": ["client_id", "client_secret", "refresh_token"],
    "custom": [],
}


def _f() -> Fernet:
    return Fernet(os.environ["CREDS_SECRET"].encode())


def encrypt(data: dict) -> str:
    return _f().encrypt(json.dumps(data).encode()).decode()


def decrypt(token: str) -> dict:
    return json.loads(_f().decrypt(token.encode()))


def mask(value: str) -> str:
    v = str(value)
    return "••••" + v[-4:] if len(v) > 8 else "••••"


async def load_creds(db, device: str) -> dict:
    out = {}
    async for d in db.credentials.find({"device_id": device}):
        try:
            out[d["name"]] = {"type": d["type"], "data": decrypt(d["data_enc"])}
        except Exception:
            continue
    return out
