// @ts-nocheck

function resolveFlutterwavePublicKey() {
  const candidateKeys = [
    process.env.VITE_FLUTTERWAVE_PUBLIC_KEY,
    process.env.VITE_FLW_PUBLIC_KEY,
    process.env.FLUTTERWAVE_PUBLIC_KEY,
    process.env.FLW_PUBLIC_KEY,
  ];

  for (const key of candidateKeys) {
    if (typeof key === 'string' && key.trim().length > 0) {
      const normalizedKey = key.trim();
      const configuredMode = String(
        process.env.FLUTTERWAVE_MODE
          || process.env.PAYMENT_ENVIRONMENT
          || '',
      ).trim().toLowerCase();
      const productionMode = configuredMode
        ? ['live', 'production', 'prod'].includes(configuredMode)
        : process.env.NODE_ENV === 'production';

      if (productionMode && /(?:^|_)TEST(?:-|_)/i.test(normalizedKey)) {
        return '';
      }

      return normalizedKey;
    }
  }

  return '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  res.status(200).json({
    flutterwavePublicKey: resolveFlutterwavePublicKey(),
    supabaseUrl: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '',
  });
}
