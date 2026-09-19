/**
 * IndexedDB Image Storage Module
 *
 * Handles persistent storage of tool-generated images (screenshots, etc.)
 * as Blobs in IndexedDB, avoiding raw base64 pollution of conversation state.
 */

import { openDatabase } from './idb';

const DB_NAME = 'tool-images-db';
const DB_VERSION = 1;
const STORE_NAME = 'images';

export interface StoredImageRecord {
  storageKey: string;       // Primary key: `${conversationId}/${imageId}`
  conversationId: string;
  messageId: string;
  imageId: string;
  blob: Blob;
  mimeType: string;
  size: number;
  createdAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return openDatabase(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'storageKey' });
      store.createIndex('byConversation', 'conversationId', { unique: false });
      store.createIndex('byMessage', ['conversationId', 'messageId'], { unique: false });
    }
  });
}

/** Convert a base64 string (without data URI prefix) to a Blob. */
export function base64ToBlob(base64: string, mimeType = 'image/png'): Blob {
  const byteChars = atob(base64);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteArray[i] = byteChars.charCodeAt(i);
  }
  return new Blob([byteArray], { type: mimeType });
}

/** Generate a storage key from conversationId and imageId. */
export function makeStorageKey(conversationId: string, imageId: string): string {
  return `${conversationId}/${imageId}`;
}

/** Save an image Blob to IndexedDB. Returns the stored record. */
export async function saveImage(params: {
  conversationId: string;
  messageId: string;
  imageId: string;
  blob: Blob;
  mimeType: string;
}): Promise<StoredImageRecord> {
  const { conversationId, messageId, imageId, blob, mimeType } = params;
  const storageKey = makeStorageKey(conversationId, imageId);

  const record: StoredImageRecord = {
    storageKey,
    conversationId,
    messageId,
    imageId,
    blob,
    mimeType,
    size: blob.size,
    createdAt: Date.now(),
  };

  const db = await openDB();
  return new Promise<StoredImageRecord>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(record);
    req.onsuccess = () => resolve(record);
    req.onerror = () => reject(req.error);
  });
}

/** Load a single image record by storageKey. Returns null if not found. */
export async function loadImage(storageKey: string): Promise<StoredImageRecord | null> {
  const db = await openDB();
  return new Promise<StoredImageRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(storageKey);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** Load all image records for a given conversationId. */
export async function loadConversationImages(conversationId: string): Promise<StoredImageRecord[]> {
  const db = await openDB();
  return new Promise<StoredImageRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('byConversation');
    const req = index.getAll(conversationId);
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

/** Delete all images belonging to a conversationId. */
export async function deleteConversationImages(conversationId: string): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('byConversation');
    const req = index.openCursor(conversationId);

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// Track active object URLs for revocation
const activeUrls = new Map<string, string>(); // storageKey → objectURL

/** Create or reuse a blob: URL for a stored image. */
export function createObjectUrl(storageKey: string, blob: Blob): string {
  const existing = activeUrls.get(storageKey);
  if (existing) return existing;

  const url = URL.createObjectURL(blob);
  activeUrls.set(storageKey, url);
  return url;
}

/** Revoke a specific object URL. */
export function revokeObjectUrl(storageKey: string): void {
  const url = activeUrls.get(storageKey);
  if (url) {
    URL.revokeObjectURL(url);
    activeUrls.delete(storageKey);
  }
}

/** Revoke all active object URLs (e.g. on conversation clear). */
export function revokeAllObjectUrls(): void {
  for (const url of activeUrls.values()) {
    URL.revokeObjectURL(url);
  }
  activeUrls.clear();
}
