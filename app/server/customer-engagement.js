import { timingSafeEqual } from 'node:crypto';

export const SOFTWARE_URL = 'https://live.morphly.fun';
export const REVIEW_ADMIN_EMAIL = 'samuellucky2424@gmail.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === 'string' && UUID.test(value);
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function cronAuthorized(header, secret) {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(String(header || ''));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validateReview(body) {
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!isUuid(body?.id)) throw new Error('A valid review request ID is required.');
  if (!['experience', 'issue', 'idea'].includes(body?.category)) throw new Error('Choose a review category.');
  if (message.length < 10 || message.length > 4000) throw new Error('Write between 10 and 4,000 characters.');
  const rating = body.rating ?? null;
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) throw new Error('Choose a rating from 1 to 5.');
  return { id: body.id, category: body.category, message, rating };
}

export function validateAnnouncement(body, now = new Date()) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!title || title.length > 100) throw new Error('Use a title of 1–100 characters.');
  if (!message || message.length > 500) throw new Error('Use a message of 1–500 characters.');
  if (!['update', 'maintenance'].includes(body.kind)) throw new Error('Choose update or maintenance.');
  const start = body.startsAt ? new Date(body.startsAt) : now;
  const end = body.endsAt ? new Date(body.endsAt) : null;
  if (!Number.isFinite(start.getTime()) || (end && (!Number.isFinite(end.getTime()) || end <= start || end <= now))) {
    throw new Error('The end time must be in the future and after the start time.');
  }
  return { title, message, kind: body.kind, starts_at: start.toISOString(), ends_at: end?.toISOString() || null, active: true };
}

const customerCopy = {
  signup_checkin: ['How is your Morphly experience?', 'You joined Morphly recently. Have you tried your first live stream? Tell us what worked, what got in the way, and what you would like us to improve or add.'],
  purchase_feedback: ['Thank you for choosing Morphly', 'Your purchase is complete. How has your experience been so far? We would love to hear what you enjoy, any issues you have had, and what we should improve next.'],
  credits_finished: ['How did your Morphly session go?', 'You have used your paid Morphly credits. How was the experience? Tell us what worked well, what needs attention, or which features you would like next.'],
  subscription_finished: ['Your Morphly plan has ended — how was it?', 'Your subscription period has ended. What did you think of Morphly? Please tell us what you would improve and whether anything would help you return.'],
  first_purchase_reminder: ['What would make Morphly better for you?', 'We noticed you have not made another purchase since your first one. Is there something about the experience, quality, pricing, or features that we could improve? We would appreciate your honest feedback.'],
};

export function renderEngagementEmail({ kind, email, review, unsubscribeToken, from, unsubscribeBase = SOFTWARE_URL }) {
  const isAdmin = kind === 'admin_review';
  const copy = customerCopy[kind];
  if (!isAdmin && !copy) throw new Error('Unsupported email type');
  const subject = isAdmin ? `Morphly review: ${review.category}${review.rating ? ` (${review.rating}/5)` : ''}` : copy[0];
  const message = isAdmin ? `From: ${review.email}\nCategory: ${review.category}\nRating: ${review.rating || 'Not rated'}\n\n${review.message}` : copy[1];
  const feedbackUrl = `${SOFTWARE_URL}/#/dashboard?feedback=1`;
  const unsubscribeUrl = `${unsubscribeBase.replace(/\/$/, '')}/api/email-preferences?token=${encodeURIComponent(unsubscribeToken || '')}`;
  const footer = isAdmin ? '' : `\n\nYou can reply to this email or leave feedback in Morphly.\nUnsubscribe from experience and reminder emails: ${unsubscribeUrl}`;
  return {
    from,
    to: [isAdmin ? REVIEW_ADMIN_EMAIL : email],
    reply_to: isAdmin ? review.email : REVIEW_ADMIN_EMAIL,
    subject,
    text: `${subject}\n\n${message}\n\n${isAdmin ? 'Open Morphly' : 'Share your experience'}: ${feedbackUrl}\nMorphly: ${SOFTWARE_URL}${footer}`,
    html: `<!doctype html><html><body style="margin:0;background:#ffffff;font-family:Arial,sans-serif;color:#20252d"><main style="max-width:560px;margin:32px auto;background:white;padding:32px;border:1px solid #e1e4e9;border-radius:12px"><a href="${SOFTWARE_URL}" style="color:#c82436;font-size:20px;font-weight:bold;text-decoration:none">Morphly</a><h1 style="font-size:23px;line-height:1.4;margin-top:28px">${escapeHtml(subject)}</h1><p style="font-size:16px;line-height:1.7;white-space:pre-wrap">${escapeHtml(message)}</p><p style="margin:28px 0"><a href="${feedbackUrl}" style="display:inline-block;background:#c82436;color:white;padding:13px 20px;border-radius:6px;text-decoration:none">${isAdmin ? 'Open Morphly' : 'Share your experience'}</a></p>${isAdmin ? '' : '<p style="font-size:14px;line-height:1.6">You can also reply directly to this email. We read every response.</p>'}<hr style="border:0;border-top:1px solid #e1e4e9"><p style="font-size:13px;line-height:1.6"><a href="${SOFTWARE_URL}" style="color:#c82436">live.morphly.fun</a>${isAdmin ? '' : `<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#c82436">Unsubscribe from experience and reminder emails</a>`}</p></main></body></html>`,
  };
}

export async function sendResendEmail(payload, id, { apiKey = process.env.RESEND_API_KEY, fetchImpl = fetch } = {}) {
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `morphly-engagement/${id}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    // Do not put recipient addresses, review text, API keys or provider responses in logs.
    throw new Error(`Resend delivery failed (HTTP ${response.status})`);
  }
  return data.id;
}

const check = ({ data, error }) => { if (error) throw error; return data; };

async function stillEligible(db, job) {
  if (job.kind === 'admin_review') return true;
  if (job.kind === 'subscription_finished') {
    const sub = check(await db.from('subscriptions').select('status, ends_at').eq('id', job.source_id).maybeSingle());
    return sub && (sub.status === 'expired' || (sub.status === 'active' && sub.ends_at && Date.parse(sub.ends_at) <= Date.now()));
  }
  const transactions = check(await db.from('transactions').select('id,status,refund_status').eq('user_id', job.user_id).or('transaction_type.eq.credit_purchase,and(transaction_type.is.null,type.eq.credit_purchase)'));
  const purchases = transactions.filter((item) => ['success', 'successful', 'completed'].includes(String(item.status).toLowerCase()));
  if (job.kind === 'signup_checkin') return purchases.length === 0;
  const purchase = purchases.find((item) => item.id === job.source_id && (!item.refund_status || item.refund_status === 'none'));
  if (!purchase) return false;
  if (job.kind === 'first_purchase_reminder') return purchases.length === 1;
  if (job.kind === 'credits_finished') {
    const wallet = check(await db.from('wallets').select('credits').eq('user_id', job.user_id).maybeSingle());
    return wallet && wallet.credits <= 0;
  }
  return true;
}

export async function deliverCustomerEmails(db, { userId = null, sourceId = null, limit = 1, budgetMs = 15000, env = process.env, fetchImpl = fetch } = {}) {
  if (!env.RESEND_API_KEY?.trim() || !env.RESEND_FROM_EMAIL?.trim()) return { configured: false, sent: 0 };
  const deadline = Date.now() + budgetMs;
  const result = { configured: true, sent: 0, cancelled: 0, failed: 0 };
  for (let i = 0; i < limit && Date.now() < deadline; i++) {
    const jobs = check(await db.rpc('morphly_claim_customer_email', { p_user: userId, p_job: sourceId }));
    const job = jobs?.[0];
    if (!job) break;
    const update = async (values) => check(await db.from('customer_email_jobs').update(values).eq('id', job.id).eq('lease_id', job.lease_id));
    try {
      const { data, error } = await db.auth.admin.getUserById(job.user_id);
      if (error) throw new Error('Could not load account email');
      const user = data?.user;
      let preferences;
      if (job.kind !== 'admin_review') {
        check(await db.from('customer_email_preferences').upsert({ user_id: job.user_id }, { onConflict: 'user_id', ignoreDuplicates: true }));
        preferences = check(await db.from('customer_email_preferences').select('enabled,unsubscribe_token').eq('user_id', job.user_id).single());
      }
      const profile = check(await db.from('users').select('account_status').eq('id', job.user_id).maybeSingle());
      if (!user?.email || (job.kind !== 'admin_review' && (!user.email_confirmed_at || !preferences?.enabled || profile?.account_status === 'suspended')) || !await stillEligible(db, job)) {
        await update({ status: 'cancelled', locked_until: null }); result.cancelled++; continue;
      }
      let payload = job.payload;
      if (!payload) {
        const review = job.kind === 'admin_review' ? check(await db.from('customer_reviews').select('email,category,rating,message').eq('id', job.source_id).single()) : null;
        payload = renderEngagementEmail({ kind: job.kind, email: user.email, review, unsubscribeToken: preferences?.unsubscribe_token, from: env.RESEND_FROM_EMAIL, unsubscribeBase: env.EMAIL_PUBLIC_BASE_URL || SOFTWARE_URL });
        // Save the exact request for identical provider retries, including after a crash.
        await update({ payload });
      }
      const providerId = await sendResendEmail(payload, job.id, { apiKey: env.RESEND_API_KEY, fetchImpl });
      await update({ status: 'sent', provider_id: providerId, sent_at: new Date().toISOString(), locked_until: null, last_error: null });
      result.sent++;
    } catch (error) {
      const permanent = job.attempts >= 8;
      await update({ status: permanent ? 'failed' : 'pending', last_error: /^Resend delivery failed/.test(error.message) ? error.message : 'Delivery temporarily unavailable', locked_until: null, due_at: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** job.attempts)).toISOString() });
      result.failed++;
    }
    if (limit > 1) await new Promise((resolve) => setTimeout(resolve, 600));
  }
  return result;
}

// Payment delivery must succeed even when email or its migration is unavailable.
export async function tryDeliverCustomerEmails(db, options) {
  try { return await deliverCustomerEmails(db, options); }
  catch { return { configured: Boolean(process.env.RESEND_API_KEY), sent: 0, failed: 1 }; }
}
