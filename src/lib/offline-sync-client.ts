/**
 * PWA OFFLINE PAYMENTS — client-side glue between the IndexedDB queue
 * (src/lib/offline-db.ts) and the two server actions (src/actions/offline.ts).
 *
 * Browser-only, like offline-db.ts. Client-side checks here (per-transaction
 * max, remaining allowance) are a UX convenience ONLY — see
 * src/lib/offline-auth.ts for the real, server-side enforcement that runs
 * again, structurally, at sync time regardless of what this file allowed.
 */
import {
  addQueueItem,
  clearToken,
  getQueue,
  getSnapshot,
  newClientId,
  removeQueueItem,
  saveToken,
  updateQueueItem,
  type OfflineTokenRecord,
  type QueuedPayment,
} from "./offline-db";
import {
  issueOfflineAuthorizationAction,
  syncOfflinePaymentAction,
} from "@/actions/offline";

export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

/** Fires `cb` on every online/offline transition; returns an unsubscribe fn. */
export function subscribeOnlineStatus(cb: (online: boolean) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onOnline = () => cb(true);
  const onOffline = () => cb(false);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}

export async function getCachedToken(): Promise<OfflineTokenRecord | null> {
  const snapshot = await getSnapshot();
  return snapshot?.token ?? null;
}

function isExpired(token: OfflineTokenRecord): boolean {
  return new Date(token.expiresAt).getTime() <= Date.now();
}

/** While online: fetches a fresh offline authorization and caches it. */
export async function refreshOfflineToken(): Promise<
  { ok: true; token: OfflineTokenRecord } | { ok: false; error: string }
> {
  const result = await issueOfflineAuthorizationAction();
  if (!result.ok) return { ok: false, error: result.error };
  const record: OfflineTokenRecord = {
    token: result.data.token,
    tokenId: result.data.tokenId,
    allowance: result.data.allowance,
    perTransactionMax: result.data.perTransactionMax,
    issuedAt: result.data.issuedAt,
    expiresAt: result.data.expiresAt,
  };
  await saveToken(record);
  return { ok: true, token: record };
}

export type QueueAttemptError =
  | "NO_TOKEN"
  | "TOKEN_EXPIRED"
  | "OVER_PER_TX_MAX"
  | "OVER_REMAINING_ALLOWANCE"
  | "INVALID_INPUT";

/**
 * Queues one offline payment locally. Never touches a real balance and never
 * calls the server — this is exactly the "local pending record only" the
 * spec asks for. The three allowance checks are client-side UX only, using
 * the CACHED token's snapshot; the server re-checks everything for real at
 * sync time.
 */
export async function queueOfflinePayment(input: {
  recipientUsername: string;
  amount: number;
  note?: string | null;
}): Promise<{ ok: true; item: QueuedPayment } | { ok: false; error: QueueAttemptError }> {
  const recipientUsername = input.recipientUsername.trim().toLowerCase().replace(/^@/, "");
  const amount = Math.floor(input.amount);
  if (recipientUsername.length === 0 || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "INVALID_INPUT" };
  }

  const token = await getCachedToken();
  if (!token) return { ok: false, error: "NO_TOKEN" };
  if (isExpired(token)) return { ok: false, error: "TOKEN_EXPIRED" };
  if (amount > token.perTransactionMax) return { ok: false, error: "OVER_PER_TX_MAX" };

  const queue = await getQueue();
  const alreadyQueued = queue
    .filter((q) => q.status !== "FAILED")
    .reduce((sum, q) => sum + q.amount, 0);
  if (alreadyQueued + amount > token.allowance) {
    return { ok: false, error: "OVER_REMAINING_ALLOWANCE" };
  }

  const item: QueuedPayment = {
    id: newClientId(),
    recipientUsername,
    amount,
    note: input.note?.trim() || null,
    createdAt: new Date().toISOString(),
    status: "PENDING",
  };
  await addQueueItem(item);
  return { ok: true, item };
}

export async function dismissQueueItem(id: string): Promise<void> {
  await removeQueueItem(id);
}

export type SyncOutcome = {
  id: string;
  ok: boolean;
  txRef?: string;
  reason?: string;
};

/**
 * Walks the queue IN ORDER (oldest first) and posts each PENDING item to the
 * server, one at a time — never in parallel, so an earlier item's allowance
 * spend is always visible to the next item's check. A FAILED item is marked
 * with its reason and left for the caller to surface and dismiss; it is
 * never retried automatically.
 */
export async function syncQueue(): Promise<SyncOutcome[]> {
  const token = await getCachedToken();
  if (!token) return [];

  const queue = await getQueue();
  const outcomes: SyncOutcome[] = [];

  for (const item of queue) {
    if (item.status !== "PENDING") continue;

    await updateQueueItem(item.id, { status: "SYNCING" });

    const result = await syncOfflinePaymentAction({
      token: token.token,
      clientKey: item.id,
      recipientUsername: item.recipientUsername,
      amount: item.amount,
      note: item.note,
      clientTimestamp: item.createdAt,
    });

    if (result.ok) {
      await removeQueueItem(item.id);
      outcomes.push({ id: item.id, ok: true, txRef: result.data.txRef });
    } else {
      await updateQueueItem(item.id, { status: "FAILED", failureReason: result.error });
      outcomes.push({ id: item.id, ok: false, reason: result.error });
    }
  }

  // The token itself may now be spent, expired or stale (any of the above
  // could have failed because of it) — drop the cached copy so the panel
  // prompts for a fresh one on the next online moment rather than silently
  // reusing a token that the server has already told us is no good.
  const anyTokenFailure = outcomes.some(
    (o) => !o.ok && (o.reason?.includes("allowance") || o.reason?.includes("expired")),
  );
  if (anyTokenFailure) await clearToken();

  return outcomes;
}
