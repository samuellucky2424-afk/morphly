# Vidu demo-compatible Plus engine

The supplied Python launcher and HTML use HTTPS POST with JSON containing
`image_url` and `editing_type`, matching Morphly's realtime creation request.
The HTML's `httpAuthHeader()` always sends `Token <key>`, and the launcher's
`_normalize_auth()` also prefixes bare `vda_` keys with `Token `. This conflicts
with the written S2-Editing reference's bare-key example. The preview keeps the
working launcher-compatible scheme rather than treating the documentation
discrepancy as a proven cause of the failure.

The HTML connects to a local `/proxy/{env}/live/ws/live/connect` route with
`live_id`, `conn_id`, `authorization`, and optional `client_secret`. Python
removes the authorization query parameter and forwards its value in an
upstream Authorization header, then relays WebSocket bytes. Morphly's direct
browser socket previously sent only the scoped secret. This is a candidate
explanation for its earlier 403, not proof. A production Morphly relay must
keep permanent provider credentials server-side and bind each connection to
an authenticated, owned session. The launcher is not deployed as a public proxy.

The `.cn` preview's runtime logs showed a session-creation request timeout,
which Morphly wrapped as HTTP 502. This happened before signaling and does not
establish an API-key rejection. The launcher allows HTTP requests 60 seconds;
Morphly's default is 15 seconds. The diagnostic preview sets a bounded 60-second
creation deadline shared across retries and a 90-second catch-all function
budget. Default production configuration is unchanged.

The diagnostic preview also includes a preview-only, fixed-host DNS/TLS check
for the two Vidu API hosts. It sends no API key or image, performs no video API
call, and preserves certificate verification. This check only tests basic
connectivity; it does not verify authorization, WebSocket compatibility, RTC,
or generated video.

## Preview engine replacement

The new preview keeps Morphly's dashboard, sign-in, wallet accounting and
virtual-camera output. It adopts the demo's server-side signaling transport:

1. The authenticated start-session API creates the Vidu session with `Token`
   authorization and forwards the caller's Origin and User-Agent, as Python does.
2. The API returns RTC credentials and an encrypted, short-lived relay ticket.
   The ticket binds the caller, Morphly session, Vidu session, connection ID,
   origin, deployment audience, provider expiry and affordable duration.
3. The browser opens the fixed `/api/vidu/live` WebSocket using a subprotocol
   ticket. Credentials do not appear in its socket URL.
4. The server verifies the ticket and claims a Firestore lease for the existing
   active, owned session before opening the fixed `api.vidu.com` socket. It adds
   the server-held API key in the Authorization header and forwards the scoped
   session secret. Text and binary messages preserve their ordering.
5. Morphly waits for `conn_init_ack`, joins AliRtc, publishes the selected camera
   and displays the provider's renderer. Its output continues feeding the
   existing virtual-camera path. The dashboard layout is unchanged.

Packaged Electron uses its configured HTTPS API origin; its opaque `null`
Origin is accepted only by the authenticated desktop start-session path.
Web clients use their current HTTPS origin. Arbitrary relay destinations and
upstream redirects are rejected.

The demo's 120-second initialization allowance is bounded by provider expiry.
The active session remains capped by the account's affordable time and Vidu's
120-second limit. The relay sends a provider hangup on cancellation, timeout,
socket loss or session/account revocation. It does not finalize wallet usage
early: the existing client usage flush and end-session API retain that job.

Concurrent ticket use and reuse after successful initialization are blocked
with a native Firestore transaction. The relay has bounded message sizes,
buffers, retries and cleanup. It is enabled only on this preview with
deployment-specific environment overrides; no project-wide credential scopes
are changed. Vercel's native Node HTTP-server WebSocket support provides the
route; its function budget is 300 seconds to cover startup and active time.
See [Vercel WebSockets](https://vercel.com/docs/functions/websockets).

The new API URL validation rejects keys mistakenly pasted into
`VIDU_API_BASE_URL` before sending a network request or logging that value.
Separately, the authorized Production configuration fix restored that variable
to `https://api.vidu.com` and redeployed the existing Production source at
`https://live.morphly.fun`. The new relay engine is being tested in preview.

Validation: 92 targeted tests passed, including real local WebSocket transport
with a mock upstream, ticket tampering/expiry, lease concurrency, message order,
hangup cleanup, browser and packaged Electron routing, existing wallet security
and Firebase authentication errors. The app TypeScript build passed. These
checks do not establish live provider video success; that requires the user's
camera test against the deployed preview.

Preview deployment: `dpl_7y8n3pyQsHbg32UWVt2KSVGYECsd`, ready at
`https://morphly-82h1sohx6-lus-projects-b2662b64.vercel.app`.
The remote build passed. Authenticated Vercel checks confirmed the relay's
`WebSocket required` response and Vidu's status-only credential check returned
HTTP 200. Unauthenticated preview access redirects to Vercel sign-in; that
is deployment protection, not evidence of a Vidu socket block. The user must
open the preview through their Vercel account to test live camera output.

## First live preview test

The user confirmed HTTP 101 on the browser's `/api/vidu/live` WebSocket,
with the expected `morphly.plus` protocol. This establishes browser-to-relay
connectivity, not generated-video delivery. Startup remained at preparing
output while AliRtc emitted warnings about transform-worker bookkeeping.
Those warnings alone do not identify the failure.

SDK 7.1.9 source review found that `joinChannel` catches automatic publication
errors and emits `occurError`; the prior engine did not handle that event.
It also treated a completed publish method as successful publication, without
observing the SDK's published-state event. The follow-up preview adds controlled
startup phase/state logging, handles relevant numeric RTC errors, and confirms
publication through the SDK event. It awaits `startPreview` after joining,
matching the demo, and bounds RTC destruction so teardown cannot keep startup
waiting indefinitely. The selected camera and existing output/billing paths
remain intact. No camera-transport diagnosis is claimed until the next test.
The user then provided `conn_init_ack` with `success: true`, confirming Vidu
accepted and initialized the session through the relay. The remaining
investigation is RTC publication or video reception, not session creation or
the browser signaling handshake.

Follow-up validation: 84 targeted transport, provider, routing, API safety and
relay tests passed; the full app TypeScript check and diff check passed.

Follow-up preview: `dpl_2nL1yzRgKWoHznNQu6Ch7jTymmMv`, ready at
`https://morphly-lq5tfjick-lus-projects-b2662b64.vercel.app`.
The remote build passed and the status-only Vidu credential check returned
HTTP 200. Live camera success still requires the user's test. If startup fails,
the `[Vidu] startup` lines identify the last confirmed phase and safe RTC code.

Camera `getVideoTrack` uses `AliRtcRawDataStreamType` value 0; the demo's view
configuration uses the distinct `AliRtcVideoTrack` camera value 1. These values
are not interchangeable.

Creation errors now preserve safe provider status/code metadata and report
server session timeouts separately from browser or generated-video timeouts.
Transport diagnostics omit raw messages, tokens, images, and authorization
headers, retaining only recognized network/TLS codes and the operation/host.
