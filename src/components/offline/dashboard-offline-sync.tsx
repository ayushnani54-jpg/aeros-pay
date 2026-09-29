"use client";

import { useEffect } from "react";
import { saveSnapshot, type OfflineSnapshot } from "@/lib/offline-db";

type Props = Omit<OfflineSnapshot, "savedAt" | "token">;

/**
 * Renders nothing. Mounted on the Dashboard page (a Server Component), it
 * writes the page's own server-rendered data into IndexedDB every time this
 * page is actually reached over the network — which is exactly "the last
 * successful response" the offline shell is meant to fall back to. When the
 * page is later served from the Service Worker's cache while offline, this
 * component hydrates with that same cached data and simply re-saves it — a
 * harmless no-op, never a stale overwrite of something newer.
 */
export function DashboardOfflineSync(props: Props) {
  const activityKey = JSON.stringify(props.recentActivity);

  useEffect(() => {
    saveSnapshot({
      balance: props.balance,
      handle: props.handle,
      displayLabel: props.displayLabel,
      status: props.status,
      recentActivity: props.recentActivity,
    }).catch(() => undefined);
    // `activityKey` stands in for `props.recentActivity`, which is a new
    // array reference on every render — this should only re-save when the
    // underlying data actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.balance, props.handle, props.displayLabel, props.status, activityKey]);

  return null;
}
