# Morphly Subscription Page Fix - TODO

## Steps:
1. [x] Update Subscription.tsx to use consistent relative API URLs and better error handling
2. [x] Test local development (run `cd app && npm run dev` manually - note Windows PS uses ; instead of &&)
3. [x] Reviewed duplicate API routes (identical, no merge needed for now)
4. [ ] Redeploy to Vercel: cd app && vercel --prod
5. [ ] Verify production /api/rate endpoint works (curl https://morphly-alpha.vercel.app/api/rate)
6. [ ] [Complete] Task done

## Next manual steps:
- Run `cd app; npm run dev` and check http://localhost:5173/subscription - should use local /api/rate without prod fetch.
- If still issues, check if VITE_API_URL set in .env.local and remove it.
- Redeploy and test prod.

Current progress: Code fixes applied, ready for testing.
