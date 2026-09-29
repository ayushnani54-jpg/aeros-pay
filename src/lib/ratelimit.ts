import "server-only";
import { headers } from "next/headers";

/**
 * RATE LIMITING (V3 Phase K, spec §43)
 * ===========================================================================
 *
 * WHAT THIS IS — AND HONESTLY, WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * This is an IN-MEMORY, PER-INSTANCE limiter. Counters live in a plain `Map`
 * inside the Node process that happens to serve the request. That has three
 * consequences the owner deserves stated plainly rather than glossed over:
 *
 *   1. It is NOT global. Vercel runs the app as serverless functions and may
 *      hold several warm instances at once. Two requests routed to two
 *      instances each get their own counter, so the effective limit across the
 *      whole deployment is (limit x number of warm instances), not `limit`.
 *   2. It does NOT survive a cold start. A new instance begins with an empty
 *      map, so a determined attacker who can force cold starts gets a fresh
 *      budget.
 *   3. It is therefore a SPEED BUMP against casual abuse, credential stuffing
 *      at human speed and accidental double-submits — not a defence against a
 *      distributed attack.
 *
 * WHY IT IS STILL THE RIGHT CHOICE HERE
 * ---------------------------------------------------------------------------
 * The alternative — a `rate_limits` table — would write a database row for
 * every login attempt and every payment attempt, on a Neon free tier whose
 * whole storage budget this project is deliberately managing (spec §38). A
 * counter that costs a row per request is the single easiest way to turn a
 * small app into a storage problem, and it would also put a write on the hot
 * path of every payment. Given a closed-loop economy whose accounts only exist
 * by Government-issued registration code, in-memory is the correct trade.
 *
 * THE REAL PROTECTIONS ARE ELSEWHERE, AND THEY ARE THE LOAD-BEARING ONES:
 * passwords are bcrypt-hashed (slow by construction), every financial action
 * re-derives its amounts server-side, balances are debited conditionally
 * inside a transaction so a flood cannot overdraw, and retryable payments are
 * idempotent (src/lib/idempotency.ts) so duplicates replay rather than double
 * spend. This module reduces noise; it is not what keeps the ledger correct.
 *
 * DESIGN NOTES
 * ---------------------------------------------------------------------------
 * Fixed window, not a sliding log: one integer and one timestamp per key
 * instead of an array of timestamps, so memory is bounded and predictable.
 * The map is capped and swept, so a flood of distinct keys cannot grow it
 * without limit — the limiter must never become the denial of service.
 *
 * Nothing here is stored, logged or counted for analytics (spec §57). The
 * counters are ephemeral process memory and are never written anywhere.
 */

export type RateLimitRule = {
  /** How many attempts are allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

export type RateLimitVerdict = {
  allowed: boolean;
  /** Attempts still available in the current window. */
  remaining: number;
  /** Whole seconds until the window resets. Zero when allowed. */
  retryAfterSeconds: number;
};

type Bucket = { count: number; resetAt: number };

/**
 * Hard ceiling on how many distinct keys are tracked. Well above anything this
 * app produces in a window, and small enough that the map can never become a
 * memory problem. When it is hit, expired buckets are swept first; if that is
 * not enough the map is cleared, which fails OPEN (everyone gets a fresh
 * budget) rather than locking legitimate users out.
 */
const MAX_TRACKED_KEYS = 5_000;

const buckets = new Map<string, Bucket>();

/** Drops every bucket whose window has already closed. */
function sweep(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Records one attempt against `key` and says whether it is allowed.
 *
 * `now` is injectable so the test suite can prove both that the limiter
 * triggers and that it RECOVERS once the window passes, without sleeping.
 */
export function consumeRateLimit(
  key: string,
  rule: RateLimitRule,
  now: number = Date.now(),
): RateLimitVerdict {
  if (buckets.size >= MAX_TRACKED_KEYS) {
    sweep(now);
    if (buckets.size >= MAX_TRACKED_KEYS) buckets.clear();
  }

  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { allowed: true, remaining: Math.max(0, rule.limit - 1), retryAfterSeconds: 0 };
  }

  if (existing.count >= rule.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, rule.limit - existing.count),
    retryAfterSeconds: 0,
  };
}

/** Clears one key — used after a SUCCESSFUL login so a legitimate user who
 * mistyped twice is not still carrying those attempts. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/** Test-only: empties every bucket. */
export function clearAllRateLimits(): void {
  buckets.clear();
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Credential checks. Deliberately generous enough that a person who has
 * genuinely forgotten which of two passwords they used is not locked out, and
 * tight enough that automated guessing is pointless against a bcrypt hash.
 */
export const LOGIN_RULE: RateLimitRule = { limit: 8, windowMs: 5 * 60_000 };

/** Registration burns a Government-issued code, so the real gate is the code.
 * This only stops a script from grinding through guessed codes. */
export const REGISTER_RULE: RateLimitRule = { limit: 6, windowMs: 10 * 60_000 };

/**
 * High-value financial actions: sending Aeros, paying an invoice, paying a
 * contract, issuing a refund, placing an order.
 *
 * Set well above any plausible human pace. Its job is to stop a runaway client
 * or a script hammering the settlement path, NOT to ration ordinary use — and
 * note that correctness never depended on it: idempotency keys and conditional
 * debits already make a duplicate submit harmless.
 */
export const FINANCIAL_RULE: RateLimitRule = { limit: 30, windowMs: 60_000 };

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * A coarse client identifier for pre-authentication endpoints.
 *
 * `x-forwarded-for` is client-controllable in general; on Vercel the left-most
 * entry is set by the platform's own proxy, which is the best signal available
 * without adding a dependency. A forged header only ever splits an attacker's
 * own budget into more buckets — it cannot consume anyone else's, because the
 * key is per-identifier and a bucket only ever counts against itself.
 */
export async function clientKey(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  const real = h.get("x-real-ip")?.trim();
  const candidate = first || real || "unknown";
  // Bound the length so a huge header cannot bloat a map key.
  return candidate.slice(0, 64);
}

/** Key for a login attempt: the client AND the account being tried, so one
 * noisy client cannot lock a specific account out for everybody else. */
export async function loginKey(username: string): Promise<string> {
  return `login:${await clientKey()}:${username.slice(0, 32).toLowerCase()}`;
}

export async function registerKey(): Promise<string> {
  return `register:${await clientKey()}`;
}

/** Key for a financial action: the acting WALLET, established from the
 * verified session — never a client-supplied value. */
export function financialKey(action: string, wallet: { kind: string; id: string }): string {
  return `fin:${action}:${wallet.kind}:${wallet.id}`;
}

/** One phrasing for every refusal, so the message never depends on which rule
 * fired or how close the caller got. */
export function rateLimitMessage(verdict: RateLimitVerdict): string {
  const seconds = verdict.retryAfterSeconds;
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `Too many attempts. Please wait about ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`;
  }
  return `Too many attempts. Please wait about ${seconds} second${seconds === 1 ? "" : "s"} and try again.`;
}
