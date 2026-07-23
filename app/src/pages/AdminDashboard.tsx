import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
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
      return 'border-[#fecaca] bg-[#fff1f2] text-[#b91c1c]';
    case 'payment':
      return 'border-[#d9f99d] bg-[#f7fee7] text-[#4d7c0f]';
    case 'db-query':
      return 'border-[#c7d2fe] bg-[#eef2ff] text-[#4338ca]';
    default:
      return 'border-[#dbe4ff] bg-[#eff6ff] text-[#1d4ed8]';
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
  const [creditsToAdd, setCreditsToAdd] = useState('');
  const [isSubmittingCredit, setIsSubmittingCredit] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [disqualifyingReferralId, setDisqualifyingReferralId] = useState<string | null>(null);

  const loadDashboardData = async (options?: { silent?: boolean }) => {
    if (options?.silent) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }

    try {
      const [usersResult, packagesResult, overviewResult, auditResult, referralsResult] = await Promise.allSettled([
        adminRequest<{ users: AdminUserRecord[] }>('/admin-users'),
        adminRequest<{ packages: CreditPackage[] }>('/admin-credit-packages'),
        adminRequest<AdminOverview>('/admin-overview'),
        adminRequest<{ entries: AuditLogEntry[] }>('/admin-audit-log?limit=50'),
        adminRequest<AdminReferralData>('/admin-referrals'),
      ]);

      if (usersResult.status === 'fulfilled') setUsers(usersResult.value.users || []);
      if (packagesResult.status === 'fulfilled') setPackages(packagesResult.value.packages || []);
      if (overviewResult.status === 'fulfilled') setOverview(overviewResult.value);
      if (auditResult.status === 'fulfilled') setAuditEntries(auditResult.value.entries || []);
      if (referralsResult.status === 'fulfilled') setReferralData(referralsResult.value);

      const failedSections = [
        usersResult.status === 'rejected' ? 'users' : null,
        packagesResult.status === 'rejected' ? 'packages' : null,
        overviewResult.status === 'rejected' ? 'overview' : null,
        auditResult.status === 'rejected' ? 'audit log' : null,
        referralsResult.status === 'rejected' ? 'referrals' : null,
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
      iconClassName: 'bg-[#eff6ff] text-[#2563eb]',
    },
    {
      title: 'Blocked',
      value: overview.blockedUsers.toLocaleString(),
      description: 'Restricted accounts',
      icon: Ban,
      iconClassName: 'bg-[#fff1f2] text-[#dc2626]',
    },
    {
      title: 'Total credits',
      value: overview.totalCredits.toLocaleString(),
      description: 'Wallet balance outstanding',
      icon: Coins,
      iconClassName: 'bg-[#ecfdf5] text-[#059669]',
    },
    {
      title: 'Revenue (NGN)',
      value: formatCurrency(overview.revenueNGN),
      description: 'Successful credit sales',
      icon: DollarSign,
      iconClassName: 'bg-[#f8fafc] text-[#0f172a]',
    },
    {
      title: 'Active sessions',
      value: overview.activeSessions.toLocaleString(),
      description: 'Currently consuming credits',
      icon: Activity,
      iconClassName: 'bg-[#f5f3ff] text-[#7c3aed]',
    },
    {
      title: 'Live packages',
      value: activePackageCount.toLocaleString(),
      description: 'Visible on the pricing page',
      icon: WalletCards,
      iconClassName: 'bg-[#fff7ed] text-[#ea580c]',
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

  const handleAddCredits = async () => {
    if (!creditDialogUser) {
      return;
    }

    const parsedCredits = Number(creditsToAdd);
    if (!Number.isFinite(parsedCredits) || parsedCredits <= 0) {
      toast.error('Enter a valid number of credits to add');
      return;
    }

    setIsSubmittingCredit(true);

    try {
      const response = await adminRequest<{ newCredits: number; creditsAdded: number }>('/admin-users', {
        method: 'POST',
        body: JSON.stringify({ userId: creditDialogUser.id, creditsToAdd: parsedCredits }),
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
        totalCredits: currentOverview.totalCredits + response.creditsAdded,
      }));
      setCreditsToAdd('');
      setCreditDialogUser(null);
      toast.success(`Added ${response.creditsAdded.toLocaleString()} credits`);
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : 'Failed to add credits');
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
      <div className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-6">
        <div className="flex flex-col items-center gap-4 rounded-[24px] border border-[#e5e7eb] bg-white px-10 py-12 text-[#64748b] shadow-[0_30px_90px_-50px_rgba(15,23,42,0.25)]">
          <Loader2 className="h-10 w-10 animate-spin text-[#2563eb]" />
          <p className="text-sm font-medium">Loading admin dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f5f7fb] text-[#0f172a]">
      <header className="border-b border-[#e5e7eb] bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#111827] text-white shadow-[0_20px_40px_-25px_rgba(15,23,42,0.6)]">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.32em] text-[#64748b]">Morphly</p>
              <h1 className="text-lg font-semibold tracking-tight text-[#0f172a]">Admin Console</h1>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Badge variant="outline" className="justify-center rounded-full border-[#dcfce7] bg-[#f0fdf4] px-3 py-1 text-[#15803d]">
              Online
            </Badge>
            <div className="text-right">
              <p className="text-sm font-medium text-[#0f172a]">{user?.email || 'Admin session'}</p>
              <p className="text-xs uppercase tracking-[0.24em] text-[#64748b]">RLS protected</p>
            </div>
            <Button
              variant="outline"
              onClick={() => void logout()}
              className="h-10 rounded-full border-[#dbe4ff] bg-white px-4 text-[#0f172a] hover:bg-[#f8fafc]"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-4 py-8 sm:px-6 lg:px-8">
        <section className="relative overflow-hidden rounded-[30px] border border-[#e5e7eb] bg-white shadow-[0_35px_90px_-55px_rgba(15,23,42,0.35)]">
          <div className="absolute inset-x-0 top-0 h-32 bg-[radial-gradient(circle_at_top_left,_rgba(59,130,246,0.12),_transparent_45%),radial-gradient(circle_at_top_right,_rgba(16,185,129,0.1),_transparent_35%)]" />
          <div className="relative px-6 py-6 sm:px-8 sm:py-8">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.34em] text-[#64748b]">Overview</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight text-[#0f172a]">Operations Dashboard</h2>
                <p className="mt-2 max-w-2xl text-sm text-[#64748b]">
                  Monitor balances, live sessions, and pricing controls from a single protected workspace.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="rounded-2xl border border-[#e5e7eb] bg-[#f8fafc] px-4 py-3 text-sm text-[#475569]">
                  Signed in as <span className="font-semibold text-[#0f172a]">{user?.email || 'admin user'}</span>
                </div>
                <Button
                  onClick={() => void loadDashboardData({ silent: true })}
                  disabled={isRefreshing}
                  className="h-11 rounded-full bg-[#0f172a] px-5 text-white hover:bg-[#1e293b]"
                >
                  {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                  Refresh data
                </Button>
              </div>
            </div>

            <div className="mt-8 grid overflow-hidden rounded-[24px] border border-[#e5e7eb] bg-white md:grid-cols-2 xl:grid-cols-3">
              {overviewCards.map((card) => {
                const Icon = card.icon;

                return (
                  <div
                    key={card.title}
                    className="border-b border-[#e5e7eb] p-6 md:[&:nth-last-child(-n+2)]:border-b-0 xl:[&:nth-last-child(-n+3)]:border-b-0 xl:border-r xl:[&:nth-child(3n)]:border-r-0"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">{card.title}</p>
                        <p className="mt-4 text-3xl font-semibold tracking-tight text-[#0f172a]">{card.value}</p>
                        <p className="mt-2 text-sm text-[#64748b]">{card.description}</p>
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

        <section className="mt-8 overflow-hidden rounded-[30px] border border-[#e5e7eb] bg-white shadow-[0_35px_90px_-55px_rgba(15,23,42,0.35)]">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-0">
            <div className="border-b border-[#e5e7eb] px-6 py-5 sm:px-8">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.34em] text-[#64748b]">Workspace</p>
                  <h3 className="mt-3 text-2xl font-semibold tracking-tight text-[#0f172a]">Operations Controls</h3>
                  <p className="mt-2 text-sm text-[#64748b]">Users, pricing, and backend audit trails aligned in one admin surface.</p>
                </div>

                <TabsList className="h-auto flex-wrap rounded-2xl bg-[#f1f5f9] p-1">
                  <TabsTrigger
                    value="users"
                    className="rounded-full px-4 py-2.5 text-sm text-[#64748b] data-[state=active]:border-transparent data-[state=active]:bg-white data-[state=active]:text-[#0f172a] data-[state=active]:shadow-none"
                  >
                    Users
                  </TabsTrigger>
                  <TabsTrigger
                    value="referrals"
                    className="rounded-full px-4 py-2.5 text-sm text-[#64748b] data-[state=active]:border-transparent data-[state=active]:bg-white data-[state=active]:text-[#0f172a] data-[state=active]:shadow-none"
                  >
                    Referrals
                  </TabsTrigger>
                  <TabsTrigger
                    value="pricing"
                    className="rounded-full px-4 py-2.5 text-sm text-[#64748b] data-[state=active]:border-transparent data-[state=active]:bg-white data-[state=active]:text-[#0f172a] data-[state=active]:shadow-none"
                  >
                    Pricing
                  </TabsTrigger>
                  <TabsTrigger
                    value="audit"
                    className="rounded-full px-4 py-2.5 text-sm text-[#64748b] data-[state=active]:border-transparent data-[state=active]:bg-white data-[state=active]:text-[#0f172a] data-[state=active]:shadow-none"
                  >
                    Audit Log
                  </TabsTrigger>
                </TabsList>
              </div>
            </div>

            <TabsContent value="users" className="m-0 p-6 sm:p-8">
              <div className="overflow-hidden rounded-[24px] border border-[#e5e7eb] bg-[#fcfcfd]">
                <div className="border-b border-[#e5e7eb] px-5 py-5">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div>
                      <h4 className="text-lg font-semibold text-[#0f172a]">Users</h4>
                      <p className="mt-1 text-sm text-[#64748b]">Inspect balances, apply credits, and remove access when required.</p>
                    </div>

                    <div className="flex flex-col gap-3 md:flex-row md:items-center">
                      <div className="relative w-full md:w-[320px]">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94a3b8]" />
                        <Input
                          value={searchInput}
                          onChange={(event) => setSearchInput(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              setAppliedSearch(searchInput);
                            }
                          }}
                          placeholder="Search by name or email"
                          className="h-11 rounded-full border-[#dbe4ff] bg-white pl-10 text-[#0f172a]"
                        />
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => setAppliedSearch(searchInput)}
                        className="h-11 rounded-full border-[#dbe4ff] bg-white px-5 text-[#0f172a] hover:bg-[#f8fafc]"
                      >
                        Search
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setSearchInput('');
                          setAppliedSearch('');
                        }}
                        className="h-11 rounded-full px-4 text-[#64748b] hover:bg-[#eef2ff] hover:text-[#0f172a]"
                      >
                        Reset
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-2 border-b border-[#e5e7eb] px-5 py-3 text-sm text-[#64748b] sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Search via admin directory</p>
                  <p>{filteredUsers.length.toLocaleString()} visible records</p>
                </div>

                <Table className="min-w-[920px]">
                  <TableHeader>
                    <TableRow className="border-[#e5e7eb] bg-white hover:bg-white">
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Email</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Credits</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Status</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Joined</TableHead>
                      <TableHead className="px-5 py-4 text-right text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredUsers.length === 0 ? (
                      <TableRow className="border-[#e5e7eb] hover:bg-transparent">
                        <TableCell colSpan={5} className="px-5 py-16 text-center text-sm text-[#64748b]">
                          No users match the current filter.
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredUsers.map((entry) => (
                        <TableRow key={entry.id} className="border-[#e5e7eb] bg-white hover:bg-[#fafcff]">
                          <TableCell className="px-5 py-4 align-top whitespace-normal">
                            <div className="min-w-[220px]">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-medium text-[#0f172a]">{entry.email}</p>
                                {entry.isAdmin && (
                                  <Badge variant="outline" className="rounded-full border-[#fde68a] bg-[#fffbeb] text-[#92400e]">
                                    {entry.adminRole || 'admin'}
                                  </Badge>
                                )}
                              </div>
                              <p className="mt-1 text-sm text-[#64748b]">{entry.name}</p>
                              <p className="mt-2 text-xs text-[#94a3b8]">Last sign in {formatDateTime(entry.lastSignInAt)}</p>
                            </div>
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm font-semibold text-[#0f172a]">{entry.credits.toLocaleString()}</TableCell>
                          <TableCell className="px-5 py-4">
                            <Badge variant="outline" className="rounded-full border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]">
                              Active
                            </Badge>
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm text-[#475569]">{formatDate(entry.createdAt)}</TableCell>
                          <TableCell className="px-5 py-4 text-right">
                            <div className="flex flex-wrap justify-end gap-2">
                              <Button
                                variant="outline"
                                onClick={() => {
                                  setCreditDialogUser(entry);
                                  setCreditsToAdd('');
                                }}
                                className="h-9 rounded-full border-[#dbe4ff] bg-white px-4 text-[#0f172a] hover:bg-[#f8fafc]"
                              >
                                Credits
                              </Button>
                              <Button
                                variant="outline"
                                onClick={() => void handleDeleteUser(entry)}
                                disabled={deletingUserId === entry.id || entry.isAdmin}
                                className="h-9 rounded-full border-[#fecaca] bg-white px-4 text-[#b91c1c] hover:bg-[#fff1f2] disabled:cursor-not-allowed disabled:opacity-50"
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

            <TabsContent value="referrals" className="m-0 p-6 sm:p-8">
              <div className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    ['Registrations', referralData.totals.registrations],
                    ['Waiting for purchase', referralData.totals.waitingForPurchase],
                    ['Referral credits issued', referralData.totals.referralCreditsIssued],
                    ['Signup bonuses issued', referralData.totals.signupBonusesIssued],
                  ].map(([label, value]) => (
                    <div key={String(label)} className="rounded-2xl border border-[#e5e7eb] bg-[#fcfcfd] p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#94a3b8]">{label}</p>
                      <p className="mt-2 text-2xl font-semibold text-[#0f172a]">{Number(value).toLocaleString()}</p>
                    </div>
                  ))}
                </div>

                <div className="overflow-hidden rounded-[24px] border border-[#e5e7eb] bg-[#fcfcfd]">
                  <div className="flex flex-col gap-4 border-b border-[#e5e7eb] px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <h4 className="flex items-center gap-2 text-lg font-semibold text-[#0f172a]">
                        <Gift className="h-5 w-5 text-[#d97706]" />
                        Referral administration
                      </h4>
                      <p className="mt-1 text-sm text-[#64748b]">
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
                              ? 'border-[#f59e0b] bg-[#fffbeb] text-[#92400e]'
                              : 'border-[#dbe4ff] bg-white text-[#475569]'
                          }`}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <Table className="min-w-[1280px]">
                    <TableHeader>
                      <TableRow className="border-[#e5e7eb] bg-white hover:bg-white">
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#94a3b8]">Code / Referrer</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#94a3b8]">Referred user</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#94a3b8]">Registered</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#94a3b8]">Status</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#94a3b8]">First qualifying purchase</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#94a3b8]">Reward transaction</TableHead>
                        <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.2em] text-[#94a3b8]">Flags</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredReferrals.length === 0 ? (
                        <TableRow className="border-[#e5e7eb] hover:bg-transparent">
                          <TableCell colSpan={7} className="px-5 py-16 text-center text-sm text-[#64748b]">
                            No referral records match this filter.
                          </TableCell>
                        </TableRow>
                      ) : filteredReferrals.map((entry) => (
                        <TableRow key={entry.id} className="border-[#e5e7eb] bg-white hover:bg-[#fafcff]">
                          <TableCell className="px-5 py-4 whitespace-normal">
                            <p className="font-mono text-sm font-semibold text-[#0f172a]">{entry.referralCodeUsed}</p>
                            <p className="mt-1 text-xs text-[#64748b]">{entry.referrerEmail}</p>
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm text-[#0f172a]">{entry.referredEmail}</TableCell>
                          <TableCell className="px-5 py-4 text-sm text-[#475569]">{formatDateTime(entry.registeredAt)}</TableCell>
                          <TableCell className="px-5 py-4">
                            <Badge
                              variant="outline"
                              className={`rounded-full ${
                                entry.status === 'rewarded'
                                  ? 'border-[#bbf7d0] bg-[#f0fdf4] text-[#166534]'
                                  : entry.status === 'disqualified'
                                    ? 'border-[#fecaca] bg-[#fff1f2] text-[#b91c1c]'
                                    : 'border-[#fde68a] bg-[#fffbeb] text-[#92400e]'
                              }`}
                            >
                              {entry.status}
                            </Badge>
                            {entry.disqualificationReason && (
                              <p className="mt-2 max-w-44 text-xs text-[#b91c1c]">
                                {entry.disqualificationReason}
                              </p>
                            )}
                          </TableCell>
                          <TableCell className="px-5 py-4 whitespace-normal text-sm text-[#475569]">
                            {entry.firstQualifyingPurchase ? (
                              <>
                                <p className="font-medium text-[#0f172a]">{entry.firstQualifyingPurchase.reference || entry.firstQualifyingPurchase.id}</p>
                                <p className="mt-1 text-xs text-[#64748b]">{entry.firstQualifyingPurchase.package || 'Credit package'}</p>
                              </>
                            ) : 'Waiting for first purchase'}
                          </TableCell>
                          <TableCell className="px-5 py-4 whitespace-normal text-sm text-[#475569]">
                            {entry.rewardTransaction ? (
                              <>
                                <p className="font-medium text-[#0f172a]">{entry.rewardTransaction.reference}</p>
                                <p className="mt-1 text-xs text-[#64748b]">{entry.rewardTransaction.credits} credits · {formatDateTime(entry.rewardedAt)}</p>
                              </>
                            ) : 'Not rewarded'}
                          </TableCell>
                          <TableCell className="px-5 py-4">
                            <div className="flex flex-wrap gap-2">
                              {entry.refundWarning && <Badge variant="destructive">Refund warning</Badge>}
                              {entry.suspicious && <Badge variant="destructive">Suspicious</Badge>}
                              {!entry.refundWarning && !entry.suspicious && (
                                <span className="text-sm text-[#64748b]">None</span>
                              )}
                              {['registered', 'qualified'].includes(entry.status) && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={disqualifyingReferralId === entry.id}
                                  onClick={() => void handleDisqualifyReferral(entry)}
                                  className="h-7 rounded-full border-[#fecaca] px-2 text-[11px] text-[#b91c1c] hover:bg-[#fff1f2]"
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

                <div className="overflow-hidden rounded-[24px] border border-[#e5e7eb] bg-[#fcfcfd]">
                  <div className="border-b border-[#e5e7eb] px-5 py-5">
                    <h4 className="text-lg font-semibold text-[#0f172a]">Referral audit log</h4>
                    <p className="mt-1 text-sm text-[#64748b]">
                      Signup bonuses, attachments, qualifications, rewards, disqualifications and refund warnings.
                    </p>
                  </div>
                  <div className="divide-y divide-[#e5e7eb]">
                    {referralData.audit.length === 0 ? (
                      <p className="px-5 py-10 text-center text-sm text-[#64748b]">
                        No referral audit events have been recorded.
                      </p>
                    ) : referralData.audit.slice(0, 50).map((entry) => (
                      <div key={entry.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-sm font-semibold text-[#0f172a]">{entry.action}</p>
                          <p className="mt-1 text-xs text-[#64748b]">
                            Referred user: {entry.referred_user_id || 'Not applicable'}
                          </p>
                        </div>
                        <p className="text-xs text-[#64748b]">{formatDateTime(entry.created_at)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="pricing" className="m-0 p-6 sm:p-8">
              <div className="overflow-hidden rounded-[24px] border border-[#e5e7eb] bg-[#fcfcfd]">
                <div className="flex flex-col gap-4 border-b border-[#e5e7eb] px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h4 className="text-lg font-semibold text-[#0f172a]">Pricing</h4>
                    <p className="mt-1 text-sm text-[#64748b]">Control which credit packages are visible and how much each one costs.</p>
                  </div>

                  <Button
                    onClick={() => void handleSavePackages()}
                    disabled={savingPackages}
                    className="h-11 rounded-full bg-[#0f172a] px-5 text-white hover:bg-[#1e293b]"
                  >
                    {savingPackages ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save pricing
                  </Button>
                </div>

                <Table className="min-w-[820px]">
                  <TableHeader>
                    <TableRow className="border-[#e5e7eb] bg-white hover:bg-white">
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Package</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Credits</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Price (NGN)</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Visibility</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Order</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {packages.map((pkg) => (
                      <TableRow key={pkg.id} className="border-[#e5e7eb] bg-white hover:bg-[#fafcff]">
                        <TableCell className="px-5 py-4 whitespace-normal">
                          <div>
                            <p className="font-medium text-[#0f172a]">{pkg.name}</p>
                            <p className="mt-1 text-sm text-[#64748b]">Displayed on the purchase page</p>
                          </div>
                        </TableCell>
                        <TableCell className="px-5 py-4 text-sm font-semibold text-[#0f172a]">{pkg.credits.toLocaleString()}</TableCell>
                        <TableCell className="px-5 py-4">
                          <Input
                            type="number"
                            min="0"
                            value={String(pkg.priceNGN)}
                            onChange={(event) => updatePackage(pkg.id, { priceNGN: Number(event.target.value) || 0 })}
                            className="h-10 w-full min-w-[140px] rounded-full border-[#dbe4ff] bg-white text-[#0f172a]"
                          />
                        </TableCell>
                        <TableCell className="px-5 py-4">
                          <div className="flex w-fit items-center gap-3 rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-4 py-2">
                            <span className="text-sm text-[#475569]">{pkg.isActive ? 'Visible' : 'Hidden'}</span>
                            <Switch
                              checked={pkg.isActive}
                              onCheckedChange={(checked) => updatePackage(pkg.id, { isActive: checked })}
                            />
                          </div>
                        </TableCell>
                        <TableCell className="px-5 py-4">
                          <Badge variant="outline" className="rounded-full border-[#dbe4ff] bg-[#f8fafc] text-[#334155]">
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
              <div className="overflow-hidden rounded-[24px] border border-[#e5e7eb] bg-[#fcfcfd]">
                <div className="flex flex-col gap-3 border-b border-[#e5e7eb] px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h4 className="text-lg font-semibold text-[#0f172a]">Audit Log</h4>
                    <p className="mt-1 text-sm text-[#64748b]">Recent request, payment, database, and error events captured by the backend logger.</p>
                  </div>

                  <div className="flex items-center gap-2 rounded-full border border-[#dbe4ff] bg-white px-4 py-2 text-sm text-[#475569]">
                    <ShieldCheck className="h-4 w-4 text-[#2563eb]" />
                    File-backed backend logs
                  </div>
                </div>

                <Table className="min-w-[860px]">
                  <TableHeader>
                    <TableRow className="border-[#e5e7eb] bg-white hover:bg-white">
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Time</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Channel</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Event</TableHead>
                      <TableHead className="px-5 py-4 text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {auditEntries.length === 0 ? (
                      <TableRow className="border-[#e5e7eb] hover:bg-transparent">
                        <TableCell colSpan={4} className="px-5 py-16 text-center text-sm text-[#64748b]">
                          No audit entries found yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      auditEntries.map((entry, index) => (
                        <TableRow key={`${entry.timestamp || 'entry'}-${entry.event || 'event'}-${index}`} className="border-[#e5e7eb] bg-white hover:bg-[#fafcff]">
                          <TableCell className="px-5 py-4 text-sm text-[#475569]">{formatDateTime(entry.timestamp)}</TableCell>
                          <TableCell className="px-5 py-4">
                            <Badge variant="outline" className={`rounded-full ${getChannelBadgeClass(entry.channel)}`}>
                              {entry.channel || 'request'}
                            </Badge>
                          </TableCell>
                          <TableCell className="px-5 py-4 text-sm font-medium text-[#0f172a]">{entry.event || 'event'}</TableCell>
                          <TableCell className="px-5 py-4 whitespace-normal text-sm text-[#64748b]">
                            <div className="flex items-start gap-2">
                              <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-[#94a3b8]" />
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
            setCreditDialogUser(null);
            setCreditsToAdd('');
          }
        }}
      >
        <DialogContent className="rounded-[28px] border-[#e5e7eb] bg-white p-0 sm:max-w-md">
          <div className="border-b border-[#e5e7eb] px-6 py-5">
            <DialogHeader className="gap-2 text-left">
              <DialogTitle className="text-xl font-semibold text-[#0f172a]">Add credits</DialogTitle>
              <DialogDescription className="text-sm text-[#64748b]">
                Apply a manual wallet adjustment for <span className="font-medium text-[#0f172a]">{creditDialogUser?.email}</span>.
              </DialogDescription>
            </DialogHeader>
          </div>

          <div className="space-y-4 px-6 py-5">
            <div className="rounded-2xl border border-[#e5e7eb] bg-[#f8fafc] px-4 py-3 text-sm text-[#475569]">
              Current balance <span className="font-semibold text-[#0f172a]">{creditDialogUser?.credits.toLocaleString() || 0}</span> credits
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-[0.28em] text-[#94a3b8]">Credits to add</label>
              <Input
                type="number"
                min="1"
                value={creditsToAdd}
                onChange={(event) => setCreditsToAdd(event.target.value)}
                placeholder="500"
                className="h-12 rounded-full border-[#dbe4ff] bg-white text-[#0f172a]"
              />
            </div>
          </div>

          <DialogFooter className="border-t border-[#e5e7eb] px-6 py-5 sm:justify-between">
            <Button
              variant="ghost"
              onClick={() => {
                setCreditDialogUser(null);
                setCreditsToAdd('');
              }}
              className="h-11 rounded-full px-4 text-[#64748b] hover:bg-[#eef2ff] hover:text-[#0f172a]"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleAddCredits()}
              disabled={isSubmittingCredit}
              className="h-11 rounded-full bg-[#0f172a] px-5 text-white hover:bg-[#1e293b]"
            >
              {isSubmittingCredit ? <Loader2 className="h-4 w-4 animate-spin" /> : <Coins className="h-4 w-4" />}
              Apply credits
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default AdminDashboard;
