import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import type { ReactNode } from 'react';
import { apiFetchWithAuth } from '@/lib/api-client';
import { useAuth } from './AuthContext';
import { formatCreditBalance } from '@/lib/credit-balance';

export interface Transaction {
  id: string;
  type: 'credit' | 'debit';
  amount: number;
  credits: number;
  description: string;
  timestamp: string;
}

interface AppContextType {
  balance: number;
  credits: number;
  creditsReady: boolean;
  setBalance: (balance: number) => void;
  setCredits: (credits: number) => void;
  addBalance: (amount: number) => void;
  addCredits: (amount: number) => void;
  deductBalance: (amount: number) => void;
  deductCredits: (amount: number) => void;
  sessionStatus: 'LIVE' | 'IDLE';
  setSessionStatus: (status: 'LIVE' | 'IDLE') => void;
  isLoading: boolean;
  setLoading: (loading: boolean) => void;
  transactions: Transaction[];
  addTransaction: (transaction: Omit<Transaction, 'id' | 'timestamp'>) => void;
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp'>) => void;
  clearNotifications: () => void;
}

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
  timestamp: string;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

const BALANCE_KEY = 'morphly_balance';
const CREDITS_KEY = 'morphly_credits';
const TRANSACTIONS_KEY = 'morphly_transactions';
const LOCAL_PREVIEW_USER = '00000000-0000-0000-0000-000000000001';

export { formatCreditBalance };

export function AppProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isLocalPreview = import.meta.env.DEV && import.meta.env.VITE_LOCAL_PREVIEW === 'true';
  const [balance, setBalanceState] = useState(isLocalPreview ? 10000 : 0);
  const [credits, setCreditsState] = useState(isLocalPreview ? 999999 : 0);
  // The number above starts at 0. That 0 is not a balance until this matches
  // the signed-in user, so a slow or failed login cannot show an empty wallet.
  const [creditOwner, setCreditOwner] = useState<string | null>(isLocalPreview ? LOCAL_PREVIEW_USER : null);
  const [sessionStatus, setSessionStatus] = useState<'LIVE' | 'IDLE'>('IDLE');
  const [isLoading, setLoading] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    if (isLocalPreview || user?.id === LOCAL_PREVIEW_USER) {
      setBalanceState(10000);
      setCreditsState(999999);
      setCreditOwner(user?.id ?? LOCAL_PREVIEW_USER);
      return;
    }

    if (!user?.id) return;

    let cancelled = false;
    const userId = user.id;
    const loadWallet = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (cancelled) return;
        try {
          const res = await apiFetchWithAuth(`/wallet?userId=${userId}`);
          if (!res.ok) {
            const rawBody = await res.text();
            let apiError = rawBody;
            try {
              const parsedBody = JSON.parse(rawBody);
              apiError = parsedBody?.error || parsedBody?.message || rawBody;
            } catch {
              // Keep raw body when response is not JSON.
            }
            const errorDetail = apiError ? `: ${apiError}` : '';
            throw new Error(`API returned ${res.status}${errorDetail}`);
          }
          const text = await res.text();
          let data: { balance?: unknown; credits?: unknown; transactions?: Transaction[] };
          try {
            data = JSON.parse(text);
          } catch {
            throw new Error(`Invalid JSON format from API: ${text.substring(0, 20)}`);
          }
          if (cancelled) return;
          if (typeof data.balance === 'number' && Number.isFinite(data.balance)) setBalanceState(data.balance);
          if (typeof data.credits === 'number' && Number.isFinite(data.credits)) {
            setCreditsState(data.credits);
            setCreditOwner(userId);
          }
          setTransactions(data.transactions || []);
          return;
        } catch (err) {
          console.warn('Failed to sync wallet data:', err);
          if (attempt < 2 && !cancelled) await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    };
    void loadWallet();
    return () => {
      cancelled = true;
    };
  }, [isLocalPreview, user?.id]);

  const creditsReady = isLocalPreview || (Boolean(user?.id) && creditOwner === user?.id);

  const setBalance = useCallback((newBalance: number) => {
    setBalanceState(newBalance);
    localStorage.setItem(BALANCE_KEY, newBalance.toString());
  }, []);

  const setCredits = useCallback((newCredits: number) => {
    setCreditsState(newCredits);
    setCreditOwner(user?.id ?? null);
    localStorage.setItem(CREDITS_KEY, newCredits.toString());
  }, [user?.id]);

  const addBalance = useCallback((amount: number) => {
    const transaction: Transaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'credit',
      amount,
      credits: 0,
      description: 'Balance added',
      timestamp: new Date().toISOString(),
    };
    
    setBalanceState(prev => {
      const newBalance = prev + amount;
      localStorage.setItem(BALANCE_KEY, newBalance.toString());
      return newBalance;
    });
    
    setTransactions(prev => {
      const updated = [transaction, ...prev].slice(0, 50);
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const addCredits = useCallback((amount: number) => {
    const transaction: Transaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'credit',
      amount: 0,
      credits: amount,
      description: 'Credits purchased',
      timestamp: new Date().toISOString(),
    };
    
    setCreditOwner(user?.id ?? null);
    setCreditsState(prev => {
      const newCredits = prev + amount;
      localStorage.setItem(CREDITS_KEY, newCredits.toString());
      return newCredits;
    });
    
    setTransactions(prev => {
      const updated = [transaction, ...prev].slice(0, 50);
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, [user?.id]);

  const deductBalance = useCallback((amount: number) => {
    const transaction: Transaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'debit',
      amount,
      credits: 0,
      description: 'Session usage',
      timestamp: new Date().toISOString(),
    };
    
    setBalanceState(prev => {
      const newBalance = Math.max(0, prev - amount);
      localStorage.setItem(BALANCE_KEY, newBalance.toString());
      return newBalance;
    });
    
    setTransactions(prev => {
      const updated = [transaction, ...prev].slice(0, 50);
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const deductCredits = useCallback((amount: number) => {
    const transaction: Transaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'debit',
      amount: 0,
      credits: amount,
      description: 'Stream usage',
      timestamp: new Date().toISOString(),
    };
    
    setCreditOwner(user?.id ?? null);
    setCreditsState(prev => {
      const newCredits = Math.max(0, prev - amount);
      localStorage.setItem(CREDITS_KEY, newCredits.toString());
      return newCredits;
    });
    
    setTransactions(prev => {
      const updated = [transaction, ...prev].slice(0, 50);
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, [user?.id]);

  const addTransaction = useCallback((transactionData: Omit<Transaction, 'id' | 'timestamp'>) => {
    const transaction: Transaction = {
      ...transactionData,
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
    };
    
    setTransactions(prev => {
      const updated = [transaction, ...prev].slice(0, 50);
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const addNotification = useCallback((notificationData: Omit<Notification, 'id' | 'timestamp'>) => {
    const notification: Notification = {
      ...notificationData,
      id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
    };
    
    setNotifications(prev => {
      const updated = [notification, ...prev].slice(0, 20);
      return updated;
    });
    
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== notification.id));
    }, 5000);
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const value = useMemo(() => ({
    balance,
    credits,
    creditsReady,
    setBalance,
    setCredits,
    addBalance,
    addCredits,
    deductBalance,
    deductCredits,
    sessionStatus,
    setSessionStatus,
    isLoading,
    setLoading,
    transactions,
    addTransaction,
    notifications,
    addNotification,
    clearNotifications,
  }), [balance, credits, creditsReady, setBalance, setCredits, addBalance, addCredits, deductBalance, deductCredits, sessionStatus, isLoading, transactions, addTransaction, notifications, addNotification, clearNotifications]);

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
