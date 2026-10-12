"use client";

import React from "react";
import { startManualGithubArchiveJobAction } from "@/actions/v5";
import { V5ActionForm } from "./action-feedback";
import { GITHUB_ARCHIVE_REPOS_V5, type GithubArchiveRepoKeyV5 } from "@/lib/constants";

export interface SerializedV5RepoStatus {
  repoKey: string;
  repoOwner?: string;
  baseRepoName: string;
  activeRepoName: string;
  shardGeneration: number;
  estimatedBytesUsed: number;
  warningThresholdBytes: number;
  hardLimitBytes: number;
  percentOfLimit: number;
  healthStatus: "NORMAL" | "WARNING" | "CRITICAL";
  nextContinuationRepoName: string;
  totalBatchesPushed: number;
  totalRecordsArchived: number;
  lastPushAt?: string | null;
  lastVerifiedAt?: string | null;
  lastError?: string | null;
}

export interface SerializedArchiveJobRun {
  id: string;
  jobNumber: string;
  status: string;
  currentPhase: string;
  batchesTotal: number;
  batchesCompleted: number;
  recordsProcessed: number;
  recordsVerified: number;
  recordsRetainedErrors: number;
  lastError: string | null;
  isLocked: boolean;
  startedAt: string;
  completedAt: string | null;
}

const JOB_STAGES = [
  "PREPARING",
  "READING",
  "BATCHING",
  "UPLOADING",
  "VERIFYING",
  "INTEGRITY_CHECK",
  "CLEANUP",
  "COMPLETED",
] as const;

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function GovArchiveV5Panel({
  repositories,
  recentJobs,
  warningCount,
  criticalCount,
  hasLiveCredentials = false,
}: {
  repositories: SerializedV5RepoStatus[];
  recentJobs: SerializedArchiveJobRun[];
  warningCount: number;
  criticalCount: number;
  hasLiveCredentials?: boolean;
}) {
  const latestJob = recentJobs[0] ?? null;

  return (
    <div className="space-y-6">
      {/* Manual "Start GitHub Archive" Durable Job Runner & Stage Progression Card */}
      <section className="card border-black/20 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded bg-black px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">
                Durable Archival Engine
              </span>
              <span className="rounded bg-surface px-2 py-0.5 text-[11px] font-semibold text-muted">
                15 Dedicated Private GitHub Repositories
              </span>
              <span className="rounded bg-surface px-2 py-0.5 text-[11px] font-semibold text-muted">
                900 MB Threshold &amp; Continuation Rollover
              </span>
            </div>
            <h2 className="mt-1.5 text-lg font-semibold">
              Manual &ldquo;Start GitHub Archive&rdquo; Control &amp; 24h Automatic Pipeline
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Triggers a durable, concurrency-locked archival job across all eligible datasets
              (&ge;24h old). Uploads deterministic <code className="font-mono">.jsonl</code>{" "}
              batches, verifies remote SHA-256 read-back checksums on GitHub, checks the monetary
              supply invariant, and only then prunes eligible historical rows from Neon.
            </p>
          </div>

          <V5ActionForm
            action={startManualGithubArchiveJobAction}
            operationKey="manual-v5-github-archive"
            operationTitle="Start GitHub Archive (15-Repo Pipeline)"
            processingDetail="Preparing -> Reading -> Batching -> Uploading -> Verifying SHA-256 -> Cleanup..."
            processingStatus="UPLOADING"
            className="shrink-0"
          >
            {(pending) => (
              <>
                <input type="hidden" name="olderThanHours" value="24" />
                <input type="hidden" name="autoClearPrunable" value="true" />
                <button
                  type="submit"
                  disabled={pending}
                  className="btn btn-primary font-semibold shadow-xs"
                >
                  {pending ? "Archiving & Verifying SHA-256..." : "▶ Start GitHub Archive"}
                </button>
              </>
            )}
          </V5ActionForm>
        </div>

        {/* Stage Progression Bar */}
        <div className="mt-4 rounded-xl border border-border bg-surface p-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold">
              Pipeline Stage Progression{" "}
              {latestJob ? `(${latestJob.jobNumber} · ${latestJob.status})` : "(Ready)"}
            </span>
            {latestJob && (
              <span className="font-mono text-[11px] text-muted">
                Uploaded: {latestJob.recordsProcessed} · SHA-256 Verified:{" "}
                {latestJob.recordsVerified} · Errors: {latestJob.recordsRetainedErrors}
              </span>
            )}
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-8">
            {JOB_STAGES.map((stage, idx) => {
              const phaseKey = (latestJob?.currentPhase ||
                latestJob?.status ||
                "") as (typeof JOB_STAGES)[number];
              const currentIdx = latestJob ? JOB_STAGES.indexOf(phaseKey) : -1;
              const isCompleted =
                latestJob?.status === "COMPLETED" ||
                latestJob?.currentPhase === "COMPLETED" ||
                (currentIdx >= 0 && idx < currentIdx);
              const isCurrent =
                latestJob !== null &&
                !isCompleted &&
                (latestJob.currentPhase === stage || latestJob.status === stage);

              return (
                <div
                  key={stage}
                  className={`rounded-lg border px-2 py-1.5 text-center text-[10px] font-bold ${
                    isCompleted
                      ? "border-emerald-300 bg-[#eaf7ee] text-[#146c2e]"
                      : isCurrent
                        ? "border-amber-400 bg-amber-100 text-amber-950"
                        : "border-border bg-white text-muted"
                  }`}
                >
                  {idx + 1}. {stage.replace("_", " ")}
                </div>
              );
            })}
          </div>

          {latestJob && (
            <p className="mt-2 text-xs text-muted">
              Latest status: <strong className="text-foreground">{latestJob.currentPhase}</strong>
              {latestJob.lastError ? (
                <span className="ml-2 text-danger">Error: {latestJob.lastError}</span>
              ) : null}
            </p>
          )}
        </div>
      </section>

      {/* 15 Private GitHub Archive Repositories & 900 MB Threshold Monitor */}
      <section className="card p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-semibold">
              15 Dedicated Private GitHub Archive Repositories (800 MB Warning / 900 MB Rollover)
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Includes dedicated repositories for <strong>Market Index</strong> (
              <code className="font-mono">aeros-archive-market-index</code>) and{" "}
              <strong>Trading Ledger</strong> (
              <code className="font-mono">aeros-archive-trading-ledger</code>). Pre-emptively rolls
              over to <code className="font-mono">&lt;repo&gt;-2</code>,{" "}
              <code className="font-mono">&lt;repo&gt;-3</code> at the 900 MB operating threshold.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="badge badge-active">
              {repositories.length - warningCount - criticalCount} Normal (&lt;800 MB)
            </span>
            {warningCount > 0 && (
              <span className="badge badge-suspended">{warningCount} Warning (&ge;800 MB)</span>
            )}
            {criticalCount > 0 && (
              <span className="badge badge-banned">{criticalCount} Critical (&ge;900 MB)</span>
            )}
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {repositories.map((repo) => {
            const meta =
              GITHUB_ARCHIVE_REPOS_V5[repo.repoKey as GithubArchiveRepoKeyV5] ?? null;
            const owner = repo.repoOwner || "ayushnani54-jpg";
            const githubUrl = `https://github.com/${owner}/${repo.activeRepoName}`;
            const headroomBytes = Math.max(0, repo.hardLimitBytes - repo.estimatedBytesUsed);

            return (
              <div
                key={repo.repoKey}
                className="flex flex-col justify-between rounded-xl border border-border bg-surface/60 p-3.5 text-xs"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <a
                        href={githubUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs font-bold text-foreground underline decoration-border hover:decoration-black"
                      >
                        {repo.activeRepoName} ↗
                      </a>
                      {repo.shardGeneration > 1 && (
                        <span className="ml-1.5 rounded bg-amber-200 px-1.5 py-0.5 font-mono text-[10px] font-bold text-amber-950">
                          Gen #{repo.shardGeneration}
                        </span>
                      )}
                    </div>
                    <span
                      className={`badge text-[10px] ${
                        repo.healthStatus === "NORMAL"
                          ? "badge-active"
                          : repo.healthStatus === "WARNING"
                            ? "badge-suspended"
                            : "badge-banned"
                      }`}
                    >
                      {repo.healthStatus}
                    </span>
                  </div>

                  {meta && (
                    <p className="mt-1 text-[11px] font-medium text-foreground">{meta.title}</p>
                  )}
                  {meta && (
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">
                      {meta.description}
                    </p>
                  )}
                  {meta && meta.datasets.length > 0 && (
                    <p className="mt-1 font-mono text-[10px] text-muted">
                      Dataset: {meta.datasets.join(", ")}
                    </p>
                  )}
                </div>

                <div className="mt-3 space-y-1.5 border-t border-border pt-2.5">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-muted">Storage vs 900 MB Cap:</span>
                    <span className="font-mono font-semibold">
                      {formatMb(repo.estimatedBytesUsed)} / 900.00 MB ({repo.percentOfLimit}%)
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                    <div
                      className={`h-full ${
                        repo.healthStatus === "CRITICAL"
                          ? "bg-[#b3261e]"
                          : repo.healthStatus === "WARNING"
                            ? "bg-[#8a5a00]"
                            : "bg-[#146c2e]"
                      }`}
                      style={{ width: `${Math.min(100, Math.max(2, repo.percentOfLimit))}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-muted">
                    <span>Headroom: {formatMb(headroomBytes)} free</span>
                    <span className="font-mono">Rollover: {repo.nextContinuationRepoName}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-muted">
                    <span>
                      Batches: <strong>{repo.totalBatchesPushed}</strong> · Records:{" "}
                      <strong>{repo.totalRecordsArchived.toLocaleString("en-IN")}</strong>
                    </span>
                    <span className="text-[10px]">
                      {repo.lastVerifiedAt
                        ? `Verified ${new Date(repo.lastVerifiedAt).toLocaleDateString()}`
                        : hasLiveCredentials
                          ? "Remote GitHub Ready"
                          : "Local Verified Store"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
