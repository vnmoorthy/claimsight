/**
 * Theme: dark-first, light on request. Defaults to `prefers-color-scheme`
 * (the inline script in index.html applies it before first paint) and follows
 * the OS until the user picks one with the header toggle, which is persisted.
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'claimsight-theme';
const THEME_COLOR: Record<Theme, string> = { dark: '#0f1320', light: '#f4f6fa' };

function readSaved(): Theme | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme]);
}

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(() => readSaved() ?? systemTheme());
  const [explicit, setExplicit] = useState<boolean>(() => readSaved() !== null);

  useEffect(() => { applyTheme(theme); }, [theme]);

  // Follow the OS until the user has chosen.
  useEffect(() => {
    if (explicit || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setThemeState(mq.matches ? 'light' : 'dark');
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [explicit]);

  const setTheme = useCallback((t: Theme) => {
    setExplicit(true);
    setThemeState(t);
    try { localStorage.setItem(STORAGE_KEY, t); } catch { /* private mode */ }
  }, []);

  const toggle = useCallback(() => {
    setThemeState(prev => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
      return next;
    });
    setExplicit(true);
  }, []);

  return { theme, toggle, setTheme };
}
