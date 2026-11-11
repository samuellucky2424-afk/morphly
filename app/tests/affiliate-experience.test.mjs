import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AFFILIATE_PROMPT_REPEAT_MS,
  affiliatePromptEligible,
  affiliateTourSteps,
  dismissAffiliatePrompt,
  readPromptRecord,
  readTourCompleted,
  shouldAutoStartAffiliateTour,
  shouldShowAffiliatePrompt,
  writePromptRecord,
  writeTourCompleted,
} from '../src/lib/affiliate-experience.ts';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-11T10:00:00Z');

function store() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('the affiliate prompt stays hidden until registrations are on or the person is an affiliate', () => {
  assert.equal(affiliatePromptEligible({ registrationsEnabled: false, isAffiliate: false }), false);
  assert.equal(affiliatePromptEligible({ registrationsEnabled: true, isAffiliate: false }), true);
  assert.equal(affiliatePromptEligible({ registrationsEnabled: false, isAffiliate: true }), true);
  assert.equal(shouldShowAffiliatePrompt({ eligible: false, record: null, now }), false);
  assert.equal(shouldShowAffiliatePrompt({ eligible: true, record: null, now }), true);
});

test('maybe later hides the prompt and allows one reminder after 14 days', () => {
  const first = dismissAffiliatePrompt(null, now, false);
  assert.equal(shouldShowAffiliatePrompt({ eligible: true, record: first, now: now + DAY }), false);
  assert.equal(shouldShowAffiliatePrompt({
    eligible: true,
    record: first,
    now: now + AFFILIATE_PROMPT_REPEAT_MS,
  }), true);
  const second = dismissAffiliatePrompt(first, now + AFFILIATE_PROMPT_REPEAT_MS, false);
  assert.equal(second.repeatUsed, true);
  assert.equal(shouldShowAffiliatePrompt({
    eligible: true,
    record: second,
    now: now + AFFILIATE_PROMPT_REPEAT_MS * 4,
  }), false);
});

test('opening the program does not schedule another reminder', () => {
  const engaged = dismissAffiliatePrompt(null, now, true);
  assert.equal(engaged.repeatUsed, true);
  assert.equal(shouldShowAffiliatePrompt({
    eligible: true,
    record: engaged,
    now: now + AFFILIATE_PROMPT_REPEAT_MS,
  }), false);
});

test('prompt and tour completion are stored per user', () => {
  const memory = store();
  assert.equal(readPromptRecord(memory, 'user-1'), null);
  writePromptRecord(memory, 'user-1', { dismissedAt: now, repeatUsed: false });
  assert.deepEqual(readPromptRecord(memory, 'user-1'), { dismissedAt: now, repeatUsed: false });
  assert.equal(readPromptRecord(memory, 'user-2'), null);
  memory.setItem('morphly-affiliate-prompt:user-3', '{');
  assert.equal(readPromptRecord(memory, 'user-3'), null);
  assert.equal(shouldAutoStartAffiliateTour(readTourCompleted(memory, 'user-1')), true);
  writeTourCompleted(memory, 'user-1');
  assert.equal(readTourCompleted(memory, 'user-1'), true);
  assert.equal(shouldAutoStartAffiliateTour(true), false);
  assert.equal(readTourCompleted(memory, 'user-2'), false);
});

test('the tour covers balances, sharing, windows, statuses, bank setup and the manual minimum', () => {
  const steps = affiliateTourSteps({
    rateLabel: 'Earn 6%',
    durationDays: 30,
    holdDays: 7,
    minWithdrawalKobo: 300000,
  });
  assert.deepEqual(steps.map((step) => step.id), ['balances', 'link', 'referrals', 'commissions', 'payout', 'minimum']);
  assert.match(steps[0].body, /Available/);
  assert.match(steps[0].body, /Pending/);
  assert.match(steps[0].body, /7-day hold/);
  assert.match(steps[1].body, /WhatsApp/);
  assert.match(steps[2].body, /30-day/);
  assert.match(steps[3].body, /Pending is in the holding period/);
  assert.match(steps[4].body, /Nigerian bank/);
  assert.match(steps[4].body, /manually/);
  assert.match(steps[5].body, /₦3,000/);
  assert.equal(steps[2].tab, 'referrals');
  assert.equal(steps[5].tab, 'payouts');
});

test('the feedback pop-out is replaced while the announcement bar and Feedback button stay', () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/components/CustomerEngagement.tsx'), 'utf8');
  const page = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/pages/Affiliate.tsx'), 'utf8');
  assert.match(source, /AffiliateProgramPrompt/);
  assert.match(source, /\/announcements/);
  assert.match(source, /> Feedback</);
  assert.match(source, /\/feedback/);
  assert.doesNotMatch(source, /promptedUsers/);
  assert.match(page, /Take the tour/);
  for (const target of ['balances', 'link', 'referrals', 'commissions', 'payout', 'minimum']) {
    assert.match(page, new RegExp(`data-affiliate-tour="${target}"`));
  }
});
