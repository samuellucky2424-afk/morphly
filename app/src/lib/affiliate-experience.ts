/** Show/dismiss rules for the affiliate introduction and the dashboard tour. */

export const AFFILIATE_PROMPT_REPEAT_MS = 14 * 24 * 60 * 60 * 1000;

export interface AffiliatePromptRecord {
  dismissedAt: number;
  /** True after the one allowed reminder, or after the person opens the program. */
  repeatUsed: boolean;
}

export interface AffiliateTourStep {
  id: string;
  tab: 'overview' | 'referrals' | 'commissions' | 'payouts' | 'bank';
  target: string;
  title: string;
  body: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function affiliatePromptEligible(input: {
  registrationsEnabled: boolean;
  isAffiliate: boolean;
}): boolean {
  return input.registrationsEnabled || input.isAffiliate;
}

export function shouldShowAffiliatePrompt(input: {
  eligible: boolean;
  record: AffiliatePromptRecord | null;
  now: number;
  repeatAfterMs?: number;
}): boolean {
  if (!input.eligible) return false;
  if (!input.record) return true;
  if (input.record.repeatUsed) return false;
  const gap = input.repeatAfterMs ?? AFFILIATE_PROMPT_REPEAT_MS;
  return input.now - input.record.dismissedAt >= gap;
}

export function dismissAffiliatePrompt(
  record: AffiliatePromptRecord | null,
  now: number,
  engaged: boolean,
): AffiliatePromptRecord {
  if (engaged || record) return { dismissedAt: now, repeatUsed: true };
  return { dismissedAt: now, repeatUsed: false };
}

export function promptStorageKey(userId: string): string {
  return `morphly-affiliate-prompt:${userId}`;
}

export function tourStorageKey(userId: string): string {
  return `morphly-affiliate-tour:${userId}`;
}

export function readPromptRecord(store: KeyValueStore, userId: string): AffiliatePromptRecord | null {
  const raw = store.getItem(promptStorageKey(userId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AffiliatePromptRecord>;
    if (typeof parsed.dismissedAt !== 'number' || typeof parsed.repeatUsed !== 'boolean') return null;
    return { dismissedAt: parsed.dismissedAt, repeatUsed: parsed.repeatUsed };
  } catch {
    return null;
  }
}

export function writePromptRecord(store: KeyValueStore, userId: string, record: AffiliatePromptRecord): void {
  store.setItem(promptStorageKey(userId), JSON.stringify(record));
}

export function readTourCompleted(store: KeyValueStore, userId: string): boolean {
  return store.getItem(tourStorageKey(userId)) === 'completed';
}

export function writeTourCompleted(store: KeyValueStore, userId: string): void {
  store.setItem(tourStorageKey(userId), 'completed');
}

export function shouldAutoStartAffiliateTour(completed: boolean): boolean {
  return !completed;
}

function naira(kobo: number): string {
  const abs = Math.abs(kobo);
  return `₦${Math.floor(abs / 100).toLocaleString('en-NG')}`;
}

export function affiliateTourSteps(program: {
  rateLabel: string;
  durationDays: number;
  holdDays: number;
  minWithdrawalKobo: number;
}): AffiliateTourStep[] {
  return [
    {
      id: 'balances',
      tab: 'overview',
      target: 'balances',
      title: 'Your four balances',
      body: `Available can be withdrawn. Pending is still in the ${program.holdDays}-day hold and is not withdrawable yet. Lifetime is everything you have earned. Withdrawn is what Morphly has already paid.`,
    },
    {
      id: 'link',
      tab: 'overview',
      target: 'link',
      title: 'Share your link',
      body: `Copy the link or send it on WhatsApp, Telegram, Facebook, or TikTok. You ${program.rateLabel.toLowerCase()} on qualifying credit purchases.`,
    },
    {
      id: 'referrals',
      tab: 'referrals',
      target: 'referrals',
      title: 'Referral windows',
      body: `Each customer has their own ${program.durationDays}-day earning window, starting at their first successful purchase. Purchases after that date earn nothing. Names and emails stay hidden.`,
    },
    {
      id: 'commissions',
      tab: 'commissions',
      target: 'commissions',
      title: 'Commission statuses',
      body: 'Pending is in the holding period. Available has cleared the hold. Held is waiting for an admin review. Reversed means the purchase was refunded.',
    },
    {
      id: 'payout',
      tab: 'payouts',
      target: 'payout',
      title: 'Withdraw to your bank',
      body: 'Add a Nigerian bank account and wait until an admin verifies it. Then request a withdrawal. Morphly pays it manually. Automatic payouts are not available.',
    },
    {
      id: 'minimum',
      tab: 'payouts',
      target: 'minimum',
      title: 'Minimum and manual payout',
      body: `The minimum withdrawal is ${naira(program.minWithdrawalKobo)}. After you confirm, an admin sends the net amount and marks the request Paid.`,
    },
  ];
}
