# RevenueCat — integrated (2026-06)
This file is supposed to serve as a memory to you if you have to interact with user's RevenueCat account via integration proxy at any later point in time.

## Identifiers (from /setup response — copy verbatim)
- rc_project_id: projcdbbe8c5
- apple_app_id: app23ffbcf738
- play_app_id: app2787ef8377
- entitlement_lookup_key: pro
- offering_lookup_key: default
- Packages (package -> product_id, current price):
  - $rc_monthly -> prod03b3eb2791   ($4.99 / P1M, trial: none)
  - $rc_annual  -> prod6ae66136d0   ($39.99 / P1Y, trial: P1W 7-day free trial)
- Dashboard: https://app.revenuecat.com/projects/projcdbbe8c5
- App user id: per-install device id from src/api.ts getDeviceId() (no auth in app), bound with Purchases.logIn in src/revenuecat.tsx
- Gating is enforced on the server (backend/billing.py: RevenueCat REST v1 subscriber check with REVENUECAT_SECRET_KEY, 5-min cache, fail closed) and mirrored in the app (src/revenuecat.tsx: FREE_WORKFLOW_LIMIT=3, FREE_AGENT_DAILY=10, PRO_STEPS; schedule & place triggers, credentials vault, local LLM are Pro). Server answers 402 -> app opens /paywall.
- App ID (bundle id / package): com.taimwe.automata. The RevenueCat Apple and Play apps must use this same ID.

## Check for project_state in revenuecat status api response. if the project_state is less then project_created, re-fetch RevenueCat playbook via the integration expert tool.
Status check:
`curl -sS -H "$AUTH" "$INTEGRATION_PROXY_URL/internal/revenuecat/projects/be3bb311-aaff-4bb9-ae20-12b22e198eb7/status"`

## Later updates to user's products (integration proxy apis ONLY — NEVER call the RevenueCat REST API)
- Change price/duration/trial OR add a package (upsert):
  POST $INTEGRATION_PROXY_URL/internal/revenuecat/projects/be3bb311-aaff-4bb9-ae20-12b22e198eb7/products
  body: {"products":[{"package":"$rc_monthly","price":14.99,"currency":"USD","period":"P1M","trial":"P1W","prices":[{"amount_micros":14990000,"currency":"USD"}]}]}
- Remove a package: DELETE .../products/%24rc_monthly
- Recover identifiers / repopulate .env: re-run the idempotent /setup call.

## Taking in-app purchases LIVE — store-side steps (USER does these)
- Upload Google Play service-account JSON in RevenueCat dashboard (https://www.revenuecat.com/docs/service-credentials/creating-play-service-credentials); iOS: In-app purchase key + App Store Connect API key
- Set up payments profile in Play Console (https://support.google.com/googleplay/android-developer/answer/7161426)
- Create matching subscription products in Play Console with the SAME product IDs shown in RevenueCat (base plans monthly / annual)
- Release build → internal testing → submit for review
All steps are in the FAQ section of the payments panel.
