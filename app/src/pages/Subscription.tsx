import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Coins, Copy, CreditCard, ExternalLink, Loader2, ShieldCheck, Wallet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import QRCode from 'qrcode';

import { Button } from '@/components/ui/button';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { apiFetch, apiFetchWithAuth } from '@/lib/api-client';
import { CREDITS_PER_SECOND } from '@/lib/billing';
import { trackPaymentStarted, trackPaymentSucceeded, trackPaymentFailed } from '@/lib/telemetry-client';

interface CreditPlan {
  id?: string;
  name?: string;
  credits: number;
  priceNGN: number;
  isActive?: boolean;
  sortOrder?: number;
}

type PaymentMethod = 'flutterwave' | 'crypto';

const FLUTTERWAVE_PENDING_PAYMENT_KEY = 'morphly.flutterwave.pending-payment';

interface PendingFlutterwavePayment {
  reference: string;
  packageId?: string;
  credits?: number;
}

interface FlutterwaveReturn {
  status: string;
  reference: string;
  transactionId: string;
  isReturn: boolean;
}

const EMPTY_FLUTTERWAVE_RETURN: FlutterwaveReturn = {
  status: '',
  reference: '',
  transactionId: '',
  isReturn: false,
};

function readFlutterwaveReturn(): FlutterwaveReturn {
  const searchParams = new URLSearchParams(window.location.search);
  const hashQuery = window.location.hash.includes('?')
    ? window.location.hash.slice(window.location.hash.indexOf('?') + 1)
    : '';
  const hashParams = new URLSearchParams(hashQuery);
  const getParameter = (name: string) => hashParams.get(name) || searchParams.get(name);

  const status = String(getParameter('status') || '').trim().toLowerCase();
  const reference = String(getParameter('tx_ref') || '').trim();
  const transactionId = String(getParameter('transaction_id') || '').trim();

  return {
    status,
    reference,
    transactionId,
    isReturn: Boolean(reference || transactionId),
  };
}

function readPendingFlutterwavePayment(): PendingFlutterwavePayment | null {
  try {
    const value = sessionStorage.getItem(FLUTTERWAVE_PENDING_PAYMENT_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed && typeof parsed.reference === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function storePendingFlutterwavePayment(payment: PendingFlutterwavePayment) {
  try {
    sessionStorage.setItem(FLUTTERWAVE_PENDING_PAYMENT_KEY, JSON.stringify(payment));
  } catch {
    // The verified Flutterwave metadata remains authoritative if storage is unavailable.
  }
}

function clearPendingFlutterwavePayment() {
  try {
    sessionStorage.removeItem(FLUTTERWAVE_PENDING_PAYMENT_KEY);
  } catch {
    // Ignore unavailable browser storage.
  }
}

function clearFlutterwaveReturnUrl() {
  window.history.replaceState(window.history.state, '', `${window.location.pathname}#/subscription`);
}

const DEFAULT_CREDIT_PLANS: CreditPlan[] = [
  { credits: 500, priceNGN: 11500 },
  { credits: 1000, priceNGN: 23000 },
  { credits: 2000, priceNGN: 46000 },
  { credits: 5000, priceNGN: 115000 },
];

function formatTime(credits: number): string {
  const seconds = credits / CREDITS_PER_SECOND;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `~${minutes}m ${remainingSeconds}s`;
  }

  return `~${remainingSeconds}s`;
}

function Subscription() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { setBalance, setCredits } = useApp();
  const [creditPlans, setCreditPlans] = useState<CreditPlan[]>(DEFAULT_CREDIT_PLANS);
  const [selectedPlan, setSelectedPlan] = useState<CreditPlan | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('flutterwave');
  const [isProcessing, setIsProcessing] = useState(false);
  const [ngnRate, setNgnRate] = useState<number>(1500);
  const [isLoadingRate, setIsLoadingRate] = useState(true);
  const [isLoadingPlans, setIsLoadingPlans] = useState(true);
  const [isFallbackRate, setIsFallbackRate] = useState(false);
  const [rateUpdatedAt, setRateUpdatedAt] = useState<string | null>(null);
  const [isCryptoEnabled, setIsCryptoEnabled] = useState(true);
  const [activeCryptoSession, setActiveCryptoSession] = useState<{
    reference: string;
    checkoutUrl: string;
    credits: number;
    packageId?: string;
    priceUSD: number;
    paymentInstructions?: {
      address: string;
      chain: string;
      amount: number | string;
      currency: string;
      expiresAt?: string | null;
    };
  } | null>(null);
  const [isCheckingCrypto, setIsCheckingCrypto] = useState(false);
  const [cryptoPaymentQrCode, setCryptoPaymentQrCode] = useState<string | null>(null);
  const [flutterwaveReturn, setFlutterwaveReturn] = useState<FlutterwaveReturn>(readFlutterwaveReturn);

  const flutterwaveReturnHandledRef = useRef(false);
  const flutterwaveCheckoutWindowRef = useRef<Window | null>(null);
  const flutterwaveCheckoutCloseTimerRef = useRef<number | null>(null);
  const flutterwaveReturnReceivedRef = useRef(false);

  useEffect(() => {
    let isCancelled = false;
    const applyRuntimeConfig = (config: any) => {
      if (isCancelled) return;
      if (typeof config?.isCryptoPaymentEnabled === 'boolean') {
        setIsCryptoEnabled(config.isCryptoPaymentEnabled);
      }
    };

    void apiFetch('/public-config')
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const config = await res.json();
        applyRuntimeConfig(config);
      })
      .catch((error) => {
        console.warn('Failed to load runtime payment configuration:', error);
      });

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleFlutterwaveMessage = (event: MessageEvent) => {
      const checkoutWindow = flutterwaveCheckoutWindowRef.current;
      const data = event.data;
      if (!checkoutWindow || event.source !== checkoutWindow) return;
      if (!data || data.type !== 'morphly:flutterwave-return') return;

      const pendingPayment = readPendingFlutterwavePayment();
      const reference = String(data.reference || data.tx_ref || '').trim();
      if (!pendingPayment?.reference || reference !== pendingPayment.reference) return;

      flutterwaveReturnReceivedRef.current = true;
      if (flutterwaveCheckoutCloseTimerRef.current != null) {
        window.clearInterval(flutterwaveCheckoutCloseTimerRef.current);
        flutterwaveCheckoutCloseTimerRef.current = null;
      }
      if (!checkoutWindow.closed) checkoutWindow.close();
      flutterwaveCheckoutWindowRef.current = null;
      setFlutterwaveReturn({
        status: String(data.status || '').trim().toLowerCase(),
        reference,
        transactionId: String(data.transactionId || data.transaction_id || '').trim(),
        isReturn: true,
      });
    };

    window.addEventListener('message', handleFlutterwaveMessage);
    return () => {
      window.removeEventListener('message', handleFlutterwaveMessage);
      if (flutterwaveCheckoutCloseTimerRef.current != null) {
        window.clearInterval(flutterwaveCheckoutCloseTimerRef.current);
        flutterwaveCheckoutCloseTimerRef.current = null;
      }
      const checkoutWindow = flutterwaveCheckoutWindowRef.current;
      if (checkoutWindow && !checkoutWindow.closed) checkoutWindow.close();
      flutterwaveCheckoutWindowRef.current = null;
    };
  }, []);

  useEffect(() => {
    const paymentReturn = flutterwaveReturn;
    if (!paymentReturn.isReturn || flutterwaveReturnHandledRef.current) return;

    const pendingPayment = readPendingFlutterwavePayment();
    if (
      pendingPayment?.reference
      && paymentReturn.reference
      && pendingPayment.reference !== paymentReturn.reference
    ) {
      flutterwaveReturnHandledRef.current = true;
      clearFlutterwaveReturnUrl();
      toast.error('Payment reference mismatch. Your pending checkout was not changed.');
      return;
    }

    const isCancelled = paymentReturn.status === 'cancelled' || paymentReturn.status === 'canceled';
    const isFailed = ['failed', 'error'].includes(paymentReturn.status);

    if (isCancelled || isFailed) {
      flutterwaveReturnHandledRef.current = true;
      if (pendingPayment?.packageId) {
        trackPaymentFailed({
          packageId: pendingPayment.packageId,
          reason: isCancelled ? 'user_cancelled' : 'payment_failed',
        });
      }
      clearPendingFlutterwavePayment();
      clearFlutterwaveReturnUrl();
      toast[isCancelled ? 'info' : 'error'](isCancelled ? 'Payment cancelled' : 'Payment was not completed.');
      setIsProcessing(false);
      navigate('/subscription', { replace: true });
      return;
    }

    if (!user?.id) return;

    if (!paymentReturn.reference) {
      flutterwaveReturnHandledRef.current = true;
      if (pendingPayment?.packageId) {
        trackPaymentFailed({ packageId: pendingPayment.packageId, reason: 'missing_transaction_reference' });
      }
      clearPendingFlutterwavePayment();
      clearFlutterwaveReturnUrl();
      toast.error('Payment was not completed.');
      setIsProcessing(false);
      navigate('/subscription', { replace: true });
      return;
    }

    flutterwaveReturnHandledRef.current = true;
    setIsProcessing(true);

    void (async () => {
      try {
        const res = await apiFetchWithAuth('/verify-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reference: paymentReturn.reference,
            ...(paymentReturn.transactionId ? { transactionId: paymentReturn.transactionId } : {}),
            userId: user.id,
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.message || `Server returned ${res.status}`);
        if (data.status !== 'success') throw new Error(data.message || 'Payment verification failed');

        if (typeof data.newBalance === 'number') setBalance(data.newBalance);
        if (typeof data.newCredits === 'number') setCredits(data.newCredits);

        const successMetadata: Record<string, string | number> = {
          transactionId: data.transactionId || paymentReturn.transactionId || paymentReturn.reference,
        };
        if (pendingPayment?.packageId) successMetadata.packageId = pendingPayment.packageId;
        trackPaymentSucceeded(successMetadata);

        const creditsAdded = Number(data.creditsAdded || pendingPayment?.credits || 0);
        toast.success(
          creditsAdded > 0
            ? `Successfully purchased ${creditsAdded} credits!`
            : 'Payment verified and credits added to your wallet!',
        );
        clearPendingFlutterwavePayment();
        clearFlutterwaveReturnUrl();
        navigate('/wallet', { replace: true });
      } catch (error) {
        console.error(error);
        if (paymentReturn.status === 'closed') {
          if (pendingPayment?.packageId) {
            trackPaymentFailed({ packageId: pendingPayment.packageId, reason: 'user_cancelled' });
          }
          clearPendingFlutterwavePayment();
          toast.info('Payment cancelled or not completed.');
          return;
        }
        const failureMetadata: Record<string, string> = {
          reason: 'verification_error',
          message: error instanceof Error ? error.message : 'Unknown',
        };
        if (pendingPayment?.packageId) failureMetadata.packageId = pendingPayment.packageId;
        trackPaymentFailed(failureMetadata);
        toast.error(error instanceof Error ? error.message : 'Payment could not be verified.');
      } finally {
        setIsProcessing(false);
      }
    })();
  }, [flutterwaveReturn, navigate, setBalance, setCredits, user?.id]);

  useEffect(() => {
    const fetchRate = async () => {
      try {
        const res = await apiFetch('/rate');
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        if (typeof data.rate === 'number') {
          setNgnRate(data.rate);
          setIsFallbackRate(data.live !== true);
          setRateUpdatedAt(data.updatedAt || null);
        }
      } catch (error) {
        console.warn('Failed to fetch exchange rate:', error, 'using fallback');
        setNgnRate(1500);
        setIsFallbackRate(true);
        setRateUpdatedAt(null);
      } finally {
        setIsLoadingRate(false);
      }
    };

    fetchRate();
  }, []);

  useEffect(() => {
    const fetchCreditPackages = async () => {
      try {
        const res = await apiFetch('/credit-packages');
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        const packages = Array.isArray(data?.packages)
          ? data.packages
              .map((pkg: any) => ({
                id: pkg.id,
                name: pkg.name,
                credits: Number(pkg.credits || 0),
                priceNGN: Number(pkg.priceNGN || pkg.price_ngn || 0),
                isActive: pkg.isActive ?? pkg.is_active,
                sortOrder: Number(pkg.sortOrder || pkg.sort_order || 0),
              }))
              .filter((pkg: CreditPlan) => pkg.credits > 0 && pkg.priceNGN >= 0)
              .sort((a: CreditPlan, b: CreditPlan) => (a.sortOrder || 0) - (b.sortOrder || 0))
          : [];

        if (packages.length > 0) {
          setCreditPlans(packages);
        }
      } catch (error) {
        console.warn('Failed to fetch live credit packages:', error, 'using fallback plans');
      } finally {
        setIsLoadingPlans(false);
      }
    };

    fetchCreditPackages();
  }, []);

  useEffect(() => {
    const address = activeCryptoSession?.paymentInstructions?.address;
    if (!address) {
      setCryptoPaymentQrCode(null);
      return undefined;
    }

    let cancelled = false;
    void QRCode.toDataURL(address, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 240,
      color: { dark: '#18181b', light: '#ffffff' },
    })
      .then((dataUrl) => {
        if (!cancelled) setCryptoPaymentQrCode(dataUrl);
      })
      .catch((error: unknown) => {
        console.error('Failed to generate crypto payment QR code:', error);
        if (!cancelled) setCryptoPaymentQrCode(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeCryptoSession?.paymentInstructions?.address]);

  const handleSelectPlan = (plan: CreditPlan) => {
    setSelectedPlan(plan);
  };

  const getPriceUSDNumber = (priceNGN: number) => {
    return Number((priceNGN / ngnRate).toFixed(2));
  };

  const getPriceUSD = (priceNGN: number) => (priceNGN / ngnRate).toFixed(2);
  const hasLiveRate = !isLoadingRate && !isFallbackRate;

  const handleProceedToPayment = async () => {
    if (!selectedPlan) {
      toast.error('Please select a plan');
      return;
    }

    if (!user?.id || !user?.email) {
      toast.error('Please log in to purchase credits');
      navigate('/login');
      return;
    }

    if (paymentMethod === 'crypto') {
      await handleCryptoPayment();
    } else {
      await handleFlutterwavePayment();
    }
  };

  const handleCryptoPayment = async () => {
    if (!selectedPlan || !user) return;
    const priceUSD = getPriceUSDNumber(selectedPlan.priceNGN);

    try {
      setIsProcessing(true);
      trackPaymentStarted({ packageId: selectedPlan.id!, amount: priceUSD, currency: 'USD' });

      const res = await apiFetchWithAuth('/initiate-crypto-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: selectedPlan.id,
          credits: selectedPlan.credits,
          priceUSD,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.reference) {
        throw new Error(data.message || 'Failed to create crypto checkout session');
      }

      const checkoutUrl = data.checkoutUrl;
      setActiveCryptoSession({
        reference: data.reference,
        checkoutUrl: checkoutUrl || '',
        credits: selectedPlan.credits,
        packageId: selectedPlan.id,
        priceUSD,
        paymentInstructions: data.paymentInstructions,
      });

      if (checkoutUrl) {
        window.open(checkoutUrl, '_blank', 'noopener,noreferrer');
        toast.info('Crypto checkout opened in a new tab. Complete your transfer and click Verify.');
      } else if (data.paymentInstructions?.address) {
        toast.success('Payment instructions are ready. Send the exact amount, then click Verify.');
      } else {
        toast.info('Crypto payment session initialized. Click Verify once transferred.');
      }
    } catch (error) {
      console.error(error);
      trackPaymentFailed({ packageId: selectedPlan.id!, reason: 'crypto_init_failed', message: error instanceof Error ? error.message : 'Unknown' });
      toast.error(error instanceof Error ? error.message : 'Failed to initialize crypto checkout');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleVerifyCryptoPayment = async () => {
    if (!activeCryptoSession || !user) return;

    try {
      setIsCheckingCrypto(true);
      const res = await apiFetchWithAuth('/verify-crypto-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference: activeCryptoSession.reference,
          userId: user.id,
          credits: activeCryptoSession.credits,
          packageId: activeCryptoSession.packageId,
          priceUSD: activeCryptoSession.priceUSD,
        }),
      });

      const data = await res.json();
      if (res.status === 202 || data.status === 'pending') {
        toast.info('Transaction is pending blockchain confirmation. Please check back in 1-2 minutes.');
        return;
      }

      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || 'Crypto payment could not be verified yet.');
      }

      if (typeof data.newBalance === 'number') {
        setBalance(data.newBalance);
      }
      if (typeof data.newCredits === 'number') {
        setCredits(data.newCredits);
      }

      trackPaymentSucceeded({ packageId: activeCryptoSession.packageId!, transactionId: data.transactionId });
      toast.success(`Crypto payment verified! ${activeCryptoSession.credits} credits added to your wallet.`);
      setActiveCryptoSession(null);
      navigate('/wallet');
    } catch (error) {
      console.error(error);
      toast.error(error instanceof Error ? error.message : 'Payment verification failed');
    } finally {
      setIsCheckingCrypto(false);
    }
  };

  const handleFlutterwavePayment = async () => {
    if (!selectedPlan || !user) return;

    const checkoutWindow = window.open(
      'about:blank',
      '_blank',
      'popup=yes,width=520,height=760,resizable=yes,scrollbars=yes',
    );
    if (!checkoutWindow) {
      trackPaymentFailed({ packageId: selectedPlan.id!, reason: 'checkout_popup_blocked' });
      toast.error('Please allow payment pop-ups for Morphly and try again.');
      return;
    }

    const priceUSD = Number(getPriceUSD(selectedPlan.priceNGN));
    flutterwaveCheckoutWindowRef.current = checkoutWindow;
    flutterwaveReturnReceivedRef.current = false;
    flutterwaveReturnHandledRef.current = false;
    setFlutterwaveReturn(EMPTY_FLUTTERWAVE_RETURN);
    setIsProcessing(true);
    trackPaymentStarted({ packageId: selectedPlan.id!, amount: selectedPlan.priceNGN, currency: 'NGN' });

    let initiatedReference = '';
    try {
      const res = await apiFetchWithAuth('/initiate-flutterwave-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: selectedPlan.id,
          priceUSD,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.reference || !data.checkoutUrl) {
        throw new Error(data.message || 'Failed to initialize Flutterwave checkout');
      }
      initiatedReference = data.reference;

      storePendingFlutterwavePayment({
        reference: data.reference,
        packageId: selectedPlan.id,
        credits: selectedPlan.credits,
      });
      checkoutWindow.location.replace(data.checkoutUrl);
      flutterwaveCheckoutCloseTimerRef.current = window.setInterval(() => {
        if (!checkoutWindow.closed) return;

        if (flutterwaveCheckoutCloseTimerRef.current != null) {
          window.clearInterval(flutterwaveCheckoutCloseTimerRef.current);
          flutterwaveCheckoutCloseTimerRef.current = null;
        }
        if (flutterwaveCheckoutWindowRef.current === checkoutWindow) {
          flutterwaveCheckoutWindowRef.current = null;
        }
        if (flutterwaveReturnReceivedRef.current) return;

        const pendingPayment = readPendingFlutterwavePayment();
        if (pendingPayment?.reference === data.reference) {
          setFlutterwaveReturn({
            status: 'closed',
            reference: data.reference,
            transactionId: '',
            isReturn: true,
          });
        }
      }, 500);
    } catch (error) {
      if (!checkoutWindow.closed) checkoutWindow.close();
      if (flutterwaveCheckoutWindowRef.current === checkoutWindow) {
        flutterwaveCheckoutWindowRef.current = null;
      }
      const pendingPayment = readPendingFlutterwavePayment();
      if (initiatedReference && pendingPayment?.reference === initiatedReference) {
        clearPendingFlutterwavePayment();
      }
      console.error(error);
      trackPaymentFailed({ packageId: selectedPlan.id!, reason: 'gateway_init_failed' });
      toast.error(error instanceof Error ? error.message : 'Failed to initialize payment gateway');
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-6 lg:p-10 flex flex-col items-start">
      <div className="w-full max-w-[560px] pb-24">
        {/* Navigation & Header */}
        <div className="flex items-center justify-between mb-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(-1)}
            className="h-7 px-2.5 text-xs text-muted-foreground hover:text-foreground bg-background border border-border rounded-md"
          >
            <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
            Back
          </Button>
          <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-muted text-muted-foreground border border-border">
            Compute Credits
          </span>
        </div>

        <div className="mb-4">
          <h1 className="text-xl font-bold text-foreground tracking-tight">Purchase Credits</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Select a credit package for real-time AI transformations</p>
        </div>

        {/* Payment Method Selector */}
        {isCryptoEnabled && (
          <div className="grid grid-cols-2 p-1 bg-background border border-border rounded-lg gap-1 mb-4">
            <button
              type="button"
              onClick={() => setPaymentMethod('flutterwave')}
              className={`py-2 px-3 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                paymentMethod === 'flutterwave'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <CreditCard className="w-3.5 h-3.5" />
              <span>Card / Bank (NGN)</span>
            </button>
            <button
              type="button"
              onClick={() => setPaymentMethod('crypto')}
              className={`py-2 px-3 rounded-md text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                paymentMethod === 'crypto'
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
            >
              <Wallet className="w-3.5 h-3.5" />
              <span>Crypto (USDT / USDC)</span>
            </button>
          </div>
        )}

        {/* Active Crypto Session Alert */}
        {activeCryptoSession && (
          <div className="mb-4 rounded-lg border border-success/30 bg-success-soft p-3 text-xs shadow-md">
            <div className="flex items-start justify-between">
              <div className="w-full">
                <div className="flex items-center gap-1.5 font-semibold text-success mb-0.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Payment in Progress</span>
                </div>
                <p className="text-[11px] text-muted-foreground mb-2">
                  {activeCryptoSession.credits.toLocaleString()} credits for ${activeCryptoSession.priceUSD}
                </p>
                {activeCryptoSession.paymentInstructions?.address && (
                  <div className="mb-2.5 rounded-md border border-success/20 bg-background p-2.5 text-[11px] text-foreground">
                    <p className="font-semibold text-success">
                      Send {activeCryptoSession.paymentInstructions.amount} {activeCryptoSession.paymentInstructions.currency} ({activeCryptoSession.paymentInstructions.chain})
                    </p>
                    {cryptoPaymentQrCode && (
                      <div className="mt-2 flex items-center gap-2.5 rounded bg-background p-2">
                        <img
                          src={cryptoPaymentQrCode}
                          alt="QR Code"
                          className="h-20 w-20 rounded"
                        />
                        <p className="text-[10px] leading-tight text-foreground">
                          Scan to copy the wallet address. Confirm the network and amount before transferring.
                        </p>
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-1.5">
                      <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1 text-[10px] font-mono text-foreground">
                        {activeCryptoSession.paymentInstructions.address}
                      </code>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-7 w-7 shrink-0 border-success/30 text-success hover:bg-success-soft"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(activeCryptoSession.paymentInstructions!.address);
                            toast.success('Wallet address copied');
                          } catch {
                            toast.error('Could not copy wallet address');
                          }
                        }}
                        aria-label="Copy wallet address"
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  {activeCryptoSession.checkoutUrl && (
                    <Button
                      size="sm"
                      onClick={() => window.open(activeCryptoSession.checkoutUrl, '_blank')}
                      className="bg-primary hover:bg-primary-hover text-primary-foreground text-xs h-7 px-3 rounded"
                    >
                      <ExternalLink className="w-3 h-3 mr-1" />
                      Reopen
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={handleVerifyCryptoPayment}
                    disabled={isCheckingCrypto}
                    className="bg-primary hover:bg-primary-hover text-primary-foreground text-xs h-7 px-3 rounded"
                  >
                    {isCheckingCrypto ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <ShieldCheck className="w-3 h-3 mr-1" />}
                    Verify & Claim
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Credit Plans Selection Grid */}
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Select Package
          </label>
          <div className="grid grid-cols-2 gap-2">
            {creditPlans.map((plan) => {
              const isSelected = selectedPlan?.credits === plan.credits;
              const priceUSD = getPriceUSD(plan.priceNGN);

              return (
                <button
                  key={plan.id || plan.credits}
                  onClick={() => handleSelectPlan(plan)}
                  className={`p-3 rounded-lg border text-left transition-all duration-150 flex flex-col justify-between ${
                    isSelected
                      ? paymentMethod === 'crypto'
                        ? 'bg-background border-success/25 shadow-sm ring-1 ring-success/40'
                        : 'bg-background border-primary/25 shadow-sm ring-1 ring-ring/40'
                      : 'bg-background border-border hover:border-border hover:bg-background'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <div
                      className={`w-7 h-7 rounded flex items-center justify-center shrink-0 ${
                        isSelected
                          ? paymentMethod === 'crypto'
                            ? 'bg-success-soft text-success'
                            : 'bg-accent text-primary'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      <Coins className="w-3.5 h-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-foreground truncate leading-tight">
                        {plan.credits.toLocaleString()} Cr
                      </p>
                      <p className="text-[10px] text-muted-foreground font-mono leading-tight">
                        {formatTime(plan.credits)}
                      </p>
                    </div>
                  </div>

                  <div className="mt-1 pt-1.5 border-t border-border flex items-baseline justify-between">
                    {paymentMethod === 'crypto' ? (
                      <>
                        <span className="text-sm font-bold text-success">${priceUSD}</span>
                        <span className="text-[10px] text-muted-foreground">USDT</span>
                      </>
                    ) : (
                      <>
                        <span className="text-sm font-bold text-foreground">₦{plan.priceNGN.toLocaleString()}</span>
                        {hasLiveRate && (
                          <span className="text-[10px] text-muted-foreground">(${priceUSD})</span>
                        )}
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* How credits work */}
        <div className="bg-background border border-border rounded-lg p-3 mb-4">
          <h3 className="text-xs font-semibold text-foreground mb-1.5">Usage & Billing Details</h3>
          <ul className="text-[11px] text-muted-foreground space-y-1 leading-snug">
            <li>- 2 credits/sec for standard morph (4 credits/sec for dual background morph)</li>
            <li>- 500 credits &asymp; 4m 10s &bull; 1,000 credits &asymp; 8m 20s</li>
            {isCryptoEnabled && <li>- Instant on-chain confirmation across USDT/USDC networks</li>}
            <li>- Credits do not expire</li>
          </ul>
        </div>

        {/* Info & Rates */}
        <div className="text-left text-[11px] text-muted-foreground">
          <p>All purchases are one-time. No recurring fees or hidden charges.</p>
          {paymentMethod === 'crypto' ? (
            <p className="text-success text-[10px] mt-0.5">
              Secure blockchain settlement
            </p>
          ) : (
            <>
              {hasLiveRate && (
                <p className="text-muted-foreground text-[10px] mt-0.5">
                  Live Rate: 1 USD = ₦{ngnRate.toLocaleString()}
                  {rateUpdatedAt && (
                    <span className="ml-1 text-muted-foreground">
                      ({new Date(rateUpdatedAt).toLocaleTimeString()})
                    </span>
                  )}
                </p>
              )}
            </>
          )}
          {isLoadingPlans && (
            <p className="text-[10px] text-muted-foreground mt-1">Refreshing credit plans...</p>
          )}
        </div>
      </div>

      {/* Floating Bottom Checkout Bar */}
      {selectedPlan && (
        <div className="fixed bottom-0 left-0 w-full bg-background backdrop-blur-md border-t border-border py-2.5 px-6 lg:px-10 z-50 shadow-2xl">
          <div className="max-w-[560px] w-full flex items-center justify-between gap-3">
            <div className="flex flex-col min-w-0">
              <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Selected</span>
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-bold text-foreground">
                  {selectedPlan.credits.toLocaleString()} Credits
                </span>
                <span className="text-muted-foreground text-xs">/</span>
                {paymentMethod === 'crypto' ? (
                  <span className="text-xs font-bold text-success">${getPriceUSD(selectedPlan.priceNGN)}</span>
                ) : (
                  <span className="text-xs font-bold text-foreground">₦{selectedPlan.priceNGN.toLocaleString()}</span>
                )}
              </div>
            </div>
            <Button
              onClick={handleProceedToPayment}
              disabled={isProcessing}
              className="h-9 px-5 text-xs font-semibold rounded-md shadow-sm transition-colors bg-primary text-primary-foreground hover:bg-primary-hover"
            >
              {isProcessing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
              ) : (
                paymentMethod === 'crypto' ? 'Pay with Crypto' : 'Pay with Card / Bank'
              )}
              {!isProcessing && <ArrowRight className="w-3.5 h-3.5 ml-1.5" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Subscription;
