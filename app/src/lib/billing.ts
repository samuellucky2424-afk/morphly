import { DECART_REALTIME_PROVIDER } from './realtime-provider';

export const CREDITS_PER_SECOND_STANDARD = 2;
export const CREDITS_PER_SECOND_AVATAR = 2;
export const CREDITS_PER_SECOND_BACKGROUND = 2;
export const CREDITS_PER_SECOND_BLENDED = 4;
export const CREDITS_PER_SECOND = CREDITS_PER_SECOND_STANDARD;

/**
 * The "Pro" engine (decart / Lucy 2.5) bills at double the standard rate.
 * The "Plus" engine (xmax / X2) bills at the standard rate.
 */
export const PRO_PROVIDER_CREDIT_MULTIPLIER = 2;

export function getProviderCreditMultiplier(provider: string | null | undefined): number {
  return provider === DECART_REALTIME_PROVIDER ? PRO_PROVIDER_CREDIT_MULTIPLIER : 1;
}

export function getCreditRatePerSecond(
  hasAvatar: boolean,
  hasBackground: boolean,
  provider?: string | null | undefined,
): number {
  const baseRate = hasAvatar && hasBackground
    ? CREDITS_PER_SECOND_BLENDED
    : CREDITS_PER_SECOND_STANDARD;
  return baseRate * getProviderCreditMultiplier(provider);
}
