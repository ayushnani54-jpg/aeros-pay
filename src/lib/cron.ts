import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * SCHEDULED-JOB AUTHORIZATION (spec §37)
 * ===========================================================================
 *
 * The cleanup endpoint is a normal HTTP route, so the only thing standing
 * between an anonymous visitor and the retention engine is this check. It is
 * kept in its own module, away from the route file, for two reasons: the route
 * stays three lines of policy, and the decision is a PURE FUNCTION of the
 * request headers and the environment, so the test suite can prove it rejects
 * a missing and a wrong secret without needing an HTTP server.
 *
 * THE MECHANISM IS THE PLATFORM'S DOCUMENTED ONE, NOT AN INVENTED ONE.
 * Vercel's cron documentation (docs/cron-jobs/manage-cron-jobs, "Securing cron
 * jobs") states that when a project defines a `CRON_SECRET` environment
 * variable, Vercel sends its value as an `Authorization` header with the
 * `Bearer` prefix on every cron invocation, and shows the App Router Route
 * Handler comparing the two. That is exactly what `authorizeCronRequest` does
 * — with two deliberate differences from the documented snippet:
 *
 *   * the comparison is CONSTANT TIME (the snippet uses `!==`, which leaks the
 *     length of the matching prefix to anyone willing to measure), and
 *   * `x-cron-secret` is accepted as an equivalent carrier, so the owner can
 *     trigger a run with `curl -H "x-cron-secret: ..."` without minting a
 *     fake Authorization header.
 *
 * FAIL CLOSED. If `CRON_SECRET` is not configured at all, every request is
 * rejected. An unset secret must never mean "open to everyone" — that is the
 * single most common way a cron endpoint becomes a public endpoint.
 */

export type CronAuthResult =
  | { ok: true; via: "authorization" | "x-cron-secret" }
  | { ok: false; reason: "NOT_CONFIGURED" | "MISSING" | "MISMATCH" };

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak the
 * length, so both sides are hashed to a fixed 32 bytes first and the digests
 * are compared. Two different strings essentially never collide, so this is
 * equality — it just takes the same time whatever the inputs are.
 */
export function secretsMatch(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Reads the presented secret out of either accepted header. */
function presentedSecret(headers: Headers): { value: string; via: "authorization" | "x-cron-secret" } | null {
  const auth = headers.get("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return { value: match[1].trim(), via: "authorization" };
  }
  const direct = headers.get("x-cron-secret");
  if (direct && direct.trim().length > 0) {
    return { value: direct.trim(), via: "x-cron-secret" };
  }
  return null;
}

/**
 * Decides whether a request may run the scheduled job.
 *
 * `secret` is injectable purely so the test suite can exercise the configured
 * and unconfigured cases without mutating the process environment.
 */
export function authorizeCronRequest(
  headers: Headers,
  secret: string | undefined = process.env.CRON_SECRET,
): CronAuthResult {
  const configured = secret?.trim();
  if (!configured) return { ok: false, reason: "NOT_CONFIGURED" };

  const presented = presentedSecret(headers);
  if (!presented) return { ok: false, reason: "MISSING" };

  if (!secretsMatch(presented.value, configured)) return { ok: false, reason: "MISMATCH" };
  return { ok: true, via: presented.via };
}

/** One HTTP status and one message per refusal, with nothing in the body that
 * tells an attacker which of the three cases they hit. */
export function cronRejection(result: Extract<CronAuthResult, { ok: false }>): Response {
  // 503 for "the server has no secret configured" is the one distinction worth
  // making: it is an operator error, not an attacker, and it must be loud in
  // the platform's logs rather than silently looking like a bad password.
  const status = result.reason === "NOT_CONFIGURED" ? 503 : 401;
  return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
