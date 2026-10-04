// @ts-nocheck
import { resolveTranslationGatewayUrl } from '../translation-config.js';

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
    translationGatewayUrl: resolveTranslationGatewayUrl(),
    flutterwavePublicKey: '',
    ivorypayPublicKey,
    isCryptoPaymentEnabled: process.env.MORPHLY_PAYMENT_MODE === 'sandbox' ? false : isCryptoPaymentEnabled,
    backend: 'firebase',
    database: process.env.FIREBASE_DATABASE_ID || '(default)',
    realtimeProviders: ['vidu','decart'],
    reviewVersion: 'firebase-vidu-decart-v1',
    paymentMode: process.env.MORPHLY_PAYMENT_MODE || 'unconfigured',
    firebaseConfig: JSON.parse(process.env.VITE_FIREBASE_CONFIG || '{}'),
  });
}
