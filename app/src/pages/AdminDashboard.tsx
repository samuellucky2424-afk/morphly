import { useEffect, useMemo, useRef, useState } from 'react';
import { AdminEngagement } from '@/components/AdminEngagement';
import {
  Activity,
  AlertTriangle,
  Ban,
  ChevronRight,
  Coins,
  DollarSign,
  Gift,
  Loader2,
  LogOut,
  RefreshCcw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  WalletCards,
} from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/context/AuthContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiFetchWithAuth } from '@/lib/api-client';

interface AdminUserRecord {
  id: string;
  email: string;
  name: string;
  createdAt: string | null;
  lastSignInAt: string | null;
  credits: number;
  isAdmin: boolean;
  adminRole: string | null;
}

interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  priceNGN: number;
  isActive: boolean;
  sortOrder: number;
}

interface AdminOverview {
  totalUsers: number;
  blockedUsers: number;
  totalCredits: number;
  revenueNGN: number;
  activeSessions: number;
}

interface AuditLogEntry {
  timestamp?: string;
  channel?: string;
  event?: string;
  [key: string]: unknown;
}

type CreditAdjustmentMode = 'add' | 'deduct';

interface AdminUsageUser {
  userId: string;
  email: string;
  isAdmin: boolean;
  walletCredits: number;
  explainedCreditGrants: number;
  unexplainedBalanceCredits: number;
  sessions: number;
  activeSessions: number;
  tokenMints: number;
  auditedTokenMints: number;
  recordedSeconds: number;
  recordedCredits: number;
  untrackedExposureSeconds: number;
  untrackedExposureCredits: number;
  installationIds: string[];
  installationCount: number;
  suspicious: boolean;
  suspiciousReasons: string[];
  lastActivityAt: string | null;
}

interface AdminUsageData {
  periodDays: number;
  since: string | null;
  asOf: string | null;
  totals: {
    users: number;
    sessions: number;
    activeSessions: number;
    recordedSeconds: number;
    recordedCredits: number;
    untrackedExposureSeconds: number;
    untrackedExposureCredits: number;
    usersWithUsageGaps: number;
    auditedTokenMints: number;
  };
  users: AdminUsageUser[];
  dataHealth: {
    analyticsAvailable: boolean;
    walletLedgerAvailable: boolean;
    tokenAuditEnabled: boolean;
  };
}

interface AdminReferralRecord {
  id: string;
  referralCodeUsed: string;
  referrerEmail: string;
  referrerCode: string | null;
  referredEmail: string;
  status: 'registered' | 'qualified' | 'rewarded' | 'disqualified';
  registeredAt: string | null;
  rewardedAt: string | null;
  disqualificationReason: string | null;
  refundWarning: boolean;
  suspicious: boolean;
  suspiciousReason: string | null;
  firstQualifyingPurchase: {
    id: string;
    reference: string | null;
    package: string | null;
    status: string | null;
    refundStatus: string;
    verifiedAt: string | null;
  } | null;
  rewardTransaction: {
    id: string;
    reference: string | null;
    credits: number;
    status: string | null;
    createdAt: string | null;
  } | null;
}

interface AdminReferralData {
  referrals: AdminReferralRecord[];
  totals: {
    registrations: number;
    waitingForPurchase: number;
    rewarded: number;
    disqualified: number;
    referralCreditsIssued: number;
    signupBonusesIssued: number;
    signupBonusCreditsIssued: number;
    suspicious: number;
  };
  audit: Array<{
    id: number;
    action: string;
    referral_id: string | null;
    referrer_user_id: string | null;
    referred_user_id: string | null;
    actor_user_id: string | null;
    metadata: Record<string, unknown>;
    created_at: string | null;
  }>;
}

const ngnFormatter = new Intl.NumberFormat('en-NG', {
  style: 'currency',
  currency: 'NGN',
  maximumFractionDigits: 0,
});

async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetchWithAuth(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Request failed with status ${response.status}`);
  }

  return payload as T;
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
  }).format(new Date(value));
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return 'Never';
  }

  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatCurrency(value: number) {
  return ngnFormatter.format(Number.isFinite(value) ? value : 0);
}

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function summarizeAuditEntry(entry: AuditLogEntry) {
  const details = { ...entry };
  delete details.timestamp;
  delete details.channel;
  delete details.event;

  const serialized = JSON.stringify(details);
  if (!serialized || serialized === '{}') {
    return 'No extra metadata';
  }

  return serialized.length > 120 ? `${serialized.slice(0, 117)}...` : serialized;
}

function getChannelBadgeClass(channel: string | undefined) {
  switch (channel) {
    case 'error':
      return 'border-destructive/25 bg-danger-soft text-destructive';
    case 'payment':
      return 'border-success/25 bg-success-soft text-success';
    case 'db-query':
      return 'border-primary/25 bg-accent text-primary';
    default:
      return 'border-primary/25 bg-accent text-primary';
  }
}

function AdminDashboard() {
  const { user, logout } = useAuth();
  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [overview, setOverview] = useState<AdminOverview>({
    totalUsers: 0,
    blockedUsers: 0,
    totalCredits: 0,
    revenueNGN: 0,
    activeSessions: 0,
  });
  const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([]);
  const [usageData, setUsageData] = useState<AdminUsageData>({
    periodDays: 30,
    since: null,
    asOf: null,
    totals: {
      users: 0,
      sessions: 0,
      activeSessions: 0,
      recordedSeconds: 0,
      recordedCredits: 0,
      untrackedExposureSeconds: 0,
      untrackedExposureCredits: 0,
      usersWithUsageGaps: 0,
      auditedTokenMints: 0,
    },
    users: [],
    dataHealth: {
      analyticsAvailable: false,
      walletLedgerAvailable: false,
      tokenAuditEnabled: false,
    },
  });
  const [referralData, setReferralData] = useState<AdminReferralData>({
    referrals: [],
    totals: {
      registrations: 0,
      waitingForPurchase: 0,
      rewarded: 0,
      disqualified: 0,
      referralCreditsIssued: 0,
      signupBonusesIssued: 0,
      signupBonusCreditsIssued: 0,
      suspicious: 0,
    },
    audit: [],
  });
  const [referralFilter, setReferralFilter] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [activeTab, setActiveTab] = useState('users');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [savingPackages, setSavingPackages] = useState(false);
  const [creditDialogUser, setCreditDialogUser] = useState<AdminUserRecord | null>(null);
  const [creditAdjustmentMode, setCreditAdjustmentMode] = useState<CreditAdjustmentMode>('add');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditReason, setCreditReason] = useState('');
  const [isSubmittingCredit, setIsSubmittingCredit] = useState(false);
  const creditOperationRef = useRef<{ signature: string; key: string } | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [disqualifyingReferralId, setDisqualifyingReferralId] = useState<string | null>(null);

  const loadDashboardData = async (options?: { silent?: boolean }) => {
    if (options?.silent) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const [usersResult, packagesResult, overviewResult, auditResult, referralsResult, usageResult] = await Promise.allSettled([
        adminRequest<{ users: AdminUserRecord[] }>('/admin-users'),
        adminRequest<{ packages: CreditPackage[] }>('/admin-credit-packages'),
        adminRequest<AdminOverview>('/admin-overview'),
        adminRequest<{ entries: AuditLogEntry[] }>('/admin-audit-log?limit=50'),
        adminRequest<AdminReferralData>('/admin-referrals'),
        adminRequest<AdminUsageData>('/admin-usage'),
      ]);

      if (usersResult.status === 'fulfilled') setUsers(usersResult.value.users || []);
      if (packagesResult.status === 'fulfilled') setPackages(packagesResult.value.packages || []);
      if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value);
      if (auditResult.status === 'fulfilled') setAuditEntries(auditResult.value.entries || []);
      if (referralsResult.status === 'fulfilled') setReferralData(referralsResult.value);
      if (usageResult.status === 'fulfilled') setUsageData(usageResult.value);

      const failedSections = [
        usersResult.status === 'rejected' ? 'users' : null,
        packagesResult.status === 'rejected' ? 'packages' : null,
        overviewResult.status === 'rejected' ? 'overview' : null,
        auditResult.status === 'rejected' ? 'audit log' : null,
        referralsResult.status === 'rejected' ? 'referrals' : null,
        usageResult.status === 'rejected' ? 'AI usage' : null,
      ].filter((section): section is string => Boolean(section));

      if (failedSections.length > 0) {
        const sectionNames = failedSections.join(', ');
        toast.error(`Some dashboard sections could not be loaded: ${sectionNames}`);
      }
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : 'Failed to load admin dashboard');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void loadDashboardData();
  }, []);

  const filteredUsers = useMemo(() => {
    const query = appliedSearch.trim().toLowerCase();
    if (!query) {
      return users;
    }

    return users.filter((entry) =>
      [entry.name, entry.email]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(query)),
    );
  }, [appliedSearch, users]);

  const activePackageCount = useMemo(
    () => packages.filter((pkg) => pkg.isActive).length,
    [packages],
  );

  const filteredReferrals = useMemo(() => {
    if (referralFilter === 'all') {
      return referralData.referrals;
    }
    if (referralFilter === 'registered') {
      return referralData.referrals.filter((entry) => entry.status !== 'disqualified');
    }
    if (referralFilter === 'waiting') {
      return referralData.referrals.filter((entry) => entry.status === 'registered');
    }
    return referralData.referrals.filter((entry) => entry.status === referralFilter);
  }, [referralData.referrals, referralFilter]);

  const overviewCards = [
    {
      title: 'Total users',
      value: overview.totalUsers.toLocaleString(),
      description: 'Registered accounts',
      icon: Users,
      iconClassName: 'bg-accent text-primary',
    },
    {
      title: 'Blocked',
      value: overview.blockedUsers.toLocaleString(),
      description: 'Restricted accounts',
      icon: Ban,
      iconClassName: 'bg-danger-soft text-destructive',
    },
    {
      title: 'Total credits',
      value: overview.totalCredits.toLocaleString(),
      description: 'Wallet balance outstanding',
      icon: Coins,
      iconClassName: 'bg-success-soft text-success',
    },
    {
      title: 'Revenue (NGN)',
      value: formatCurrency(overview.revenueNGN),
      description: 'Successful credit sales',
      icon: DollarSign,
      iconClassName: 'bg-muted text-foreground',
    },
    {
      title: 'Active sessions',
      value: overview.activeSessions.toLocaleString(),
      description: 'Currently consuming credits',
      icon: Activity,
      iconClassName: 'bg-accent text-primary',
    },
    {
      title: 'Live packages',
      value: activePackageCount.toLocaleString(),
      description: 'Visible on the pricing page',
      icon: WalletCards,
      iconClassName: 'bg-warning-soft text-warning',
    },
  ];

  const updatePackage = (packageId: string, changes: Partial<CreditPackage>) => {
    setPackages((currentPackages) =>
      currentPackages.map((pkg) => (pkg.id === packageId ? { ...pkg, ...changes } : pkg)),
    );
  };

  const handleSavePackages = async () => {
    setSavingPackages(true);

    try {
      const response = await adminRequest<{ packages: CreditPackage[] }>('/admin-credit-packages', {
        method: 'PUT',
        body: JSON.stringify({ packages }),
      });

      setPackages(response.packages || []);
      toast.success('Credit pricing updated');
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : 'Failed to save pricing');
    } finally {
      setSavingPackages(false);
    }
  };

  const resetCreditDialog = () => {
    setCreditDialogUser(null);
    setCreditAdjustmentMode('add');
    setCreditAmount('');
    setCreditReason('');
  };

  const handleAdjustCredits = async () => {
    if (!creditDialogUser) {
      return;
    }

    const parsedCredits = Number(creditAmount);
    if (!Number.isSafeInteger(parsedCredits) || parsedCredits <= 0 || parsedCredits > 1_000_000) {
      toast.error('Enter a whole number between 1 and 1,000,000');
      return;
    }

    if (creditAdjustmentMode === 'deduct' && parsedCredits > creditDialogUser.credits) {
      toast.error(`This user only has ${creditDialogUser.credits.toLocaleString()} credits`);
      return;
    }

    if (creditAdjustmentMode === 'deduct' && user?.adminRole !== 'super_admin') {
      toast.error('Only a super admin can deduct credits');
      return;
    }

    const reason = creditReason.trim();
    if (reason.length < 3) {
      toast.error('Enter a reason of at least 3 characters');
      return;
    }

    const adjustment = creditAdjustmentMode === 'deduct' ? -parsedCredits : parsedCredits;
    const operationSignature = JSON.stringify({
      userId: creditDialogUser.id,
      adjustment,
      reason,
    });
    const creditOperation = creditOperationRef.current?.signature === operationSignature
      ? creditOperationRef.current
      : {
        signature: operationSignature,
        key: `admin:${crypto.randomUUID()}`,
      };
    creditOperationRef.current = creditOperation;

    setIsSubmittingCredit(true);

    try {
      const response = await adminRequest<{
        newCredits: number;
        adjustment: number;
        creditsAdded: number;
        creditsDeducted: number;
      }>('/admin-users', {
        method: 'POST',
        body: JSON.stringify({
          action: 'credits',
          userId: creditDialogUser.id,
          adjustment,
          reason,
          idempotencyKey: creditOperation.key,
        }),
      });

      setUsers((currentUsers) =>
        currentUsers.map((entry) =>
          entry.id === creditDialogUser.id
            ? { ...entry, credits: response.newCredits }
            : entry,
        ),
      );
      setOverview((currentOverview) => ({
        ...currentOverview,
        totalCredits: Math.max(0, currentOverview.totalCredits + response.adjustment),
      }));
      creditOperationRef.current = null;
      resetCreditDialog();
      toast.success(
        response.adjustment < 0
          ? `Deducted ${response.creditsDeducted.toLocaleString()} credits`
          : `Added ${response.creditsAdded.toLocaleString()} credits`,
      );
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : 'Failed to adjust credits');
    } finally {
      setIsSubmittingCredit(false);
    }
  };

  const handleDeleteUser = async (targetUser: AdminUserRecord) => {
    const confirmed = window.confirm(`Delete ${targetUser.email}? This removes the user account and all linked app data.`);
    if (!confirmed) {
      return;
    }

    setDeletingUserId(targetUser.id);

    try {
      await adminRequest('/admin-users', {
        method: 'DELETE',
        body: JSON.stringify({ userId: targetUser.id }),
      });

      setUsers((currentUsers) => currentUsers.filter((entry) => entry.id !== targetUser.id));
      setOverview((currentOverview) => ({
        ...currentOverview,
        totalUsers: Math.max(0, currentOverview.totalUsers - 1),
        totalCredits: Math.max(0, currentOverview.totalCredits - targetUser.credits),
      }));
      toast.success(`Deleted ${targetUser.email}`);
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : 'Failed to delete user');
    } finally {
      setDeletingUserId(null);
    }
  };

  const handleDisqualifyReferral = async (entry: AdminReferralRecord) => {
    const reason = window.prompt(
      `Why should the referral for ${entry.referredEmail} be disqualified?`,
    );
    if (reason === null) return;
    if (reason.trim().length < 3) {
      toast.error('Enter a disqualification reason of at least 3 characters.');
      return;
    }

    setDisqualifyingReferralId(entry.id);
    try {
      await adminRequest('/admin-referrals', {
        method: 'POST',
        body: JSON.stringify({
          referralId: entry.id,
          reason: reason.trim(),
        }),
      });
      toast.success('Referral disqualified and recorded in the audit log.');
      await loadDashboardData({ silent: true });
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : 'Failed to disqualify referral');
    } finally {
      setDisqualifyingReferralId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted px-6">
        <div className="flex flex-col items-center gap-4 rounded-[24px] border border-border bg-background px-10 py-12 text-muted-foreground shadow-[0_30px_90px_-50px_rgba(15,23,42,0.25)]">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <p className="text-sm font-medium">Loading admin dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted text-foreground">
      <header className="border-b border-border bg-muted backdrop-blur">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-background text-foreground shadow-[0_20px_40px_-25px_rgba(15,23,42,0.6)]">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">Morphly</p>
              <h1 className="text-lg font-semibold tracking-tight text-foreground">Admin Console</h1>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Badge variant="outline" className="justify-center rounded-full border-success/25 bg-success-soft px-3 py-1 text-success">
              Online
            </Badge>
            <div className="text-right">
              <p className="text-sm font-medium text-foreground">{user?.email || 'Admin session'}</p>
              <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">RLS protected</p>
            </div>
            <Button
              variant="outline"
              onClick={() => void logout()}
              className="h-10 rounded-full border-primary/25 bg-background px-4 text-foreground hover:bg-muted"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8">
        <section className="relative overflow-hidden rounded-[30px] border border-border bg-background shadow-[0_35px_90px_-55px_rgba(15,23,42,0.35)]">
          <div className="absolute inset-x-0 top-0 h-1 bg-primary" />
          <div className="relative px-6 py-6 sm:px-8 sm:py-8">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.34em] text-muted-foreground">Overview</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">Operations Dashboard</h2>
                <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                  Monitor balances, live sessions, and pricing controls from a single protected workspace.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="rounded-2xl border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
                  Signed in as <span className="font-semibold text-foreground">{user?.email || 'admin user'}</span>
                </div>
                <Button
                  onClick={() => void loadDashboardData({ silent: true })}
                  disabled={isRefreshing}
                  className="h-11 rounded-full bg-primary px-5 text-primary-foreground hover:bg-primary-hover"
                >
                  {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                  Refresh data
                </Button>
              </div>
            </div>

            <div className="mt-8 grid overflow-hidden rounded-[24px] border border-border bg-background md:grid-cols-2 xl:grid-cols-3">
              {overviewCards.map((card) => {
                const Icon = card.icon;

                return (
                  <div
                    key={card.title}
                    className="border-b border-border p-6 md:[&:nth-last-child(-n+2)]:border-b-0 xl:[&:nth-last-child(-n+3)]:border-b-0 xl:border-r xl:[&:nth-child(3n)]:border-r-0"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">{card.title}</p>
                        <p className="mt-4 text-3xl font-semibold tracking-tight text-foreground">{card.value}</p>
                        <p className="mt-2 text-sm text-muted-foreground">{card.description}</p>
                      </div>
                      <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ${card.iconClassName}`}>
                        <Icon className="h-5 w-5" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="mt-8 overflow-hidden rounded-[30px] border border-border bg-background shadow-[0_35px_90px_-55px_rgba(15,23,42,0.35)]">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-0">
            <div className="border-b border-border px-6 py-5 sm:px-8">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.34em] text-muted-foreground">Workspace</p>
                  <h3 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">Operations Controls</h3>
                  <p className="mt-2 text-sm text-muted-foreground">Users, pricing, and backend audit trails aligned in one admin surface.</p>
                </div>

                <TabsList className="h-auto flex-wrap rounded-2xl bg-muted p-1">
                  <TabsTrigger value="communications" className="rounded-full px-4 py-2.5 text-sm text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground">Feedback & notices</TabsTrigger>
                  <TabsTrigger
                    value="users"
                    className="rounded-full px-4 py-2.5 text-sm text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none"
                  >
                    Users
                  </TabsTrigger>
                  <TabsTrigger
                    value="usage"
                    className="rounded-full px-4 py-2.5 text-sm text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none"
                  >
                    AI Usage
                  </TabsTrigger>
                  <TabsTrigger
                    value="referrals"
                    className="rounded-full px-4 py-2.5 text-sm text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none"
                  >
                    Referrals
                  </TabsTrigger>
                  <TabsTrigger
                    value="pricing"
                    className="rounded-full px-4 py-2.5 text-sm text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none"
                  >
                    Pricing
                  </TabsTrigger>
                  <TabsTrigger
                    value="audit"
                    className="rounded-full px-4 py-2.5 text-sm text-muted-foreground data-[state=active]:border-transparent data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none"
                  >
                    Audit Log
                  </TabsTrigger>
                </TabsList>
              </div>
            </div>

            <TabsContent value="communications" className="m-0 p-6 sm:p-8"><AdminEngagement /></TabsContent>
            <TabsContent value="users" className="m-0 p-6 sm:p-8">
              <div className="overflow-hidden rounded-[24px] border border-border bg-muted">
                <div className="border-b border-border px-5 py-5">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div>
                      <h4 className="text-lg font-semibold text-foreground">Users</h4>
                      <p className="mt-1 text-sm text-muted-foreground">Inspect balances, apply credits, and remove access when required.</p>
                    </div>

                    <div className="flex flex-col gap-3 md:flex-row md:items-center">
                      <div className="relative w-full md:w-[320px]">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={searchInput}
                          onChange={(event) => setSearchInput(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              setAppliedSearch(searchInput);
                            }
                          }}
                          placeholder="Search by name or email"
                          className="h-11 rounded-full border-primary/25 bg-background pl-10 text-foreground"
                        />
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => setAppliedSearch(searchInput)}
                        className="h-11 rounded-full border-primary/25 bg-background px-5 text-foreground hover:bg-muted"
                      >
                        Search
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setSearchInput('');
                          setAppliedSearch('');
                        }}
                        className="h-11 rounded-full px-4 text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        Reset
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-2 border-b border-border px-5 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Search via admin directory</p>
                  <p>{filteredUsers.length.toLocaleString()} visible records</p>
                </div>

                <Table className="min-w-[920px]">
                  <TableHeader>
                    <TableRow className="border-border bg-background hover:bg-background">
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Email</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Credits</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Status</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Joined</TableHead>
                      <TableHead className="px-5 py-4 text-right text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredUsers.length === 0 ? (
                      <TableRow className="border-border hover:bg-transparent">
                        <TableCell colSpan={5} className="px-5 py-16 text-center text-sm text-muted-foreground">
                          No users match the current filter.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredUsers.map((entry) => (
                        <TableRow key={entry.id} className="border-border bg-background hover:bg-muted">
                          <TableCell className="px-5 py-4 align-top whitespace-normal">
                            <div className="min-w-[220px]">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-medium text-foreground">{entry.email}</p>
                                {entry.isAdmin && (
                                  <Badge variant="outline" className="rounded-full border-warning/25 bg-warning-soft text-warning">
                                    {entry.adminRole || 'admin'}
                                  </Badge>
                                )}
                              </div>
                              <p className="mt-1 text-sm text-muted-foreground">{entry.name}</p>
                              <p className="mt-2 text-xs text-muted-foreground">Last sign in {formatDateTime(entry.lastSignInAt)}</p>
                            </div>
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm font-semibold text-foreground">{entry.credits.toLocaleString()}</TableCell>
                          <TableCell className="px-5 py-4">
                            <Badge variant="outline" className="rounded-full border-success/25 bg-success-soft text-success">
                              Active
                            </Badge>
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm text-muted-foreground">{formatDate(entry.createdAt)}</TableCell>
                          <TableCell className="px-5 py-4 text-right">
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                variant="outline"
                                onClick={() => {
                                  setCreditDialogUser(entry);
                                  setCreditAdjustmentMode('add');
                                  setCreditAmount('');
                                  setCreditReason('');
                                }}
                                className="h-9 rounded-full border-primary/25 bg-background px-4 text-foreground hover:bg-muted"
                              >
                                Credits
                              </Button>
                              <Button
                                variant="outline"
                                onClick={() => void handleDeleteUser(entry)}
                                disabled={deletingUserId === entry.id || entry.isAdmin}
                                className="h-9 rounded-full border-destructive/25 bg-background px-4 text-destructive hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {deletingUserId === entry.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                Delete
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="usage" className="m-0 p-6 sm:p-8">
              <div className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    ['Recorded credits', usageData.totals.recordedCredits.toLocaleString(), formatDuration(usageData.totals.recordedSeconds)],
                    ['Provider sessions', usageData.totals.sessions.toLocaleString(), `${usageData.totals.activeSessions.toLocaleString()} still active`],
                    ['Untracked exposure', formatDuration(usageData.totals.untrackedExposureSeconds), `${usageData.totals.untrackedExposureCredits.toLocaleString()} potential credits`],
                    ['Users with gaps', usageData.totals.usersWithUsageGaps.toLocaleString(), `${usageData.totals.auditedTokenMints.toLocaleString()} audited token mints`],
                  ].map(([label, value, detail]) => (
                    <div key={label} className="rounded-2xl border border-border bg-muted p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
                      <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
                    </div>
                  ))}
                </div>

                {!usageData.dataHealth.tokenAuditEnabled && (
                  <div className="flex items-start gap-3 rounded-2xl border border-warning/25 bg-warning-soft px-4 py-3 text-sm text-warning">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                      Historical rows predate server-side token auditing. Session rows are used as the token-mint estimate until the new audit events arrive.
                    </p>
                  </div>
                )}

                <div className="overflow-hidden rounded-[24px] border border-border bg-muted">
                  <div className="flex flex-col gap-3 border-b border-border px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <h4 className="text-lg font-semibold text-foreground">Plus usage by user</h4>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Recorded generation is confirmed by Morphly. Untracked exposure is the maximum connected time with a first frame but no matching usage record; it is a warning, not a confirmed Plus charge.
                      </p>
                    </div>
                    <div className="rounded-full border border-primary/25 bg-background px-4 py-2 text-sm text-muted-foreground">
                      Last {usageData.periodDays} days · as of {formatDateTime(usageData.asOf)}
                    </div>
                  </div>

                  <Table className="min-w-[1180px]">
                    <TableHeader>
                      <TableRow className="border-border bg-background hover:bg-background">
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">User</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Sessions / tokens</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Recorded usage</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Untracked exposure</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Installations</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Last activity</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Risk</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {usageData.users.length === 0 ? (
                        <TableRow className="border-border hover:bg-transparent">
                          <TableCell colSpan={7} className="px-5 py-16 text-center text-sm text-muted-foreground">
                            No Plus sessions were recorded in this period.
                          </TableCell>
                        </TableRow>
                      ) : usageData.users.map((entry) => (
                        <TableRow key={entry.userId} className="border-border bg-background hover:bg-muted">
                          <TableCell className="px-5 py-4 whitespace-normal">
                            <p className="font-medium text-foreground">{entry.email}</p>
                            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{entry.userId}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{entry.walletCredits.toLocaleString()} wallet credits</p>
                            {entry.unexplainedBalanceCredits >= 5000 && !entry.isAdmin && (
                              <p className="mt-1 text-xs font-semibold text-destructive">
                                {entry.unexplainedBalanceCredits.toLocaleString()} lack purchase/grant proof
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm text-muted-foreground">
                            <p><span className="font-semibold text-foreground">{entry.sessions}</span> sessions</p>
                            <p className="mt-1">{entry.tokenMints} token mints</p>
                            {entry.activeSessions > 0 && <p className="mt-1 text-destructive">{entry.activeSessions} active</p>}
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm text-muted-foreground">
                            <p className="font-semibold text-foreground">{entry.recordedCredits.toLocaleString()} credits</p>
                            <p className="mt-1">{formatDuration(entry.recordedSeconds)}</p>
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm">
                            <p className={entry.untrackedExposureSeconds > 0 ? 'font-semibold text-warning' : 'text-muted-foreground'}>
                              {formatDuration(entry.untrackedExposureSeconds)}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">{entry.untrackedExposureCredits.toLocaleString()} potential credits</p>
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm text-muted-foreground">
                            <p className="font-semibold text-foreground">{entry.installationCount}</p>
                            <p className="mt-1 max-w-40 truncate font-mono text-[11px]" title={entry.installationIds.join(', ')}>
                              {entry.installationIds[0] || 'Unknown'}
                            </p>
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm text-muted-foreground">{formatDateTime(entry.lastActivityAt)}</TableCell>
                          <TableCell className="px-5 py-4 whitespace-normal">
                            {entry.suspicious ? (
                              <div className="max-w-64">
                                <Badge variant="outline" className="rounded-full border-destructive/25 bg-danger-soft text-destructive">
                                  Review
                                </Badge>
                                <p className="mt-2 text-xs text-destructive">{entry.suspiciousReasons.join('; ')}</p>
                              </div>
                            ) : (
                              <Badge variant="outline" className="rounded-full border-success/25 bg-success-soft text-success">
                                Normal
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="referrals" className="m-0 p-6 sm:p-8">
              <div className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    ['Registrations', referralData.totals.registrations],
                    ['Waiting for purchase', referralData.totals.waitingForPurchase],
                    ['Referral credits issued', referralData.totals.referralCreditsIssued],
                    ['Signup bonuses issued', referralData.totals.signupBonusesIssued],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-2xl border border-border bg-muted p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
                      <p className="mt-2 text-2xl font-semibold text-foreground">{Number(value).toLocaleString()}</p>
                    </div>
                  ))}
                </div>

                <div className="overflow-hidden rounded-[24px] border border-border bg-muted">
                  <div className="flex flex-col gap-4 border-b border-border px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <h4 className="flex items-center gap-2 text-lg font-semibold text-foreground">
                        <Gift className="h-5 w-5 text-warning" />
                        Referral administration
                      </h4>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Inspect referral codes, qualifying purchases, rewards, refunds and suspicious records.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        ['all', 'All'],
                        ['registered', 'Registered'],
                        ['waiting', 'Waiting for purchase'],
                        ['rewarded', 'Rewarded'],
                        ['disqualified', 'Disqualified'],
                      ].map(([value, label]) => (
                        <Button
                          key={value}
                          type="button"
                          variant="outline"
                          onClick={() => setReferralFilter(value)}
                          className={`h-9 rounded-full px-3 text-xs ${
                            referralFilter === value
                              ? 'border-warning/25 bg-warning-soft text-warning'
                              : 'border-primary/25 bg-background text-muted-foreground'
                          }`}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <Table className="min-w-[1280px]">
                    <TableHeader>
                      <TableRow className="border-border bg-background hover:bg-background">
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Code / Referrer</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Referred user</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Registered</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Status</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">First qualifying purchase</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Reward transaction</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Flags</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredReferrals.length === 0 ? (
                        <TableRow className="border-border hover:bg-transparent">
                          <TableCell colSpan={7} className="px-5 py-16 text-center text-sm text-muted-foreground">
                            No referral records match this filter.
                          </TableCell>
                        </TableRow>
                      ) : filteredReferrals.map((entry) => (
                        <TableRow key={entry.id} className="border-border bg-background hover:bg-muted">
                          <TableCell className="px-5 py-4 whitespace-normal">
                            <p className="font-mono text-sm font-semibold text-foreground">{entry.referralCodeUsed}</p>
                            <p className="mt-1 text-xs text-muted-foreground">{entry.referrerEmail}</p>
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm text-foreground">{entry.referredEmail}</TableCell>
                          <TableCell className="px-5 py-4 text-sm text-muted-foreground">{formatDateTime(entry.registeredAt)}</TableCell>
                          <TableCell className="px-5 py-4">
                            <Badge
                              variant="outline"
                              className={`rounded-full ${
                                entry.status === 'rewarded'
                                  ? 'border-success/25 bg-success-soft text-success'
                                  : entry.status === 'disqualified'
                                    ? 'border-destructive/25 bg-danger-soft text-destructive'
                                    : 'border-warning/25 bg-warning-soft text-warning'
                              }`}
                            >
                              {entry.status}
                            </Badge>
                            {entry.disqualificationReason && (
                              <p className="mt-2 max-w-44 text-xs text-destructive">
                                {entry.disqualificationReason}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="px-5 py-4 whitespace-normal text-sm text-muted-foreground">
                            {entry.firstQualifyingPurchase ? (
                              <>
                                <p className="font-medium text-foreground">{entry.firstQualifyingPurchase.reference || entry.firstQualifyingPurchase.id}</p>
                                <p className="mt-1 text-xs text-muted-foreground">{entry.firstQualifyingPurchase.package || 'Credit package'}</p>
                              </>
                            ) : 'Waiting for first purchase'}
                          </TableCell>
                          <TableCell className="px-5 py-4 whitespace-normal text-sm text-muted-foreground">
                            {entry.rewardTransaction ? (
                              <>
                                <p className="font-medium text-foreground">{entry.rewardTransaction.reference}</p>
                                <p className="mt-1 text-xs text-muted-foreground">{entry.rewardTransaction.credits} credits · {formatDateTime(entry.rewardedAt)}</p>
                              </>
                            ) : 'Not rewarded'}
                          </TableCell>
                          <TableCell className="px-5 py-4">
                            <div className="flex flex-wrap gap-2">
                              {entry.refundWarning && <Badge variant="destructive">Refund warning</Badge>}
                              {entry.suspicious && <Badge variant="destructive">Suspicious</Badge>}
                              {!entry.refundWarning && !entry.suspicious && (
                                <span className="text-sm text-muted-foreground">None</span>
                              )}
                              {['registered', 'qualified'].includes(entry.status) && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={disqualifyingReferralId === entry.id}
                                  onClick={() => void handleDisqualifyReferral(entry)}
                                  className="h-7 rounded-full border-destructive/25 px-2 text-[11px] text-destructive hover:bg-danger-soft"
                                >
                                  {disqualifyingReferralId === entry.id ? 'Saving...' : 'Disqualify'}
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="overflow-hidden rounded-[24px] border border-border bg-muted">
                  <div className="border-b border-border px-5 py-5">
                    <h4 className="text-lg font-semibold text-foreground">Referral audit log</h4>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Signup bonuses, attachments, qualifications, rewards, disqualifications and refund warnings.
                    </p>
                  </div>
                  <div className="divide-y divide-border">
                    {referralData.audit.length === 0 ? (
                      <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                        No referral audit events have been recorded.
                      </p>
                    ) : referralData.audit.slice(0, 50).map((entry) => (
                      <div key={entry.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-foreground">{entry.action}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Referred user: {entry.referred_user_id || 'Not applicable'}
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground">{formatDateTime(entry.created_at)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="pricing" className="m-0 p-6 sm:p-8">
              <div className="overflow-hidden rounded-[24px] border border-border bg-muted">
                <div className="flex flex-col gap-4 border-b border-border px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h4 className="text-lg font-semibold text-foreground">Pricing</h4>
                    <p className="mt-1 text-sm text-muted-foreground">Control which credit packages are visible and how much each one costs.</p>
                  </div>

                  <Button
                    onClick={() => void handleSavePackages()}
                    disabled={savingPackages}
                    className="h-11 rounded-full bg-primary px-5 text-primary-foreground hover:bg-primary-hover"
                  >
                    {savingPackages ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save pricing
                  </Button>
                </div>

                <Table className="min-w-[820px]">
                  <TableHeader>
                    <TableRow className="border-border bg-background hover:bg-background">
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Package</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Credits</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Price (NGN)</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Visibility</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Order</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {packages.map((pkg) => (
                      <TableRow key={pkg.id} className="border-border bg-background hover:bg-muted">
                        <TableCell className="px-5 py-4 whitespace-normal">
                          <div>
                            <p className="font-medium text-foreground">{pkg.name}</p>
                            <p className="mt-1 text-sm text-muted-foreground">Displayed on the purchase page</p>
                          </div>
                        </TableCell>
                        <TableCell className="px-5 py-4 text-sm font-semibold text-foreground">{pkg.credits.toLocaleString()}</TableCell>
                        <TableCell className="px-5 py-4">
                          <Input
                            type="number"
                            min="0"
                            value={String(pkg.priceNGN)}
                            onChange={(event) => updatePackage(pkg.id, { priceNGN: Number(event.target.value) || 0 })}
                            className="h-10 w-full min-w-[140px] rounded-full border-primary/25 bg-background text-foreground"
                          />
                        </TableCell>
                        <TableCell className="px-5 py-4">
                          <div className="flex w-fit items-center gap-3 rounded-full border border-border bg-muted px-4 py-2">
                            <span className="text-sm text-muted-foreground">{pkg.isActive ? 'Visible' : 'Hidden'}</span>
                            <Switch
                              checked={pkg.isActive}
                              onCheckedChange={(checked) => updatePackage(pkg.id, { isActive: checked })}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="px-5 py-4">
                          <Badge variant="outline" className="rounded-full border-primary/25 bg-muted text-foreground">
                            #{pkg.sortOrder}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>

            <TabsContent value="audit" className="m-0 p-6 sm:p-8">
              <div className="overflow-hidden rounded-[24px] border border-border bg-muted">
                <div className="flex flex-col gap-3 border-b border-border px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h4 className="text-lg font-semibold text-foreground">Audit Log</h4>
                    <p className="mt-1 text-sm text-muted-foreground">Recent request, payment, database, and error events captured by the backend logger.</p>
                  </div>

                  <div className="flex items-center gap-2 rounded-full border border-primary/25 bg-background px-4 py-2 text-sm text-muted-foreground">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    File-backed backend logs
                  </div>
                </div>

                <Table className="min-w-[860px]">
                  <TableHeader>
                    <TableRow className="border-border bg-background hover:bg-background">
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Time</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Channel</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Event</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditEntries.length === 0 ? (
                      <TableRow className="border-border hover:bg-transparent">
                        <TableCell colSpan={4} className="px-5 py-16 text-center text-sm text-muted-foreground">
                          No audit entries found yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      auditEntries.map((entry, index) => (
                        <TableRow key={`${entry.timestamp || 'entry'}-${entry.event || 'event'}-${index}`} className="border-border bg-background hover:bg-muted">
                          <TableCell className="px-5 py-4 text-sm text-muted-foreground">{formatDateTime(entry.timestamp)}</TableCell>
                          <TableCell className="px-5 py-4">
                            <Badge variant="outline" className={`rounded-full ${getChannelBadgeClass(entry.channel)}`}>
                              {entry.channel || 'request'}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm font-medium text-foreground">{entry.event || 'event'}</TableCell>
                          <TableCell className="px-5 py-4 whitespace-normal text-sm text-muted-foreground">
                            <div className="flex items-start gap-2">
                              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                              <span>{summarizeAuditEntry(entry)}</span>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </TabsContent>
          </Tabs>
        </section>
      </main>

      <Dialog
        open={Boolean(creditDialogUser)}
        onOpenChange={(open) => {
          if (!open) {
            resetCreditDialog();
          }
        }}
      >
        <DialogContent className="rounded-[28px] border-border bg-background p-0 sm:max-w-md">
          <div className="border-b border-border px-6 py-5">
            <DialogHeader className="gap-2 text-left">
              <DialogTitle className="text-xl font-semibold text-foreground">Adjust credits</DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">
                Apply a manual wallet adjustment for <span className="font-medium text-foreground">{creditDialogUser?.email}</span>.
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="space-y-4 px-6 py-5">
            <div className="rounded-2xl border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
              Current balance <span className="font-semibold text-foreground">{creditDialogUser?.credits.toLocaleString() || 0}</span> credits
            </div>

            <div className={`grid gap-2 rounded-2xl bg-muted p-1.5 ${user?.adminRole === 'super_admin' ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <Button
                type="button"
                variant="ghost"
                aria-pressed={creditAdjustmentMode === 'add'}
                onClick={() => setCreditAdjustmentMode('add')}
                className={creditAdjustmentMode === 'add'
                  ? 'h-10 rounded-xl bg-background text-success shadow-sm hover:bg-background hover:text-success'
                  : 'h-10 rounded-xl text-muted-foreground hover:bg-background'}
              >
                Add credits
              </Button>
              {user?.adminRole === 'super_admin' && (
                <Button
                  type="button"
                  variant="ghost"
                  aria-pressed={creditAdjustmentMode === 'deduct'}
                  onClick={() => setCreditAdjustmentMode('deduct')}
                  className={creditAdjustmentMode === 'deduct'
                    ? 'h-10 rounded-xl bg-background text-destructive shadow-sm hover:bg-background hover:text-destructive'
                    : 'h-10 rounded-xl text-muted-foreground hover:bg-background'}
                >
                  Deduct credits
                </Button>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">
                Credits to {creditAdjustmentMode}
              </label>
              <Input
                type="number"
                min="1"
                max={creditAdjustmentMode === 'deduct' ? creditDialogUser?.credits : 1_000_000}
                step="1"
                value={creditAmount}
                onChange={(event) => setCreditAmount(event.target.value)}
                placeholder="500"
                className="h-12 rounded-full border-primary/25 bg-background text-foreground"
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-[0.28em] text-muted-foreground">Reason</label>
              <Input
                type="text"
                value={creditReason}
                onChange={(event) => setCreditReason(event.target.value)}
                placeholder={creditAdjustmentMode === 'deduct' ? 'Refund, correction, or policy action' : 'Support credit or account correction'}
                maxLength={240}
                className="h-12 rounded-full border-primary/25 bg-background text-foreground"
              />
              <p className="px-1 text-xs text-muted-foreground">This reason is saved in the admin audit log.</p>
            </div>

            {creditAdjustmentMode === 'deduct' && Number(creditAmount) > 0 && creditDialogUser && (
              <div className="rounded-2xl border border-destructive/25 bg-danger-soft px-4 py-3 text-sm text-destructive">
                Balance after deduction:{' '}
                <span className="font-semibold">
                  {Math.max(0, creditDialogUser.credits - Number(creditAmount)).toLocaleString()} credits
                </span>
              </div>
            )}
          </div>

          <DialogFooter className="border-t border-border px-6 py-5 sm:justify-between">
            <Button
              variant="ghost"
              onClick={resetCreditDialog}
              className="h-11 rounded-full px-4 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleAdjustCredits()}
              disabled={isSubmittingCredit}
              className={creditAdjustmentMode === 'deduct'
                ? 'h-11 rounded-full bg-destructive px-5 text-primary-foreground hover:bg-destructive'
                : 'h-11 rounded-full bg-primary px-5 text-primary-foreground hover:bg-primary-hover'}
            >
              {isSubmittingCredit ? <Loader2 className="h-4 w-4 animate-spin" /> : <Coins className="h-4 w-4" />}
              {creditAdjustmentMode === 'deduct' ? 'Deduct credits' : 'Add credits'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default AdminDashboard;
