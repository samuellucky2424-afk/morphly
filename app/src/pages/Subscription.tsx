import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Coins, Copy, CreditCard, ExternalLink, Loader2, ShieldCheck, Wallet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { apiFetch, apiFetchWithAuth } from '@/lib/api-client';
import { CREDITS_PER_SECOND } from '@/lib/billing';
import { trackPaymentStarted, trackPaymentSucceeded, trackPaymentFailed } from '@/lib/telemetry-client';

declare global {
  interface Window {
    FlutterwaveCheckout?: (options: any) => void;
  }
}

interface CreditPlan {
  id?: string;
  name?: string;
  credits: number;
  priceNGN: number;
  isActive?: boolean;
  sortOrder?: number;
}

type PaymentMethod = 'flutterwave' | 'crypto';

const FLUTTERWAVE_SCRIPT_ID = 'flutterwave-checkout-js';

function isValidFlutterwavePublicKey(key: string): boolean {
  return /^FLWPUBK(?:_TEST)?-[A-Za-z0-9_-]+-X$/.test(key);
}

function loadFlutterwaveScript(): Promise<void> {
  if (window.FlutterwaveCheckout) {
    return Promise.resolve();
  }

  const existingScript = document.getElementById(FLUTTERWAVE_SCRIPT_ID) as HTMLScriptElement | null;
  if (existingScript) {
    return new Promise((resolve, reject) => {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', () => reject(new Error('Failed to load Flutterwave SDK')), { once: true });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = FLUTTERWAVE_SCRIPT_ID;
    script.src = 'https://checkout.flutterwave.com/v3.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Flutterwave SDK'));
    document.body.appendChild(script);
  });
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
  const [isFlutterwaveReady, setIsFlutterwaveReady] = useState(false);
  const [runtimeFlutterwavePublicKey, setRuntimeFlutterwavePublicKey] = useState('');
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

  const flutterwavePublicKey = runtimeFlutterwavePublicKey;
  const hasValidFlutterwavePublicKey = isValidFlutterwavePublicKey(flutterwavePublicKey);
  const paymentCompletedRef = useRef(false);

  useEffect(() => {
    let isCancelled = false;
    const applyRuntimeConfig = (config: any) => {
      if (isCancelled) return;
      const normalizedKey = typeof config?.flutterwavePublicKey === 'string' ? config.flutterwavePublicKey.trim() : '';
      if (normalizedKey) {
        setRuntimeFlutterwavePublicKey(normalizedKey);
      }
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
    void loadFlutterwaveScript()
      .then(() => {
        setIsFlutterwaveReady(true);
      })
      .catch((error) => {
        console.error(error);
        setIsFlutterwaveReady(false);
      });
  }, []);

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
      handleFlutterwavePayment();
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

  const handleFlutterwavePayment = () => {
    if (!selectedPlan || !user) return;
    if (!hasValidFlutterwavePublicKey) {
      toast.error('Payment configuration is invalid. Please contact support.');
      return;
    }

    if (!isFlutterwaveReady || !window.FlutterwaveCheckout) {
      toast.error('Payment gateway is still loading. Please try again.');
      return;
    }

    const priceUSD = Number(getPriceUSD(selectedPlan.priceNGN));
    setIsProcessing(true);
    paymentCompletedRef.current = false;
    trackPaymentStarted({ packageId: selectedPlan.id!, amount: selectedPlan.priceNGN, currency: 'NGN' });

    const txRef = `morphly_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    try {
      window.FlutterwaveCheckout?.({
        public_key: flutterwavePublicKey,
        tx_ref: txRef,
        amount: selectedPlan.priceNGN,
        currency: 'NGN',
        payment_options: 'card,banktransfer,ussd',
        customer: {
          email: user.email,
          name: user.name || user.email.split('@')[0] || 'Morphly User',
        },
        meta: {
          userId: user.id,
          credits: selectedPlan.credits,
          packageId: selectedPlan.id,
          priceUSD,
        },
        customizations: {
          title: 'Morphly Credits',
          description: `Purchase ${selectedPlan.credits} credits`,
        },
        callback: function (response: any) {
          if (paymentCompletedRef.current) return;
          if (!response?.transaction_id) {
            setIsProcessing(false);
            trackPaymentFailed({ packageId: selectedPlan.id!, reason: 'missing_transaction_id' });
            toast.error('Payment was not completed.');
            return;
          }

          paymentCompletedRef.current = true;
          (async () => {
            try {
              const res = await apiFetchWithAuth('/verify-payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  reference: response.tx_ref || txRef,
                  transactionId: response.transaction_id,
                  userId: user?.id,
                  credits: selectedPlan.credits,
                  packageId: selectedPlan.id,
                  priceUSD: priceUSD,
                }),
              });

              const data = await res.json();
              if (!res.ok) throw new Error(data.message || `Server returned ${res.status}`);
              if (data.status === 'success') {
                if (typeof data.newBalance === 'number') setBalance(data.newBalance);
                if (typeof data.newCredits === 'number') setCredits(data.newCredits);
                trackPaymentSucceeded({ packageId: selectedPlan.id!, transactionId: data.transactionId });
                toast.success(`Successfully purchased ${selectedPlan.credits} credits!`);
                navigate('/wallet');
              } else {
                trackPaymentFailed({ packageId: selectedPlan.id!, reason: 'verification_failed' });
                toast.error(data.message || 'Payment verification failed');
              }
            } catch (error) {
              console.error(error);
              trackPaymentFailed({ packageId: selectedPlan.id!, reason: 'verification_error', message: error instanceof Error ? error.message : 'Unknown' });
              toast.error(error instanceof Error ? error.message : 'Payment could not be verified.');
            } finally {
              setIsProcessing(false);
            }
          })();
        },
        onclose: function () {
          if (!paymentCompletedRef.current) {
            trackPaymentFailed({ packageId: selectedPlan.id!, reason: 'user_cancelled' });
            toast.info('Payment cancelled');
            setIsProcessing(false);
          }
        },
      });
    } catch (error) {
      console.error(error);
      trackPaymentFailed({ packageId: selectedPlan.id!, reason: 'gateway_init_failed' });
      toast.error('Failed to initialize payment gateway');
      setIsProcessing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f0f10] p-6 lg:p-12 flex flex-col items-center">
      <div className="w-full max-w-[800px] pb-32">
        <Button
          variant="ghost"
          onClick={() => navigate(-1)}
          className="mb-8 text-[#a1a1aa] hover:text-white"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>

        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">Purchase Credits</h1>
          <p className="text-sm text-[#a1a1aa]">Select credits to power your AI transformations</p>
        </div>

        {/* Payment Method Selector */}
        {isCryptoEnabled && (
          <div className="mb-8 p-1.5 bg-[#131316] border border-[#27272a] rounded-2xl flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPaymentMethod('flutterwave')}
              className={`flex-1 py-3 px-4 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold transition-all ${
                paymentMethod === 'flutterwave'
                  ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                  : 'text-[#a1a1aa] hover:text-white hover:bg-[#1f1f23]'
              }`}
            >
              <CreditCard className="w-4 h-4" />
              <span>Card / Bank (NGN)</span>
            </button>
            <button
              type="button"
              onClick={() => setPaymentMethod('crypto')}
              className={`flex-1 py-3 px-4 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold transition-all ${
                paymentMethod === 'crypto'
                  ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-500/20'
                  : 'text-[#a1a1aa] hover:text-white hover:bg-[#1f1f23]'
              }`}
            >
              <Wallet className="w-4 h-4" />
              <span>Pay with Crypto</span>
            </button>
          </div>
        )}

        {/* Active Crypto Session Alert */}
        {activeCryptoSession && (
          <div className="mb-6 rounded-2xl border border-emerald-500/40 bg-emerald-950/20 p-5 shadow-xl">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm text-emerald-400 font-bold mb-1 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4" />
                  Crypto Payment in Progress
                </p>
                <p className="text-xs text-[#a1a1aa] mb-3">
                  Purchasing {activeCryptoSession.credits.toLocaleString()} credits for ${activeCryptoSession.priceUSD} in crypto.
                </p>
                {activeCryptoSession.paymentInstructions?.address && (
                  <div className="mb-4 rounded-xl border border-emerald-500/20 bg-black/20 p-3 text-xs text-[#d4d4d8]">
                    <p className="font-semibold text-emerald-300">
                      Send exactly {activeCryptoSession.paymentInstructions.amount} {activeCryptoSession.paymentInstructions.currency}
                    </p>
                    <p className="mt-1 text-[#a1a1aa]">Network: {activeCryptoSession.paymentInstructions.chain}</p>
                    <div className="mt-2 flex items-center gap-2">
                      <code className="min-w-0 flex-1 break-all rounded bg-black/30 px-2 py-1.5 text-[#e4e4e7]">
                        {activeCryptoSession.paymentInstructions.address}
                      </code>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-8 w-8 shrink-0 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(activeCryptoSession.paymentInstructions!.address);
                            toast.success('Wallet address copied');
                          } catch {
                            toast.error('Could not copy the wallet address. Please copy it manually.');
                          }
                        }}
                        aria-label="Copy wallet address"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  {activeCryptoSession.checkoutUrl && (
                    <Button
                      size="sm"
                      onClick={() => window.open(activeCryptoSession.checkoutUrl, '_blank')}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs h-8"
                    >
                      <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                      Reopen Checkout
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={handleVerifyCryptoPayment}
                    disabled={isCheckingCrypto}
                    className="bg-blue-600 hover:bg-blue-500 text-white text-xs h-8"
                  >
                    {isCheckingCrypto ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />}
                    Verify & Claim Credits
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mb-8">
          <label className="block text-sm font-medium text-[#a1a1aa] mb-3">Select Credits Package</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {creditPlans.map((plan) => {
              const isSelected = selectedPlan?.credits === plan.credits;
              const priceUSD = getPriceUSD(plan.priceNGN);

              return (
                <button
                  key={plan.id || plan.credits}
                  onClick={() => handleSelectPlan(plan)}
                  className={`p-5 rounded-xl border text-left transition-all duration-200 ${
                    isSelected
                      ? paymentMethod === 'crypto'
                        ? 'bg-gradient-to-br from-emerald-600/15 via-emerald-600/5 to-transparent border-emerald-500 shadow-xl shadow-emerald-500/20 ring-2 ring-emerald-500/50'
                        : 'bg-gradient-to-br from-blue-600/15 via-blue-600/5 to-transparent border-blue-500 shadow-xl shadow-blue-500/20 ring-2 ring-blue-500/50'
                      : 'bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#27272a] hover:border-[#3f3f46] hover:bg-[#1a1a1f]'
                  }`}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        isSelected
                          ? paymentMethod === 'crypto'
                            ? 'bg-emerald-500/20'
                            : 'bg-blue-500/20'
                          : 'bg-[#27272a]'
                      }`}
                    >
                      <Coins
                        className={`w-5 h-5 ${
                          isSelected
                            ? paymentMethod === 'crypto'
                              ? 'text-emerald-400'
                              : 'text-blue-400'
                            : 'text-[#71717a]'
                        }`}
                      />
                    </div>
                    <div>
                      <span className="text-lg font-bold text-white">{plan.credits.toLocaleString()} Credits</span>
                      <span className="text-xs text-[#71717a] ml-2">{formatTime(plan.credits)}</span>
                      {plan.name && (
                        <p className="text-xs text-[#71717a] mt-1">{plan.name}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {paymentMethod === 'crypto' ? (
                      <>
                        <span className="text-xl font-bold text-emerald-400">${priceUSD}</span>
                        <span className="text-xs text-[#71717a]">Crypto</span>
                      </>
                    ) : (
                      <>
                        <span className="text-xl font-bold text-white">₦{plan.priceNGN.toLocaleString()}</span>
                        {hasLiveRate && (
                          <span className="text-sm text-[#71717a]">(${priceUSD})</span>
                        )}
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="bg-[#131316] border border-[#27272a] rounded-xl p-5 mb-8">
          <h3 className="text-sm font-semibold text-white mb-2">How credits work</h3>
          <ul className="text-sm text-[#a1a1aa] space-y-1">
            <li>- 2 credits are deducted per second of stream time (4 cr/s for dual morph)</li>
            <li>- 500 credits is about 4 minutes 10 seconds</li>
            <li>- 1000 credits is about 8 minutes 20 seconds</li>
            {isCryptoEnabled && <li>- Pay the exact USDT amount shown using the displayed supported network.</li>}
            <li>- Credits never expire</li>
          </ul>
        </div>

        <div className="text-center">
          <p className="text-sm text-[#71717a] mb-4">All purchases are one-time. No subscriptions or hidden fees.</p>
          {paymentMethod === 'crypto' ? (
            <p className="text-xs text-emerald-400/80">
              Safe and instant on-chain crypto settlement.
            </p>
          ) : (
            <>
              {hasLiveRate && (
                <p className="text-xs text-[#52525b]">
                  Exchange rate: 1 USD = NGN {ngnRate.toLocaleString()}
                  {rateUpdatedAt && (
                    <span className="ml-1 text-[#3f3f46]">
                      (updated {new Date(rateUpdatedAt).toLocaleTimeString()})
                    </span>
                  )}
                </p>
              )}
              {isLoadingRate && (
                <p className="text-xs text-[#52525b]">
                  {isFlutterwaveReady ? 'Proceed to Payment' : 'Loading payment gateway...'}
                </p>
              )}
            </>
          )}
          {isLoadingPlans && (
            <p className="text-xs text-[#52525b] mt-2">Loading live credit packages...</p>
          )}
        </div>
      </div>

      {selectedPlan && (
        <div className="fixed bottom-0 left-0 w-full bg-[#0f0f10]/90 backdrop-blur-md border-t border-[#27272a] p-4 flex justify-between items-center z-50 animate-in slide-in-from-bottom shadow-2xl">
          <div className="max-w-[800px] mx-auto w-full flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-sm text-[#a1a1aa] font-medium">Selected Plan</span>
              <span className="text-xl font-bold text-white tracking-tight">
                {selectedPlan.credits.toLocaleString()} Credits{' '}
                <span className="text-blue-500 font-normal mx-1">/</span>{' '}
                {paymentMethod === 'crypto' ? (
                  <span className="text-emerald-400">${getPriceUSD(selectedPlan.priceNGN)} Crypto</span>
                ) : (
                  <>₦{selectedPlan.priceNGN.toLocaleString()} <span className="text-[#71717a] font-normal text-sm">(${getPriceUSD(selectedPlan.priceNGN)})</span></>
                )}
              </span>
              <span className="text-xs text-[#71717a] mt-1">{formatTime(selectedPlan.credits)} estimated time</span>
            </div>
            <Button
              onClick={handleProceedToPayment}
              disabled={isProcessing || (paymentMethod === 'flutterwave' && (!isFlutterwaveReady || !hasValidFlutterwavePublicKey))}
              className={`h-12 px-8 font-bold rounded-xl shadow-lg hover:scale-105 transition-all text-white ${
                paymentMethod === 'crypto'
                  ? 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 shadow-emerald-500/30'
                  : 'bg-blue-600 hover:bg-blue-500 shadow-blue-500/30'
              }`}
            >
              {isProcessing ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : (paymentMethod === 'crypto' ? 'Pay with Crypto' : 'Pay Now')}
              {!isProcessing && <ArrowRight className="w-5 h-5 ml-2" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Subscription;
