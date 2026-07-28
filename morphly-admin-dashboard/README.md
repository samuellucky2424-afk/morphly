# Morphly Admin Dashboard

Professional vanilla HTML, CSS and JavaScript dashboard prototype for Morphly.

## Preview locally

Open `index.html` directly in a browser, or run a static server:

```bash
npx serve .
```

The dashboard is connected to Morphly's authenticated backend. It signs administrators in with Supabase Auth and sends the access token to protected admin endpoints. No service-role or Decart key is included in the browser.

## Files

- `index.html` — semantic page structure
- `styles.css` — responsive admin design
- `app.js` — charts, filters, users, credit adjustment, suspension, logs and audit behavior

## Connect the real backend

The production build mounts this portal at `/private/morphly/login` and uses the same website origin for its backend. Set `window.MORPHLY_API_BASE` before `app.js` only when deploying against another backend.

- `GET /api/admin/overview`
- `GET /api/admin/users`
- `POST /api/admin/users/:userId/credits`
- `PATCH /api/admin/users/:userId/status`
- `GET /api/admin/packages`
- `POST /api/admin/packages`
- `PATCH /api/admin/packages/:packageId`
- `GET /api/admin/transactions`
- `GET /api/admin/usage?days=30`
- `GET /api/admin/logs`

The admin frontend must never update a Supabase wallet table directly. The backend credit endpoint should:

1. Verify the signed-in administrator and role.
2. Validate the amount and required reason.
3. Generate or accept an idempotency key.
4. Insert an immutable wallet-ledger credit entry.
5. Update the cached wallet balance in the same database transaction.
6. Insert an admin audit record containing admin ID, user ID, amount, reason and timestamp.
7. Return the updated balance.

The status endpoint should update `active`/`suspended`, revoke active app sessions where appropriate, and create an immutable audit record. Do not log passwords, permanent API keys, card data or uploaded user images.

The package endpoint should validate the package name, NGN price, credit amount, `active`/`draft` status and featured flag. Completed purchases must retain a snapshot of the original package price and credits, so changing a package never changes historical transactions. Only authenticated administrators should be allowed to create, activate or pause packages, and every change should be written to `admin_audit_logs`.

## Recommended Supabase tables

- `profiles`
- `wallets`
- `wallet_ledger`
- `payment_transactions`
- `usage_sessions`
- `analytics_events`
- `error_logs`
- `admin_audit_logs`
- `daily_metrics`
- `credit_packages`

Use a server-side service role only inside a protected backend or Supabase Edge Function. Never place it in `app.js` or any browser/mobile build.
