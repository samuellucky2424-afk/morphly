export const REFERRAL_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6,12}$/;

export function normalizeReferralCode(value: string): string {
  return value.trim().toUpperCase().slice(0, 12);
}

export function getReferralCodeFormatError(value: string): string | null {
  const normalized = normalizeReferralCode(value);
  if (!normalized) return null;
  if (!REFERRAL_CODE_PATTERN.test(normalized)) {
    return 'Use 6 to 12 uppercase letters and numbers. The characters I, O, 0 and 1 are not used.';
  }
  return null;
}

export function isReferralCodeFormatValid(value: string): boolean {
  return REFERRAL_CODE_PATTERN.test(normalizeReferralCode(value));
}
