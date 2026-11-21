let cachedRates;
let pendingRates;
const CACHE_MS = 60 * 60 * 1000;

export async function getUsdExchangeRates() {
  if (cachedRates && Date.now() - cachedRates.fetchedAt < CACHE_MS) {
    return { ...cachedRates, cached: true };
  }
  if (pendingRates) return pendingRates;

  const key = process.env.EXCHANGE_RATE_API_KEY?.trim();
  if (!key) throw new Error('Exchange rates are not configured');

  pendingRates = (async () => {
    try {
      const response = await fetch(
        `https://v6.exchangerate-api.com/v6/${encodeURIComponent(key)}/latest/USD`,
        { signal: AbortSignal.timeout(5000), redirect: 'error' },
      );
      if (!response.ok) throw new Error('FX provider request failed');
      const data = await response.json();
      if (data.result !== 'success' || data.base_code !== 'USD' ||
          !Number.isFinite(data.conversion_rates?.NGN) || data.conversion_rates.NGN <= 0) {
        throw new Error('FX provider rates were invalid');
      }
      cachedRates = { rates: data.conversion_rates, fetchedAt: Date.now() };
      return { ...cachedRates, cached: false };
    } catch {
      throw new Error('Exchange rates are temporarily unavailable');
    }
  })();

  try {
    return await pendingRates;
  } finally {
    pendingRates = undefined;
  }
}
