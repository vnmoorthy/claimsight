/**
 * In-app navigation without a router. The URL hash mirrors the view:
 *
 *   ""                       → Chat
 *   "#desk"                  → Refund Desk
 *   "#desk?claim=<claim_id>" → Refund Desk with that claim's drawer open
 *   "#lab"                   → Synthetic Evidence Lab
 *
 * `useNav().openInDesk(claimId)` is how a Decision Card jumps to its claim.
 */

import { createContext, useContext } from 'react';
import type { ViewId } from '../components/ViewTabs';

export interface DeskFocus {
  claimId: string;
  /** Bumped on every request so opening the same claim twice still re-opens the drawer. */
  nonce: number;
}

export interface NavContextValue {
  view: ViewId;
  setView: (view: ViewId) => void;
  openInDesk: (claimId: string) => void;
}

export const NavContext = createContext<NavContextValue>({ view: 'chat', setView: () => {}, openInDesk: () => {} });

export function useNav(): NavContextValue {
  return useContext(NavContext);
}

export function parseHash(hash: string): { view: ViewId; claimId: string | null } {
  const raw = hash.replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  if (path === 'lab') return { view: 'lab', claimId: null };
  if (path !== 'desk') return { view: 'chat', claimId: null };
  const claimId = new URLSearchParams(query).get('claim');
  return { view: 'desk', claimId: claimId && claimId.trim() ? claimId.trim() : null };
}

export function buildHash(view: ViewId, claimId?: string | null): string {
  if (view === 'lab') return '#lab';
  if (view !== 'desk') return '';
  return claimId ? `#desk?claim=${encodeURIComponent(claimId)}` : '#desk';
}
