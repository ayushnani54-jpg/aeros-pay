import Link from "next/link";
import { getCurrentGovernment } from "@/lib/auth";
import {
  getAccountingCheckpointsList,
  getAccountingPreservationSnapshot,
  getArchiveBatchesList,
  getArchiveCenterV41Overview,
} from "@/lib/archive";
import { formatBytes } from "@/lib/health";
import { CURRENCY_NAME, DATASET_TO_GITHUB_REPO } from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";
import {
  ClearArchiveBatchForm,
  CreateArchiveBatchForm,
  DownloadAllArchiveBundleForm,
  RetryFailedArchiveBatchButton,
  Run24HourGithubArchivalButton,
  VerifyArchiveBatchForm,
} from "@/components/v4/v4-forms";

export default async function GovArchiveCenterPage() {
  const gov = await getCurrentGovernment();
  if (!gov) return null;

  const [snapshot, v41Overview, batches, checkpoints] = await Promise.all([
    getAccountingPreservationSnapshot(),
    getArchiveCenterV41Overview(),
    getArchiveBatchesList(50),
    getAccountingCheckpointsList(40),
  ]);

  const totalArchivedInGithub = v41Overview.repositories.reduce(
    (sum, r) => sum + r.totalRecordsArchived,
    0,
  );
  const totalAwaitingArchival24h = Object.values(v41Overview.awaitingArchivalCounts).reduce(
    (sum, c) => sum + c,
    0,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Archive Center V4.1 &amp; 5-Repo GitHub Historical Store
          </h1>
          <p className="mt-1 text-sm text-muted">
            Dual-Layer Architecture: <strong>Neon PostgreSQL</strong> (minimal operational state) +{" "}
            <strong>5 Private GitHub Repositories</strong> (permanent historical economic store).
            Records &ge;24h old are archived, SHA-256 verified remotely, and safely cleared from
            Neon while preserving 100% of balances and supply invariants.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`badge ${
              v41Overview.githubEnv.hasLiveCredentials ? "badge-active" : "badge-pending"
            }`}
          >
            {v41Overview.githubEnv.modeLabel}
          </span>
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

      {/* 1. 5 Private GitHub Archive Repositories Status */}
      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-medium">
              5 Private GitHub Historical Archive Repositories (400 MB Warning / 750 MB Auto-Shard)
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Each repository stores partitioned <span className="font-mono">.jsonl</span> batches,{" "}
              <span className="font-mono">manifests/</span> with SHA-256 verification tokens, and{" "}
              <span className="font-mono">index/</span> catalogs. Automatically rotates to{" "}
              <span className="font-mono">shards/s2/</span> before hitting GitHub size limits.
            </p>
          </div>
          <Run24HourGithubArchivalButton />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {v41Overview.repositories.map((repo) => {
            const pct = repo.usagePercent;
            const warnPct = Math.round(
              (repo.warningThresholdBytes / Math.max(1, repo.hardLimitBytes)) * 100,
            );
            return (
              <div
                key={repo.repoKey}
                className="flex flex-col justify-between rounded-md border border-border bg-surface p-3 text-xs"
              >
                <div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono font-semibold text-foreground">
                      {repo.repoName}
                    </span>
                    <span
                      className={`badge text-[10px] ${
                        repo.healthStatus === "HEALTHY"
                          ? "badge-active"
                          : repo.healthStatus === "WARNING_STORAGE" ||
                              repo.healthStatus === "ROTATION_REQUIRED"
                            ? "badge-pending"
                            : "badge-banned"
                      }`}
                    >
                      {repo.healthStatus}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted">{repo.meta.description}</p>
                </div>

                <div className="mt-3 space-y-1.5 border-t border-border pt-2">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-muted">Archived Records:</span>
                    <span className="font-mono font-semibold">
                      {repo.totalRecordsArchived.toLocaleString()} ({repo.totalBatchesPushed}{" "}
                      batches)
                    </span>
                  </div>
                  <div className="flex justify-between text-[11px]">
                    <span className="text-muted">Shard Usage:</span>
                    <span className="font-mono">
                      {formatBytes(repo.estimatedBytesUsed)} / {formatBytes(repo.hardLimitBytes)}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                    <div
                      className={`h-full ${
                        pct >= warnPct ? "bg-[#b45309]" : "bg-[#15803d]"
                      }`}
                      style={{ width: `${Math.max(2, pct)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-muted">
                    <span>Shard #{repo.shardGeneration}</span>
                    <span className="font-mono">
                      {repo.lastCommitSha
                        ? `SHA ${repo.lastCommitSha.slice(0, 8)}`
                        : "No commits yet"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 2. The 4 Required Dual-Layer States */}
      <section className="grid gap-4 lg:grid-cols-4">
        {/* State 1: Archived in GitHub */}
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">1. Archived in GitHub</h3>
            <span className="badge badge-active text-[10px]">VERIFIED REMOTE</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            Permanently stored in the 5 GitHub repositories with verified SHA-256 manifests.
          </p>
          <p className="mt-2 font-mono text-xl font-semibold">
            {totalArchivedInGithub.toLocaleString()}{" "}
            <span className="text-xs font-normal text-muted">records</span>
          </p>
          <dl className="mt-3 space-y-1 border-t border-border pt-2 text-[11px]">
            {v41Overview.repositories.map((r) => (
              <div key={r.repoKey} className="flex justify-between">
                <dt className="font-mono text-muted">{r.repoKey}</dt>
                <dd className="font-mono font-medium">
                  {r.totalRecordsArchived.toLocaleString()} ({r.totalBatchesPushed}b)
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/* State 2: Awaiting Archival >=24h */}
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">2. Awaiting Archival (&ge;24h)</h3>
            <span className="badge badge-pending text-[10px]">ELIGIBLE NOW</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            Completed records &ge;24 hours old in Neon ready for the next GitHub archival batch.
          </p>
          <p className="mt-2 font-mono text-xl font-semibold">
            {totalAwaitingArchival24h.toLocaleString()}{" "}
            <span className="text-xs font-normal text-muted">records</span>
          </p>
          <dl className="mt-3 space-y-1 border-t border-border pt-2 text-[11px]">
            {Object.entries(v41Overview.awaitingArchivalCounts).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <dt className="font-mono text-muted">{k}</dt>
                <dd className="font-mono font-medium">{Number(v).toLocaleString()}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* State 3: Failed / Retryable Archival Jobs */}
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">3. Failed / Retryable Jobs</h3>
            <span
              className={`badge text-[10px] ${
                v41Overview.failedOrHaltedBatches.length === 0
                  ? "badge-active"
                  : "badge-banned"
              }`}
            >
              {v41Overview.failedOrHaltedBatches.length} FAILED
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">
            Source rows remain 100% intact in Neon whenever a GitHub upload or checksum fails.
          </p>
          {v41Overview.failedOrHaltedBatches.length === 0 ? (
            <div className="mt-4 rounded-md bg-surface p-3 text-xs text-muted">
              Zero failed archival jobs. All GitHub synchronization pipelines are healthy.
            </div>
          ) : (
            <div className="mt-3 space-y-2 border-t border-border pt-2 text-xs">
              {v41Overview.failedOrHaltedBatches.map((fb) => (
                <div key={fb.id} className="rounded border border-border bg-surface p-2">
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="font-semibold">{fb.batchNumber}</span>
                    <span className="text-danger">{fb.stateMachineStatus}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {fb.datasetKey} ({fb.recordCount} rows) · Retries: {fb.retryCount}
                  </p>
                  {fb.lastError && (
                    <p className="mt-1 text-[11px] text-danger">{fb.lastError}</p>
                  )}
                  <RetryFailedArchiveBatchButton batchId={fb.id} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* State 4: Operational Records in Neon */}
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">4. Operational State in Neon</h3>
            <span className="badge badge-active text-[10px]">HOT / ACTIVE</span>
          </div>
          <p className="mt-1 text-xs text-muted">
            Authoritative live balances, active contracts/orders, and hot (&lt;24h) activity.
          </p>
          <dl className="mt-3 space-y-1 border-t border-border pt-2 text-[11px]">
            <div className="flex justify-between">
              <dt className="text-muted">Registered Users (Balances &amp; Auth)</dt>
              <dd className="font-mono font-medium">
                {v41Overview.neonOperationalCounts.registeredUsers.toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Approved Companies</dt>
              <dd className="font-mono font-medium">
                {v41Overview.neonOperationalCounts.approvedCompanies.toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Open Long/Short Market Positions</dt>
              <dd className="font-mono font-medium">
                {v41Overview.neonOperationalCounts.openMarketPositions.toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Active Loans</dt>
              <dd className="font-mono font-medium">
                {v41Overview.neonOperationalCounts.activeLoans.toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Pending Invoices</dt>
              <dd className="font-mono font-medium">
                {v41Overview.neonOperationalCounts.pendingInvoices.toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Open Contracts</dt>
              <dd className="font-mono font-medium">
                {v41Overview.neonOperationalCounts.openContracts.toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Active Marketplace Listings</dt>
              <dd className="font-mono font-medium">
                {v41Overview.neonOperationalCounts.activeMarketplaceListings.toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Open Marketplace Orders</dt>
              <dd className="font-mono font-medium">
                {v41Overview.neonOperationalCounts.openMarketplaceOrders.toLocaleString()}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* 3. Core Accounting Preservation */}
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

      {/* 4. Download All Bundle & Individual Category Archive Generator */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="font-medium">
            Download All Categories — Unified Multi-Dataset .zip Bundle
          </h2>
          <p className="mt-1 mb-4 text-xs text-muted">
            Packages all 11 historical datasets (both live Neon records and records already
            archived to the 5 GitHub repositories) into a single verified{" "}
            <span className="font-mono">.zip</span> archive with{" "}
            <span className="font-mono">manifest.json</span>, per-category JSON/CSV/JSONL files,
            and <span className="font-mono">accounting-snapshot.json</span>.
          </p>
          <DownloadAllArchiveBundleForm />
        </section>

        <section className="card p-5">
          <h2 className="font-medium">
            Generate Category-Specific Verified .zip &amp; Push to GitHub
          </h2>
          <p className="mt-1 mb-4 text-xs text-muted">
            Select any of the 11 datasets and optional date range to build a category{" "}
            <span className="font-mono">.zip</span> archive and push its{" "}
            <span className="font-mono">.jsonl</span> + manifest to its mapped GitHub repository.
          </p>
          <CreateArchiveBatchForm />
        </section>
      </div>

      {/* 5. Archive Batches List */}
      <section className="card p-5">
        <h2 className="mb-3 font-medium">
          Archive Batches, Remote GitHub Commits, Verification &amp; Safe Clearing ({batches.length})
        </h2>
        {batches.length === 0 ? (
          <p className="text-sm text-muted">
            No archive batches have been generated yet.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {batches.map((b) => {
              const mappedRepo =
                b.repoName ??
                (b.datasetKey in DATASET_TO_GITHUB_REPO
                  ? DATASET_TO_GITHUB_REPO[b.datasetKey as keyof typeof DATASET_TO_GITHUB_REPO]
                  : "aeros-archive-ledger");
              return (
                <div key={b.id} className="py-4 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-semibold">{b.batchNumber}</span>
                        <span className="rounded bg-surface px-2 py-0.5 font-mono text-xs">
                          {b.datasetKey}
                        </span>
                        <span className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-muted">
                          Repo: {mappedRepo} (Shard #{b.shardGeneration})
                        </span>
                        <span
                          className={`badge ${
                            b.status === "CLEARED" || b.status === "VERIFIED"
                              ? "badge-active"
                              : "badge-pending"
                          }`}
                        >
                          {b.status} · {b.stateMachineStatus}
                        </span>
                      </div>
                      <p className="text-xs text-muted">
                        Records: <strong>{b.recordCount.toLocaleString()}</strong> · Size:{" "}
                        <strong>{formatBytes(b.byteSize)}</strong> · Cutoff:{" "}
                        {formatDateTime(b.cutoffDate)}
                      </p>
                      <p className="text-xs text-muted">
                        SHA-256: <span className="font-mono">{b.sha256Checksum}</span>
                        {b.verifiedRemoteSha256 ? (
                          <span className="ml-2 text-success">
                            ✓ Remote GitHub SHA-256 Verified
                          </span>
                        ) : null}
                      </p>
                      {b.remoteBatchPath && (
                        <p className="font-mono text-[11px] text-muted">
                          GitHub Path: {b.remoteBatchPath}
                          {b.remoteCommitSha ? ` (Commit ${b.remoteCommitSha.slice(0, 10)})` : ""}
                        </p>
                      )}
                      <p className="text-xs text-muted">
                        Manifest Verification Token:{" "}
                        <span className="font-mono font-semibold text-foreground">
                          {b.verificationToken}
                        </span>
                      </p>
                      {b.lastError && (
                        <p className="text-xs text-danger">
                          Last Error (Retry #{b.retryCount}): {b.lastError}
                        </p>
                      )}
                      <p className="text-[11px] text-muted">
                        Created {formatDateTime(b.createdAt)}
                        {b.downloadedAt ? ` · Downloaded ${formatDateTime(b.downloadedAt)}` : ""}
                        {b.verifiedAt ? ` · Verified ${formatDateTime(b.verifiedAt)}` : ""}
                        {b.clearedAt
                          ? ` · Cleared ${(b.clearedRecordCount ?? 0).toLocaleString()} rows at ${formatDateTime(b.clearedAt)}`
                          : ""}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={`/api/gov/archive/${b.id}`}
                        className="btn btn-primary text-xs"
                      >
                        Download .zip ({formatBytes(b.byteSize)})
                      </a>
                    </div>
                  </div>

                  {(b.stateMachineStatus === "FAILED_RETRYABLE" ||
                    b.stateMachineStatus === "DEGRADED_HALTED") && (
                    <RetryFailedArchiveBatchButton batchId={b.id} />
                  )}

                  {b.status !== "VERIFIED" && b.status !== "CLEARED" && (
                    <VerifyArchiveBatchForm
                      batchId={b.id}
                      verificationTokenHint={b.verificationToken}
                    />
                  )}

                  {b.status === "VERIFIED" && !b.isDownloadAllBundle && (
                    <ClearArchiveBatchForm
                      batchId={b.id}
                      verificationToken={b.verificationToken}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 6. Immutable Accounting Checkpoints */}
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
