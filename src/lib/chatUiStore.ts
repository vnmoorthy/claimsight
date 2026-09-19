/**
 * Chat UI Snapshot Store (IndexedDB)
 *
 * Stores lightweight Message[] snapshots per conversationId so that
 * the frontend can restore image references after page refresh.
 *
 * Snapshots contain ImageAttachment references (storageKey, imageId, mimeType, size)
 * but NOT raw base64 or blob: URLs. At load time, blob: URLs are recreated from
 * IndexedDB Blobs via imageStore.
 */

import type { Message } from '../types';
import { openDatabase } from './idb';

const DB_NAME = 'chat-ui-store-db';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';

interface SnapshotRecord {
  conversationId: string;    // Primary key
  messages: Message[];       // Lightweight messages (no base64, no blob URLs)
  updatedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return openDatabase(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'conversationId' });
    }
  });
}

/**
 * Strip runtime-only fields (blob: URLs) from messages before persisting.
 * Preserves storageKey/imageId/mimeType/size but removes url field from ImageAttachments.
 */
function sanitizeForStorage(messages: Message[]): Message[] {
  // Fast path: skip allocation when no messages have images or transient activity.
  if (!messages.some(m => (m.images && m.images.length > 0) || m.activity)) return messages;

  return messages.map(msg => {
    const { activity: _activity, ...messageWithoutActivity } = msg;
    if (!msg.images || msg.images.length === 0) return messageWithoutActivity;

    const sanitizedImages = msg.images.map(img => {
      if (typeof img === 'string') {
        // Legacy base64 string — don't persist these at all (they're too large)
        return null;
      }
      // ImageAttachment — strip runtime url field
      const { url: _url, ...rest } = img;
      return rest;
    }).filter(Boolean);

    return {
      ...messageWithoutActivity,
      images: sanitizedImages as Message['images'],
    };
  });
}

/** Save a conversation's message snapshot. */
export async function saveSnapshot(conversationId: string, messages: Message[]): Promise<void> {
  try {
    const db = await openDB();
    const record: SnapshotRecord = {
      conversationId,
      messages: sanitizeForStorage(messages),
      updatedAt: Date.now(),
    };

    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[chatUiStore] failed to save snapshot:', e);
  }
}

/** Load a conversation's message snapshot. Returns empty array if not found. */
export async function loadSnapshot(conversationId: string): Promise<Message[]> {
  try {
    const db = await openDB();
    return new Promise<Message[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(conversationId);
      req.onsuccess = () => {
        const record = req.result as SnapshotRecord | undefined;
        resolve(record?.messages ?? []);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[chatUiStore] failed to load snapshot:', e);
    return [];
  }
}

/** Delete a conversation's snapshot (when history is cleared). */
export async function deleteSnapshot(conversationId: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(conversationId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn('[chatUiStore] failed to delete snapshot:', e);
  }
}
