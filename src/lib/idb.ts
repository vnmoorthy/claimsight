/**
 * Shared IndexedDB helper — singleton database opener.
 * Used by imageStore and chatUiStore to avoid duplicating the open/upgrade pattern.
 */

type UpgradeFn = (db: IDBDatabase) => void;

const dbCache = new Map<string, Promise<IDBDatabase>>();

export function openDatabase(name: string, version: number, onUpgrade: UpgradeFn): Promise<IDBDatabase> {
  const cached = dbCache.get(name);
  if (cached) return cached;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, version);

    request.onupgradeneeded = () => onUpgrade(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbCache.delete(name);
      reject(request.error);
    };
  });

  dbCache.set(name, promise);
  return promise;
}
