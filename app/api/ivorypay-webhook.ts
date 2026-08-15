// @ts-nocheck
import handler from '../server/api/ivorypay-webhook.js';

// IvoryPay HMAC signs the exact request payload.
export const config = { api: { bodyParser: false } };

export default handler;
