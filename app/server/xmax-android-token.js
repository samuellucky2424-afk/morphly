// Permanent credentials stay on the server; clients receive only bounded temporary keys.
export async function createXmaxAndroidKey({apiKey, maxSeconds, fetchImpl = fetch}) {
  if (!apiKey) return {error: {error: 'XMAX_NOT_CONFIGURED', details: 'XMax is not configured.'}};
  const sessionLimit = Math.min(1800, Math.max(1, Math.floor(Number(maxSeconds) || 0)));
  try {
    const response = await fetchImpl('https://api.xmax.cloud/open/api/v1/temporary-api-key', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Api-Key': apiKey},
      body: JSON.stringify({expireSeconds: sessionLimit + 120, pointsLimit: sessionLimit}),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => null);
    const token = body?.data?.temporaryApiKey;
    if (!response.ok || body?.success === false || typeof token !== 'string' || !token || token === apiKey) {
      return {error: {error: 'XMAX_SESSION_FAILED', providerStatus: response.status,
        details: 'XMax could not issue a temporary session. Check its server configuration and provider balance.'}};
    }
    return {token, sessionLimit, expiresAt: body.data.expireTimestamp ?? null};
  } catch {
    return {error: {error: 'XMAX_SESSION_FAILED', details: 'XMax could not be reached. Try again shortly.'}};
  }
}
