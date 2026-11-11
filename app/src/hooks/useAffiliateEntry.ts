import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { apiFetchWithAuth } from '@/lib/api-client';

export interface AffiliateEntry {
  sublabel: string;
  view: 'apply' | 'dashboard';
}

function rateLabel(bps: number) {
  const percent = bps / 100;
  const text = Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
  return `Earn ${text}%`;
}

export function useAffiliateEntry(): AffiliateEntry | null {
  const { user } = useAuth();
  const [entry, setEntry] = useState<AffiliateEntry | null>(null);

  useEffect(() => {
    if (!user?.id) {
      setEntry(null);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetchWithAuth('/affiliate');
        if (!response.ok) {
          if (!cancelled) setEntry(null);
          return;
        }
        const data = await response.json() as {
          affiliate?: { status?: string; rateBps?: number } | null;
          program?: { registrationsEnabled?: boolean; defaultRateBps?: number };
        };
        const affiliate = data.affiliate;
        const visible = Boolean(affiliate) || Boolean(data.program?.registrationsEnabled);
        if (!visible) {
          if (!cancelled) setEntry(null);
          return;
        }
        const approved = affiliate?.status === 'active' || affiliate?.status === 'suspended';
        const sublabel = affiliate?.status === 'pending'
          ? 'Application in review'
          : affiliate?.status === 'rejected'
            ? 'Application update'
            : rateLabel(affiliate?.rateBps || data.program?.defaultRateBps || 600);
        if (!cancelled) setEntry({ sublabel, view: approved ? 'dashboard' : 'apply' });
      } catch {
        if (!cancelled) setEntry(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  return entry;
}
