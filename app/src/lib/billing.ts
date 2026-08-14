export const CREDITS_PER_SECOND_STANDARD = 2;
export const CREDITS_PER_SECOND_AVATAR = 2;
export const CREDITS_PER_SECOND_BACKGROUND = 2;
export const CREDITS_PER_SECOND_BLENDED = 4;
export const CREDITS_PER_SECOND = CREDITS_PER_SECOND_STANDARD;

export function getCreditRatePerSecond(hasAvatar: boolean, hasBackground: boolean): number {
  if (hasAvatar && hasBackground) {
    return CREDITS_PER_SECOND_BLENDED;
  }
  return CREDITS_PER_SECOND_STANDARD;
}