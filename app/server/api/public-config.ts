// @ts-nocheck

function resolveIvoryPayPublicKey() {
  const candidateKeys = [
    process.env.VITE_IVORYPAY_PUBLIC_KEY,
    process.env.IVORYPAY_PUBLIC_KEY,
  ];

  for (const key of candidateKeys) {
    if (typeof key === 'string' && key.trim().length > 0) {
      return key.trim();
    }
  }

  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ivorypayPublicKey = resolveIvoryPayPublicKey();
  const isCryptoPaymentEnabled = Boolean(
    process.env.IVORYPAY_SECRET_KEY || ivorypayPublicKey || process.env.VITE_IVORYPAY_PUBLIC_KEY
  );

  res.status(200).json({
    // Updated clients create server-side Standard payments. Hiding the legacy
    // Inline key always prevents older clients from creating unsplit checkouts,
    // including when the required split subaccount configuration is missing.
    flutterwavePublicKey: '',
    ivorypayPublicKey,
    isCryptoPaymentEnabled,
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '',
  });
}
