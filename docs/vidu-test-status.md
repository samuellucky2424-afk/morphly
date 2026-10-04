# Vidu quality-test branch

Version 2.5.11 includes Pro using Vidu S2-Editing and Plus using Xmax. Users must choose an engine for each new stream; neither is preselected. The user confirmed Pro produced working video on September 16; output quality has not been independently evaluated.

## Implemented

- Session creation sends the selected reference image and `subject_replacement` to `/live/s_editing/realtime`, with the documented bare server-side Authorization header.
- Browser signaling uses Vidu's short-lived `client_secret`. The permanent API key never goes to the browser. Responses missing scoped credentials fail explicitly.
- The pinned AliRTC 7.1.9 SDK publishes a clone of the selected camera track, disables microphone publishing and plays only the generated stream from `render_uid`.
- Initialization, NOT_READY retries, reference-image updates, provider disconnects, startup cancellation and hangup are implemented. Stop sends hangup before waiting on wallet requests.
- The client ends quality-test sessions after at most 120 seconds (or the shorter returned provider/session limit). This browser timer is not server-enforced credit protection. Provider lifetime also depends on Vidu's returned `live_duration`.
- Session creation retries explicit rate limits only. Ambiguous server failures/timeouts are not automatically retried because creation is not documented as idempotent.

Protocol reference: [Vidu S2-Editing parameters](https://platform.vidu.com/vidu-stream/doc/s2-editing/parameters) and [official browser demo](https://platform.vidu.com/live-doc/files/s2-editing/quick-start/index.html).

## Testing quality

Sign in, choose Pro in the engine dialog, upload a PNG/JPEG/WebP reference under 2 MB, and start the camera. Pro currently uses image-based subject replacement; text/background prompt controls do not change Vidu output. Stop the session after comparing the generated output. Start a new session after the test timer expires.

The server environment needs a Vidu API key with S2-Editing access and working Supabase credentials. The downloaded source's local `.env` files contained placeholder Supabase browser credentials. Keep all real credentials outside Git. Mock credentials cannot evaluate Vidu quality and are rejected by the RTC client.

Automated checks exercise session credentials and payloads, renderer selection, prompt signaling, initialization retry, timeouts, cancellation and hangup. They mock the provider and RTC engine; they do not establish real Vidu media connectivity.

## Provider disconnect diagnostics (web follow-up)

A reported session joined RTC and published its camera, then Vidu sent a forced hangup. A read-only provider status query confirmed `close_reason=sip_close` and six billed seconds. The provider record does not explain the underlying rendering closure; the user subsequently confirmed Pro worked. No connection-order changes or automatic paid retries were introduced based on that single failure.

The web follow-up preserves safe hangup reason codes and logs session/trace IDs with initialization, publication and received-video flags. Raw SDK debug logging is disabled because it includes RTC credentials and signed URLs. This diagnostic change follows the v2.5.11 installer tag.

## Separate deployment fixes and limitations

Web builds use their own deployment's `/api`; configured remote API URLs remain supported in packaged desktop builds. Hosted voice controls explain that MorphlyVC requires the desktop app instead of calling desktop-only routes.

Production logs on September 16 showed wallet requests reaching the 30-second function timeout, including user upserts taking 13-17 seconds. That database latency is separate from the Vidu RTC integration and is not resolved here.

## Credit rates and engine selection

Pro uses 2.5 credits/second. Plus retains 2 credits/second for a single transformation and 4 credits/second for avatar plus background. The engine dialog shows the applicable rate and a short quality description before confirming. The clear-image action is removed; Change Image remains available.

The existing server bills whole usage units worth two credits each. The client retains fractional units between heartbeats, so 60 seconds of Pro bills 150 credits. Any final remainder smaller than one usage unit is waived when the session ends; it is never rounded up. No wallet schema migration is required.

## v2.5.13: subject replacement only

Pro now fixes `editing_type` to `subject_replacement` during session creation and every WebSocket image update. Client overrides cannot select background replacement, style transfer, or virtual try-on. The existing Vidu signaling and AliRTC transport remain in place. Regression tests cover a background-replacement override at both API and WebSocket boundaries.
