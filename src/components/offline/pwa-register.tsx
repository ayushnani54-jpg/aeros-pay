"use client";

import { useEffect } from "react";

/**
 * Renders nothing. Registers `/sw.js` once on mount.
 *
 * Registration failing — an unsupported browser, a test harness that blocks
 * service workers, a private-mode restriction — must never break the app:
 * offline support is additive, so every failure here is swallowed.
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  return null;
}
