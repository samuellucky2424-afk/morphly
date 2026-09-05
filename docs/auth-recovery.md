# Signup and password recovery

Included in version 2.5.2. Web deployment and a successful desktop release build are required to deliver these changes; local testing does not verify production email delivery.

## Changes

- Signup uses the response from the current request, never an unrelated saved session. A provider duplicate error or an obfuscated user with empty identities shows sign-in/password-reset guidance. An unconfirmed signup stays on the form with confirmation instructions; it does not provision a wallet or emit `signup_completed`.
- Authentication initialization is separate from form submission. Route guards no longer unmount the form while a request is pending, so fields and inline feedback survive errors and retries.
- Email addresses are trimmed/lowercased for signup, login and reset requests. Reset requests do not reveal whether an email is registered. Supabase remains the authority for email uniqueness; no public email-lookup endpoint or database permissions were added.
- Password recovery requires a valid recovery link, not any session already stored in the browser. Implicit links work across the Electron/browser boundary. PKCE links require the matching browser verifier; recovery `token_hash` links are also supported.
- Recovery session storage is memory-only, with a unique storage/broadcast key. Recovery does not replace a different account signed in on the same browser. Credentials are removed from the URL; new passwords are submitted only through Auth's password-update API.
- Invalid/expired links keep the form disabled. Mismatches, provider errors and retries stay inline. Successful updates clear both password fields and offer a sign-in link. Both customer and private-admin reset request buttons handle errors and block concurrent requests.

## Deployment

1. Deploy the web/API build together: Vite now copies `reset-password.js` and `password-recovery.mjs` alongside the recovery HTML. Rebuild Electron to deliver the corrected signup/reset-request UI.
2. Keep `https://morphly-alpha.vercel.app/reset-password` in Supabase Authentication → URL Configuration → Redirect URLs. This existing app endpoint was reachable during verification. `live.morphly.fun` was unreachable from this environment, so recovery links were not silently moved there.
3. Optional public build variable `VITE_AUTH_SITE_URL` changes the recovery app origin. Use an HTTPS origin hosting the reset page and `/api/public-config`, backed by the same Supabase project. Add its exact `/reset-password` URL to Supabase before rebuilding. Do not point this at a marketing-only site or Electron's `file://` address.
4. Supabase sends authentication emails. Its email-confirmation settings, redirect allowlist, SMTP configuration and delivery limits still apply. Setting the separate customer-engagement `RESEND_API_KEY` does not configure Supabase Auth SMTP automatically.
5. After deploying, test an actual reset email with a designated test account, update its password, then sign in using the new password. No production accounts, credentials or SMTP settings were changed by local testing.

## Verification

- 145 Node tests pass, including signup outcomes, recovery validation, session isolation and route-guard regression checks.
- TypeScript and the production Vite build pass.
- Isolated browser tests using the real bundled Supabase JavaScript client and mocked HTTP responses pass for duplicate signup (both response formats), confirmation-required signup, genuine signup, reset-request validation/rate-limit retry, expired/wrong-purpose links, implicit and PKCE recovery, password mismatch, provider failure/retry, successful update and return to sign-in. No live signup, password update or email was performed.
- White/red feedback is tested in a narrow 375 px window with reduced motion and OS dark preference. It follows UI/UX Pro Max's inline, focusable error-feedback guidance.

Provider references: [Supabase password-based authentication](https://supabase.com/docs/guides/auth/passwords), [redirect allowlist](https://supabase.com/docs/guides/auth/redirect-urls).
