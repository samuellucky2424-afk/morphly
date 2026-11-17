#!/usr/bin/env node
/**
 * Find Morphly balances that look empty because a prepaid session hold was
 * taken out of the wallet and not put back.
 *
 * This file does not connect to morphly-production. It will not write credits.
 * Run it only as a checklist. The balance read and the next sign-in put an
 * unbilled hold back; this list is how to see who was affected before that.
 *
 * Database: Firestore database id `morphly-production`.
 *
 * Collections:
 *   users/{uid}                         email, account_status
 *   wallets  where user_id == uid       credits
 *   sessions where user_id == uid       status, reserved_half, output_started_epoch,
 *                                       last_heartbeat_at, start_time, seconds_used
 *   wallet_ledger where user_id == uid  entry_type == hold_release (after repair)
 *                                       entry_type == realtime_usage (already billed)
 *
 * A hold is reserved_half on the session, in half-credit units (2 half-credits
 * = 1 credit). While it is set, wallets.credits does not include it.
 *   live_hold          session still streaming. The credits are not spent.
 *   stale_no_output    session went quiet before any output. Return the hold.
 *   stale_with_output  session went quiet after output. Bill the streamed time,
 *                      then return whatever hold is left. Do not refund the
 *                      realtime_usage rows.
 *   ended_stranded     session is already ended and reserved_half is still set.
 *                      That remainder was never billed. Return it once.
 */

const HEARTBEAT_TIMEOUT_MS = 90000;

function reservedCredits(session) {
  const half = Number(session?.reserved_half || 0);
  return Number.isFinite(half) && half > 0 ? half / 2 : 0;
}

function classifyHold(session, now) {
  const active = session?.status === 'active';
  const beat = Date.parse(session?.last_heartbeat_at || session?.start_time || '');
  const stale = active && Number.isFinite(beat) && now - beat > HEARTBEAT_TIMEOUT_MS;
  const output = Number.isFinite(Number(session?.output_started_epoch));
  if (active && !stale) return 'live_hold';
  if (active && output) return 'stale_with_output';
  if (active) return 'stale_no_output';
  return 'ended_stranded';
}

export function planUnreturnedHolds({ userId, wallets = [], sessions = [], now = Date.now() } = {}) {
  if (!userId) throw new Error('userId is required');
  const ownedWallets = wallets.filter(wallet => wallet?.user_id === userId);
  const walletCredits = ownedWallets.map(wallet => Number(wallet.credits)).filter(Number.isFinite);
  const holds = sessions.filter(session => session?.user_id === userId && reservedCredits(session) > 0).map(session => {
    const kind = classifyHold(session, now);
    const credits = reservedCredits(session);
    return {
      sessionId: session.id,
      kind,
      reservedCredits: credits,
      // A live hold is still the customer's balance, but it stays on the session
      // until the stream ends. The other unbilled kinds are returned in full.
      // A stale session that already showed output is billed for that time first.
      action: kind === 'live_hold' ? 'keep_on_session' : kind === 'stale_with_output' ? 'bill_output_then_return_rest' : 'return_hold',
    };
  });
  const hiddenCredits = holds.reduce((sum, hold) => sum + hold.reservedCredits, 0);
  const shownFromWallet = walletCredits.length ? Math.max(...walletCredits) : 0;
  return {
    userId,
    duplicateWallets: ownedWallets.length > 1,
    walletCredits: shownFromWallet,
    holds,
    hiddenCredits,
    // What /wallet used to show before holds were counted.
    displayedWithoutHold: shownFromWallet,
    // What the customer still has before a stale output session is billed.
    balanceIncludingHolds: shownFromWallet + hiddenCredits,
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
    '2. Read wallets where user_id == uid. Note every credits value.',
    '   More than one wallet is a duplicate. The balance is the larger credits',
    '   value plus any holds below. Do not add the wallets together.',
    '3. Read sessions where user_id == uid and reserved_half > 0.',
    '   Hold credits = reserved_half / 2.',
    '4. Classify each hold:',
    '   status active, and last_heartbeat_at (or start_time) within 90 seconds:',
    '     live hold. The credits are not spent. Leave the session alone.',
    '   status active, heartbeat older than 90 seconds, no output_started_epoch:',
    '     return the whole hold. Nothing was streamed.',
    '   status active, heartbeat older than 90 seconds, output_started_epoch set:',
    '     bill streamed time through the heartbeat timeout, then return the rest.',
    '     Do not refund realtime_usage ledger rows.',
    '   any other status:',
    '     the session ended without releasing the hold. Return reserved_half / 2 once.',
    '5. Read wallet_ledger where user_id == uid and entry_type == hold_release.',
    '   If that session already has a release row, do not return it again.',
    '6. The next sign-in and the next /wallet read do this return themselves.',
    '   Use this list to confirm the amount. There is no --execute path.',
    '',
    'Refusing to write.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  if (process.argv.includes('--execute') || process.argv.includes('--apply')) {
    process.stderr.write('Refusing to write credits. Review the printed steps. Sign-in returns an unbilled hold.\n');
    process.exitCode = 2;
  } else {
    printSteps();
  }
}
