# Real-time voice translation

English microphone audio passes through Gemini Live Translation, then the local MeanVC voice engine, then the outgoing virtual cable. Optional incoming translation uses a second independent cable and sends English audio only to physical headphones.

## Deploy and activate

1. Apply `supabase/migrations/20260929120000_add_combined_realtime_billing.sql` after the existing billing migrations. Deploy the updated API and desktop together. Restart existing face sessions before enabling translation.
2. In the existing Vercel project's Production environment, set `GEMINI_API_KEY`, the existing Supabase server credentials (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SERVICE_KEY`), and optionally `GEMINI_TRANSLATION_MODEL` (default `gemini-3.5-live-translate-preview`). Keep secrets server-side; never use a `VITE_` secret.
3. Enable Fluid Compute in Vercel's Functions settings and deploy this revision after saving the variables. The Node HTTP server export at `api/translation/live.ts` serves the WebSocket relay. Both repository-root and `app`-root Vercel projects are supported.
4. Leave `TRANSLATION_GATEWAY_URL` unset for the built-in Vercel relay. `/api/public-config` discovers its URL from Vercel's deployment environment, never from request headers. Production uses `VERCEL_PROJECT_PRODUCTION_URL`; previews use `VERCEL_URL`. If system environment variables are disabled, enable them or explicitly set `TRANSLATION_GATEWAY_URL=wss://your-vercel-domain/api/translation/live`.
5. Check `/api/translation/live` over HTTPS: a configured server returns `{"configured":true,"transport":"websocket"}`; missing credentials return 503. This checks credential presence, not key validity or the billing migration. Check that `/api/public-config` publishes the expected secure relay URL. Restart Morphly Desktop (v2.5.16 or later) and test translation. No desktop rebuild is needed for this server update.

[Vercel WebSockets](https://vercel.com/docs/functions/websockets) require Fluid Compute and are subject to the function duration limit. The route is configured for 300 seconds. At 240 seconds, a v2.5.18 client prepares a replacement connection while the current one still carries audio. After Gemini acknowledges the replacement setup, capture buffers briefly while the old connection drains for up to 750 ms and settles its unused credit reservation. The new connection activates after settlement; the local voice engine and playback devices remain open. A 270-second fallback closes a connection if handoff did not complete. Older desktop versions need a manual restart. The key alone does not activate an older deployment that lacks this route.

For a separate persistent Node host, run `npm run translation:server` from `app` with the same server credentials. It exposes `/api/translation/live` and `/health` on `PORT` (default 3001); put it behind TLS with WebSocket upgrades enabled and set `TRANSLATION_GATEWAY_URL=wss://your-node-host/api/translation/live` on the API host. This is optional. Local development permits `ws://127.0.0.1:3000/api/translation/live`.

## Audio setup

- Select your physical microphone. English is the fixed source; choose the target language from the dropdown.
- Select an outgoing virtual cable in Morphly's converted-output selector and its recording endpoint as the call application's microphone.
- For incoming translation, select a second independent cable as the call application's speaker, then its recording endpoint as Morphly's incoming call cable.
- Choose physical headphones for translated incoming speech. The two directions cannot share a cable.
- Every off-to-on toggle shows a confirmation with the rates, internet-dependent latency and Google audio processing. Start voice conversion after accepting. Stop conversion before changing settings.

## Rates and settlement

- Translation without face streaming: **2.5 credits per second**, including both enabled translation directions.
- Face streaming and translation in the same UTC-second bucket: **4 credits per second total**.
- Face streaming without translation retains its selected engine/mode rate.

Billing starts with microphone audio at the authenticated relay, not when the toggle is enabled. The face meter reports actual generation seconds after output begins, aligned with server time. Shared seconds are reconciled atomically regardless of which service reports first; retries cannot double-charge them. Billing uses whole second buckets, so partially used boundary seconds are rounded up for translation.

The existing integer wallet remains compatible with older wallet operations. `realtime_credit_carry` preserves positive half-credit change and the wallet API returns the effective fractional balance. `realtime_usage_seconds.cost_half` is the exact usage audit; legacy session cost fields are not the authoritative v2 charge report. The integer ledger records corresponding whole-wallet movements.

The relay reserves up to five seconds ahead and stops when authorization expires. The displayed balance can temporarily include those reservations. Closing refunds unused reservations while retaining any face-stream charge in the same seconds. A hard process crash or prolonged database outage can leave up to five reserved seconds charged; investigate relay settlement-retry logs before refunds. A stale lease expires 30 seconds after its authorization deadline so a crashed relay cannot permanently block a new session.

Audio and keys are not logged. Desktop v2.5.18 prepares replacements after relay rotation or Gemini `goAway`, and reconnects after transient connection failures or a previous account session still closing. The standby requires a signed, short-lived ticket bound to the authenticated user, target language, and enabled directions. It cannot forward audio or debit credits before activation. The database's single-open-session constraint remains authoritative across server instances.

During handoff or unexpected recovery the desktop retains at most two seconds of unsent PCM per direction. It replays at a bounded rate (up to twice real time), subject to the same two-second age limit. Overflow and older audio are dropped; Stop erases the queue. Planned handoff keeps playback open; unexpected disconnection clears old playback buffers. A brief gap or interrupted sentence is still possible, particularly for audio already sent to Gemini before a failure. This opens a fresh Gemini session; it does not resume its previous context or guarantee lossless speech. Persistent failures stop after a 45-second recovery window. Authentication and credit failures remain terminal. Stop cancels both active and standby connections and pending retries.

Recurring credit reservations run outside the audio forwarding path while existing authorization is valid. v2.5.18 uses a separate `begin`/`authorized` exchange before sending its first PCM; the desktop buffers audio during that initial authorization. There is no database await in its audio forwarding path. Reservations renew every two seconds, up to five seconds ahead, and their cached deadline fails closed if renewal stops. This preserves the existing credit model without a 30-second unpaid usage window. Per-session `translation.first_audio` logs report the time from the first forwarded PCM frame to the first Gemini audio frame for each direction, without recording speech. This includes initial silence, so it is not a speech-to-speech latency measurement. Measure latency with spoken test phrases on the target network; no fixed sub-second response is guaranteed.

## Verification

Tests exercise authenticated WebSocket audio with simulated Gemini responses, exact rates and overlapping usage in PGlite, upgrades of the existing billing functions, session ownership, refunds, and Python audio routing with mocked devices. A live test additionally requires the configured relay, Gemini key, applied migration, independent virtual cables and a call partner.

Protocol: [Google Live Translation](https://ai.google.dev/gemini-api/docs/live-api/live-translate).
