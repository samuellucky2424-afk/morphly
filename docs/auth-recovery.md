# OTP password recovery (browser and desktop)

## Current implementation

- Select **Forgot password?** on the sign-in screen to open `/#/reset-password` in the browser or the same hash route inside Electron. The clean browser URL `/reset-password` forwards to this screen.
- Request a code, verify it, then enter and confirm a new password. Codes can be pasted/autofilled; numeric codes from 6 to 10 digits are accepted to match project configuration. Resending has a 60-second UI cooldown; Supabase enforces its server-side limits and expiration.
- Requests use `resetPasswordForEmail`; verification uses `verifyOtp({ email, token, type: 'recovery' })`. No magic-link sign-in or account creation is used.
- A dedicated memory-only Supabase client keeps recovery separate from the main app session. An existing login cannot unlock password updates. The verified server user must match the recovery email and session before the password form is enabled.
- Errors stay inline. A successful reset clears password fields and signs out the temporary recovery session. Previously issued browser recovery links remain supported during rollout.
- The private admin sign-in also opens the code recovery page.

## Supabase configuration

Release 2.5.12 introduces this flow. The owner confirmed the code-only recovery email template was saved before release. The application code does **not** change hosted Supabase email templates. The local `.env` has public client credentials, not Management API access. The available database connector cannot update Auth email settings.

1. In the project's Supabase dashboard, open **Authentication ? Email templates ? Reset password**.
2. Set the subject to `Your Morphly password reset code`.
3. Replace the body with [`supabase/templates/recovery.html`](../supabase/templates/recovery.html). This uses `{{ .Token }}` and contains no recovery link. Do not change the magic-link or signup template.
4. Save the template. Review the existing email OTP expiry and SMTP delivery settings. No new environment variables or database migrations are needed.
5. Deploy the web build and rebuild/release the Electron app together. Older installed apps expect recovery links, so coordinate this template switch with the desktop release.
6. With a designated test account, request a real email from both clients, verify the code, change the password, and sign in with the new password. Also check expired codes and resends. Local tests do not verify SMTP delivery.

Provider documentation: [email templates](https://supabase.com/docs/guides/auth/auth-email-templates), [verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp).

## Current verification

- TypeScript and the production Vite build pass (existing large-chunk warnings remain).
- All 11 focused authentication/recovery tests pass, including five new OTP tests.
- Release 2.5.12 was prepared from the latest main branch with pinned submodules and exact lockfile dependencies. All 230 Node tests pass. Earlier failures in the older working copy are absent in this complete release checkout.
- An isolated browser using the actual Supabase client with mocked Auth HTTP responses verified request, resend cooldown, invalid-code rejection, valid-code verification, password mismatch and successful update. Desktop-width and 375 px screenshots were inspected; no page errors were reported. The mobile check included OS dark preference and reduced motion (the application's existing light theme remains in effect).
- No live emails or account password updates were performed during automated verification. The owner applied the hosted email template. GitHub Actions builds and verifies the native Windows installer before publishing it; Vercel deploys the same release commit for the browser.

---

## Previous link-based recovery implementation (historical)


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
