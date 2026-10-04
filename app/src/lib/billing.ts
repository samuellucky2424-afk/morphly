import { VIDU_REALTIME_PROVIDER } from './realtime-provider';

export const CREDITS_PER_SECOND_STANDARD = 2;
export const CREDITS_PER_SECOND_AVATAR = 2;
export const CREDITS_PER_SECOND_BACKGROUND = 2;
export const CREDITS_PER_SECOND_BLENDED = 4;
export const CREDITS_PER_SECOND = CREDITS_PER_SECOND_STANDARD;

export const CREDITS_PER_SECOND_PRO = 2.5;
export const PRO_PROVIDER_CREDIT_MULTIPLIER = CREDITS_PER_SECOND_PRO / CREDITS_PER_SECOND_STANDARD;

export function getProviderCreditMultiplier(provider: string | null | undefined): number {
  return provider === 'decart'
    ? PRO_PROVIDER_CREDIT_MULTIPLIER
    : 1;
}

export function getCreditRatePerSecond(
  hasAvatar: boolean,
  hasBackground: boolean,
  provider?: string | null | undefined,
): number {
  if (provider === 'decart') return CREDITS_PER_SECOND_PRO;
  if (provider === VIDU_REALTIME_PROVIDER) return CREDITS_PER_SECOND_STANDARD;
  const baseRate = hasAvatar && hasBackground
    ? CREDITS_PER_SECOND_BLENDED
    : CREDITS_PER_SECOND_STANDARD;
  return baseRate * getProviderCreditMultiplier(provider);
}

// The existing billing API accepts whole usage units worth two credits each.
// Keep fractional units between flushes; round down only when sending usage.
export function getBillableUsageUnits(seconds: number, blended: boolean, provider: string): number {
  return seconds * getCreditRatePerSecond(blended, blended, provider) / CREDITS_PER_SECOND_STANDARD;
}
