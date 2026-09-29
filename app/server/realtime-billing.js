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
  const result = await supabase.rpc('record_realtime_video_usage', {
    p_user: userId, p_session: body.sessionId, p_epoch_seconds: seconds,
    p_close: close, p_blended: body.blended === true,
    p_blended_seconds: blendedSeconds,
  });
  if (result.error) throw result.error;
  return result.data;
}
