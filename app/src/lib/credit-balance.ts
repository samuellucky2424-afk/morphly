/** Shown until /wallet returns. A loaded balance of zero is a real zero. */
export function formatCreditBalance(credits: number, ready: boolean): string {
  if (!ready || !Number.isFinite(credits)) return '…';
  return Math.round(credits).toLocaleString();
}
