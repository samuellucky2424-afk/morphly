# Decart Lucy 2.5 / Vidu engine configuration

- Plus is selected by default and uses Vidu S2-Editing at 2 credits per second, with a required reference image.
- Pro uses Decart Lucy 2.5 at 3 credits per second, including avatar + background editing.
- Video with translation retains the existing 4 credits per second total; translation alone remains 2.5.
- Xmax is no longer selectable or accepted by start-session. Historical usage records remain readable.

## Deployment

1. Apply migrations through `20260930143532_restore_decart_lucy_25_pro.sql` before deploying the new backend and client. This extends half-credit rates to support Pro's 6 half-credits per second without changing existing sessions.
2. Set server-only `DECART_API_KEY` and retain `VIDU_API_KEY`. `DECART_MAX_SESSION_SECONDS` defaults to 1800 (maximum 7200). Remove obsolete Xmax configuration when no older deployment needs it.
3. Supply the normal public `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` settings when building the app.

The backend issues a Decart client token scoped to `lucy-2.5`, the browser origin where available, and the affordable session duration. Its connection window is 60 seconds. The permanent key never reaches the renderer. Decart's minimum session-duration constraint is 10 seconds, so starting Pro requires 30 credits; this is a balance requirement, not an upfront debit. Only recorded generation seconds are billed.

The client sends the reference file and `Turn the person into the reference image` together in `initialState`. Background selections append their background instruction. Prompt enhancement is disabled to retain the requested wording. Live changes use `set({ prompt, image, enhance })` atomically. Lucy uses 720p / 30 fps input. Cancellation disconnects late SDK connections and terminal provider events stop the app session.

## Verification

`npm test` from `app` exercises provider selection, token scopes, cancellation, prompts and actual PostgreSQL billing functions using PGlite. The new billing tests cover exact rates, retries, balances, finalization, translation overlap in both arrival orders, and refunds.

Local browser checks cover both engine choices and narrow-screen layout. Real provider video output still requires configured credentials, the applied migration and a camera. A bundle built with temporary verification settings is not a configured production build.

References: [Lucy 2.5](https://docs.platform.decart.ai/models/realtime/lucy-2.5), [JavaScript realtime SDK](https://docs.platform.decart.ai/sdks/javascript-realtime), [client tokens](https://docs.platform.decart.ai/getting-started/client-tokens).
