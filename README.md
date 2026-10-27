# Automata: AI workflow automation in your pocket

Build and run automations from your phone. Trigger them manually, by webhook, on a schedule or when you arrive at or leave a place, or just ask the built-in AI agent to do the task for you.

**Steps available:** HTTP request · web scrape · web search · sandboxed Python code · LLM prompt · if/else · loop · filter · delay · Telegram · Slack · Discord · email (Resend) · Google Sheets / Gmail / Drive / Calendar · phone actions (notify, copy, open link, share, vibrate) · n8n workflow control

**Also:** AI agent chat that can create and run your workflows · run history with step logs · encrypted bring-your-own-key credentials vault

## Run it

Two commands, no accounts and no external services:

```bash
cd backend
pip install -r requirements.txt
uvicorn server:app --reload --port 8001
```

The backend creates `backend/data/automata.db` (SQLite) and a vault key on first boot. Every endpoint works immediately except the AI ones, which need one API key:

```bash
export OPENAI_API_KEY=sk-...        # or ANTHROPIC_API_KEY, or GEMINI_API_KEY
```

Then the app:

```bash
cd frontend
cp .env.example .env        # EXPO_PUBLIC_BACKEND_URL=http://<your-lan-ip>:8001
yarn && yarn start
```

On a phone, `localhost` means the phone: use your machine's LAN IP instead
(`EXPO_PUBLIC_BACKEND_URL=http://192.168.1.20:8001`).

Docker instead: `docker compose up -d --build`.

Or run the prebuilt image — CI publishes one on every push to `main`:

```bash
docker run -d --name automata -p 8001:8001 \
  -v automata-data:/data \
  -e OPENAI_API_KEY=sk-... \
  ghcr.io/taimweromita505-source/automata-api:latest
```

## Stack

- **Frontend:** Expo / React Native (TypeScript, expo-router). App ID `com.taimwe.automata`.
- **Backend:** FastAPI, SQLite via `aiosqlite`, httpx. No ORM, no message queue, no vendor SDKs.
- **Storage:** one file, `backend/data/automata.db`. Collections are JSON documents with the queried fields promoted to indexed columns; `db.py` is ~250 lines and is the only thing that knows about SQL.
- **AI:** any OpenAI-compatible endpoint, plus native Anthropic and Gemini support. Keys live in the backend environment; users can also point `provider: "local"` at their own Ollama / LM Studio server.
- **Tests:** pytest, in-process, no services needed.

## Configuration

Everything is optional — see [`backend/.env.example`](backend/.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | — | Server-paid AI calls. `LLM_API_KEY` works as a fallback for all three. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Point at Azure, OpenRouter, a proxy… |
| `LLM_MODEL` | per provider | Default when the app has not chosen one. |
| `DB_PATH` / `DATA_DIR` | `./data` | Where the database and generated vault key live. |
| `CREDS_SECRET` | generated | Fernet key for the credentials vault. |
| `BILLING_MODE` | `open` | `open` unlocks everything; `revenuecat` sells Pro. |
| `DAILY_LLM_CAP` / `DAILY_CODE_CAP` | 300 / 200 | Per-device daily caps. These protect *your* API budget, so they apply even in `open` mode. |
| `CORS_ORIGINS` | `*` | Comma-separated allowlist for the web build. |

## Plans and limits

`BILLING_MODE=open` (the default) treats every device as Pro: no paywall, no RevenueCat account, all steps and triggers available. The daily cost caps still apply.

`BILLING_MODE=revenuecat` is the paid-app mode. `billing.py` asks RevenueCat (`GET /v1/subscribers/{device_id}`, secret key in `REVENUECAT_SECRET_KEY`) whether the install has an active `pro` entitlement, caching the answer for 5 minutes and **failing closed** — no key, or RevenueCat unreachable, means Free.

In that mode:

| | Free | Pro |
|---|---|---|
| Workflows | 3 | Unlimited |
| Agent messages | 10 per day | Unlimited (within the daily cap) |
| Steps | Core, logic, web, phone | + Code, Telegram, Slack, Discord, Email, Google |
| Triggers | Manual, webhook | + Schedule, location |
| Credentials vault, local LLM | No | Yes |

Limits are enforced server-side: Pro-only features return **HTTP 402** and the app opens the paywall. `GET /api/plan` reports the plan, today's usage and the limits for the calling device, and the app uses it as the source of truth so a self-hosted server shows Pro correctly.

Each install identifies itself with a random device ID (`X-Device-Id` header). There are no accounts yet.

## API surface

`/api` — `workflows` (CRUD, `:id/run`, `:id/active`), `hooks/{id}` (webhook trigger), `runs`, `device/pending`, `credentials`, `settings`, `agent/messages`, `agent/chat` (SSE), `llm/test`, `plan`, `n8n/workflows`. Interactive docs at `/docs`.

## Deploy

Everything runs from one container. On any VM, NUC, Raspberry Pi or spare laptop:

```bash
git clone https://github.com/taimweromita505-source/Automata.git
cd Automata
cp backend/.env.example backend/.env     # add OPENAI_API_KEY
docker compose up -d --build
```

That exposes port `8001` and keeps the database in the `automata-data` volume,
so `docker compose down && docker compose up -d` keeps your workflows.

Prefer the image CI built instead of building locally:

```bash
docker run -d --name automata --restart unless-stopped -p 8001:8001 \
  -v automata-data:/data -e OPENAI_API_KEY=sk-... \
  ghcr.io/taimweromita505-source/automata-api:latest
```

Updating: `git pull && docker compose up -d --build`, or the image equivalent
`docker pull ghcr.io/... && docker rm -f automata` then run again.

**HTTPS** is optional. If you point a domain at the box and want TLS, put
[Caddy](https://caddyserver.com) in front — two lines and it handles
certificates:

```
api.example.com {
    reverse_proxy 127.0.0.1:8001
}
```

Then `EXPO_PUBLIC_BACKEND_URL=https://api.example.com`.

**CI:** `.github/workflows/ci.yml` runs the tests, then builds a multi-arch
(`amd64` + `arm64`) image and pushes it to GHCR on every push to `main` and on
`v*` tags.

## Tests

```bash
cd backend
pytest tests/test_gating.py     # plan enforcement, limits and caps: in-process, mocked RevenueCat, no services
```

The end-to-end suite in `tests/backend_test.py` runs against a backend on `localhost:8001` and is skipped when nothing is listening.

## Notes

- The Python code step runs in a subprocess that is **not** a security sandbox (CPU, memory and file-size rlimits only). Keep `DAILY_CODE_CAP` sane and do not expose the API to untrusted users without hardening it.
- The API is currently unauthenticated apart from the device ID header. Add auth before any public multi-user release.

---

Built by Taimwe. Available for freelance AI and automation work: taimweromita505@gmail.com
