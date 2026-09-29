# Real-time voice translation

English microphone audio passes through Gemini Live Translation, then the local MeanVC voice engine, then the outgoing virtual cable. Optional incoming translation uses a second independent cable and sends English audio only to physical headphones.

## Deploy and activate

1. Apply `supabase/migrations/20260929120000_add_combined_realtime_billing.sql` after the existing billing migrations. Deploy the updated API and desktop together. Restart existing face sessions before enabling translation.
2. On a persistent Node host, set `GEMINI_API_KEY`, the existing Supabase server credentials, and optionally `GEMINI_TRANSLATION_MODEL` (default `gemini-3.5-live-translate-preview`). Keep the key server-side; never use a `VITE_` secret.
3. From `app`, run `npm run translation:server`. The service exposes `/api/translation/live` and `/health` on `PORT` (default 3001). Put it behind TLS with WebSocket upgrades enabled. The development API server also exposes the relay on port 3000.
4. On the API host, set `TRANSLATION_GATEWAY_URL=wss://your-node-host/api/translation/live`. `/api/public-config` publishes only this URL. Local development permits `ws://127.0.0.1:3000/api/translation/live`.
5. Build the updated desktop app. The bundled voice archive needs no additional Python dependency. Run a live two-way audio test before enabling the feature for customers.

Vercel's request/response API can publish the relay URL; the relay itself requires a host supporting persistent WebSocket servers. Translation refuses to start without relay configuration and valid credit authorization. Repository changes do not provision or configure that host.

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

Audio and keys are not logged. Bounded queues discard stale speech rather than accumulating latency. Gemini disconnection or its session limit stops translation with a reconnect message; restart the voice session to reconnect. Automatic Gemini session resumption is not implemented.

## Verification

Tests exercise authenticated WebSocket audio with simulated Gemini responses, exact rates and overlapping usage in PGlite, upgrades of the existing billing functions, session ownership, refunds, and Python audio routing with mocked devices. A live test additionally requires the configured relay, Gemini key, applied migration, independent virtual cables and a call partner.

Protocol: [Google Live Translation](https://ai.google.dev/gemini-api/docs/live-api/live-translate).
