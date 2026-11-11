import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BadgePercent } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { apiFetchWithAuth } from '@/lib/api-client';
import { ROUTES } from '@/lib/routes';
import {
  affiliatePromptEligible,
  dismissAffiliatePrompt,
  readPromptRecord,
  shouldShowAffiliatePrompt,
  writePromptRecord,
} from '@/lib/affiliate-experience';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

function formatNaira(kobo: number): string {
  return `₦${Math.floor(Math.abs(kobo) / 100).toLocaleString('en-NG')}`;
}

export function AffiliateProgramPrompt({ paused = false }: { paused?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const closing = useRef(false);
  const [copy, setCopy] = useState({ rate: 'Earn 6%', days: 30, hold: 7, minimum: '₦3,000' });

  useEffect(() => {
    if (!user?.id || paused) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await apiFetchWithAuth('/affiliate', { signal: controller.signal });
          if (!response.ok || controller.signal.aborted) return;
          const data = await response.json() as {
            affiliate?: { status?: string } | null;
            program?: { registrationsEnabled?: boolean; defaultRateBps?: number; durationDays?: number; holdDays?: number; minWithdrawalKobo?: number; earnLabel?: string };
          };
          const eligible = affiliatePromptEligible({
            registrationsEnabled: Boolean(data.program?.registrationsEnabled),
            isAffiliate: Boolean(data.affiliate),
          });
          const record = readPromptRecord(window.localStorage, user.id);
          if (!shouldShowAffiliatePrompt({ eligible, record, now: Date.now() })) return;
          closing.current = false;
          const rateBps = data.program?.defaultRateBps ?? 600;
          const percent = rateBps / 100;
          setCopy({
            rate: data.program?.earnLabel || `Earn ${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`,
            days: data.program?.durationDays ?? 30,
            hold: data.program?.holdDays ?? 7,
            minimum: formatNaira(data.program?.minWithdrawalKobo ?? 300000),
          });
          setOpen(true);
        } catch {
          /* A failed eligibility check must not open the prompt. */
        }
      })();
    }, 1000);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [paused, user?.id]);

  function remember(engaged: boolean) {
    if (!user?.id || closing.current) return;
    closing.current = true;
    const current = readPromptRecord(window.localStorage, user.id);
    writePromptRecord(window.localStorage, user.id, dismissAffiliatePrompt(current, Date.now(), engaged));
    setOpen(false);
  }

  if (!user) return null;

  return (
    <Dialog open={open && !paused} onOpenChange={(next) => { if (!next) remember(false); }}>
      <DialogContent className="morphly-feedback-dialog morphly-affiliate-prompt" showCloseButton={false}>
        <DialogHeader>
          <span className="morphly-feedback-eyebrow">Affiliate program</span>
          <DialogTitle>Earn when people you invite buy credits</DialogTitle>
          <DialogDescription>
            {copy.rate} on every qualifying credit purchase your referrals make, paid in Naira to your Nigerian bank account.
          </DialogDescription>
        </DialogHeader>
        <ul className="morphly-affiliate-points">
          <li>Share your personal Morphly link.</li>
          <li>Their first purchase must be within {copy.days} days of signup. You then earn for {copy.days} days from that purchase.</li>
          <li>Commission waits {copy.hold} days, then becomes available.</li>
          <li>Withdraw from {copy.minimum}. An admin sends the transfer. Morphly does not pay it automatically.</li>
        </ul>
        <div className="morphly-feedback-actions">
          <button type="button" onClick={() => remember(false)}>Maybe later</button>
          <button
            type="button"
            className="community-primary"
            onClick={() => {
              remember(true);
              navigate(ROUTES.PROTECTED.AFFILIATE);
            }}
          >
            <BadgePercent size={16} aria-hidden="true" /> Become an affiliate
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
