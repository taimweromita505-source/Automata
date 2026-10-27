"""Encrypted per-device credentials vault (user-supplied keys).

The encryption key comes from CREDS_SECRET. If that is unset (the common case
for a fresh self-host), a key is generated once and stored next to the database
in CREDS_SECRET_FILE, so secrets stay encrypted across restarts without any
extra setup.
"""
import json
import logging
import os
import stat

from cryptography.fernet import Fernet

logger = logging.getLogger("vault")

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

_cached: bytes | None = None


def _secret_path() -> str:
    default = os.path.join(os.environ.get("DATA_DIR", "data"), ".creds_secret")
    return os.environ.get("CREDS_SECRET_FILE", default)


def _secret() -> bytes:
    """CREDS_SECRET if set, else a generated key persisted beside the database."""
    global _cached
    if _cached is not None:
        return _cached
    raw = os.environ.get("CREDS_SECRET", "").strip()
    if raw:
        _cached = raw.encode()
        return _cached
    path = _secret_path()
    if os.path.exists(path):
        with open(path, "rb") as fh:
            _cached = fh.read().strip()
        return _cached
    key = Fernet.generate_key()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(key)
    logger.warning("CREDS_SECRET is not set; generated one at %s. Back this file up with the "
                   "database — without it, saved credentials cannot be decrypted.", path)
    _cached = key
    return _cached


def _f() -> Fernet:
    return Fernet(_secret())


def encrypt(data: dict) -> str:
    return _f().encrypt(json.dumps(data).encode()).decode()


def decrypt(token: str) -> dict:
    return json.loads(_f().decrypt(token.encode()))


def mask(value: str) -> str:
    v = str(value)
    return "••••" + v[-4:] if len(v) > 8 else "••••"


async def load_creds(store, device: str) -> dict:
    out = {}
    for d in await store.find("credentials", device, limit=500, order_by="created_at"):
        try:
            out[d["name"]] = {"type": d["type"], "data": decrypt(d["data_enc"])}
        except Exception:
            continue
    return out
