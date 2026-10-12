"use client";

import React, {
  createContext,
  useActionState,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ActionResult } from "@/actions/auth";

export type ActionFeedbackStatus =
  | "PROCESSING"
  | "WAITING"
  | "UPLOADING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "RETRYING"
  | "PAUSED_INTERVENTION";

export interface ActionFeedbackItem {
  id: string;
  operationKey: string;
  title: string;
  detail?: string;
  status: ActionFeedbackStatus;
  persistentBanner?: boolean;
  updatedAt: number;
}

interface ActionFeedbackContextValue {
  activeItems: ActionFeedbackItem[];
  notifyAction: (item: {
    operationKey: string;
    title: string;
    detail?: string;
    status: ActionFeedbackStatus;
    persistentBanner?: boolean;
  }) => void;
  dismissAction: (operationKey: string) => void;
}

const ActionFeedbackContext = createContext<ActionFeedbackContextValue | null>(null);

export function useActionFeedback() {
  const ctx = useContext(ActionFeedbackContext);
  if (!ctx) {
    return {
      activeItems: [],
      notifyAction: () => {},
      dismissAction: () => {},
    };
  }
  return ctx;
}

const STATUS_LABELS: Record<ActionFeedbackStatus, string> = {
  PROCESSING: "Processing",
  WAITING: "Waiting",
  UPLOADING: "Uploading to GitHub",
  VERIFYING: "Verifying SHA-256",
  COMPLETED: "Completed successfully",
  FAILED: "Failed",
  RETRYING: "Retrying",
  PAUSED_INTERVENTION: "Paused — awaiting intervention",
};

export function GlobalActionFeedbackProvider({
  children,
  storageAlertNotice,
}: {
  children: React.ReactNode;
  storageAlertNotice?: string | null;
}) {
  const [items, setItems] = useState<ActionFeedbackItem[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissAction = useCallback((operationKey: string) => {
    const t = timersRef.current.get(operationKey);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(operationKey);
    }
    setItems((prev) => prev.filter((item) => item.operationKey !== operationKey));
  }, []);

  const notifyAction = useCallback(
    (input: {
      operationKey: string;
      title: string;
      detail?: string;
      status: ActionFeedbackStatus;
      persistentBanner?: boolean;
    }) => {
      const existingTimer = timersRef.current.get(input.operationKey);
      if (existingTimer) {
        clearTimeout(existingTimer);
        timersRef.current.delete(input.operationKey);
      }

      const now = Date.now();
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.operationKey === input.operationKey);
        const nextItem: ActionFeedbackItem = {
          id: idx >= 0 ? prev[idx].id : `${input.operationKey}-${now}`,
          operationKey: input.operationKey,
          title: input.title,
          detail: input.detail,
          status: input.status,
          persistentBanner:
            input.persistentBanner ??
            ["PROCESSING", "WAITING", "UPLOADING", "VERIFYING", "RETRYING", "PAUSED_INTERVENTION"].includes(
              input.status,
            ),
          updatedAt: now,
        };
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = nextItem;
          return copy;
        }
        return [...prev.slice(-4), nextItem];
      });

      if (input.status === "COMPLETED") {
        const timer = setTimeout(() => {
          dismissAction(input.operationKey);
        }, 4800);
        timersRef.current.set(input.operationKey, timer);
      } else if (input.status === "FAILED") {
        const timer = setTimeout(() => {
          dismissAction(input.operationKey);
        }, 8000);
        timersRef.current.set(input.operationKey, timer);
      }
    },
    [dismissAction],
  );

  // Automatic global listener for standard HTML form submissions across V1-V5 pages
  // (excluding GET filter forms and opt-out forms that manage their own state via V5ActionForm)
  useEffect(() => {
    const handleFormSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement | null;
      if (!form || form.tagName !== "FORM") return;
      if (form.method?.toLowerCase() === "get") return;
      if (form.dataset.v5Managed === "true") return;

      const submitter = e.submitter as HTMLElement | null;
      const buttonLabel =
        submitter?.textContent?.trim() ||
        form.querySelector('button[type="submit"]')?.textContent?.trim() ||
        "Operation";

      if (buttonLabel.toLowerCase() === "log out") return;

      const opKey = `auto-form-${buttonLabel.slice(0, 32)}`;
      const isArchive = buttonLabel.toLowerCase().includes("archive");

      notifyAction({
        operationKey: opKey,
        title: isArchive ? "GitHub Archival Pipeline" : buttonLabel,
        detail: isArchive
          ? "Uploading & verifying deterministic archive batch with SHA-256 read-back..."
          : "Verifying and committing transaction on the server...",
        status: isArchive ? "UPLOADING" : "PROCESSING",
        persistentBanner: true,
      });

      // Poll the submit button's disabled state (React transitions disable or re-render buttons)
      let checks = 0;
      const interval = setInterval(() => {
        checks += 1;
        const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement | null;
        const stillPending = btn?.disabled && checks < 45;
        if (!stillPending || checks >= 45) {
          clearInterval(interval);
          // Inspect nearby alert messages rendered after server response
          const errorEl = form.querySelector('[data-feedback="error"], .text-danger, .bg-\\[\\#fdecea\\]');
          const successEl = form.querySelector('[data-feedback="success"], .text-success, .bg-\\[\\#eaf7ee\\]');
          if (errorEl && errorEl.textContent?.trim()) {
            notifyAction({
              operationKey: opKey,
              title: `${buttonLabel} failed`,
              detail: errorEl.textContent.trim(),
              status: "FAILED",
              persistentBanner: false,
            });
          } else if (successEl && successEl.textContent?.trim()) {
            notifyAction({
              operationKey: opKey,
              title: `${buttonLabel} completed`,
              detail: successEl.textContent.trim(),
              status: "COMPLETED",
              persistentBanner: false,
            });
          } else {
            notifyAction({
              operationKey: opKey,
              title: `${buttonLabel} processed`,
              detail: "Server state synchronized.",
              status: "COMPLETED",
              persistentBanner: false,
            });
          }
        }
      }, 350);
    };

    document.addEventListener("submit", handleFormSubmit, true);
    return () => document.removeEventListener("submit", handleFormSubmit, true);
  }, [notifyAction]);

  const bannerItem = items.find(
    (i) =>
      i.persistentBanner &&
      ["PROCESSING", "WAITING", "UPLOADING", "VERIFYING", "RETRYING", "PAUSED_INTERVENTION"].includes(
        i.status,
      ),
  );

  const latestToast = items[items.length - 1] ?? null;

  return (
    <ActionFeedbackContext.Provider value={{ activeItems: items, notifyAction, dismissAction }}>
      {/* Element B: Persistent Yellow/Amber Processing Banner Below Navbar */}
      {bannerItem && (
        <div
          role="status"
          aria-live="polite"
          className="sticky top-[53px] z-20 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-amber-950 shadow-xs transition-all"
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
            <div className="flex items-center gap-2.5">
              <span className="inline-block h-2.5 w-2.5 animate-ping rounded-full bg-amber-600" />
              <span className="rounded bg-amber-200/80 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-900">
                {STATUS_LABELS[bannerItem.status]}
              </span>
              <span className="font-semibold">{bannerItem.title}</span>
              {bannerItem.detail && (
                <span className="hidden text-amber-800 sm:inline">— {bannerItem.detail}</span>
              )}
            </div>
            <span className="font-mono text-[11px] text-amber-800">
              Awaiting server verification...
            </span>
          </div>
        </div>
      )}

      {/* System-wide GitHub Archive Storage Notice when near 900 MB threshold */}
      {storageAlertNotice && (
        <div className="border-b border-amber-300 bg-[#fff8e6] px-4 py-2 text-center text-xs font-medium text-[#8a5a00]">
          {storageAlertNotice}
        </div>
      )}

      {children}

      {/* Element A: Small, Attractive Bottom Floating Action Notification */}
      {latestToast && (
        <div
          role="region"
          aria-label="Action notification"
          className="fixed bottom-16 right-4 z-50 max-w-sm sm:bottom-5 sm:right-6"
        >
          <div
            className={`flex items-start gap-3 rounded-xl border px-4 py-3 shadow-lg backdrop-blur-md transition-all ${
              latestToast.status === "FAILED"
                ? "border-red-300 bg-[#fdecea]/95 text-[#b3261e]"
                : latestToast.status === "COMPLETED"
                  ? "border-emerald-300 bg-[#eaf7ee]/95 text-[#146c2e]"
                  : "border-amber-300 bg-amber-50/95 text-amber-950"
            }`}
          >
            <div className="mt-0.5 shrink-0">
              {latestToast.status === "COMPLETED" ? (
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#146c2e] text-xs font-bold text-white">
                  ✓
                </span>
              ) : latestToast.status === "FAILED" ? (
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[#b3261e] text-xs font-bold text-white">
                  !
                </span>
              ) : (
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-amber-700 border-t-transparent" />
              )}
            </div>

            <div className="min-w-0 flex-1 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold uppercase tracking-wider opacity-80">
                  {STATUS_LABELS[latestToast.status]}
                </span>
                <button
                  type="button"
                  onClick={() => dismissAction(latestToast.operationKey)}
                  className="rounded px-1 text-[11px] opacity-60 hover:opacity-100"
                  aria-label="Dismiss notification"
                >
                  ✕
                </button>
              </div>
              <p className="mt-0.5 font-semibold leading-snug">{latestToast.title}</p>
              {latestToast.detail && (
                <p className="mt-0.5 line-clamp-3 opacity-90">{latestToast.detail}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </ActionFeedbackContext.Provider>
  );
}

/**
 * Reusable V5 Action Form wrapper that connects any Server Action (`ActionResult`)
 * directly to the Global Action & Loading Notification System (`Element A` + `Element B`)
 * and renders inline status feedback as well.
 */
export function V5ActionForm({
  action,
  operationKey,
  operationTitle,
  processingDetail,
  processingStatus = "PROCESSING",
  label,
  bannerTitle,
  bannerDetail,
  className = "space-y-3",
  children,
  onSuccessReset = false,
}: {
  action: (prev: unknown, formData: FormData) => Promise<ActionResult>;
  operationKey?: string;
  operationTitle?: string;
  processingDetail?: string;
  processingStatus?: ActionFeedbackStatus;
  label?: string;
  bannerTitle?: string;
  bannerDetail?: string;
  className?: string;
  children: React.ReactNode | ((pending: boolean) => React.ReactNode);
  onSuccessReset?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const { notifyAction } = useActionFeedback();
  const formRef = useRef<HTMLFormElement>(null);
  const prevPendingRef = useRef(false);

  const resolvedTitle = operationTitle || bannerTitle || label || "Processing Action";
  const resolvedKey =
    operationKey ||
    `v5-op-${resolvedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 36)}`;
  const resolvedDetail =
    processingDetail || bannerDetail || "Validating and committing changes on the server...";

  useEffect(() => {
    if (pending && !prevPendingRef.current) {
      notifyAction({
        operationKey: resolvedKey,
        title: resolvedTitle,
        detail: resolvedDetail,
        status: processingStatus,
        persistentBanner: true,
      });
    } else if (!pending && prevPendingRef.current && state) {
      if (state.ok) {
        notifyAction({
          operationKey: resolvedKey,
          title: resolvedTitle,
          detail: state.message || "Operation verified and completed.",
          status: "COMPLETED",
          persistentBanner: false,
        });
        if (onSuccessReset && formRef.current) {
          formRef.current.reset();
        }
      } else if (state.error) {
        notifyAction({
          operationKey: resolvedKey,
          title: `${resolvedTitle} Failed`,
          detail: state.error,
          status: "FAILED",
          persistentBanner: false,
        });
      }
    }
    prevPendingRef.current = pending;
  }, [
    pending,
    state,
    resolvedKey,
    resolvedTitle,
    resolvedDetail,
    processingStatus,
    notifyAction,
    onSuccessReset,
  ]);

  return (
    <form ref={formRef} action={formAction} data-v5-managed="true" className={className}>
      {typeof children === "function" ? children(pending) : children}

      {state && !state.ok && state.error && (
        <div
          data-feedback="error"
          className="rounded-lg border border-[#e3b3ae] bg-[#fdecea] px-3 py-2 text-xs font-medium text-[#b3261e]"
        >
          {state.error}
        </div>
      )}
      {state && state.ok && state.message && (
        <div
          data-feedback="success"
          className="rounded-lg border border-emerald-200 bg-[#eaf7ee] px-3 py-2 text-xs font-medium text-[#146c2e]"
        >
          {state.message}
        </div>
      )}
    </form>
  );
}
