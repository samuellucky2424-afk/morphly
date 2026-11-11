export function missingBillingFunction(error) {
  return ['PGRST202', '42883'].includes(error?.code);
}

export async function realtimeWalletBalance(supabase, userId, fallback) {
  const result = await supabase.rpc('realtime_wallet_balance', { p_user: userId });
  if (missingBillingFunction(result.error)) return Number(fallback || 0);
  if (result.error) throw result.error;
  return result.data == null ? Number(fallback || 0) : Number(result.data);
}

export async function recordRealtimeVideo(supabase, userId, body, close = false) {
  const seconds = body.epochSeconds ?? [];
  const blendedSeconds = body.blendedSeconds ?? [];
  if ([seconds, blendedSeconds].some(values => !Array.isArray(values) || values.length > 60 || values.some(value => !Number.isSafeInteger(value)))) {
    throw new Error('Invalid video usage timestamps.');
  }
  // Client epoch lists are ignored by timestamp billing. Wall-clock settlement
  // below is the source of truth; this call remains for older adapters.
  return settleRealtimeVideo(supabase, userId, body.sessionId, close, { extend: body.acceptRenewal === true });
}

// Bills server elapsed time, looping until a long gap fits in one commit.
export async function settleRealtimeVideo(supabase, userId, sessionId, close = false, extra = {}) {
  let result;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await supabase.rpc('record_realtime_video_usage', {
      p_user: userId,
      p_session: sessionId,
      p_epoch_seconds: [],
      p_close: close,
      p_extend: extra.extend === true,
    });
    if (response.error) throw response.error;
    result = response.data;
    if (!result?.billingIncomplete) break;
  }
  return result;
}
