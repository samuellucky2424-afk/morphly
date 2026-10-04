# Firebase production release 2.5.12

The live domains have not been promoted. Production data uses the named Firestore database `morphly-production` in `luckyweb-f546e`. Review deployments and the sandbox Cloud Function continue to use `(default)`, so sandbox purchases do not affect production balances. Firebase Authentication is shared, preserving migrated user IDs and login credentials.

The preflight source snapshot was imported and every record read back and compared: 51,073 documents across 26 collections, 709 account profiles, 710 wallets, 430 transactions, and 11,581 wallet ledger entries. The snapshot preserves 32,632 credits and NGN 138,591.92 in legacy wallet balances. These totals describe the captured snapshot; a final sync is still required because Supabase remains writable.

Client Firestore reads and writes are denied. Server endpoints enforce authentication, ownership, suspension and administrator membership. Existing production Flutterwave, IvoryPay and Resend credentials were preserved. Preview emails remain disabled; live email scheduling, delivery leases and event deduplication are implemented. The website has Google sign-in. Windows uses Firebase email/password authentication; Google sign-in on the website is a separate browser flow.

The engine choices are Plus at 2 credits/sec and Pro at 2.5 credits/sec. Internal provider identifiers remain Decart and Vidu. The provider duration cap accounts for Pro's usage multiplier. Tests: 236 application tests and nine Firestore emulator tests passed. Staged production API checks passed for the named database, live payment mode, migrated wallet access, non-admin restrictions and invalid webhook rejection. No live charge was made.

The Windows installer was built and its package verified. It contains the native camera bridge and camera registration tools, uses `https://live.morphly.fun/api`, and contains no environment files. It is not Authenticode signed. It must not be published to automatic updates until the live backend has switched successfully.

## Remaining cutover steps

1. Confirm the webhook setting in the **live** Flutterwave dashboard, distinct from the sandbox configuration. The intended stable endpoint is `https://live.morphly.fun/api/flutterwave-webhook`. Confirm the IvoryPay live callback if crypto payments are used.
2. Briefly lock Morphly source-table writes, capture a fresh private snapshot and reconcile changes against the verified production baseline. Keep the source backup and unlock script available for rollback. Preserve safe login history without copying usable session tokens.
3. Close copied active sessions in Firebase without an additional debit, then verify wallet totals and deployment behavior. Users will need to sign in again; existing Supabase sessions are not Firebase sessions.
4. Promote the production deployment to the live domains, check the stable webhook URLs and owner/admin routes, enable live customer communications, and publish the verified Windows release.

Local operational tooling is under `morphly-main/tools/firebase-migration`. `source-cutover-lock.mjs lock` and `unlock` only affect the scoped Morphly application tables; neither has been executed for this release. Private exports, credentials and deployment/test logs remain outside the repository under `C:/morphly-private`.
