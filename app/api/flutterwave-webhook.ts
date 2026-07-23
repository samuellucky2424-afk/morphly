// @ts-nocheck
import handler from '../server/api/flutterwave-webhook.js';

// Flutterwave signs the exact request bytes. Keep this route outside the
// parsed catch-all API so both root-level and app-level Vercel deployments
// verify the original payload.
export const config = { api: { bodyParser: false } };

export default handler;
