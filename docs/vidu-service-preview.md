# Vidu service endpoint experiment result

On October 14, 2026, a preview created a session through `api.vidu.com` and
attempted signaling through `service.vidu.com` with the returned scoped
credentials. The browser reported HTTP 404 for all three WebSocket handshake
attempts. Initialization, video publishing, and generated video never started.

The response demonstrates that the service hostname was reachable for that
test. It does not identify whether routing, authentication, origin handling,
or session separation caused the 404. The captured website session's HTTP 101
does not establish compatibility with public API sessions.

The experimental signaling override and service-host allowlist entry were
removed. Both session creation and signaling again use `api.vidu.com` by default.
The Firebase public build configuration guard is retained. Preview deployments
must explicitly receive the matching public Firebase configuration and server
project, service-account credential, and intended database settings.

To verify the restored preview, sign in, choose a camera and reference image,
and start Plus. Check that `/api/start-session` returns `baseUrl` as
`https://api.vidu.com` and that the WebSocket uses `wss://api.vidu.com`.
Successful live video still needs a user camera test; no provider session is
opened by the deployment checks.

The separate announcements `ERR_NAME_NOT_RESOLVED` occurred on a same-origin
API request, before HTTP. It does not diagnose the Vidu WebSocket 404.

Do not include scoped credential query parameters when sharing connection logs.

## Firebase preview authentication checks

Unauthenticated endpoint checks did not establish that Firebase server token
verification worked. The fallback preview returned 401 for signed-in requests;
its generic authentication wrapper also converted backend lookup failures to 401.

The existing stored preview credential passed OAuth, test-account lookup, and
named-database profile reads. A new preview explicitly receives that credential
per deployment through an in-memory environment value, with no key in command
arguments or saved environment files. Project-level credential scopes remain
unchanged. Hosted initialization now requires a server credential, and lookup
diagnostics record only the failure stage and safe error code. Backend lookup
failures return 503 while invalid, expired, or revoked user tokens return 401.

Authenticated checks using the existing test account returned 200 for
`/api/admin-me` and `/api/announcements`. An invalid token returned 401 for
`/api/ensure-user-wallet`. These checks did not open a Vidu session, provision a
wallet, or modify balances. The test account has no wallet in the named live
database, so the user's wallet and camera flow still require their own test.

## China-region preview

The authenticated API-host preview later returned HTTP 403 on its
`api.vidu.com` WebSocket handshake, before initialization or generated video.
That response establishes a rejected handshake, not a confirmed firewall cause.

At the user's request, the next preview sets
`VIDU_API_BASE_URL=https://api.vidu.cn`. Session creation uses that host and
returns it as `baseUrl`, so signaling uses the same region with fresh credentials.
The currently configured provider key remains in use; real China-region
authentication and live video remain unverified and may require a matching key.
Production retains the default API host. The generic start-error message no
longer names the global host or diagnoses a firewall without supporting evidence.
