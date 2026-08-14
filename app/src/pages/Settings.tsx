import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useAuth } from '@/context/AuthContext';
import { toast } from 'sonner';
import { StreamGuideModal } from '@/components/StreamGuideModal';
import {
  checkForUpdates as checkDesktopForUpdates,
  downloadUpdate as downloadDesktopUpdate,
  getDesktopUpdateState,
  installUpdate as installDesktopUpdate,
  isDesktopUpdaterAvailable,
  subscribeToDesktopUpdateState,
  formatUpdateInstallMode,
  formatUpdatePackageType,
  type DesktopUpdateState
} from '@/lib/desktop-updater';
import {
  getReferralSummary,
  updateOnboardingState,
  type ReferralSummary,
} from '@/lib/account';

function Settings() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [isSaving, setIsSaving] = useState(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState>(() => ({
    status: 'idle',
    currentVersion: 'Unknown',
    latestVersion: null,
    packageType: null,
    installMode: 'download-only',
    manifestUrl: null,
    releasePageUrl: null,
    sourceLabel: null,
    sourceHost: null,
    downloadUrl: null,
    checksum: null,
    expectedSize: null,
    releaseNotes: null,
    assetName: null,
    downloadedFileName: null,
    downloadedPath: null,
    downloadDirectory: null,
    downloadProgress: {
      percent: 0,
      transferredBytes: 0,
      totalBytes: null,
      bytesPerSecond: null,
      etaSeconds: null
    },
    progress: 0,
    updateAvailable: false,
    readyToInstall: false,
    canAutoInstall: false,
    checksumVerified: null,
    checkInProgress: false,
    downloadInProgress: false,
    installInProgress: false,
    error: null,
    lastCheckedAt: null,
    lastDownloadedAt: null,
    lastInstalledAt: null
  }));
  const [isGuideModalOpen, setIsGuideModalOpen] = useState(false);
  const [referralSummary, setReferralSummary] = useState<ReferralSummary | null>(null);
  const [isLoadingReferrals, setIsLoadingReferrals] = useState(true);
  const [cameraPermissionStatus, setCameraPermissionStatus] = useState('Not checked');
  const [isRequestingCameraPermission, setIsRequestingCameraPermission] = useState(false);
  const isDesktopUpdatesAvailable = isDesktopUpdaterAvailable();

  useEffect(() => {
    let alive = true;

    const hydrateState = async () => {
      const state = await getDesktopUpdateState();
      if (alive) {
        setDesktopUpdateState(state);
      }
    };

    void hydrateState();

    const unsubscribe = subscribeToDesktopUpdateState((state) => {
      setDesktopUpdateState(state);
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let alive = true;

    void getReferralSummary()
      .then((summary) => {
        if (alive) setReferralSummary(summary);
      })
      .catch((error) => {
        console.warn('Unable to load referral program details:', error);
      })
      .finally(() => {
        if (alive) setIsLoadingReferrals(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  const formatBytes = (value: number | null | undefined) => {
    if (!value || value <= 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const amount = value / 1024 ** exponent;
    return `${amount.toFixed(amount >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  };

  const updateProgressLabel = () => {
    const progress = desktopUpdateState.downloadProgress;
    if (desktopUpdateState.error) {
      return 'Update check failed';
    }
    if (desktopUpdateState.checkInProgress) {
      return 'Checking for updates';
    }
    if (desktopUpdateState.downloadInProgress) {
      const total = progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : '';
      return `Downloading update — ${formatBytes(progress.transferredBytes)}${total}`;
    }

    if (desktopUpdateState.readyToInstall && desktopUpdateState.downloadedFileName) {
      return `Restart to install — ${desktopUpdateState.downloadedFileName}`;
    }

    if (desktopUpdateState.updateAvailable) {
      return 'Update available';
    }

    if (desktopUpdateState.latestVersion && desktopUpdateState.latestVersion === desktopUpdateState.currentVersion) {
      return 'You are using the latest version';
    }

    return 'No download in progress';
  };

  const handleCheckForUpdates = async () => {
    if (!isDesktopUpdatesAvailable) {
      toast.error('Desktop updates are only available in the Electron app');
      return;
    }

    toast('Checking for updates...');
    const result = await checkDesktopForUpdates();

    if (result.success) {
      if (result.updateAvailable) {
        toast.info(`Version ${result.latestVersion || 'unknown'} found. Downloading now...`);
      } else {
        toast.success('You are using the latest version.');
      }
    } else {
      toast.error(result.error || 'Failed to check for updates');
    }
  };

  const handleDownloadUpdate = async () => {
    if (!isDesktopUpdatesAvailable) {
      toast.error('Desktop updates are only available in the Electron app');
      return;
    }

    toast('Downloading update...');
    const result = await downloadDesktopUpdate();

    if (result.success) {
      if (result.readyToInstall) {
        toast.success(`Update ${result.latestVersion || ''} is ready to install.`);
      } else if (result.updateAvailable) {
        toast.info('Download is in progress.');
      } else {
        toast.info('No newer build is available right now.');
      }
    } else {
      toast.error(result.error || 'Failed to download update');
    }
  };

  const handleInstallUpdate = async () => {
    if (!isDesktopUpdatesAvailable) {
      toast.error('Desktop updates are only available in the Electron app');
      return;
    }

    const result = await installDesktopUpdate();

    if (result.success) {
      if (result.downloadOnly) {
        toast.info('The downloaded file was opened in its folder. Run it manually to finish updating.');
      } else {
        toast.success('Installer launched. Please approve the Windows prompt.');
      }
    } else {
      toast.error(result.error || 'Failed to start the installer');
    }
  };

  const handleRestartTour = async () => {
    try {
      await updateOnboardingState('restart');
      toast.success('The guided tour will restart on the dashboard.');
      navigate('/dashboard');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to restart the guided tour.');
    }
  };

  const handleCameraPermission = async () => {
    setIsRequestingCameraPermission(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      stream.getTracks().forEach((track) => track.stop());
      setCameraPermissionStatus('Camera access allowed');
      toast.success('Camera permission is enabled.');
    } catch (error) {
      const denied = error instanceof DOMException
        && ['NotAllowedError', 'SecurityError'].includes(error.name);
      setCameraPermissionStatus(denied ? 'Camera access denied' : 'Camera access unavailable');
      toast.error(
        denied
          ? 'Camera access was denied. Enable it in Windows privacy settings, then try again.'
          : 'Morphly could not access a camera on this device.',
      );
    } finally {
      setIsRequestingCameraPermission(false);
    }
  };

  const copyText = async (value: string, label: string) => {
    try {
      if (!value) {
        throw new Error('There is nothing to copy.');
      }

      if (window.electron?.isElectron) {
        const result = await window.electron.invoke('clipboard:write-text', value);
        if (!result?.success) {
          throw new Error(result?.error || 'Electron clipboard write failed.');
        }
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = value;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        const copied = document.execCommand('copy');
        textArea.remove();
        if (!copied) {
          throw new Error('Browser clipboard write failed.');
        }
      }

      toast.success(`${label} copied.`);
    } catch (error) {
      console.error(`Unable to copy ${label.toLowerCase()}:`, error);
      toast.error(`Unable to copy ${label.toLowerCase()}.`);
    }
  };

  const referralBaseUrl = String(
    import.meta.env.VITE_PUBLIC_APP_URL || 'https://morphly-alpha.vercel.app',
  ).replace(/\/+$/, '');
  const referralLink = referralSummary?.referralCode
    ? `${referralBaseUrl}/#/signup?ref=${encodeURIComponent(referralSummary.referralCode)}`
    : '';



  const handleSaveProfile = async () => {
    setIsSaving(true);
    await new Promise(resolve => setTimeout(resolve, 1000));
    toast.success('Profile updated successfully');
    setIsSaving(false);
  };

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">Settings</h1>
        <p className="text-sm text-[#a1a1aa]">Manage your account settings and preferences</p>
      </div>

      <div className="space-y-6">
        <Card className="bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#1f1f23] overflow-hidden rounded-2xl shadow-2xl shadow-black/20">
          <CardHeader className="border-b border-[#1f1f23]">
            <CardTitle className="text-lg font-semibold text-white tracking-tight">Profile Information</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">Update your account details</CardDescription>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name" className="text-sm font-medium text-[#a1a1aa]">Full Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-11 bg-[#18181b] border-[#27272a] text-white focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm font-medium text-[#a1a1aa]">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11 bg-[#18181b] border-[#27272a] text-white focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
            </div>
            <Button 
              onClick={handleSaveProfile}
              disabled={isSaving}
              className="bg-blue-600 hover:bg-blue-500 text-white font-medium"
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#1f1f23] overflow-hidden rounded-2xl shadow-2xl shadow-black/20">
          <CardHeader className="border-b border-[#1f1f23]">
            <CardTitle className="text-lg font-semibold text-white tracking-tight">Notifications</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">Configure your notification preferences</CardDescription>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-white">Email Notifications</Label>
                <p className="text-xs text-[#71717a]">Receive email updates about your account</p>
              </div>
              <Switch defaultChecked />
            </div>
            <Separator className="bg-[#27272a]" />
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-white">Low Balance Alerts</Label>
                <p className="text-xs text-[#71717a]">Get notified when your balance is low</p>
              </div>
              <Switch defaultChecked />
            </div>
            <Separator className="bg-[#27272a]" />
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-white">Marketing Emails</Label>
                <p className="text-xs text-[#71717a]">Receive updates about new features and offers</p>
              </div>
              <Switch />
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#1f1f23] overflow-hidden rounded-2xl shadow-2xl shadow-black/20">
          <CardHeader className="border-b border-[#1f1f23]">
            <CardTitle className="text-lg font-semibold text-white tracking-tight">Streaming / Capture Setup</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">Learn how to send Morphly into SplitCam, OBS, Zoom, WhatsApp & more</CardDescription>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-white">SplitCam / OBS Guide</Label>
                <p className="text-xs text-[#71717a]">Step-by-step instructions for capturing the Morphly feed and routing it into video apps</p>
              </div>
              <Button 
                onClick={() => setIsGuideModalOpen(true)}
                className="bg-blue-600 hover:bg-blue-500 text-white font-medium"
              >
                View Guide
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden rounded-2xl border-[#1f1f23] bg-gradient-to-br from-[#131316] to-[#0f0f10] shadow-2xl shadow-black/20">
          <CardHeader className="border-b border-[#1f1f23]">
            <CardTitle className="text-lg font-semibold tracking-tight text-white">Guided Tour &amp; Camera Permissions</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">
              Reopen the dashboard walkthrough or confirm that Morphly can see your physical camera.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Label className="text-sm font-medium text-white">Restart Guided Tour</Label>
                <p className="mt-1 text-xs text-[#71717a]">
                  Restarting changes only your guide state. Credits, camera settings and purchases are untouched.
                </p>
              </div>
              <Button
                data-tour="restart-tour"
                onClick={() => void handleRestartTour()}
                className="bg-amber-400 font-semibold text-black hover:bg-amber-300"
              >
                Restart Guided Tour
              </Button>
            </div>
            <Separator className="bg-[#27272a]" />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Label className="text-sm font-medium text-white">Camera Permissions</Label>
                <p className="mt-1 text-xs text-[#71717a]">{cameraPermissionStatus}</p>
              </div>
              <Button
                onClick={() => void handleCameraPermission()}
                disabled={isRequestingCameraPermission}
                variant="outline"
                className="border-[#3f3f46] text-white hover:bg-[#27272a]"
              >
                {isRequestingCameraPermission ? 'Checking...' : 'Check Camera Access'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden rounded-2xl border-[#1f1f23] bg-gradient-to-br from-[#131316] to-[#0f0f10] shadow-2xl shadow-black/20">
          <CardHeader className="border-b border-[#1f1f23]">
            <CardTitle className="text-lg font-semibold tracking-tight text-white">Referral Program</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">
              Invite people to Morphly. You receive 200 credits after each referred user completes
              their first successful credit purchase.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5 p-6">
            {isLoadingReferrals ? (
              <p className="text-sm text-[#a1a1aa]">Loading your referral details...</p>
            ) : referralSummary?.referralCode ? (
              <>
                <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-amber-300">Your referral code</p>
                  <p className="mt-2 font-mono text-2xl font-bold tracking-[0.2em] text-white">
                    {referralSummary.referralCode}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      onClick={() => void copyText(referralSummary.referralCode, 'Referral code')}
                      className="bg-amber-400 font-semibold text-black hover:bg-amber-300"
                    >
                      Copy Code
                    </Button>
                    <Button
                      onClick={() => void copyText(referralLink, 'Referral link')}
                      variant="outline"
                      className="border-[#3f3f46] text-white hover:bg-[#27272a]"
                    >
                      Copy Referral Link
                    </Button>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-[#27272a] bg-[#18181b] p-4">
                    <p className="text-xs text-[#71717a]">People referred</p>
                    <p className="mt-1 text-2xl font-semibold text-white">{referralSummary.referredCount}</p>
                  </div>
                  <div className="rounded-xl border border-[#27272a] bg-[#18181b] p-4">
                    <p className="text-xs text-[#71717a]">Qualifying purchases</p>
                    <p className="mt-1 text-2xl font-semibold text-white">{referralSummary.qualifyingPurchaseCount}</p>
                  </div>
                  <div className="rounded-xl border border-[#27272a] bg-[#18181b] p-4">
                    <p className="text-xs text-[#71717a]">Credits earned</p>
                    <p className="mt-1 text-2xl font-semibold text-white">
                      {referralSummary.totalReferralCreditsEarned.toLocaleString()}
                    </p>
                  </div>
                </div>
                {referralSummary.referrals.length === 0 ? (
                  <p className="text-sm text-[#71717a]">You have not referred anyone yet.</p>
                ) : (
                  <div className="space-y-2">
                    {referralSummary.referrals.map((referral) => (
                      <div
                        key={referral.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#27272a] bg-[#18181b] px-4 py-3"
                      >
                        <div>
                          <p className="text-sm font-medium text-white">
                            {referral.status === 'rewarded'
                              ? 'Reward earned — 200 credits added'
                              : referral.status === 'registered'
                                ? 'Signed up — waiting for first purchase'
                                : referral.status === 'qualified'
                                  ? 'First purchase confirmed'
                                  : 'Referral disqualified'}
                          </p>
                          <p className="mt-1 text-xs text-[#71717a]">
                            Registered {new Date(referral.createdAt).toLocaleDateString()}
                          </p>
                        </div>
                        {referral.refundWarning && (
                          <Badge variant="destructive">Qualifying purchase refunded</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-red-300">
                Referral details are temporarily unavailable. Please try again later.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden rounded-2xl border-[#1f1f23] bg-gradient-to-br from-[#131316] to-[#0f0f10] shadow-2xl shadow-black/20">
          <CardHeader className="border-b border-[#1f1f23]">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle className="text-lg font-semibold tracking-tight text-white">Software Updates</CardTitle>
                <CardDescription className="text-xs text-[#71717a]">
                  Check for new desktop builds, validate the download, and install when you are ready.
                </CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={desktopUpdateState.updateAvailable ? 'default' : 'secondary'}>
                  {desktopUpdateState.updateAvailable ? 'Update available' : 'Up to date'}
                </Badge>
                <Badge variant="outline">{formatUpdatePackageType(desktopUpdateState.packageType)}</Badge>
                <Badge variant="outline">{formatUpdateInstallMode(desktopUpdateState.installMode)}</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5 p-6">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-[#27272a] bg-[#18181b]/70 p-4">
                <p className="text-xs uppercase tracking-[0.24em] text-[#71717a]">Application Version</p>
                <p className="mt-2 text-2xl font-semibold text-white">{desktopUpdateState.currentVersion}</p>
                <p className="mt-2 text-xs text-[#a1a1aa]">Installed on this device right now.</p>
              </div>
              <div className="rounded-2xl border border-[#27272a] bg-[#18181b]/70 p-4">
                <p className="text-xs uppercase tracking-[0.24em] text-[#71717a]">Latest Version</p>
                <p className="mt-2 text-2xl font-semibold text-white">
                  {desktopUpdateState.latestVersion || 'Not checked yet'}
                </p>
                <p className="mt-2 text-xs text-[#a1a1aa]">
                  {desktopUpdateState.updateAvailable
                    ? 'A newer build is ready to download.'
                    : 'The updater will refresh this after it checks the manifest.'}
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-[#27272a] bg-[#18181b]/80 p-4 shadow-inner shadow-black/10">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-white">Update Status</p>
                  <p className="text-xs text-[#71717a]">{updateProgressLabel()}</p>
                </div>
                <Badge
                  variant={desktopUpdateState.error ? 'destructive' : desktopUpdateState.readyToInstall ? 'default' : 'secondary'}
                >
                  {desktopUpdateState.status.replace(/-/g, ' ')}
                </Badge>
              </div>

              <div className="mt-4">
                <Progress
                  value={desktopUpdateState.downloadInProgress || desktopUpdateState.readyToInstall ? desktopUpdateState.downloadProgress.percent : desktopUpdateState.updateAvailable ? 10 : 0}
                  className="h-2 bg-[#27272a]"
                />
              </div>

              <div className="mt-4 grid gap-3 text-xs text-[#a1a1aa] sm:grid-cols-2">
                <div>
                  <p className="text-[#71717a]">Downloaded file</p>
                  <p className="mt-1 font-medium text-white">
                    {desktopUpdateState.downloadedFileName || 'Waiting for download'}
                  </p>
                  <p className="mt-1 text-[#a1a1aa]">
                    {desktopUpdateState.downloadInProgress
                      ? formatBytes(desktopUpdateState.downloadProgress.transferredBytes)
                      : desktopUpdateState.readyToInstall
                        ? 'Validated and ready to install'
                        : 'The updater will fill this in once the file arrives.'}
                  </p>
                </div>
                <div>
                  <p className="text-[#71717a]">Checksum</p>
                  <p className="mt-1 text-white">
                    {desktopUpdateState.checksum
                      ? desktopUpdateState.checksumVerified === true
                        ? 'Verified'
                        : 'Pending verification'
                      : 'Not provided'}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-1">
              <div className="rounded-2xl border border-[#27272a] bg-[#18181b]/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-white">Release Notes</p>
                    <p className="text-xs text-[#71717a]">What changed in the latest build.</p>
                  </div>
                </div>
                <div className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-[#27272a] bg-black/20 p-3 text-xs leading-6 text-[#d4d4d8]">
                  {desktopUpdateState.releaseNotes || 'No release notes were provided with this manifest.'}
                </div>
              </div>
            </div>

            {desktopUpdateState.error && (
              <div className="rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
                <p className="font-semibold">Updater error</p>
                <p className="mt-1 break-words text-xs leading-6 text-red-100/90">{desktopUpdateState.error}</p>
              </div>
            )}

            {!isDesktopUpdatesAvailable && (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
                Desktop updates are only available in the packaged Electron app. The web app will keep updating through normal deploys.
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <Button
                onClick={handleCheckForUpdates}
                disabled={!isDesktopUpdatesAvailable || desktopUpdateState.checkInProgress || desktopUpdateState.downloadInProgress || desktopUpdateState.installInProgress}
                className="bg-green-600 font-medium text-white hover:bg-green-500"
              >
                {desktopUpdateState.checkInProgress
                  ? 'Checking...'
                  : desktopUpdateState.downloadInProgress
                    ? 'Downloading...'
                    : 'Check for Updates'}
              </Button>
              <Button
                onClick={handleDownloadUpdate}
                disabled={!isDesktopUpdatesAvailable || desktopUpdateState.downloadInProgress || desktopUpdateState.installInProgress || desktopUpdateState.readyToInstall}
                className="bg-blue-600 font-medium text-white hover:bg-blue-500"
              >
                Download Update
              </Button>
              <Button
                onClick={handleInstallUpdate}
                disabled={!isDesktopUpdatesAvailable || !desktopUpdateState.readyToInstall || desktopUpdateState.installInProgress}
                className="bg-white font-bold text-black hover:bg-[#e4e4e7]"
              >
                {desktopUpdateState.installInProgress
                  ? 'Launching...'
                  : desktopUpdateState.canAutoInstall
                    ? 'Restart to Install'
                    : 'Show Download'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <StreamGuideModal 
          isOpen={isGuideModalOpen} 
          onClose={() => setIsGuideModalOpen(false)} 
        />

        <Card className="bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#1f1f23] overflow-hidden rounded-2xl shadow-2xl shadow-black/20">
          <CardHeader className="border-b border-[#1f1f23]">
            <CardTitle className="text-lg font-semibold text-white tracking-tight">Contact &amp; Support</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">Reach out for help or feedback</CardDescription>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-white">Email Support</Label>
                <p className="text-xs text-[#71717a]">samuellucky2424@gmail.com</p>
              </div>
              <Button
                onClick={() => { window.open('mailto:samuellucky2424@gmail.com', '_blank'); }}
                variant="outline"
                className="border-[#27272a] text-[#a1a1aa] hover:text-white hover:bg-[#27272a]"
              >
                Send Email
              </Button>
            </div>
            <Separator className="bg-[#27272a]" />
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-white">WhatsApp</Label>
                <p className="text-xs text-[#71717a]">+234 703 819 5038</p>
              </div>
              <Button
                onClick={() => { window.open('https://wa.me/2347038195038', '_blank'); }}
                variant="outline"
                className="border-[#27272a] text-[#a1a1aa] hover:text-white hover:bg-[#27272a]"
              >
                Open WhatsApp
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#1f1f23] overflow-hidden rounded-2xl shadow-2xl shadow-black/20">
          <CardHeader className="border-b border-[#1f1f23]">
            <CardTitle className="text-lg font-semibold text-white tracking-tight">Danger Zone</CardTitle>
            <CardDescription className="text-xs text-[#71717a]">Irreversible actions</CardDescription>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium text-white">Sign Out</Label>
                <p className="text-xs text-[#71717a]">Sign out of your account on this device</p>
              </div>
              <Button 
                onClick={logout}
                variant="outline"
                className="border-[#27272a] text-[#a1a1aa] hover:text-white hover:bg-[#27272a]"
              >
                Sign Out
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default Settings;
