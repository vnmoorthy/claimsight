/**
 * Toasts — bottom-left, auto-dismissing, announced through an aria-live
 * region. `useToast().push(...)` from anywhere under <ToastProvider>.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastTone = 'good' | 'crit' | 'info';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  text: string;
  /** Milliseconds before auto-dismiss (0 keeps it until dismissed). */
  ttl: number;
}

interface ToastContextValue {
  toasts: ToastItem[];
  push: (toast: { tone?: ToastTone; text: string; ttl?: number }) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue>({ toasts: [], push: () => 0, dismiss: () => {} });

const DEFAULT_TTL = 5000;
const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const push = useCallback(({ tone = 'info', text, ttl = DEFAULT_TTL }: { tone?: ToastTone; text: string; ttl?: number }) => {
    const id = ++seq.current;
    setToasts(prev => [...prev, { id, tone, text, ttl }].slice(-MAX_VISIBLE));
    if (ttl > 0) {
      timers.current.set(id, window.setTimeout(() => dismiss(id), ttl));
    }
    return id;
  }, [dismiss]);

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}
