# Automata app (Expo)

The mobile app for Automata. See the [main README](../README.md) for the overview, the Free/Pro limits and how to run the backend.

```bash
cp .env.example .env   # EXPO_PUBLIC_BACKEND_URL + public RevenueCat SDK keys
yarn
yarn start             # Expo dev server (press a / i / w)
```

- Routes live in `app/` (expo-router); shared code in `src/`.
- `src/api.ts` talks to the backend and opens the paywall whenever the server answers 402.
- `src/revenuecat.tsx` holds the subscription state and the free-tier limits shown in the UI (the server enforces the same limits).
- App ID: `com.taimwe.automata` (Android package and iOS bundle identifier).
