import { apiFetch, apiFetchWithAuth } from '@/lib/api-client';
export { shouldAutoStartOnboarding } from '@/components/onboarding/onboardingState';

export const CURRENT_ONBOARDING_VERSION = 1;

export interface OnboardingState {
  completed: boolean;
  completedAt: string | null;
  skippedAt: string | null;
  version: number;
  currentVersion: number;
}

export interface ReferralSummaryItem {
  id: string;
  status: 'registered' | 'qualified' | 'rewarded' | 'disqualified';
  createdAt: string;
  qualifiedAt: string | null;
  rewardedAt: string | null;
  refundWarning: boolean;
}

export interface ReferralSummary {
  referralCode: string;
  referredCount: number;
  qualifyingPurchaseCount: number;
  rewardedCount: number;
  totalReferralCreditsEarned: number;
  referrals: ReferralSummaryItem[];
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || `Request failed (${response.status})`);
  }
  return data as T;
}

export async function getOnboardingState(): Promise<OnboardingState> {
  const response = await apiFetchWithAuth('/account');
  const data = await parseApiResponse<{ onboarding: OnboardingState }>(response);
  return data.onboarding;
}

export async function updateOnboardingState(
  action: 'complete' | 'skip' | 'restart',
): Promise<OnboardingState> {
  const response = await apiFetchWithAuth('/account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const data = await parseApiResponse<{ onboarding: OnboardingState }>(response);
  return data.onboarding;
}

export async function claimSignupBonusWelcome(): Promise<boolean> {
  const response = await apiFetchWithAuth('/account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'claim-signup-welcome' }),
  });
  const data = await parseApiResponse<{ showWelcome: boolean }>(response);
  return Boolean(data.showWelcome);
}

export async function validateReferralCode(code: string): Promise<boolean> {
  const response = await apiFetch(`/referral-code?code=${encodeURIComponent(code)}`);
  const data = await parseApiResponse<{ valid: boolean }>(response);
  return Boolean(data.valid);
}

export async function getReferralSummary(): Promise<ReferralSummary> {
  const response = await apiFetchWithAuth('/referrals');
  return parseApiResponse<ReferralSummary>(response);
}
