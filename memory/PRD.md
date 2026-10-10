# Automata — PRD

## Original problem statement
Build a mobile app with built-in n8n and an agent powered by local LLM or API providers for automation.

## User choices
- Built-in n8n-style workflow builder (run by backend) + optional external n8n instance connection
- LLM: Emergent Universal Key (OpenAI / Claude / Gemini) + local OpenAI-compatible endpoint (Ollama / LM Studio)
- Agent: chat + create/run workflows via tools
- No login, single user. Goal: publish to Play Store

## Architecture
- Expo Router (SDK 57) app with 4 tabs (Agent, Workflows, Runs, Settings) + /workflow/[id] editor. NativeTabs on iOS 26+, JS Tabs on other platforms
- FastAPI backend (server.py): workflow engine (http/llm/delay/set/filter steps, {{input}}/{{prev}}/{{step_N}}/{{now}} templates), scheduler loop running every 20s, webhook trigger /api/hooks/{id}, SSE agent with <tool> JSON tool-calling (up to 4 loops), n8n public API proxy
- MongoDB collections: workflows, runs, messages, settings
- Dark tactical design (Rajdhani / IBM Plex fonts, amber #FF6B00 accent, Phosphor icons)

## Implemented (2026-06)
- Iteration 3 (paid app): free download + Automata Pro subscription via Emergent-managed RevenueCat (monthly + yearly, `pro` entitlement). Coded paywall with restore, simulated Test Store purchase in preview, identity bound to device id. Client-side gates: 3 workflows and 10 agent messages/day on free; Pro unlocks schedules, place triggers, code/messaging/Google steps, credentials vault and local LLM. Details in /app/memory/revenuecat.md
- Iteration 2 ("automate anything"):
  - Every install gets its own device ID (X-Device-Id header), so each user has separate workflows, runs, chats, settings and credentials
  - Encrypted credentials vault (Fernet) where users add their own keys: Telegram, Slack, Discord, Resend, Google OAuth (client + refresh token), Bearer, API-key header, Basic, Custom
  - New steps: Python code (sandboxed subprocess with limits), web scraper, web search (Bing HTML), If/Else (stop or skip), Loop, Telegram, Slack, Discord, Email, Google Sheets/Gmail/Drive/Calendar, Phone action (notify/clipboard/open_url/share/vibrate); {{cred.NAME.field}} templates; HTTP steps can use a saved credential
  - Agent acts directly: web_search, fetch_url, http_request, run_code, run_step, list_credentials, update_workflow; phone actions are streamed to the device
  - Phone triggers: place-based geofence (expo-location + task-manager), deep link automata://run/<id>?input=, run with clipboard; phone actions queued by background runs are delivered when the app opens
  - Permission sheets with Open Settings fallback; app.json updated with location/notification permissions and the automata scheme
  - Tested: backend 32/32, frontend passed
- Workflow builder with vertical node chain, reorder, step config sheets, run results with console logs
- Manual, schedule and webhook triggers; active toggles; run history
- AI agent chat with streaming replies and task cards, persisted history, suggestions
- Settings: Cloud/Local LLM, provider and model chips, connection test, n8n URL and API key
- External n8n: list and activate/deactivate workflows
- Tested: backend 21/21, frontend flows passed

## Backlog
- P1: Credentials vault for HTTP steps; workflow templates gallery; edit workflows through the agent
- P1: Running local LLM directly on the phone over LAN (today the backend calls the endpoint, so it must be publicly reachable)
- P2: Run external n8n workflows via webhook; branching/conditional paths; export/import workflow JSON
- P2: Login/auth before public release (the API is open today)
