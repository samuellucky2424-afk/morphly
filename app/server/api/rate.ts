import { getUsdExchangeRates } from '../exchange-rates.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { rates, fetchedAt, cached } = await getUsdExchangeRates();
    return res.json({ rate: rates.NGN, cached, updatedAt: new Date(fetchedAt).toISOString() });
  } catch {
    // The display rate may use a fallback. Local currency checkout requires provider rates.
    return res.json({ rate: 1500, cached: false, fallback: true, updatedAt: new Date().toISOString() });
  }
}
