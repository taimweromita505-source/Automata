"""Outbound connectors: web scraping/search, sandboxed code, messaging, Google APIs.
All credentials are supplied by the end user (bring-your-own) via the vault."""
import asyncio
import base64
import json
import re
import resource
import sys
import tempfile
import time
from email.mime.text import MIMEText
from urllib.parse import quote

import httpx
from bs4 import BeautifulSoup

UA = {"User-Agent": "Mozilla/5.0 (compatible; AutomataBot/1.0)"}
TIMEOUT = httpx.Timeout(20.0, connect=8.0)


def _err(provider: str, r: httpx.Response) -> RuntimeError:
    try:
        body = r.json()
        msg = body.get("description") or body.get("message") or body.get("error") or str(body)[:200]
        if isinstance(msg, dict):
            msg = msg.get("message") or str(msg)[:200]
    except Exception:
        msg = r.text[:200]
    return RuntimeError(f"{provider} error {r.status_code}: {msg}")


# ---------------------------------------------------------------- Web
async def scrape(url: str, selector: str = "") -> str:
    if not url.startswith("http"):
        raise RuntimeError("Scrape needs a valid URL")
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True, headers=UA) as hc:
        r = await hc.get(url)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code} fetching page")
    soup = BeautifulSoup(r.text, "html.parser")
    for t in soup(["script", "style", "noscript", "svg"]):
        t.decompose()
    if selector:
        els = soup.select(selector)
        if not els:
            raise RuntimeError(f"No elements match selector '{selector}'")
        text = "\n".join(e.get_text(" ", strip=True) for e in els[:100])
    else:
        title = soup.title.get_text(strip=True) if soup.title else ""
        text = soup.get_text("\n", strip=True)
        text = f"{title}\n\n{text}" if title else text
    return re.sub(r"\n{3,}", "\n\n", text)[:8000]


async def web_search(query: str, limit: int = 8) -> list:
    """Bing HTML results (no API key needed)."""
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
               "Accept-Language": "en-US,en;q=0.9"}
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True, headers=headers) as hc:
        r = await hc.get("https://www.bing.com/search", params={"q": query})
    soup = BeautifulSoup(r.text, "html.parser")
    out = []
    for li in soup.select("li.b_algo"):
        a = li.select_one("h2 a")
        if not a:
            continue
        href = a.get("href", "")
        m = re.search(r"[?&]u=a1([^&]+)", href)
        if m:
            try:
                enc = m.group(1)
                href = base64.urlsafe_b64decode(enc + "=" * (-len(enc) % 4)).decode()
            except Exception:
                pass
        sn = li.select_one(".b_caption p") or li.select_one("p")
        out.append({"title": a.get_text(" ", strip=True), "url": href, "snippet": sn.get_text(" ", strip=True) if sn else ""})
        if len(out) >= limit:
            break
    if not out:
        raise RuntimeError("No search results found")
    return out


# ---------------------------------------------------------------- Code
CODE_WRAPPER = r'''
import json, sys
_ctx = json.loads(sys.stdin.read())
input = _ctx["input"]; prev = _ctx["prev"]; steps = _ctx["steps"]
try:
    data = json.loads(prev)
except Exception:
    data = None
result = None
exec(compile(_ctx["code"], "<code-step>", "exec"))
if result is not None:
    sys.stdout.write("\n__RESULT__" + (result if isinstance(result, str) else json.dumps(result, default=str)))
'''


def _limits():
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (10 * 1024 * 1024, 10 * 1024 * 1024))


async def run_code(code: str, input_text: str, prev: str, steps: list) -> str:
    if not code.strip():
        raise RuntimeError("Code step is empty")
    payload = json.dumps({"code": code, "input": input_text, "prev": prev, "steps": steps}).encode()
    with tempfile.TemporaryDirectory() as tmp:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-I", "-c", CODE_WRAPPER,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            cwd=tmp, env={"PATH": "/usr/bin:/bin", "HOME": tmp}, preexec_fn=_limits)
        try:
            out, err = await asyncio.wait_for(proc.communicate(payload), timeout=20)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("Code timed out after 20s")
    stdout = out.decode(errors="ignore")
    if proc.returncode != 0:
        lines = [l for l in err.decode(errors="ignore").strip().splitlines() if l.strip()]
        raise RuntimeError("Code error: " + (lines[-1] if lines else f"exit {proc.returncode}"))
    if "\n__RESULT__" in stdout:
        printed, result = stdout.split("\n__RESULT__", 1)
        return result[:8000]
    return stdout.strip()[:8000]


# ---------------------------------------------------------------- Messaging
async def telegram(bot_token: str, chat_id: str, text: str) -> str:
    if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", bot_token or ""):
        raise RuntimeError("Invalid Telegram bot token format")
    if not chat_id:
        raise RuntimeError("Telegram chat_id missing")
    async with httpx.AsyncClient(timeout=TIMEOUT) as hc:
        r = await hc.post(f"https://api.telegram.org/bot{bot_token}/sendMessage",
                          json={"chat_id": chat_id, "text": text[:4096]})
    data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.is_error or data.get("ok") is not True:
        raise _err("Telegram", r)
    return f"Telegram message sent (id {data['result'].get('message_id')})"


async def slack(webhook_url: str, text: str) -> str:
    if not (webhook_url or "").startswith("https://hooks.slack.com/"):
        raise RuntimeError("Invalid Slack webhook URL")
    async with httpx.AsyncClient(timeout=TIMEOUT) as hc:
        r = await hc.post(webhook_url, json={"text": text})
    if r.status_code != 200 or r.text.strip() != "ok":
        raise RuntimeError(f"Slack error {r.status_code}: {r.text[:200]}")
    return "Slack message sent"


async def discord(webhook_url: str, text: str) -> str:
    if not re.match(r"https://(discord|discordapp)\.com/api/webhooks/", webhook_url or ""):
        raise RuntimeError("Invalid Discord webhook URL")
    url = webhook_url + ("&" if "?" in webhook_url else "?") + "wait=true"
    async with httpx.AsyncClient(timeout=TIMEOUT) as hc:
        r = await hc.post(url, json={"content": text[:2000], "allowed_mentions": {"parse": []}})
    if r.status_code not in (200, 204):
        raise _err("Discord", r)
    return "Discord message sent"


async def resend_email(api_key: str, sender: str, to: list, subject: str, text: str) -> str:
    if not api_key or not sender or not to or not subject:
        raise RuntimeError("Email needs API key, from, to and subject")
    async with httpx.AsyncClient(timeout=TIMEOUT) as hc:
        r = await hc.post("https://api.resend.com/emails", headers={"Authorization": f"Bearer {api_key}"},
                          json={"from": sender, "to": to, "subject": subject, "text": text})
    if r.is_error:
        raise _err("Resend", r)
    return f"Email sent (id {r.json().get('id')})"


# ---------------------------------------------------------------- Google (user OAuth client + refresh token)
_token_cache: dict = {}


async def google_token(cred: dict) -> str:
    rt = cred.get("refresh_token", "")
    cached = _token_cache.get(rt)
    if cached and cached[1] > time.time() + 60:
        return cached[0]
    if not (cred.get("client_id") and cred.get("client_secret") and rt):
        raise RuntimeError("Google credential needs client_id, client_secret and refresh_token")
    async with httpx.AsyncClient(timeout=TIMEOUT) as hc:
        r = await hc.post("https://oauth2.googleapis.com/token", data={
            "client_id": cred["client_id"], "client_secret": cred["client_secret"],
            "refresh_token": rt, "grant_type": "refresh_token"})
    if r.is_error:
        raise _err("Google OAuth", r)
    data = r.json()
    _token_cache[rt] = (data["access_token"], time.time() + int(data.get("expires_in", 3600)))
    return data["access_token"]


async def _g(cred: dict, method: str, url: str, **kw) -> dict:
    token = await google_token(cred)
    async with httpx.AsyncClient(timeout=TIMEOUT) as hc:
        r = await hc.request(method, url, headers={"Authorization": f"Bearer {token}"}, **kw)
    if r.is_error:
        raise _err("Google", r)
    return r.json() if r.text else {}


async def sheets_read(cred, sid, rng) -> list:
    data = await _g(cred, "GET", f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/{quote(rng)}")
    return data.get("values", [])


async def sheets_append(cred, sid, rng, rows: list) -> str:
    data = await _g(cred, "POST",
                    f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/{quote(rng)}:append",
                    params={"valueInputOption": "USER_ENTERED"}, json={"values": rows})
    return f"Appended {data.get('updates', {}).get('updatedRows', len(rows))} row(s)"


async def gmail_send(cred, to: str, subject: str, text: str) -> str:
    msg = MIMEText(text)
    msg["to"], msg["subject"] = to, subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    data = await _g(cred, "POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", json={"raw": raw})
    return f"Gmail sent (id {data.get('id')})"


async def drive_list(cred, query: str = "") -> list:
    params = {"pageSize": 20, "fields": "files(id,name,mimeType,modifiedTime,webViewLink)", "orderBy": "modifiedTime desc"}
    if query:
        params["q"] = query if ("contains" in query or "=" in query) else f"name contains '{query}'"
    data = await _g(cred, "GET", "https://www.googleapis.com/drive/v3/files", params=params)
    return data.get("files", [])


async def calendar_list(cred, cal: str = "primary") -> list:
    from datetime import datetime, timezone
    data = await _g(cred, "GET", f"https://www.googleapis.com/calendar/v3/calendars/{quote(cal)}/events",
                    params={"timeMin": datetime.now(timezone.utc).isoformat(), "singleEvents": "true",
                            "orderBy": "startTime", "maxResults": 15})
    return [{"summary": e.get("summary"), "start": e.get("start"), "end": e.get("end"), "link": e.get("htmlLink")}
            for e in data.get("items", [])]


async def calendar_create(cred, cal: str, summary: str, start: str, end: str) -> str:
    data = await _g(cred, "POST", f"https://www.googleapis.com/calendar/v3/calendars/{quote(cal)}/events",
                    json={"summary": summary, "start": {"dateTime": start}, "end": {"dateTime": end}})
    return f"Event created: {data.get('htmlLink')}"
