// The packaged desktop app calls the API cross-origin (Origin: null), so every
// authenticated request is preceded by a CORS preflight. Answer it for all
// routes here; a handler that rejects OPTIONS (e.g. with 405) would otherwise
// make the browser block the real request with "Failed to fetch".
export function applyApiCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method !== 'OPTIONS') return false;
  res.setHeader('Access-Control-Max-Age', '600');
  res.status(204).end();
  return true;
}
