#!/usr/bin/env node
/**
 * Find a Morphly session that was charged for connect time and never delivered
 * a frame, and describe the Firestore reads an admin would use to refund it.
 *
 * This file does not connect to morphly-production. It will not write credits.
 * Run it only as a checklist. Apply the refund from the admin dashboard, or
 * with admin_adjust_credits, after a person has confirmed the rows.
 *
 * Database: Firestore database id `morphly-production`.
 *
 * Collections:
 *   users/{uid}                         email, account_status
 *   wallets  where user_id == uid       credits
 *   sessions where user_id == uid       provider, status, seconds_used,
 *                                       start_time, end_time, end_reason
 *   analytics_events where user_id == uid
 *                                       event_name == first_frame_received,
 *                                       session_id
 *   wallet_ledger where user_id == uid  entry_type == realtime_usage, delta
 *   transactions where user_id == uid   transaction_type == signup_bonus,
 *                                       reference == signup_bonus:{uid}
 *
 * A charged connect has seconds_used > 0, no first_frame_received event for
 * that session, and negative realtime_usage ledger deltas. Refund that amount
 * once, with a new idempotency key. Do not delete the usage rows.
 */

export function planConnectChargeRefund({ userId, sessions = [], events = [], ledger = [] } = {}) {
  if (!userId) throw new Error('userId is required');
  const framed = new Set(
    events.filter(event => event?.event_name === 'first_frame_received' && event.session_id).map(event => event.session_id),
  );
  const affected = sessions.filter(session => session?.user_id === userId && Number(session.seconds_used) > 0 && !framed.has(session.id));
  const usageDebits = ledger.filter(entry => {
    if (entry?.user_id !== userId || entry.entry_type !== 'realtime_usage' || !(Number(entry.delta) < 0)) return false;
    const at = Date.parse(entry.created_at || '');
    if (!Number.isFinite(at)) return affected.length === 1;
    return affected.some(session => {
      const start = Date.parse(session.start_time || '');
      const end = Date.parse(session.end_time || '');
      if (!Number.isFinite(start)) return affected.length === 1;
      const endMs = Number.isFinite(end) ? end + 5000 : start + 3600000;
      return at >= start - 5000 && at <= endMs;
    });
  });
  const chargedCredits = usageDebits.reduce((sum, entry) => sum + Math.abs(Number(entry.delta)), 0);
  return {
    userId,
    affectedSessionIds: affected.map(session => session.id),
    chargedCredits,
    refundCredits: affected.length ? chargedCredits : 0,
    write: false,
  };
}

function printSteps() {
  const lines = [
    'Dry run only. This script does not read or write morphly-production.',
    '',
    '1. In Firestore database morphly-production, find the user:',
    '   collection users, field email == the account email.',
    '   The document id is the uid.',
    '2. Read wallets where user_id == uid. Note credits.',
    '3. Read sessions where user_id == uid. Keep rows with seconds_used > 0.',
    '4. Read analytics_events where user_id == uid and event_name == first_frame_received.',
    '   Drop any session whose id appears as session_id on those events.',
    '5. Read wallet_ledger where user_id == uid and entry_type == realtime_usage.',
    '   Sum the absolute value of negative deltas. That is the charged amount.',
    '6. Read transactions where reference == signup_bonus:{uid} to see the original 50 credit grant.',
    '7. Refund once with admin_adjust_credits (super admin), amount = that sum,',
    '   reason mentioning the session id, and a new idempotency key.',
    '   Leave the usage ledger rows in place.',
    '',
    'Refusing to write. There is no --execute path.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  if (process.argv.includes('--execute') || process.argv.includes('--apply')) {
    process.stderr.write('Refusing to write credits. Review the printed steps and refund from the admin dashboard.\n');
    process.exitCode = 2;
  } else {
    printSteps();
  }
}
