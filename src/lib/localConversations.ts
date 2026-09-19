/**
 * Local index of this browser's claims conversations.
 *
 * The backend's /conversations list is authoritative on the platform, but in
 * local dev the agent process and the cloud functions do not share the
 * in-memory store, so the list comes back empty. The message snapshots already
 * live in IndexedDB, so a small localStorage index (id, title, time) is enough
 * to keep the "Claims history" drawer useful everywhere. Server rows win on
 * merge; local rows fill in what the server does not know.
 */

import type { ConversationSummary } from '../types';

const STORAGE_KEY = 'claimsight-conversations';
const MAX_ENTRIES = 50;

export function readLocalConversations(): ConversationSummary[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((c): c is ConversationSummary => !!c && typeof c === 'object' && typeof (c as ConversationSummary).id === 'string')
      : [];
  } catch {
    return [];
  }
}

function writeLocalConversations(list: ConversationSummary[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    /* private mode / quota — the drawer just loses its local fallback */
  }
}

export function upsertLocalConversation(summary: ConversationSummary): void {
  const rest = readLocalConversations().filter(c => c.id !== summary.id);
  writeLocalConversations([summary, ...rest]);
}

export function removeLocalConversation(id: string): void {
  writeLocalConversations(readLocalConversations().filter(c => c.id !== id));
}

function stamp(c: ConversationSummary): number {
  return c.lastMessageAt ?? c.createdAt ?? 0;
}

/** Server list first (authoritative), local rows fill the gaps; newest first. */
export function mergeConversations(server: ConversationSummary[], local: ConversationSummary[] = readLocalConversations()): ConversationSummary[] {
  const byId = new Map<string, ConversationSummary>();
  for (const c of local) byId.set(c.id, c);
  for (const c of server) byId.set(c.id, { ...(byId.get(c.id) ?? {}), ...c });
  return [...byId.values()].sort((a, b) => stamp(b) - stamp(a));
}

/** "A1042 · My ceramic mug arrived with a chip on the…" */
export function summarizeTitle(text: string, orderId?: string, fallback = 'New claim'): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const body = clean.length <= 42 ? clean : `${clean.slice(0, 41).trimEnd()}…`;
  const base = body || fallback;
  return orderId ? `${orderId} · ${base}` : base;
}
