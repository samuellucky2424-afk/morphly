import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';

import { logErrorEvent, logRequestEvent } from '../../shared/backend-logger.js';

function printUsage() {
  process.stdout.write(
    [
      'Usage: npm run cleanup:stale-sessions -- [--apply] [--user <uuid>] [--older-than-minutes <minutes>]',
      '',
      'Options:',
      '  --apply                  Actually close the matched active sessions.',
      '  --user <uuid>            Restrict cleanup to one user.',
      '  --older-than-minutes <n> Only match sessions older than n minutes.',
      '  --help                   Show this help text.',
      '',
      'Without --apply, the command runs in dry-run mode and only lists matches.',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = {
    apply: false,
    help: false,
    olderThanMinutes: null,
    userId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--apply') {
      args.apply = true;
      continue;
    }

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    if (token === '--user' && argv[index + 1]) {
      args.userId = argv[index + 1];
      index += 1;
      continue;
    }

    if (token.startsWith('--user=')) {
      args.userId = token.slice('--user='.length);
      continue;
    }

    if (token === '--older-than-minutes' && argv[index + 1]) {
      args.olderThanMinutes = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token.startsWith('--older-than-minutes=')) {
      args.olderThanMinutes = Number(token.slice('--older-than-minutes='.length));
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (args.olderThanMinutes !== null && (!Number.isFinite(args.olderThanMinutes) || args.olderThanMinutes < 0)) {
    throw new Error('Expected --older-than-minutes to be a non-negative number');
  }

  return args;
}

function normalizeSecondsUsed(value) {
  const seconds = Number(value ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

function normalizeCost(value) {
  const cost = Number(value ?? 0);
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

function getSessionAgeMinutes(startTime) {
  const timestamp = new Date(startTime).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
}

function formatSessionsForOutput(sessions) {
  return sessions.map((session) => ({
    sessionId: session.id,
    userId: session.user_id,
    startedAt: session.start_time,
    ageMinutes: getSessionAgeMinutes(session.start_time),
    secondsUsed: normalizeSecondsUsed(session.seconds_used),
    cost: normalizeCost(session.cost),
    createdAt: session.created_at,
  }));
}

async function main() {
  const { apply, help, olderThanMinutes, userId } = parseArgs(process.argv.slice(2));

  if (help) {
    printUsage();
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Missing SUPABASE_URL/VITE_SUPABASE_URL or SUPABASE_SERVICE_KEY/SUPABASE_SERVICE_ROLE_KEY');
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let query = supabaseAdmin
    .from('sessions')
    .select('id, user_id, start_time, seconds_used, cost, created_at')
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (userId) {
    query = query.eq('user_id', userId);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  let sessions = data ?? [];

  if (olderThanMinutes !== null) {
    sessions = sessions.filter((session) => {
      const ageMinutes = getSessionAgeMinutes(session.start_time);
      return ageMinutes !== null && ageMinutes >= olderThanMinutes;
    });
  }

  await logRequestEvent('cleanup-stale-sessions.scan', {
    apply,
    userId,
    olderThanMinutes,
    matchedSessions: sessions.length,
  });

  if (sessions.length === 0) {
    process.stdout.write('No matching active sessions found.\n');
    return;
  }

  const printableSessions = formatSessionsForOutput(sessions);
  console.table(printableSessions);

  if (!apply) {
    process.stdout.write(`Dry run only. Re-run with --apply to close ${sessions.length} session(s).\n`);
    return;
  }

  const closedAt = new Date().toISOString();
  const results = await Promise.all(
    sessions.map((session) =>
      supabaseAdmin
        .from('sessions')
        .update({
          end_time: closedAt,
          status: 'ended',
          seconds_used: normalizeSecondsUsed(session.seconds_used),
          cost: normalizeCost(session.cost),
        })
        .eq('id', session.id)
        .eq('status', 'active'),
    ),
  );

  const failedResult = results.find((result) => result?.error);
  if (failedResult?.error) {
    throw failedResult.error;
  }

  await logRequestEvent('cleanup-stale-sessions.applied', {
    userId,
    olderThanMinutes,
    closedSessions: sessions.length,
    closedAt,
  });

  process.stdout.write(`Closed ${sessions.length} active session(s).\n`);
}

main().catch(async (error) => {
  await logErrorEvent('cleanup-stale-sessions.exception', error);
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});