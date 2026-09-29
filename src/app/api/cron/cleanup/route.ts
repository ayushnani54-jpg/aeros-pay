import { authorizeCronRequest, cronRejection } from "@/lib/cron";
import { runFullCleanup } from "@/lib/retention";
import { expireOverdueInvoices } from "@/lib/invoices";
import { expireOverdueOrders } from "@/lib/marketplace";
import { expireOverdueWantedRequests } from "@/lib/wanted";
import { expireOverdueContracts } from "@/lib/contracts";

/**
 * THE ONE SCHEDULED JOB (spec §37)
 * ===========================================================================
 *
 * WHY EXACTLY ONE, AND WHY DAILY
 * ------------------------------
 * This app is deployed on Vercel's Hobby plan, whose cron documentation states
 * two restrictions that shape this whole design: a Hobby cron job **can only
 * run once per day** (a more frequent expression fails the deployment), and
 * Vercel may invoke it **anywhere inside the specified hour** to spread load.
 * So there is one entry in vercel.json, it runs daily, and nothing in the app
 * may assume it fired at a precise minute — or at all.
 *
 * The same documentation is equally clear that delivery is BEST EFFORT: a run
 * can be missed, and a run can occasionally be delivered TWICE. Both are
 * designed for here rather than hoped against:
 *
 *   missed    every predicate in the retention engine is a property of the
 *             row (age, status, expiry), never a cursor, so a run that never
 *             happened costs nothing but a day of latency — the next one
 *             sweeps the backlog.
 *   duplicate every statement is idempotent and re-states its eligibility
 *             conditions, so a second delivery finds nothing left to do.
 *   concurrent the two invocations touch disjoint id batches (each probes,
 *             then acts on exactly the ids it read); the loser of any overlap
 *             simply reports fewer affected rows.
 *
 * BUDGET, NOT A LOOP
 * ------------------
 * The handler hands `runFullCleanup` a wall-clock budget well inside the
 * platform's function timeout and returns whatever it got through. It never
 * loops until done. A backlog larger than one budget is reported as
 * `completed: false` and continues tomorrow — bounded work per invocation is
 * what keeps this safe on a plan with a hard function duration limit.
 *
 * THIS IS A FALLBACK-ABLE SCHEDULE, NOT A LOAD-BEARING ONE
 * --------------------------------------------------------
 * The lazy sweeps this route calls are the SAME functions the pages already
 * call on view, and `runDueCleanupLazily` (wired into the Government pages)
 * claims at most one automatic run per IST day. If cron is disabled, misfires,
 * or the project is moved off Vercel entirely, the app stays correct — it just
 * gets tidy when somebody looks at it instead of overnight.
 */

/** Never cached, never prerendered: it reads the request headers and writes. */
export const dynamic = "force-dynamic";
/** Comfortably above the internal budget below, so the handler always gets to
 * return its own summary rather than being killed mid-write. */
export const maxDuration = 60;

/** Wall-clock budget for the retention engine itself, in ms. */
const CLEANUP_BUDGET_MS = 8_000;
/** Budget for the status sweeps that run alongside it. */
const SWEEP_BUDGET_MS = 4_000;

async function handle(request: Request): Promise<Response> {
  const auth = authorizeCronRequest(request.headers);
  if (!auth.ok) return cronRejection(auth);

  const startedAt = Date.now();

  // 1. Status sweeps — the same "bring things up to date" work the pages do
  //    lazily. Each is individually bounded and individually fault-tolerant:
  //    one failing sweep must not cost us the cleanup.
  const sweeps: Record<string, number | string> = {};
  const sweepDeadline = startedAt + SWEEP_BUDGET_MS;
  const sweepList = [
    ["invoicesExpired", expireOverdueInvoices],
    ["ordersExpired", () => expireOverdueOrders(200)],
    ["wantedExpired", expireOverdueWantedRequests],
    ["contractsExpired", expireOverdueContracts],
  ] as const;

  for (const [name, run] of sweepList) {
    if (Date.now() >= sweepDeadline) {
      sweeps[name] = "skipped (budget)";
      continue;
    }
    try {
      sweeps[name] = await run();
    } catch (e) {
      sweeps[name] = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 2. The retention engine.
  const summary = await runFullCleanup({ source: "CRON" }, { budgetMs: CLEANUP_BUDGET_MS });

  return Response.json(
    {
      ok: summary.ok,
      completed: summary.completed,
      durationMs: Date.now() - startedAt,
      sweeps,
      cleanup: {
        totalAffected: summary.totalAffected,
        failures: summary.failures,
        targets: summary.targets.map((t) => ({
          key: t.key,
          affected: t.affected,
          completed: t.completed,
          ...(t.error ? { error: t.error } : {}),
        })),
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/** Vercel cron invokes the path with GET. */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

/** POST is accepted so the owner can trigger a run by hand without a browser
 * turning it into a navigation. Same authorization, same work. */
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
