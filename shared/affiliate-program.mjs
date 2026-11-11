/**
 * Morphly affiliate program rules. Integer kobo only.
 * This module has no I/O and no admin UI.
 */

export const DAY_MS = 86400000;
export const REAUTH_WINDOW_MS = 5 * 60 * 1000;
export const AFFILIATE_LINK_ORIGIN = 'https://live.morphly.fun';
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const RATE_LIMIT_MAX = 5;

export const DEFAULT_AFFILIATE_SETTINGS = Object.freeze({
  registrationsEnabled: false,
  commissionsEnabled: true,
  defaultRateBps: 600,
  durationDays: 30,
  maxDaysBeforeFirstPurchase: 30,
  minWithdrawalKobo: 300000,
  holdDays: 7,
  manualAffiliateApproval: true,
  manualWithdrawalApproval: true,
  autoPayoutsEnabled: false,
  transferFeePayer: 'affiliate',
  estimatedTransferFeeKobo: 0,
});

export const NIGERIAN_BANKS = Object.freeze([
  { code: '044', name: 'Access Bank' },
  { code: '063', name: 'Access Bank (Diamond)' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '030', name: 'Heritage Bank' },
  { code: '301', name: 'Jaiz Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '076', name: 'Polaris Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '068', name: 'Standard Chartered' },
  { code: '232', name: 'Sterling Bank' },
  { code: '032', name: 'Union Bank of Nigeria' },
  { code: '033', name: 'United Bank for Africa' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
]);

const BANK_BY_CODE = new Map(NIGERIAN_BANKS.map((bank) => [bank.code, bank]));

export function affiliateError(message, status = 400, code = 'AFFILIATE_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function bankByCode(code) {
  return BANK_BY_CODE.get(String(code || '').trim()) || null;
}

export function isNuban(value) {
  return /^\d{10}$/.test(String(value || '').trim());
}

export function assertRecentAuth(authTimeSeconds, nowMs) {
  const authTime = Number(authTimeSeconds);
  if (!Number.isSafeInteger(authTime) || authTime <= 0) {
    throw affiliateError('Re-authentication required', 403, 'REAUTH_REQUIRED');
  }
  const age = nowMs - authTime * 1000;
  if (age < -5000 || age > REAUTH_WINDOW_MS) {
    throw affiliateError('Re-authentication required. Sign in again, then continue within 5 minutes.', 403, 'REAUTH_REQUIRED');
  }
}

export function requireKobo(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw affiliateError(`${label} must be an integer number of kobo`);
  }
  return value;
}

export function nairaToKobo(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const kobo = Math.round(value * 100);
    if (!Number.isSafeInteger(kobo) || Math.abs(value * 100 - kobo) > 1e-6) return null;
    return kobo;
  }
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  const kobo = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(kobo) && kobo > 0 ? kobo : null;
}

export function commissionKobo(purchaseKobo, rateBps) {
  if (!Number.isSafeInteger(purchaseKobo) || purchaseKobo <= 0) return 0;
  if (!Number.isSafeInteger(rateBps) || rateBps < 0) return 0;
  return Math.floor((purchaseKobo * rateBps) / 10000);
}

export function formatNgn(kobo) {
  const amount = Number.isSafeInteger(kobo) ? kobo : 0;
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const naira = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  return `${sign}₦${naira.toLocaleString('en-NG')}.${rem}`;
}

export function formatRate(rateBps) {
  const bps = Number.isSafeInteger(rateBps) ? rateBps : DEFAULT_AFFILIATE_SETTINGS.defaultRateBps;
  const percent = bps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

export function affiliateLink(code) {
  return `${AFFILIATE_LINK_ORIGIN}/ref/${encodeURIComponent(code)}`;
}

export function maskAccountNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return '**********';
  return `${'*'.repeat(Math.max(6, digits.length - 4))}${digits.slice(-4)}`;
}

export function maskAccountName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '***';
  return parts.map((part) => `${part.slice(0, 1)}***`).join(' ');
}

export function maskCustomer(name, email) {
  const mail = String(email || '').trim().toLowerCase();
  if (mail.includes('@')) {
    const [local, domain] = mail.split('@');
    const labels = domain.split('.');
    const tld = labels.pop() || '***';
    const host = labels[0] || '';
    return `${(local || '*').slice(0, 1)}***@${(host || '*').slice(0, 1)}***.${tld}`;
  }
  const text = String(name || 'Customer').trim();
  if (text.length <= 1) return 'C***';
  return `${text.slice(0, 1)}***${text.slice(-1)}`;
}

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const pick = (snake, camel, fallback) => {
    if (source[snake] !== undefined && source[snake] !== null) return source[snake];
    if (source[camel] !== undefined && source[camel] !== null) return source[camel];
    return fallback;
  };
  const defaults = DEFAULT_AFFILIATE_SETTINGS;
  const payer = pick('transfer_fee_payer', 'transferFeePayer', defaults.transferFeePayer);
  return {
    registrationsEnabled: Boolean(pick('registrations_enabled', 'registrationsEnabled', defaults.registrationsEnabled)),
    commissionsEnabled: Boolean(pick('commissions_enabled', 'commissionsEnabled', defaults.commissionsEnabled)),
    defaultRateBps: Number(pick('default_rate_bps', 'defaultRateBps', defaults.defaultRateBps)),
    durationDays: Number(pick('duration_days', 'durationDays', defaults.durationDays)),
    maxDaysBeforeFirstPurchase: Number(pick('max_days_before_first_purchase', 'maxDaysBeforeFirstPurchase', defaults.maxDaysBeforeFirstPurchase)),
    minWithdrawalKobo: Number(pick('min_withdrawal_kobo', 'minWithdrawalKobo', defaults.minWithdrawalKobo)),
    holdDays: Number(pick('hold_days', 'holdDays', defaults.holdDays)),
    manualAffiliateApproval: Boolean(pick('manual_affiliate_approval', 'manualAffiliateApproval', defaults.manualAffiliateApproval)),
    manualWithdrawalApproval: Boolean(pick('manual_withdrawal_approval', 'manualWithdrawalApproval', defaults.manualWithdrawalApproval)),
    autoPayoutsEnabled: false,
    transferFeePayer: payer === 'platform' ? 'platform' : 'affiliate',
    estimatedTransferFeeKobo: Number(pick('estimated_transfer_fee_kobo', 'estimatedTransferFeeKobo', defaults.estimatedTransferFeeKobo)),
  };
}

export function settingsToDoc(settings, extra = {}) {
  return {
    registrations_enabled: settings.registrationsEnabled,
    commissions_enabled: settings.commissionsEnabled,
    default_rate_bps: settings.defaultRateBps,
    duration_days: settings.durationDays,
    max_days_before_first_purchase: settings.maxDaysBeforeFirstPurchase,
    min_withdrawal_kobo: settings.minWithdrawalKobo,
    hold_days: settings.holdDays,
    manual_affiliate_approval: settings.manualAffiliateApproval,
    manual_withdrawal_approval: settings.manualWithdrawalApproval,
    auto_payouts_enabled: false,
    transfer_fee_payer: settings.transferFeePayer,
    estimated_transfer_fee_kobo: settings.estimatedTransferFeeKobo,
    ...extra,
  };
}

export function validateSettingsPatch(patch) {
  const next = normalizeSettings({ ...DEFAULT_AFFILIATE_SETTINGS, ...patch });
  if (!Number.isSafeInteger(next.defaultRateBps) || next.defaultRateBps < 0 || next.defaultRateBps > 5000) {
    throw affiliateError('Commission rate must be between 0 and 50 percent');
  }
  for (const [key, max] of [['durationDays', 365], ['maxDaysBeforeFirstPurchase', 365], ['holdDays', 90]]) {
    if (!Number.isSafeInteger(next[key]) || next[key] < 0 || next[key] > max) {
      throw affiliateError(`${key} is out of range`);
    }
  }
  if (next.durationDays < 1 || next.maxDaysBeforeFirstPurchase < 1) {
    throw affiliateError('Windows must be at least one day');
  }
  if (!Number.isSafeInteger(next.minWithdrawalKobo) || next.minWithdrawalKobo < 0) {
    throw affiliateError('Minimum withdrawal must be an integer number of kobo');
  }
  if (!Number.isSafeInteger(next.estimatedTransferFeeKobo) || next.estimatedTransferFeeKobo < 0) {
    throw affiliateError('Transfer fee estimate must be an integer number of kobo');
  }
  next.autoPayoutsEnabled = false;
  return next;
}

export function emptyWallet(affiliateId) {
  return {
    affiliate_id: affiliateId,
    available_kobo: 0,
    pending_kobo: 0,
    reserved_kobo: 0,
    held_kobo: 0,
    lifetime_earned_kobo: 0,
    lifetime_reversed_kobo: 0,
    withdrawn_kobo: 0,
    clawback_due_kobo: 0,
  };
}

export function walletView(wallet) {
  const source = wallet || emptyWallet('');
  return {
    availableKobo: source.available_kobo || 0,
    pendingKobo: source.pending_kobo || 0,
    reservedKobo: source.reserved_kobo || 0,
    heldKobo: source.held_kobo || 0,
    lifetimeEarnedKobo: source.lifetime_earned_kobo || 0,
    lifetimeReversedKobo: source.lifetime_reversed_kobo || 0,
    withdrawnKobo: source.withdrawn_kobo || 0,
    clawbackDueKobo: source.clawback_due_kobo || 0,
  };
}

export function presentBank(bank, { reveal = false } = {}) {
  if (!bank) return null;
  const accountNumber = String(bank.account_number || bank.accountNumber || '');
  const accountName = String(bank.account_name || bank.accountName || '');
  const bankName = String(bank.bank_name || bank.bankName || '');
  if (!reveal) {
    return {
      bankName,
      accountNumberMasked: maskAccountNumber(accountNumber),
      accountNameMasked: maskAccountName(accountName),
      verified: Boolean(bank.verified),
    };
  }
  return {
    bankName,
    accountNumber,
    accountName,
    bankCode: bank.bank_code || bank.bankCode || '',
    verified: Boolean(bank.verified),
  };
}

export function netPayoutKobo(amountKobo, feeKobo, payer) {
  if (payer === 'platform') return amountKobo;
  return amountKobo - feeKobo;
}

export function buildSignupAttribution({
  referredUserId,
  affiliateId,
  code,
  suspicious,
  settings,
  now,
  maskedLabel,
}) {
  return {
    id: referredUserId,
    affiliate_id: affiliateId,
    referred_user_id: referredUserId,
    code_used: code,
    status: 'registered',
    registered_at: now,
    first_purchase_at: null,
    window_started_at: null,
    window_ends_at: null,
    rate_bps: null,
    duration_days: null,
    hold_days: null,
    max_days_before_first_purchase: settings.maxDaysBeforeFirstPurchase,
    settings_snapshot_id: null,
    purchase_count: 0,
    earned_kobo: 0,
    suspicious: Boolean(suspicious),
    suspicion_cleared: false,
    masked_label: maskedLabel || 'C***',
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  };
}

export function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
