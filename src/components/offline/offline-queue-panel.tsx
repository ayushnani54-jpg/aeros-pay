"use client";

import { useEffect, useState, type FormEvent } from "react";
import { CURRENCY_NAME, MIN_TRANSACTION_AMOUNT } from "@/lib/constants";
import {
  dismissQueueItem,
  getCachedToken,
  isOnline,
  queueOfflinePayment,
  refreshOfflineToken,
  subscribeOnlineStatus,
  syncQueue,
  type QueueAttemptError,
  type SyncOutcome,
} from "@/lib/offline-sync-client";
import { getQueue, type OfflineTokenRecord, type QueuedPayment } from "@/lib/offline-db";

const QUEUE_ERROR_MESSAGE: Record<QueueAttemptError, string> = {
  NO_TOKEN:
    "No offline authorization is cached yet. Connect once while online, then try again offline.",
  TOKEN_EXPIRED: "Your cached offline authorization has expired. Go online to renew it.",
  OVER_PER_TX_MAX: "That is more than this authorization allows in a single payment.",
  OVER_REMAINING_ALLOWANCE: "That would exceed your remaining offline allowance.",
  INVALID_INPUT: "Enter a recipient and a valid amount.",
};

/**
 * The offline queue UI (spec: PWA offline payments).
 *
 * Mounted on the Pay page (`showQueueForm`) and on the Transactions page
 * (read-only: pending/failed lists + Sync now, no "queue a new one" form —
 * that page has no recipient-entry flow of its own).
 *
 * Everything here is client state read from IndexedDB (src/lib/offline-db.ts)
 * plus two server actions (src/actions/offline.ts); it never touches
 * `/transactions`' real server-rendered list, and a queued item is never
 * mixed into it — this panel is a visually distinct, purely additive overlay.
 */
export function OfflineQueuePanel({
  offlinePolicyEnabled,
  showQueueForm,
}: {
  offlinePolicyEnabled: boolean;
  showQueueForm: boolean;
}) {
  // Lazy initializer: reads the real navigator state during the first render
  // instead of a setState call inside the effect below, which is what the
  // client actually is on mount — `isOnline()` itself already guards against
  // running where `navigator` doesn't exist (SSR), so this is safe there too.
  const [online, setOnline] = useState(() => isOnline());
  const [token, setToken] = useState<OfflineTokenRecord | null>(null);
  const [queue, setQueue] = useState<QueuedPayment[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [queueError, setQueueError] = useState<string | null>(null);

  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);

  async function reload() {
    const [t, q] = await Promise.all([getCachedToken(), getQueue()]);
    setToken(t);
    setQueue(q);
    setLoaded(true);
  }

  async function ensureFreshToken() {
    if (!offlinePolicyEnabled) return;
    if (!isOnline()) return;
    const current = await getCachedToken();
    const stillValid = current && new Date(current.expiresAt).getTime() > Date.now();
    if (stillValid) return;
    setTokenBusy(true);
    const result = await refreshOfflineToken();
    setTokenBusy(false);
    if (result.ok) {
      setToken(result.token);
      setTokenError(null);
    } else {
      // A silent background refresh failing (feature disabled, banned
      // account, ...) is not an error worth surfacing on every page load —
      // it will surface clearly the moment someone tries to queue a payment.
      setToken(null);
    }
  }

  useEffect(() => {
    // Fetch-on-mount: reload() only sets state after its own `await`
    // (IndexedDB reads), never synchronously inside this effect body, which
    // is the standard "load local data once the component is live" pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload().then(ensureFreshToken);

    const unsubscribe = subscribeOnlineStatus(async (nowOnline) => {
      setOnline(nowOnline);
      if (nowOnline) {
        await ensureFreshToken();
        const pending = (await getQueue()).filter(
          (q: QueuedPayment) => q.status === "PENDING",
        );
        if (pending.length > 0) await handleSync();
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRefreshToken() {
    setTokenBusy(true);
    setTokenError(null);
    const result = await refreshOfflineToken();
    setTokenBusy(false);
    if (result.ok) {
      setToken(result.token);
    } else {
      setTokenError(result.error);
    }
  }

  async function handleQueueSubmit(e: FormEvent) {
    e.preventDefault();
    setQueueError(null);
    if (typeof amount !== "number") {
      setQueueError(QUEUE_ERROR_MESSAGE.INVALID_INPUT);
      return;
    }
    const result = await queueOfflinePayment({
      recipientUsername: recipient,
      amount,
      note,
    });
    if (result.ok) {
      setRecipient("");
      setAmount("");
      setNote("");
      await reload();
    } else {
      setQueueError(QUEUE_ERROR_MESSAGE[result.error]);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncSummary(null);
    const outcomes: SyncOutcome[] = await syncQueue();
    const anySynced = outcomes.some((o) => o.ok);
    // The cached token's `allowance` field is a snapshot taken at issue time
    // and isn't decremented locally as items sync — only `syncQueue`'s own
    // token-FAILURE case clears it. Without this, the "remaining" banner
    // would keep showing the pre-sync figure (stale, but never unsafe: the
    // server independently re-checks the real remaining allowance at every
    // sync regardless of what this banner says) until the token happens to
    // expire. Re-issuing right after a successful sync keeps the displayed
    // figure honest.
    if (anySynced && isOnline()) {
      await refreshOfflineToken();
    }
    setSyncing(false);
    await reload();
    if (outcomes.length === 0) return;
    const ok = outcomes.filter((o) => o.ok).length;
    const failedCount = outcomes.length - ok;
    setSyncSummary(
      failedCount === 0
        ? `Synced ${ok} offline payment${ok === 1 ? "" : "s"}.`
        : `Synced ${ok}, ${failedCount} failed — see below.`,
    );
  }

  async function handleDismiss(id: string) {
    await dismissQueueItem(id);
    await reload();
  }

  if (!loaded) return null;

  const pendingItems = queue.filter((q) => q.status === "PENDING" || q.status === "SYNCING");
  const failedItems = queue.filter((q) => q.status === "FAILED");
  const remaining = token
    ? token.allowance - pendingItems.reduce((sum, q) => sum + q.amount, 0)
    : 0;

  if (!offlinePolicyEnabled && pendingItems.length === 0 && failedItems.length === 0) {
    return null;
  }

  return (
    <div className="card space-y-4 p-5" data-testid="offline-queue-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Offline payments</h2>
        <span
          className={`badge ${online ? "badge-active" : "badge-suspended"}`}
          data-testid="offline-network-status"
        >
          {online ? "Online" : "Offline"}
        </span>
      </div>

      {!offlinePolicyEnabled && (
        <p className="text-xs text-muted">
          Offline payments are currently disabled by the Government. Anything queued below cannot
          sync until it is re-enabled.
        </p>
      )}

      {offlinePolicyEnabled && showQueueForm && (
        <>
          <div className="rounded-md bg-surface px-3 py-2 text-xs text-muted">
            {token ? (
              <>
                Offline authorization cached — up to{" "}
                <span className="font-medium text-foreground">
                  {Math.max(0, remaining).toLocaleString()} {CURRENCY_NAME}
                </span>{" "}
                remaining, {token.perTransactionMax.toLocaleString()} {CURRENCY_NAME} max per
                payment. Valid until you next go online after it expires.
              </>
            ) : (
              <>No offline authorization cached yet — connect while online to enable it.</>
            )}
            {online && (
              <button
                type="button"
                className="ml-2 font-medium underline"
                onClick={handleRefreshToken}
                disabled={tokenBusy}
              >
                {tokenBusy ? "Refreshing…" : "Refresh"}
              </button>
            )}
          </div>
          {tokenError && (
            <p className="text-xs text-danger" role="alert">
              {tokenError}
            </p>
          )}

          {!online && (
            <form onSubmit={handleQueueSubmit} className="space-y-3" data-testid="offline-pay-form">
              <p className="text-xs text-muted">
                You&apos;re offline. This queues a direct Aeros payment locally — it will send
                automatically once you&apos;re back online.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="offlineRecipient" className="mb-1 block text-xs font-medium">
                    Recipient username
                  </label>
                  <input
                    id="offlineRecipient"
                    className="input"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    placeholder="e.g. piyush"
                  />
                </div>
                <div>
                  <label htmlFor="offlineAmount" className="mb-1 block text-xs font-medium">
                    Amount ({CURRENCY_NAME})
                  </label>
                  <input
                    id="offlineAmount"
                    type="number"
                    className="input"
                    min={MIN_TRANSACTION_AMOUNT}
                    step={1}
                    value={amount}
                    onChange={(e) =>
                      setAmount(e.target.value === "" ? "" : Math.floor(Number(e.target.value)))
                    }
                  />
                </div>
              </div>
              <input
                className="input"
                placeholder="Note (optional)"
                maxLength={200}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {queueError && (
                <p className="text-xs text-danger" role="alert">
                  {queueError}
                </p>
              )}
              <button type="submit" className="btn btn-primary w-full" disabled={!token}>
                Queue offline payment
              </button>
            </form>
          )}
        </>
      )}

      {pendingItems.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">Pending</h3>
            {online && (
              <button
                type="button"
                className="btn btn-secondary text-xs"
                onClick={handleSync}
                disabled={syncing}
                data-testid="offline-sync-now"
              >
                {syncing ? "Syncing…" : "Sync now"}
              </button>
            )}
          </div>
          <div className="divide-y divide-border">
            {pendingItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
                data-testid="offline-pending-item"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">@{item.recipientUsername}</p>
                  {item.note && <p className="truncate text-xs text-muted">{item.note}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-sm">
                    {item.amount.toLocaleString()} {CURRENCY_NAME}
                  </span>
                  <span className="badge badge-suspended">
                    {item.status === "SYNCING"
                      ? "Syncing…"
                      : "Pending — will send once you're back online"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {syncSummary && <p className="text-xs text-muted">{syncSummary}</p>}

      {failedItems.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Could not send</h3>
          <div className="divide-y divide-border">
            {failedItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 py-2 text-sm"
                data-testid="offline-failed-item"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">@{item.recipientUsername}</p>
                  <p className="truncate text-xs text-danger">
                    {item.failureReason ?? "This payment could not be sent."}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-sm">
                    {item.amount.toLocaleString()} {CURRENCY_NAME}
                  </span>
                  <span className="badge badge-banned">Failed</span>
                  <button
                    type="button"
                    className="text-xs text-muted underline"
                    onClick={() => handleDismiss(item.id)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
