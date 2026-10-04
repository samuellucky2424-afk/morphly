# Firebase production release 2.5.23

The live domains have not been promoted. Production data uses the named Firestore database `morphly-production` in `luckyweb-f546e`. Review deployments and the sandbox Cloud Function continue to use `(default)`, so sandbox purchases do not affect production balances. Firebase Authentication is shared, preserving migrated user IDs and login credentials.

The preflight source snapshot was imported and every record read back and compared: 51,073 documents across 26 collections, 709 account profiles, 710 wallets, 430 transactions, and 11,581 wallet ledger entries. The snapshot preserves 32,632 credits and NGN 138,591.92 in legacy wallet balances. These totals describe the captured snapshot; a final sync is still required because Supabase remains writable.

Client Firestore reads and writes are denied. Server endpoints enforce authentication, ownership, suspension and administrator membership. Existing production Flutterwave, IvoryPay and Resend credentials were preserved. Preview emails remain disabled; live email scheduling, delivery leases and event deduplication are implemented. The website has Google sign-in. Windows uses Firebase email/password authentication; Google sign-in on the website is a separate browser flow.

The engine choices are Plus (Vidu) at 2 credits/sec and Pro (Decart) at 2.5 credits/sec; selection labels hide the vendor names. Firebase timestamp billing retains half-credit change and deduplicates retry timestamps. Translation costs 2.5 credits/sec alone and 4 credits/sec with video; unused reservations are refunded. The latest translation, voice setup and CPU/audio improvements are preserved. Application and emulator validation is recorded below when complete. Earlier staged production API checks passed for the named database, live payment mode, migrated wallet access, non-admin restrictions and invalid webhook rejection. No live charge was made.

Validation on October 5: 304 application tests and 12 Firestore emulator tests passed. The emulator exercises concurrent retry deduplication, owner checks, fractional Pro charges, translation refunds and combined video/translation pricing.

The Windows 2.5.23 installer is being rebuilt and must pass package verification. It includes the native camera bridge and camera registration tools and uses `https://live.morphly.fun/api`. Voice models are pinned independently to the existing verified v2.5.22 archive. The installer is not Authenticode signed. It must not be published to automatic updates until the live backend has switched successfully.

## Remaining cutover steps

1. The user confirmed that live Flutterwave currently calls a Make scenario. Identify and preserve its modules/actions before replacing that callback. The intended stable Firebase endpoint is `https://live.morphly.fun/api/flutterwave-webhook`. Confirm the live secret and the IvoryPay live callback if crypto payments are used. The Make capability URL is intentionally excluded from the repository.
2. Briefly lock Morphly source-table writes, capture a fresh private snapshot and reconcile changes against the verified production baseline. Keep the source backup and unlock script available for rollback. Preserve safe login history without copying usable session tokens.
3. Close copied active sessions in Firebase without an additional debit, then verify wallet totals and deployment behavior. Users will need to sign in again; existing Supabase sessions are not Firebase sessions.
4. Promote the production deployment to the live domains, check the stable webhook URLs and owner/admin routes, enable live customer communications, and publish the verified Windows release.

Local operational tooling is under `morphly-main/tools/firebase-migration`. `source-cutover-lock.mjs lock` and `unlock` only affect the scoped Morphly application tables; neither has been executed for this release. Private exports, credentials and deployment/test logs remain outside the repository under `C:/morphly-private`.
