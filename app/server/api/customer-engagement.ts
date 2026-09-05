// @ts-nocheck
import { supabaseAdmin } from '../supabase-admin.js';
import { authenticateRequestUser, requireAdminContext } from '../../../shared/admin-auth.js';
import { cronAuthorized, deliverCustomerEmails, escapeHtml, isUuid, REVIEW_ADMIN_EMAIL, SOFTWARE_URL, tryDeliverCustomerEmails, validateAnnouncement, validateReview } from '../customer-engagement.js';

function headers(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', `${methods.join(', ')}, OPTIONS`);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
}
const check = ({ data, error }) => { if (error) throw error; return data; };

export function createEngagementHandler(route, { db = supabaseAdmin } = {}) {
  return async (req, res) => {
    const methods = route === 'announcements' ? ['GET'] : route === 'engagement-cron' ? ['GET'] : ['GET','POST'];
    headers(res, methods);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!methods.includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Customer communications are not configured yet.' });
    try {
      if (route === 'engagement-cron') {
        if (!cronAuthorized(req.headers?.authorization, process.env.CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });
        if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) return res.status(503).json({ error: 'Configure RESEND_API_KEY and RESEND_FROM_EMAIL first.' });
        const inactivityDays = Number(process.env.CUSTOMER_REMINDER_DAYS || 14);
        check(await db.rpc('morphly_schedule_customer_emails', { p_inactivity_days: inactivityDays }));
        return res.json(await deliverCustomerEmails(db, { limit: 100, budgetMs: 170000 }));
      }
      if (route === 'email-preferences') {
        const token = req.query?.token;
        if (!isUuid(token)) return res.status(400).json({ error: 'Invalid unsubscribe link.' });
        const pref = check(await db.from('customer_email_preferences').select('user_id').eq('unsubscribe_token', token).maybeSingle());
        if (!pref) return res.status(404).json({ error: 'This link is no longer valid.' });
        if (req.method === 'POST') check(await db.from('customer_email_preferences').update({ enabled: false, updated_at: new Date().toISOString() }).eq('unsubscribe_token', token));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.status(200).send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Morphly email preferences</title></head><body style="font:16px/1.6 system-ui;max-width:540px;margin:64px auto;padding:24px"><h1>${req.method === 'POST' ? 'You are unsubscribed' : 'Email preferences'}</h1><p>${req.method === 'POST' ? 'You will no longer receive experience surveys or purchase reminders.' : 'Stop receiving Morphly experience surveys and purchase reminders.'}</p>${req.method === 'GET' ? `<form method="post" action="?token=${escapeHtml(token)}"><button style="padding:12px 20px">Unsubscribe</button></form>` : ''}<p><a href="${SOFTWARE_URL}">Return to live.morphly.fun</a></p></body></html>`);
      }
      if (route === 'admin-engagement') {
        const admin = await requireAdminContext(req, res, db);
        if (!admin) return;
        if (req.method === 'POST') {
          const action = req.body?.action;
          if (action === 'publish') {
            let values;
            try { values = validateAnnouncement(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
            const announcement = check(await db.from('customer_announcements').insert({ ...values, created_by: admin.user.id }).select().single());
            check(await db.from('admin_audit_logs').insert({ admin_user_id: admin.user.id, action: 'announcement.published', target_type: 'announcement', target_id: announcement.id, after_data: announcement }));
            return res.status(201).json({ announcement });
          }
          if (action === 'end-announcement' && isUuid(req.body?.id)) {
            const announcement = check(await db.from('customer_announcements').update({ active: false, updated_at: new Date().toISOString() }).eq('id', req.body.id).select().single());
            check(await db.from('admin_audit_logs').insert({ admin_user_id: admin.user.id, action: 'announcement.ended', target_type: 'announcement', target_id: announcement.id }));
            return res.json({ announcement });
          }
          if (action === 'review-status' && isUuid(req.body?.id) && ['new','reviewed','resolved'].includes(req.body?.status)) {
            const review = check(await db.from('customer_reviews').update({ status: req.body.status }).eq('id', req.body.id).select().single());
            return res.json({ review });
          }
          return res.status(400).json({ error: 'Invalid communication action.' });
        }
        const offset = Math.max(0, Math.min(1000000, Number.parseInt(req.query?.offset || '0', 10) || 0));
        const reviewQuery = await db.from('customer_reviews').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + 49);
        const reviews = check(reviewQuery);
        const announcements = check(await db.from('customer_announcements').select('*').order('created_at', { ascending: false }).limit(50));
        const jobs = check(await db.from('customer_email_jobs').select('id,kind,status,created_at,sent_at,last_error').order('created_at', { ascending: false }).limit(30));
        return res.json({ reviews, reviewCount: reviewQuery.count, offset, announcements, jobs, email: { configured: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL), adminEmail: REVIEW_ADMIN_EMAIL, reminderDays: Number(process.env.CUSTOMER_REMINDER_DAYS || 14) } });
      }
      const auth = await authenticateRequestUser(req, db);
      if (auth.error) return res.status(auth.status).json({ error: auth.error });
      if (route === 'announcements') {
        const now = new Date().toISOString();
        const announcements = check(await db.from('customer_announcements').select('id,title,message,kind,starts_at,ends_at,revision').eq('active', true).lte('starts_at', now).or(`ends_at.is.null,ends_at.gt.${now}`).order('created_at', { ascending: false }).limit(5));
        return res.json({ announcements, serverTime: now });
      }
      if (route === 'feedback') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        let review;
        try { review = validateReview(req.body); } catch (error) { return res.status(400).json({ error: error.message }); }
        const profile = check(await db.from('users').select('account_status').eq('id', auth.user.id).maybeSingle());
        if (profile?.account_status === 'suspended') return res.status(403).json({ error: 'Account suspended.' });
        const result = await db.rpc('morphly_submit_review', { p_user: auth.user.id, p_id: review.id, p_category: review.category, p_rating: review.rating, p_message: review.message });
        if (result.error) {
          if (/five reviews per day/.test(result.error.message)) return res.status(429).json({ error: result.error.message });
          if (/conflicts/.test(result.error.message)) return res.status(409).json({ error: result.error.message });
          throw result.error;
        }
        await tryDeliverCustomerEmails(db, { userId: auth.user.id, sourceId: review.id, limit: 1 });
        return res.status(201).json({ id: result.data, message: 'Your feedback is saved. Thank you for helping improve Morphly.' });
      }
      return res.status(404).json({ error: 'Not found' });
    } catch {
      return res.status(503).json({ error: 'Customer communications are temporarily unavailable. Please try again.' });
    }
  };
}
