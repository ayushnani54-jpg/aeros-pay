import Link from "next/link";
import { getCurrentGovernment } from "@/lib/auth";
import {
  getAccountingCheckpointsList,
  getAccountingPreservationSnapshot,
  getArchiveBatchesList,
  getArchiveEligibilityPreview,
} from "@/lib/archive";
import { formatBytes } from "@/lib/health";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";
import {
  ClearArchiveBatchForm,
  CreateArchiveBatchForm,
  VerifyArchiveBatchForm,
} from "@/components/v4/v4-forms";

export default async function GovArchiveCenterPage() {
  const gov = await getCurrentGovernment();
  if (!gov) return null;

  const [snapshot, eligibility, batches, checkpoints] = await Promise.all([
    getAccountingPreservationSnapshot(),
    getArchiveEligibilityPreview(),
    getArchiveBatchesList(40),
    getAccountingCheckpointsList(40),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Archive Center &amp; Accounting Preservation
          </h1>
          <p className="mt-1 text-sm text-muted">
            Generate checksummed <span className="font-mono">.zip</span> archives, verify
            manifests, and safely clear eligible historical records while preserving 100% of wallet
            balances and supply invariants.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`badge ${
              gov.archiveCenterEnabled ? "badge-active" : "badge-suspended"
            }`}
          >
            Archive Center: {gov.archiveCenterEnabled ? "ENABLED" : "DISABLED"}
          </span>
          <Link href="/gov/retention" className="btn btn-secondary text-xs">
            Retention Rules
          </Link>
          <Link href="/gov/health" className="btn btn-secondary text-xs">
            System Health
          </Link>
        </div>
      </div>

      <section className="card border-[#111111] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">
            Core Accounting Preservation (&ldquo;Never Lose the Balance&rdquo;)
          </h2>
          <span
            className={`badge ${
              snapshot.supplyBalanced ? "badge-active" : "badge-banned"
            }`}
          >
            {snapshot.supplyBalanced
              ? "SUPPLY INVARIANT BALANCED"
              : "SUPPLY DISCREPANCY DETECTED"}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted">
          Authoritative wallet balances live on <span className="font-mono">users.balance</span>,{" "}
          <span className="font-mono">companies.balance</span>, and{" "}
          <span className="font-mono">government.balance</span> — never reconstructed by summing
          deletable transaction rows. Clearing a verified transaction-history batch atomically
          rolls up cumulative credits, debits, tax collected, and company net sales into durable
          wallet counters and writes an immutable{" "}
          <span className="font-mono">accounting_checkpoints</span> record.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-md bg-surface p-3">
            <p className="text-[11px] text-muted">Treasury + User + Company</p>
            <p className="mt-0.5 text-base font-semibold">
              {snapshot.accounted.toLocaleString()} {CURRENCY_NAME}
            </p>
            <p className="text-[11px] text-muted">
              Total supply: {snapshot.totalSupply.toLocaleString()} {CURRENCY_NAME}
            </p>
          </div>
          <div className="rounded-md bg-surface p-3">
            <p className="text-[11px] text-muted">Archived Tx Cleared</p>
            <p className="mt-0.5 text-base font-semibold">
              {snapshot.totalClearedTx.toLocaleString()} rows
            </p>
            <p className="text-[11px] text-muted">
              Across {snapshot.checkpointCount} checkpoint(s)
            </p>
          </div>
          <div className="rounded-md bg-surface p-3">
            <p className="text-[11px] text-muted">Cumulative Archived Gross / Tax</p>
            <p className="mt-0.5 text-base font-semibold">
              {snapshot.totalGrossCleared.toLocaleString()} {CURRENCY_NAME}
            </p>
            <p className="text-[11px] text-muted">
              Tax preserved: {snapshot.archivedTaxCollected.toLocaleString()} {CURRENCY_NAME}
            </p>
          </div>
          <div className="rounded-md bg-surface p-3">
            <p className="text-[11px] text-muted">Preserved Company Sales Net</p>
            <p className="mt-0.5 text-base font-semibold">
              {snapshot.archivedCompanySalesNet.toLocaleString()} {CURRENCY_NAME}
            </p>
            <p className="text-[11px] text-muted">
              Retained for company sale valuations
            </p>
          </div>
        </div>
      </section>

      <section className="card p-5">
        <h2 className="font-medium">Step 1 — Generate a Structured .zip Archive Batch</h2>
        <p className="mt-1 mb-4 text-xs text-muted">
          Each <span className="font-mono">.zip</span> archive contains{" "}
          <span className="font-mono">manifest.json</span> (with SHA-256 hashes and verification
          token), <span className="font-mono">accounting-snapshot.json</span>,{" "}
          <span className="font-mono">data/&lt;dataset&gt;.json</span>, and{" "}
          <span className="font-mono">data/&lt;dataset&gt;.csv</span>. Protected Category A/B
          records (issuance, invoices, loans, company sale anchors, reversals) are automatically
          excluded from deletion eligibility.
        </p>

        <dl className="mb-4 grid gap-2 rounded-md bg-surface p-3 text-xs sm:grid-cols-2">
          <div className="flex justify-between">
            <dt className="text-muted">Category C transaction history (default cutoff):</dt>
            <dd className="font-medium">
              {eligibility.eligibleCounts.transactions_history} eligible
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Settled synthetic market orders:</dt>
            <dd className="font-medium">
              {eligibility.eligibleCounts.settled_market_orders} eligible
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Closed refund requests:</dt>
            <dd className="font-medium">
              {eligibility.eligibleCounts.closed_refunds} eligible
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Historical market candles (&gt;48h old):</dt>
            <dd className="font-medium">
              {eligibility.eligibleCounts.old_market_candles} eligible
            </dd>
          </div>
        </dl>

        <CreateArchiveBatchForm />
      </section>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">
          Step 2 &amp; 3 — Download, Verify &amp; Safely Clear Archive Batches ({batches.length})
        </h2>
        {batches.length === 0 ? (
          <p className="text-sm text-muted">
            No archive batches have been generated yet.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {batches.map((b) => (
              <div key={b.id} className="py-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold">{b.batchNumber}</span>
                      <span className="rounded bg-surface px-2 py-0.5 font-mono text-xs">
                        {b.datasetKey}
                      </span>
                      <span
                        className={`badge ${
                          b.status === "CLEARED" || b.status === "VERIFIED"
                            ? "badge-active"
                            : "badge-pending"
                        }`}
                      >
                        {b.status}
                      </span>
                    </div>
                    <p className="text-xs text-muted">
                      Records: <strong>{b.recordCount.toLocaleString()}</strong> · Size:{" "}
                      <strong>{formatBytes(b.byteSize)}</strong> · Cutoff:{" "}
                      {formatDateTime(b.cutoffDate)}
                    </p>
                    <p className="text-xs text-muted">
                      SHA-256: <span className="font-mono">{b.sha256Checksum}</span>
                    </p>
                    <p className="text-xs text-muted">
                      Manifest Verification Token:{" "}
                      <span className="font-mono font-semibold text-foreground">
                        {b.verificationToken}
                      </span>
                    </p>
                    <p className="text-[11px] text-muted">
                      Created {formatDateTime(b.createdAt)}
                      {b.downloadedAt ? ` · Downloaded ${formatDateTime(b.downloadedAt)}` : ""}
                      {b.verifiedAt ? ` · Verified ${formatDateTime(b.verifiedAt)}` : ""}
                      {b.clearedAt
                        ? ` · Cleared ${(b.clearedRecordCount ?? 0).toLocaleString()} rows at ${formatDateTime(b.clearedAt)}`
                        : ""}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <a
                      href={`/api/gov/archive/${b.id}`}
                      className="btn btn-primary text-xs"
                    >
                      Download .zip ({formatBytes(b.byteSize)})
                    </a>
                  </div>
                </div>

                {b.status !== "VERIFIED" && b.status !== "CLEARED" && (
                  <VerifyArchiveBatchForm
                    batchId={b.id}
                    verificationTokenHint={b.verificationToken}
                  />
                )}

                {b.status === "VERIFIED" && (
                  <ClearArchiveBatchForm
                    batchId={b.id}
                    verificationToken={b.verificationToken}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-2 font-medium">
          Immutable Accounting Checkpoints ({checkpoints.length})
        </h2>
        <p className="mb-3 text-xs text-muted">
          Permanent Category B accounting evidence written whenever a{" "}
          <span className="font-mono">transactions_history</span> archive batch is cleared.
          Protected by database <span className="font-mono">CHECK</span> constraint{" "}
          <span className="font-mono">
            treasury + userHeld + companyHeld + retiredSupply = totalSupply
          </span>
          .
        </p>

        {checkpoints.length === 0 ? (
          <p className="text-sm text-muted">
            No transaction-history batches have been cleared yet.
          </p>
        ) : (
          <div className="divide-y divide-border text-sm">
            {checkpoints.map((cp) => (
              <div key={cp.id} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">{cp.checkpointNumber}</span>
                    <span className="badge badge-active">
                      {cp.clearedTxCount.toLocaleString()} tx cleared
                    </span>
                  </div>
                  <span className="text-xs text-muted">
                    {formatDateTime(cp.createdAt)}
                  </span>
                </div>
                <p className="text-xs text-muted">
                  Cleared volume: Gross {cp.grossVolumeCleared.toLocaleString()} {CURRENCY_NAME} ·
                  Tax {cp.taxVolumeCleared.toLocaleString()} {CURRENCY_NAME} · Net{" "}
                  {cp.netVolumeCleared.toLocaleString()} {CURRENCY_NAME}
                </p>
                <p className="text-xs text-muted">
                  Post-clear invariant snapshot: Treasury{" "}
                  {cp.treasuryBalanceSnapshot.toLocaleString()} + Users{" "}
                  {cp.userHeldBalanceSnapshot.toLocaleString()} + Companies{" "}
                  {cp.companyHeldBalanceSnapshot.toLocaleString()} = Total Supply{" "}
                  <strong>
                    {cp.totalSupplySnapshot.toLocaleString()} {CURRENCY_NAME}
                  </strong>
                </p>
                <p className="font-mono text-[11px] text-muted">
                  Checkpoint hash: {cp.checkpointHash}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
