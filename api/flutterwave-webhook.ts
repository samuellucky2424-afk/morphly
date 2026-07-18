// @ts-nocheck
import handler from '../app/server/api/flutterwave-webhook.js';

// Flutterwave signs the exact request bytes. Parsing and re-serializing JSON
// before verification changes those bytes and causes valid webhooks to fail.
export const config = { api: { bodyParser: false } };

export default handler;
