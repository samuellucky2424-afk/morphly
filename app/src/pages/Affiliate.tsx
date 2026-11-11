import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { BadgePercent, Copy, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetchWithAuth } from '@/lib/api-client';
import { firebaseSessionClient } from '@/lib/firebase-auth';

type Tab = 'overview' | 'referrals' | 'commissions' | 'payouts' | 'bank';

interface ProgramState {
  program: {
    registrationsEnabled: boolean;
    commissionsEnabled: boolean;
    defaultRateBps: number;
    durationDays: number;
    maxDaysBeforeFirstPurchase: number;
    minWithdrawalKobo: number;
    holdDays: number;
    estimatedTransferFeeKobo: number;
    transferFeePayer: 'affiliate' | 'platform';
    earnLabel: string;
    payoutsManual: boolean;
  };
  affiliate: null | {
    status: string;
    code: string | null;
    link: string | null;
    rateBps: number;
    rejectionReason?: string;
  };
  wallet: {
    availableKobo: number;
    pendingKobo: number;
    reservedKobo: number;
    lifetimeEarnedKobo: number;
    withdrawnKobo: number;
    clawbackDueKobo: number;
    heldKobo: number;
  };
  stats: {
    totalReferrals: number;
    payingReferrals: number;
    activeWindowReferrals: number;
    expiredReferrals: number;
    conversionRate: number;
  };
  referrals: Array<{ id: string; maskedLabel: string; status: string; registeredAt: string; windowEndsAt: string | null; earnedKobo: number; purchaseCount: number }>;
  commissions: Array<{ id: string; status: string; amountKobo: number; purchaseKobo: number; rateBps: number; createdAt: string; availableAt: string | null }>;
  withdrawals: Array<{ id: string; status: string; amountKobo: number; feeKobo: number; netKobo: number; createdAt: string; transferRef: string | null; bank: { bankName: string; accountNumberMasked: string; accountNameMasked: string } | null }>;
  bank: null | { bankName: string; accountNumberMasked: string; accountNameMasked: string; verified: boolean };
  banks: Array<{ code: string; name: string }>;
}

function formatNgn(kobo: number) {
  const sign = kobo < 0 ? '-' : '';
  const abs = Math.abs(kobo);
  return `${sign}₦${Math.floor(abs / 100).toLocaleString('en-NG')}.${String(abs % 100).padStart(2, '0')}`;
}

function formatWhen(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function confirmRecentSignIn(password: string) {
  if (password.trim()) {
    await firebaseSessionClient.auth.reauthenticateWithPassword(password);
  } else {
    await firebaseSessionClient.auth.reauthenticateWithGoogle();
  }
  await firebaseSessionClient.auth.refreshSession();
}

export default function Affiliate() {
  const location = useLocation();
  const preferred = (location.state as { view?: string } | null)?.view;
  const [data, setData] = useState<ProgramState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<Tab>(preferred === 'dashboard' ? 'overview' : 'overview');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [amountNaira, setAmountNaira] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await apiFetchWithAuth('/affiliate');
      const body = await response.json() as ProgramState & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to load the affiliate program');
      setData(body);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load the affiliate program');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function apply() {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const response = await apiFetchWithAuth('/affiliate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply', acceptTerms }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to submit the application');
      setNotice('Application received.');
      await load();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Unable to submit the application');
    } finally {
      setBusy(false);
    }
  }

  async function saveBank() {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      await confirmRecentSignIn(password);
      const response = await apiFetchWithAuth('/affiliate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save-bank', bankCode, accountNumber, accountName }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to save bank details');
      setPassword('');
      setAccountNumber('');
      setNotice('Bank details saved. A Morphly admin verifies them before you can withdraw.');
      await load();
    } catch (bankError) {
      setError(bankError instanceof Error ? bankError.message : 'Unable to save bank details');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    const naira = Number(amountNaira);
    if (!Number.isFinite(naira) || naira <= 0) {
      setError('Enter a withdrawal amount in naira.');
      return;
    }
    const amountKobo = Math.round(naira * 100);
    if (Math.abs(naira * 100 - amountKobo) > 0.001) {
      setError('Use at most two decimal places.');
      return;
    }
    setBusy(true);
    setNotice('');
    setError('');
    try {
      await confirmRecentSignIn(password);
      const response = await apiFetchWithAuth('/affiliate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'withdraw', amountKobo }),
      });
      const body = await response.json() as { error?: string; netKobo?: number };
      if (!response.ok) throw new Error(body.error || 'Unable to request a withdrawal');
      setPassword('');
      setAmountNaira('');
      setNotice(`Withdrawal requested. Morphly pays ${formatNgn(body.netKobo || amountKobo)} manually after approval.`);
      await load();
    } catch (withdrawError) {
      setError(withdrawError instanceof Error ? withdrawError.message : 'Unable to request a withdrawal');
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error(`Unable to copy ${label.toLowerCase()}.`);
    }
  }

  if (loading && !data) {
    return (
      <div className="mx-auto max-w-5xl space-y-4" aria-busy="true">
        <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-24 animate-pulse rounded-xl bg-muted" />)}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>Affiliate program</CardTitle>
          <CardDescription>We could not load your affiliate details.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-destructive" role="alert">{error || 'Something went wrong.'}</p>
          <Button type="button" onClick={() => void load()}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  const affiliate = data.affiliate;
  const closed = !data.program.registrationsEnabled && !affiliate;
  if (closed) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>Affiliate program</CardTitle>
          <CardDescription>Applications are currently closed.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">The usual Morphly referral reward is unchanged. Check back when applications open.</p>
        </CardContent>
      </Card>
    );
  }

  if (!affiliate || affiliate.status === 'pending' || affiliate.status === 'rejected') {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Morphly</p>
          <h1 className="text-2xl font-semibold tracking-tight">Become an affiliate</h1>
          <p className="mt-1 text-sm text-muted-foreground">{data.program.earnLabel} on qualifying credit purchases for {data.program.durationDays} days after a referred customer’s first payment.</p>
        </div>
        {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        {notice ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">{notice}</p> : null}
        {affiliate?.status === 'pending' ? (
          <Card><CardHeader><CardTitle>Application in review</CardTitle><CardDescription>We will use your existing referral code if the application is approved. Your link is not active yet.</CardDescription></CardHeader></Card>
        ) : null}
        {affiliate?.status === 'rejected' ? (
          <Card><CardHeader><CardTitle>Application not approved</CardTitle><CardDescription>{affiliate.rejectionReason || 'You can contact support if you think this is a mistake.'}</CardDescription></CardHeader></Card>
        ) : null}
        {!affiliate || affiliate.status === 'rejected' ? (
          <Card>
            <CardHeader>
              <CardTitle>Affiliate terms</CardTitle>
              <CardDescription>Commission is paid in Naira, not usage credits. There is a {data.program.holdDays}-day hold and a {formatNgn(data.program.minWithdrawalKobo)} minimum withdrawal. Payouts are sent manually to a verified Nigerian bank account.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-sm leading-6 text-muted-foreground">
                <p>You earn commission only on a referred customer’s successful paid credit purchases. The first purchase must happen within {data.program.maxDaysBeforeFirstPurchase} days of signup, and later purchases earn only inside the {data.program.durationDays}-day window that starts then. Free credits, signup bonuses, manual credits and refunded payments do not earn. Self-referrals are not allowed. Morphly can pause new applications or new commissions without changing commissions already earned.</p>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={acceptTerms} onChange={(event) => setAcceptTerms(event.target.checked)} />
                <span>I agree to the affiliate terms.</span>
              </label>
              <Button type="button" disabled={!acceptTerms || busy || !data.program.registrationsEnabled} onClick={() => void apply()}>
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : <BadgePercent className="size-4" />}
                Apply
              </Button>
              {!data.program.registrationsEnabled ? <p className="text-sm text-muted-foreground">Applications are closed right now.</p> : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    );
  }

  const fee = data.program.transferFeePayer === 'affiliate' ? data.program.estimatedTransferFeeKobo : 0;
  const requestedKobo = Math.round(Number(amountNaira || 0) * 100);
  const netKobo = Number.isFinite(requestedKobo) ? Math.max(0, requestedKobo - fee) : 0;
  const shareUrl = affiliate.link || '';
  const shareText = encodeURIComponent(`Try Morphly with my link ${shareUrl}`);
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'referrals', label: 'Referrals' },
    { id: 'commissions', label: 'Commissions' },
    { id: 'payouts', label: 'Payouts' },
    { id: 'bank', label: 'Bank account' },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Affiliate program</p>
          <h1 className="text-2xl font-semibold tracking-tight">{affiliate.status === 'suspended' ? 'Affiliate access paused' : 'Your earnings'}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {tabs.map((item) => (
            <Button key={item.id} type="button" variant={tab === item.id ? 'default' : 'outline'} size="sm" onClick={() => setTab(item.id)}>{item.label}</Button>
          ))}
        </div>
      </div>
      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {notice ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800" role="status">{notice}</p> : null}
      {!data.program.commissionsEnabled ? <p className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">New commissions are paused. Amounts already earned are unchanged.</p> : null}

      {tab === 'overview' ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Available', data.wallet.availableKobo],
              ['Pending', data.wallet.pendingKobo],
              ['Lifetime', data.wallet.lifetimeEarnedKobo],
              ['Withdrawn', data.wallet.withdrawnKobo],
            ].map(([label, value]) => (
              <Card key={String(label)}><CardHeader className="pb-2"><CardDescription>{label}</CardDescription><CardTitle>{formatNgn(Number(value))}</CardTitle></CardHeader></Card>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Referrals', String(data.stats.totalReferrals)],
              ['Paying', String(data.stats.payingReferrals)],
              ['Active windows', String(data.stats.activeWindowReferrals)],
              ['Conversion', `${Math.round(data.stats.conversionRate * 100)}%`],
            ].map(([label, value]) => (
              <Card key={label}><CardHeader className="pb-2"><CardDescription>{label}</CardDescription><CardTitle className="text-xl">{value}</CardTitle></CardHeader></Card>
            ))}
          </div>
          {affiliate.link ? (
            <Card>
              <CardHeader>
                <CardTitle>Referral link</CardTitle>
                <CardDescription>Share this link. Old signup links with the same code still work.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <code className="flex-1 overflow-hidden text-ellipsis rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{affiliate.link}</code>
                  <Button type="button" variant="outline" onClick={() => void copy(affiliate.link || '', 'Referral link')}><Copy className="size-4" />Copy</Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" asChild><a href={`https://wa.me/?text=${shareText}`} target="_blank" rel="noreferrer">WhatsApp</a></Button>
                  <Button type="button" variant="outline" size="sm" asChild><a href={`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${shareText}`} target="_blank" rel="noreferrer">Telegram</a></Button>
                  <Button type="button" variant="outline" size="sm" asChild><a href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`} target="_blank" rel="noreferrer">Facebook</a></Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => void copy(shareUrl, 'TikTok link')}>TikTok</Button>
                </div>
              </CardContent>
            </Card>
          ) : <p className="text-sm text-muted-foreground">Your referral link appears after approval.</p>}
          {data.wallet.clawbackDueKobo > 0 ? <p className="text-sm text-muted-foreground">A refund left {formatNgn(data.wallet.clawbackDueKobo)} to offset against your next available commission. Morphly does not take this from your bank.</p> : null}
        </div>
      ) : null}

      {tab === 'referrals' ? (
        <Card>
          <CardHeader><CardTitle>Referrals</CardTitle><CardDescription>Customer names and emails are hidden.</CardDescription></CardHeader>
          <CardContent className="overflow-x-auto">
            {data.referrals.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No referrals yet. Share your link to get started.</p> : (
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="py-2">Customer</th><th>Status</th><th>Joined</th><th>Window ends</th><th>Earned</th></tr></thead>
                <tbody>
                  {data.referrals.map((row) => (
                    <tr key={row.id} className="border-t border-border"><td className="py-2">{row.maskedLabel}</td><td className="capitalize">{row.status.replaceAll('_', ' ')}</td><td>{formatWhen(row.registeredAt)}</td><td>{formatWhen(row.windowEndsAt)}</td><td>{formatNgn(row.earnedKobo)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      ) : null}

      {tab === 'commissions' ? (
        <Card>
          <CardHeader><CardTitle>Commission history</CardTitle><CardDescription>Each row is one paid purchase. Pending amounts are on hold for {data.program.holdDays} days.</CardDescription></CardHeader>
          <CardContent className="overflow-x-auto">
            {data.commissions.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No commissions yet.</p> : (
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="py-2">When</th><th>Purchase</th><th>Rate</th><th>Commission</th><th>Status</th></tr></thead>
                <tbody>
                  {data.commissions.map((row) => (
                    <tr key={row.id} className="border-t border-border"><td className="py-2">{formatWhen(row.createdAt)}</td><td>{formatNgn(row.purchaseKobo)}</td><td>{(row.rateBps / 100).toFixed(row.rateBps % 100 ? 1 : 0)}%</td><td>{formatNgn(row.amountKobo)}</td><td className="capitalize">{row.status}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      ) : null}

      {tab === 'payouts' ? (
        <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Request a withdrawal</CardTitle>
              <CardDescription>Minimum {formatNgn(data.program.minWithdrawalKobo)}. Morphly sends the net amount manually after approval. Automatic payouts are not available.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="withdraw-amount">Amount (NGN)</Label>
                <Input id="withdraw-amount" inputMode="decimal" value={amountNaira} onChange={(event) => setAmountNaira(event.target.value)} placeholder="3000" />
              </div>
              <p className="text-sm text-muted-foreground">Estimated transfer fee {formatNgn(fee)} ({data.program.transferFeePayer === 'affiliate' ? 'deducted from this withdrawal' : 'paid by Morphly'}). Net to your bank: {formatNgn(netKobo)}.</p>
              <div className="space-y-1">
                <Label htmlFor="withdraw-password">Confirm it’s you</Label>
                <Input id="withdraw-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password, or leave blank for Google" />
              </div>
              <Button type="button" disabled={busy || affiliate.status !== 'active' || !data.bank?.verified} onClick={() => void withdraw()}>Request withdrawal</Button>
              {!data.bank?.verified ? <p className="text-sm text-muted-foreground">Save a bank account and wait for verification before withdrawing.</p> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Withdrawal history</CardTitle></CardHeader>
            <CardContent className="overflow-x-auto">
              {data.withdrawals.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No withdrawals yet.</p> : (
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-muted-foreground"><tr><th className="py-2">When</th><th>Net</th><th>Bank</th><th>Status</th></tr></thead>
                  <tbody>
                    {data.withdrawals.map((row) => (
                      <tr key={row.id} className="border-t border-border"><td className="py-2">{formatWhen(row.createdAt)}</td><td>{formatNgn(row.netKobo)}</td><td>{row.bank ? `${row.bank.bankName} ${row.bank.accountNumberMasked}` : '—'}</td><td className="capitalize">{row.status}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {tab === 'bank' ? (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Bank account</CardTitle>
            <CardDescription>Nigerian bank account only. The full account number is masked here. Changing it requires a fresh sign-in.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.bank ? <p className="text-sm">Current: {data.bank.bankName}, {data.bank.accountNameMasked}, {data.bank.accountNumberMasked}. {data.bank.verified ? 'Verified.' : 'Waiting for verification.'}</p> : <p className="text-sm text-muted-foreground">No bank account saved.</p>}
            <div className="space-y-1">
              <Label htmlFor="bank">Bank</Label>
              <select id="bank" className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm" value={bankCode} onChange={(event) => setBankCode(event.target.value)}>
                <option value="">Select a bank</option>
                {data.banks.map((bank) => <option key={bank.code} value={bank.code}>{bank.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="nuban">Account number</Label>
              <Input id="nuban" inputMode="numeric" maxLength={10} value={accountNumber} onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="10-digit NUBAN" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="account-name">Account name</Label>
              <Input id="account-name" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="Name on the account" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bank-password">Confirm it’s you</Label>
              <Input id="bank-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password, or leave blank for Google" />
            </div>
            <Button type="button" disabled={busy} onClick={() => void saveBank()}>Save bank details</Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
