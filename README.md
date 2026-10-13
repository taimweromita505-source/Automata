# Automata: AI workflow automation in your pocket

Build and run automations from your phone. Trigger them manually, by webhook, on a schedule or when you arrive at or leave a place, or just ask the built-in AI agent to do the task for you.

**Steps available:** HTTP request · web scrape · web search · sandboxed Python code · LLM prompt · if/else · loop · filter · delay · Telegram · Slack · Discord · email (Resend) · Google Sheets / Gmail / Drive / Calendar · phone actions (notify, copy, open link, share, vibrate) · n8n workflow control

**Also:** AI agent chat that can create and run your workflows · run history with step logs · encrypted bring-your-own-key credentials vault · Automata Pro subscription (RevenueCat)

## Free vs Pro

| | Free | Pro |
|---|---|---|
| Workflows | 3 | Unlimited |
| Agent messages | 10 per day | Unlimited (within the daily cost cap) |
| Steps | Core, logic, web, phone | + Code, Telegram, Slack, Discord, Email, Google |
| Triggers | Manual, webhook | + Schedule, location |
| Credentials vault, local LLM | No | Yes |

The limits are **enforced on the server**, not only in the app:

- `backend/billing.py` asks RevenueCat (`GET /v1/subscribers/{device_id}`, secret key in `REVENUECAT_SECRET_KEY`) whether the install has an active `pro` entitlement. Answers are cached for 5 minutes. If the key is missing or RevenueCat cannot be reached, the device is treated as Free (fail closed).
- Pro-only features are rejected with **HTTP 402** in workflow create/update/activate/run, webhook runs, scheduled runs (skipped and marked `needs_pro`), credential creation, the local-LLM setting and the agent's tools. The app opens the paywall on any 402.
- Agent messages are counted per device per day in MongoDB (`usage` collection).
- **Cost protection:** every device, Pro included, has a daily cap on server-paid LLM calls (`DAILY_LLM_CAP`) and code executions (`DAILY_CODE_CAP`). Going over returns HTTP 429.
- `GET /api/plan` shows the plan, today's usage and the limits for the calling device.

The app identifies each install with a random device ID (`X-Device-Id` header), which is also the RevenueCat app user ID. There are no accounts yet.

## Stack

- Frontend: Expo / React Native (TypeScript, expo-router), RevenueCat SDK. App ID `com.taimwe.automata`.
- Backend: FastAPI, MongoDB (motor), httpx. LLM calls go through `emergentintegrations` (Emergent universal key) or a local OpenAI-compatible endpoint.
- Tests: pytest (`backend/tests`)

## Run locally

```bash
# backend
cd backend
pip install -r requirements.txt   # emergentintegrations: --extra-index-url https://d33sy5i8bnduwe.cloudfront.net/simple/
cp .env.example .env              # fill in MONGO_URL, DB_NAME, CREDS_SECRET, EMERGENT_LLM_KEY, REVENUECAT_SECRET_KEY
uvicorn server:app --reload --port 8001

# app
cd frontend
cp .env.example .env              # EXPO_PUBLIC_BACKEND_URL and the public RevenueCat SDK keys
yarn && yarn start
```

All backend settings are listed in [`backend/.env.example`](backend/.env.example).

## Tests

```bash
cd backend
pytest tests/test_gating.py      # plan enforcement; in-process, mocked RevenueCat + mongomock, no services needed
pytest                           # also runs the end-to-end suite against a backend on localhost:8001 (skipped if none)
```

The end-to-end suite exercises Pro features, so run that backend with a RevenueCat key (or mock) that grants Pro. Its LLM tests need `EMERGENT_LLM_KEY`.

## Screenshots

(add 3 phone screenshots)

---

Built by Taimwe. Available for freelance AI and automation work: taimweromita505@gmail.com
