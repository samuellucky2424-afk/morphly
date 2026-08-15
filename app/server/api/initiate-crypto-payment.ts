// @ts-nocheck
import crypto from 'crypto';
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { logRequestEvent, logErrorEvent } from '../../../shared/backend-logger.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';
import { initiateIvoryPayTransaction } from '../ivorypay-payment.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });

  const { packageId, credits, priceUSD, redirectUrl } = req.body || {};

  try {
    const authResult = await authenticateRequestUser(req, supabaseAdmin);
    if (authResult.error) {
      return res.status(authResult.status).json({ status: 'failed', message: authResult.error });
    }

    const user = authResult.user;
    const userId = user.id;

    if (!packageId || !credits || !priceUSD || Number(credits) <= 0 || Number(priceUSD) <= 0) {
      return res.status(400).json({ status: 'failed', message: 'Invalid package or amount parameters' });
    }

    // Verify package exists in database
    const { data: pkg, error: pkgError } = await supabaseAdmin
      .from('credit_packages')
      .select('id, credits, price_ngn, is_active')
      .eq('id', packageId)
      .maybeSingle();

    if (pkgError || !pkg) {
      return res.status(404).json({ status: 'failed', message: 'Credit package not found' });
    }

    if (pkg.is_active === false) {
      return res.status(400).json({ status: 'failed', message: 'Credit package is no longer active' });
    }

    // IvoryPay requires reference to be alphanumeric and maximum 32 characters
    const reference = `mc_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`.slice(0, 32);

    await logRequestEvent('initiate-crypto-payment.request', {
      userId,
      packageId,
      credits,
      priceUSD,
      priceNGN: pkg.price_ngn,
      reference,
    });

    const session = await initiateIvoryPayTransaction({
      userId,
      email: user.email,
      amountUSD: Number(priceUSD),
      priceNGN: Number(pkg.price_ngn || 0),
      credits: Number(credits),
      packageId,
      reference,
      redirectUrl,
    });

    return res.status(200).json({
      status: 'success',
      reference,
      checkoutUrl: session.checkoutUrl,
      data: session.data,
    });
  } catch (error) {
    await logErrorEvent('initiate-crypto-payment.error', {
      error: error?.message || String(error),
      stack: error?.stack,
    });

    return res.status(500).json({
      status: 'failed',
      message: error?.message || 'Failed to initialize crypto checkout session',
    });
  }
}
