import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Coins, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useApp } from '@/context/AppContext';
import { useAuth } from '@/context/AuthContext';
import { apiFetch } from '@/lib/api-client';
import { CREDITS_PER_SECOND } from '@/lib/billing';

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

const FLUTTERWAVE_SCRIPT_ID = 'flutterwave-checkout-js';

function resolveFlutterwavePublicKey(): string {
  const candidateKeys = [
    import.meta.env.VITE_FLUTTERWAVE_PUBLIC_KEY,
    import.meta.env.VITE_FLW_PUBLIC_KEY,
    import.meta.env.FLUTTERWAVE_PUBLIC_KEY,
  ];

  for (const key of candidateKeys) {
    if (typeof key === 'string' && key.trim().length > 0) {
      return key.trim();
    }
  }

  return '';
}

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
  const [isProcessing, setIsProcessing] = useState(false);
  const [ngnRate, setNgnRate] = useState<number>(1500);
  const [isLoadingRate, setIsLoadingRate] = useState(true);
  const [isLoadingPlans, setIsLoadingPlans] = useState(true);
  const [isFallbackRate, setIsFallbackRate] = useState(false);
  const [rateUpdatedAt, setRateUpdatedAt] = useState<string | null>(null);
  const [isFlutterwaveReady, setIsFlutterwaveReady] = useState(false);
  const flutterwavePublicKey = resolveFlutterwavePublicKey();
  const hasValidFlutterwavePublicKey = isValidFlutterwavePublicKey(flutterwavePublicKey);
  const paymentCompletedRef = useRef(false);

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
          : [];

        if (packages.length > 0) {
          setCreditPlans(packages);
        }
      } catch (error) {
        console.warn('Failed to fetch credit packages:', error, 'using default plans');
        setCreditPlans(DEFAULT_CREDIT_PLANS);
      } finally {
        setIsLoadingPlans(false);
      }
    };

    void fetchCreditPackages();
  }, []);

  const handleSelectPlan = (plan: CreditPlan) => {
    setSelectedPlan(plan);
  };

  const handleProceedToPayment = async () => {
    if (!selectedPlan) return;

    if (!user) {
      toast.error('Please log in to purchase credits.');
      navigate('/login');
      return;
    }

    if (!user.email) {
      toast.error('Your account is missing an email address.');
      return;
    }

    if (!window.FlutterwaveCheckout) {
      try {
        await loadFlutterwaveScript();
        setIsFlutterwaveReady(true);
      } catch (error) {
        console.error(error);
        toast.error('Payment gateway not loaded. Check your network and try again.');
        return;
      }
    }

    if (!hasValidFlutterwavePublicKey) {
      toast.error('Payment is unavailable. Flutterwave public key is missing or invalid.');
      setIsProcessing(false);
      return;
    }

    const txRef = `morphly_${user.id}_${Date.now()}`;
    const amountNGN = selectedPlan.priceNGN;
    const priceUSD = Number((selectedPlan.priceNGN / ngnRate).toFixed(2));

    paymentCompletedRef.current = false;
    setIsProcessing(true);

    try {
      window.FlutterwaveCheckout?.({
        public_key: flutterwavePublicKey,
        tx_ref: txRef,
        amount: amountNGN,
        currency: 'NGN',
        payment_options: 'card,banktransfer,ussd',
        customer: {
          email: user.email,
          name: user.name || user.email.split('@')[0] || 'Morphly User',
        },
        meta: {
          userId: user.id,
          credits: selectedPlan.credits,
          priceUSD,
        },
        customizations: {
          title: 'Morphly Credits',
          description: `Purchase ${selectedPlan.credits} credits`,
        },
        callback: function (response: any) {
          if (paymentCompletedRef.current) {
            return;
          }

          if (!response?.transaction_id) {
            setIsProcessing(false);
            toast.error('Payment was not completed.');
            return;
          }

          paymentCompletedRef.current = true;

          (async () => {
            try {
              const res = await apiFetch('/verify-payment', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  reference: response.tx_ref || txRef,
                  transactionId: response.transaction_id,
                  userId: user?.id,
                  credits: selectedPlan.credits,
                  priceUSD: priceUSD,
                }),
              });

              const data = await res.json();
              if (!res.ok) {
                throw new Error(data.message || `Server returned ${res.status}`);
              }

              if (data.status === 'success') {
                if (typeof data.newBalance === 'number') {
                  setBalance(data.newBalance);
                }
                if (typeof data.newCredits === 'number') {
                  setCredits(data.newCredits);
                }
                toast.success(`Successfully purchased ${selectedPlan.credits} credits!`);
                navigate('/wallet');
              } else {
                toast.error(data.message || 'Payment verification failed');
              }
            } catch (error) {
              console.error(error);
              toast.error(error instanceof Error ? error.message : 'Payment could not be verified, so credits were not added.');
            } finally {
              setIsProcessing(false);
            }
          })();
        },
        onclose: function () {
          if (!paymentCompletedRef.current) {
            toast.info('Payment cancelled');
            setIsProcessing(false);
          }
        },
      });
    } catch (error) {
      console.error(error);
      toast.error('Failed to initialize payment gateway');
      setIsProcessing(false);
    }
  };

  const getPriceUSD = (priceNGN: number) => (priceNGN / ngnRate).toFixed(2);
  const hasLiveRate = !isLoadingRate && !isFallbackRate;

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

        <div className="mb-12">
          <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">Purchase Credits</h1>
          <p className="text-sm text-[#a1a1aa]">Select credits to power your AI transformations</p>
        </div>

        <div className="mb-6 rounded-2xl border border-[#27272a] bg-[#131316] p-5 shadow-xl shadow-black/20">
          <p className="text-sm text-white font-semibold mb-2">Need the latest version?</p>
          <p className="text-sm text-[#a1a1aa] mb-4">
            Click Recharge from the wallet page to go to Settings, then use the "Check for New Version" button to download and install updates immediately.
          </p>
          <Button
            onClick={() => navigate('/settings')}
            className="bg-blue-600 hover:bg-blue-500 text-white font-medium"
          >
            Go to Settings
          </Button>
        </div>

        <div className="mb-8">
          <label className="block text-sm font-medium text-[#a1a1aa] mb-3">Select Credits</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {creditPlans.map((plan) => {
              const isSelected = selectedPlan?.credits === plan.credits;
              const priceUSD = hasLiveRate ? getPriceUSD(plan.priceNGN) : null;

              return (
                <button
                  key={plan.id || plan.credits}
                  onClick={() => handleSelectPlan(plan)}
                  className={`p-5 rounded-xl border text-left transition-all duration-200 ${
                    isSelected
                      ? 'bg-gradient-to-br from-blue-600/15 via-blue-600/5 to-transparent border-blue-500 shadow-xl shadow-blue-500/20 ring-2 ring-blue-500/50'
                      : 'bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#27272a] hover:border-[#3f3f46] hover:bg-[#1a1a1f]'
                  }`}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        isSelected ? 'bg-blue-500/20' : 'bg-[#27272a]'
                      }`}
                    >
                      <Coins className={`w-5 h-5 ${isSelected ? 'text-blue-400' : 'text-[#71717a]'}`} />
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
                    <span className="text-xl font-bold text-white">₦{plan.priceNGN.toLocaleString()}</span>
                    {priceUSD !== null && (
                      <span className="text-sm text-[#71717a]">(${priceUSD})</span>
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
            <li>- 2 credits are deducted per second of stream time</li>
            <li>- 500 credits is about 4 minutes 10 seconds</li>
            <li>- 1000 credits is about 8 minutes 20 seconds</li>
            <li>- Credits never expire</li>
          </ul>
        </div>
        <div className="text-center">
          <p className="text-sm text-[#71717a] mb-4">All purchases are one-time. No subscriptions or hidden fees.</p>
          {hasLiveRate && (
            <p className="text-xs text-[#52525b]">
              Exchange rate: 1 USD = NGN {ngnRate.toLocaleString()}
            </p>
          )}
          {isLoadingRate && (
            <p className="text-xs text-[#52525b]">
                {isFlutterwaveReady ? 'Proceed to Payment' : 'Loading payment gateway...'}
            </p>
          )}
          {isLoadingPlans && (
            <p className="text-xs text-[#52525b] mt-2">Loading live credit packages...</p>
          )}
          {isFallbackRate && (
            <p className="text-xs text-amber-400 mt-2">
              Showing fallback pricing. Configure `EXCHANGE_RATE_API_KEY` in the active API environment for live USD to NGN rates.
            </p>
          )}
          {!hasValidFlutterwavePublicKey && (
            <p className="text-xs text-red-400 mt-2">
              Payments are temporarily unavailable due to invalid Flutterwave configuration.
            </p>
          )}
          {!isFallbackRate && rateUpdatedAt && (
            <p className="text-xs text-[#52525b] mt-2">
              Last updated: {new Date(rateUpdatedAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>

      {selectedPlan && (
        <div className="fixed bottom-0 left-0 w-full bg-[#0f0f10]/90 backdrop-blur-md border-t border-[#27272a] p-4 flex justify-between items-center z-50 animate-in slide-in-from-bottom shadow-2xl">
          <div className="max-w-[800px] mx-auto w-full flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-sm text-[#a1a1aa] font-medium">Selected Plan</span>
              <span className="text-xl font-bold text-white tracking-tight">
                {selectedPlan.credits.toLocaleString()} Credits <span className="text-blue-500 font-normal mx-1">/</span> ₦{selectedPlan.priceNGN.toLocaleString()}
                {hasLiveRate && (
                  <>
                    {' '}
                    <span className="text-[#71717a] font-normal">
                      (${getPriceUSD(selectedPlan.priceNGN)})
                    </span>
                  </>
                )}
              </span>
              <span className="text-xs text-[#71717a] mt-1">{formatTime(selectedPlan.credits)} estimated time</span>
            </div>
            <Button
              onClick={handleProceedToPayment}
              disabled={isProcessing || !isFlutterwaveReady || !hasValidFlutterwavePublicKey}
              className="h-12 px-8 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 hover:scale-105 transition-all"
            >
              {isProcessing ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : 'Pay Now'}
              {!isProcessing && <ArrowRight className="w-5 h-5 ml-2" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Subscription;
