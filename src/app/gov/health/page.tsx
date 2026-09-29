import Link from "next/link";
import { runHealthCheck } from "@/lib/reconcile";
import { formatBytes, getSystemHealth } from "@/lib/health";
import { RunHealthCheckButton } from "@/components/forms/health-forms";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";

/**
 * HEALTH & RECONCILIATION (V3 Phase K, spec §§40, 48, 49)
 * ===========================================================================
 *
 * Two things on one page, because they answer the same question from two
 * directions: "is the ledger telling the truth" and "is the database going to
 * run out of room".
 *
 * BOTH HALVES ARE COMPUTED LIVE, ON EVERY VIEW, AND NEITHER IS STORED.
 * The reconciliation is re-run here rather than read back from
 * `reconciliation_status`, so what is on screen is the state of the ledger
 * right now — the stored singleton exists only to answer "when did somebody
 * last press the button, and did it pass". The size figures come from
 * Postgres's own catalogs at render time; there is no metrics table, no
 * history and no analytics of any kind (spec §57).
 *
 * Access is the ordinary Government session enforced by src/app/gov/layout.tsx.
 * Like the Control Room, this page's separation is organisational, not a
 * security measure.
 */
export const dynamic = "force-dynamic";

export default async function GovHealthPage() {
  // Both are read-only, so they can run together.
  const [reconciliation, system] = await Promise.all([
    runHealthCheck().catch((e) => ({ error: e instanceof Error ? e.message : String(e) }) as const),
    getSystemHealth().catch((e) => ({ error: e instanceof Error ? e.message : String(e) }) as const),
  ]);

  const rec = "error" in reconciliation ? null : reconciliation;
  const sys = "error" in system ? null : system;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">System health</h1>
        <p className="mt-1 text-sm text-muted">
          Reconciliation and storage, both computed fresh every time this page is opened. Nothing
          on this page is stored except the one line recording when the check was last run by hand.
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Reconciliation                                                      */}
      {/* ------------------------------------------------------------------ */}

      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-medium">Reconciliation</h2>
            <p className="mt-1 text-sm text-muted">
              Every check below is a query. Running one moves no {CURRENCY_NAME}, repairs nothing
              and writes nothing but the latest-status line.
            </p>
          </div>
          <RunHealthCheckButton />
        </div>

        {"error" in reconciliation && (
          <p className="mt-4 text-sm text-danger">
            The reconciliation could not be run: {reconciliation.error}
          </p>
        )}

        {rec && (
          <>
            <p
              className={`mt-4 text-sm font-medium ${rec.healthy ? "text-success" : "text-danger"}`}
              data-testid="health-verdict"
            >
              {rec.healthy
                ? `All ${rec.checksRun} checks passed as of ${formatDateTime(rec.ranAt)}.`
                : `${rec.checksFailed} of ${rec.checksRun} checks FAILED as of ${formatDateTime(rec.ranAt)}.`}
            </p>

            <div className="mt-4 rounded-md bg-surface p-4">
              <h3 className="text-sm font-medium">Supply</h3>
              <dl className="mt-2 space-y-1 text-sm">
                <Money label="Treasury" value={rec.supply.treasury} />
                <Money label="Held by people" value={rec.supply.userHeld} />
                <Money label="Held by companies" value={rec.supply.companyHeld} />
                <div className="flex justify-between border-t border-border pt-1 font-medium">
                  <dt>Accounted for</dt>
                  <dd>
                    {rec.supply.accounted.toLocaleString()} {CURRENCY_NAME}
                  </dd>
                </div>
                <div className="flex justify-between font-medium">
                  <dt>Recorded supply</dt>
                  <dd>
                    {rec.supply.totalSupply.toLocaleString()} {CURRENCY_NAME}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="mt-4 divide-y divide-border" data-testid="health-checks">
              {rec.checks.map((c) => (
                <div key={c.key} className="flex flex-wrap items-start gap-3 py-3">
                  <span
                    className={`badge ${c.passed ? "badge-active" : "badge-suspended"} shrink-0`}
                  >
                    {c.passed ? "PASS" : c.severity === "CRITICAL" ? "FAIL" : "WARN"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{c.label}</p>
                    <p className="mt-0.5 text-sm text-muted">{c.detail}</p>
                    {c.examples.length > 0 && (
                      <p className="mt-1 break-all font-mono text-xs text-muted">
                        {c.examples.join(", ")}
                        {c.offenders > c.examples.length
                          ? ` … and ${c.offenders - c.examples.length} more`
                          : ""}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {sys?.reconciliation && (
          <p className="mt-4 border-t border-border pt-3 text-xs text-muted">
            Last run by hand: {formatDateTime(sys.reconciliation.lastRunAt)}
            {sys.reconciliation.ranBy ? ` by ${sys.reconciliation.ranBy}` : ""} —{" "}
            {sys.reconciliation.summary}
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Storage                                                             */}
      {/* ------------------------------------------------------------------ */}

      {"error" in system && (
        <section className="card p-5">
          <h2 className="font-medium">Storage</h2>
          <p className="mt-2 text-sm text-danger">
            The size figures could not be read: {system.error}
          </p>
        </section>
      )}

      {sys && (
        <>
          <section className="card p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="font-medium">Database</h2>
              <p className="text-2xl font-semibold tracking-tight" data-testid="db-size">
                {formatBytes(sys.databaseBytes)}
              </p>
            </div>
            <p className="mt-1 text-sm text-muted">
              <span className="font-mono">{sys.databaseName}</span> — total on-disk size including
              indexes, measured at {formatDateTime(sys.generatedAt)}.
            </p>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 font-medium">Largest tables</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th className="pb-2 pr-3 font-medium">Table</th>
                    <th className="pb-2 pr-3 text-right font-medium">Total</th>
                    <th className="pb-2 pr-3 text-right font-medium">Data</th>
                    <th className="pb-2 pr-3 text-right font-medium">Indexes</th>
                    <th className="pb-2 text-right font-medium">Rows (est.)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sys.tables.map((t) => (
                    <tr key={t.table}>
                      <td className="py-2 pr-3 font-mono text-xs">{t.table}</td>
                      <td className="py-2 pr-3 text-right">{formatBytes(t.totalBytes)}</td>
                      <td className="py-2 pr-3 text-right text-muted">
                        {formatBytes(t.tableBytes)}
                      </td>
                      <td className="py-2 pr-3 text-right text-muted">
                        {formatBytes(t.indexBytes)}
                      </td>
                      <td className="py-2 text-right text-muted">
                        {t.estimatedRows.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted">
              Row counts are the planner&rsquo;s estimate, not an exact count — counting every
              table exactly on every page view would be the most expensive thing this page does.
            </p>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 font-medium">Largest indexes</h2>
            <div className="divide-y divide-border">
              {sys.indexes.map((i) => (
                <div key={i.index} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs">{i.index}</p>
                    <p className="text-xs text-muted">on {i.table}</p>
                  </div>
                  <span className="shrink-0 text-muted">{formatBytes(i.bytes)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="card p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="font-medium">Temporary data</h2>
              <p className="text-sm text-muted">
                {sys.cleanableTotal.toLocaleString()} rows in cleanable classes
              </p>
            </div>
            <div className="mt-3 divide-y divide-border">
              {sys.cleanable.map((c) => (
                <div key={c.key} className="flex flex-wrap items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{c.label}</p>
                    <p className="text-xs text-muted">{c.disposition}</p>
                  </div>
                  <span className="shrink-0 text-sm">{c.rows.toLocaleString()}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-muted">
              These are how many rows exist in each class, not how many are due for removal today —
              the second number moves every day and would make this page look unstable.
            </p>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 font-medium">Cleanup</h2>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Last attempt</dt>
                <dd>{sys.lastCleanupAt ? formatDateTime(sys.lastCleanupAt) : "never"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Last success</dt>
                <dd>
                  {sys.lastCleanupSuccessAt ? formatDateTime(sys.lastCleanupSuccessAt) : "never"}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Last text scrub</dt>
                <dd>{sys.lastScrubAt ? formatDateTime(sys.lastScrubAt) : "never"}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted">
              A widening gap between the last attempt and the last success means the schedule is
              running but failing. Settings and manual runs live on the{" "}
              <Link href="/gov/retention" className="underline">
                retention page
              </Link>
              .
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function Money({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd>
        {value.toLocaleString()} {CURRENCY_NAME}
      </dd>
    </div>
  );
}
