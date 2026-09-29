/**
 * PWA OFFLINE PAYMENTS — CLIENT-SIDE STORAGE (IndexedDB)
 * ===========================================================================
 * Deliberately NOT `localStorage`: this holds structured queued-transaction
 * records (a growing list, each with its own id and status) and a signed
 * token, which is exactly the shape IndexedDB is for and `localStorage` is
 * not (string-only, no real querying, easy to corrupt with partial writes).
 *
 * This is a hand-rolled, ~small wrapper over the plain `indexedDB` API — no
 * `idb` or any other package. It is deliberately NOT `"use server"` and does
 * NOT import `"server-only"` anywhere: everything here runs in the browser,
 * inside client components.
 *
 * Three tiny "collections", each its own object store in one database:
 *
 *   snapshot — a SINGLE row (key "current") holding the last-synchronized
 *              dashboard state (balance, handle, label, recent activity) and
 *              the current offline authorization token, if any.
 *   queue    — one row per queued offline payment, keyed by its own
 *              client-generated UUID (the idempotency key used at sync).
 *
 * Every function is safe to call from anywhere: IndexedDB can be unavailable
 * (very old browser, private-mode restrictions in some browsers, blocked
 * site data) or a request can simply fail, and none of that should ever
 * crash the page — offline support is additive, not load-bearing.
 */

const DB_NAME = "aeros-pay-offline";
const DB_VERSION = 1;
const SNAPSHOT_STORE = "snapshot";
const QUEUE_STORE = "queue";
const SNAPSHOT_KEY = "current";

export type OfflineSnapshot = {
  balance: number;
  handle: string;
  displayLabel: string;
  status: "ACTIVE" | "SUSPENDED" | "BANNED";
  recentActivity: Array<{
    id: string;
    txRef: string;
    counterparty: string;
    direction: "in" | "out";
    amount: number;
    createdAt: string;
  }>;
  savedAt: string;
  token: OfflineTokenRecord | null;
};

export type OfflineTokenRecord = {
  token: string;
  tokenId: string;
  allowance: number;
  perTransactionMax: number;
  issuedAt: string;
  expiresAt: string;
};

export type QueuedPaymentStatus = "PENDING" | "SYNCING" | "FAILED";

export type QueuedPayment = {
  /** Client-generated UUID — doubles as the sync idempotency key. */
  id: string;
  recipientUsername: string;
  amount: number;
  note: string | null;
  createdAt: string;
  status: QueuedPaymentStatus;
  /** Set only when status is FAILED. */
  failureReason?: string;
};

function isSupported(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function openDb(): Promise<IDBDatabase | null> {
  if (!isSupported()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE);
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

// --- snapshot ----------------------------------------------------------------

export async function saveSnapshot(
  snapshot: Omit<OfflineSnapshot, "savedAt" | "token">,
): Promise<void> {
  const existing = await getSnapshot();
  const full: OfflineSnapshot = {
    ...snapshot,
    savedAt: new Date().toISOString(),
    token: existing?.token ?? null,
  };
  await withStore(SNAPSHOT_STORE, "readwrite", (store) => store.put(full, SNAPSHOT_KEY));
}

export async function getSnapshot(): Promise<OfflineSnapshot | null> {
  return withStore<OfflineSnapshot>(SNAPSHOT_STORE, "readonly", (store) =>
    store.get(SNAPSHOT_KEY),
  );
}

export async function saveToken(token: OfflineTokenRecord): Promise<void> {
  const existing = await getSnapshot();
  const full: OfflineSnapshot = existing
    ? { ...existing, token }
    : {
        balance: 0,
        handle: "",
        displayLabel: "",
        status: "ACTIVE",
        recentActivity: [],
        savedAt: new Date().toISOString(),
        token,
      };
  await withStore(SNAPSHOT_STORE, "readwrite", (store) => store.put(full, SNAPSHOT_KEY));
}

export async function clearToken(): Promise<void> {
  const existing = await getSnapshot();
  if (!existing) return;
  await withStore(SNAPSHOT_STORE, "readwrite", (store) =>
    store.put({ ...existing, token: null }, SNAPSHOT_KEY),
  );
}

// --- queue ---------------------------------------------------------------

export async function getQueue(): Promise<QueuedPayment[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(QUEUE_STORE, "readonly");
      const store = tx.objectStore(QUEUE_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as QueuedPayment[]) ?? [];
        // Oldest first — the sync walk must process the queue IN ORDER.
        rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        resolve(rows);
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function addQueueItem(item: QueuedPayment): Promise<void> {
  await withStore(QUEUE_STORE, "readwrite", (store) => store.put(item));
}

export async function updateQueueItem(
  id: string,
  patch: Partial<QueuedPayment>,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(QUEUE_STORE, "readwrite");
      const store = tx.objectStore(QUEUE_STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result as QueuedPayment | undefined;
        if (!existing) {
          resolve();
          return;
        }
        const putReq = store.put({ ...existing, ...patch });
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => resolve();
      };
      getReq.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function removeQueueItem(id: string): Promise<void> {
  await withStore(QUEUE_STORE, "readwrite", (store) => store.delete(id));
}

/** RFC 4122 v4 UUID, used as both the queue item's id and its sync
 * idempotency key. `crypto.randomUUID` is available in every browser this
 * app already targets (same one used for every other client-generated id in
 * this codebase's runtime environment); no polyfill is added for it. */
export function newClientId(): string {
  return crypto.randomUUID();
}
