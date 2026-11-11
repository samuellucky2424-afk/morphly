const EXTERNAL_HOSTS = new Set(['checkout.flutterwave.com']);

export function classifyWindowTarget(url, { packaged = true } = {}) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return 'deny'; }
  if (parsed.protocol === 'file:') return 'allow';
  if (!packaged && parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) return 'allow';
  if (parsed.protocol === 'https:' && EXTERNAL_HOSTS.has(parsed.hostname)) return 'external';
  return 'deny';
}
