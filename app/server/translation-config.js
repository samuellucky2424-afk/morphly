// Only deployment-owned environment values may choose where clients send tokens.
// Never derive this URL from an untrusted Host or X-Forwarded-Host header.
export function resolveTranslationGatewayUrl(env = process.env) {
  if (env.TRANSLATION_GATEWAY_URL?.trim()) return env.TRANSLATION_GATEWAY_URL.trim();
  if (!env.GEMINI_API_KEY?.trim() || env.VERCEL !== '1') return '';
  const host = env.VERCEL_ENV === 'production'
    ? env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL
    : env.VERCEL_URL;
  if (!host || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) return '';
  return `wss://${host}/api/translation/live`;
}
