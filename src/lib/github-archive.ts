import "server-only";
import { createHash } from "crypto";
import {
  DATASET_TO_GITHUB_REPO,
  GITHUB_ARCHIVE_REPOS,
  GITHUB_ARCHIVE_REPO_KEYS,
  GITHUB_REPO_HARD_LIMIT_BYTES,
  GITHUB_REPO_WARNING_BYTES,
  type ArchiveDatasetKey,
  type GithubArchiveRepoKey,
  // --- V5 ---
  DATASET_TO_GITHUB_REPO_V5,
  GITHUB_ARCHIVE_REPOS_V5,
  GITHUB_ARCHIVE_REPO_KEYS_V5,
  GITHUB_V5_REPO_HARD_LIMIT_BYTES,
  GITHUB_V5_REPO_WARNING_BYTES,
  type GithubArchiveRepoKeyV5,
} from "./constants";

/**
 * AEROS PAY V4.1 — 5-REPOSITORY GITHUB PERMANENT HISTORICAL ARCHIVE CLIENT
 * ========================================================================
 *
 * Implements:
 * - Server-only GitHub Contents/Git Data API client for the 5 private archive
 *   repositories (`aeros-archive-ledger`, `aeros-archive-contracts`,
 *   `aeros-archive-market`, `aeros-archive-economy`, `aeros-archive-audit`).
 * - Partitioned immutable file paths:
 *     `batches/YYYY/MM/DD/<batchNumber>-<datasetKey>.jsonl`
 *     `manifests/YYYY/MM/DD/<batchNumber>-manifest.json`
 *     `index/YYYY-MM/<datasetKey>.json`
 *     `index/catalog.json`
 * - Remote read-back & SHA-256 verification before any Neon row can be cleared.
 * - Rate-limit inspection, exponential backoff, conflict retry on index updates,
 *   storage threshold monitoring (400 MB warning / 750 MB shard rotation), and
 *   injectable transport for deterministic failure-mode testing.
 */

export interface GithubArchiveEnvConfig {
  enabled: boolean;
  hasLiveCredentials: boolean;
  owner: string;
  branch: string;
  token: string;
  repos: Record<GithubArchiveRepoKey, string>;
}

export function getGithubArchiveEnvConfig(): GithubArchiveEnvConfig {
  const token = (process.env.GITHUB_ARCHIVE_TOKEN ?? "").trim();
  const explicitOwner = (process.env.GITHUB_ARCHIVE_OWNER ?? "").trim();
  const owner = explicitOwner || "ayushnani54-jpg";
  const branch = (process.env.GITHUB_ARCHIVE_BRANCH ?? "main").trim() || "main";
  const rawEnabled = (process.env.GITHUB_ARCHIVE_ENABLED ?? "true").trim().toLowerCase();
  const enabledFlag = rawEnabled !== "false" && rawEnabled !== "0";

  const repos: Record<GithubArchiveRepoKey, string> = {
    "aeros-archive-ledger":
      (process.env.GITHUB_REPO_LEDGER ?? "").trim() ||
      GITHUB_ARCHIVE_REPOS["aeros-archive-ledger"].defaultRepoName,
    "aeros-archive-contracts":
      (process.env.GITHUB_REPO_CONTRACTS ?? "").trim() ||
      GITHUB_ARCHIVE_REPOS["aeros-archive-contracts"].defaultRepoName,
    "aeros-archive-market":
      (process.env.GITHUB_REPO_MARKET ?? "").trim() ||
      GITHUB_ARCHIVE_REPOS["aeros-archive-market"].defaultRepoName,
    "aeros-archive-economy":
      (process.env.GITHUB_REPO_ECONOMY ?? "").trim() ||
      GITHUB_ARCHIVE_REPOS["aeros-archive-economy"].defaultRepoName,
    "aeros-archive-audit":
      (process.env.GITHUB_REPO_AUDIT ?? "").trim() ||
      GITHUB_ARCHIVE_REPOS["aeros-archive-audit"].defaultRepoName,
  };

  return {
    enabled: enabledFlag,
    hasLiveCredentials: Boolean(token && owner && enabledFlag),
    owner,
    branch,
    token,
    repos,
  };
}

export class GithubArchiveRemoteError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(message: string, statusCode = 500, retryable = true) {
    super(message);
    this.name = "GithubArchiveRemoteError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export interface GithubPutFileParams {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  contentUtf8: string;
  commitMessage: string;
  expectedBlobSha?: string | null;
}

export interface GithubPutFileResult {
  commitSha: string;
  blobSha: string;
  byteSize: number;
}

export interface GithubGetFileParams {
  owner: string;
  repo: string;
  branch: string;
  path: string;
}

export interface GithubGetFileResult {
  exists: boolean;
  contentUtf8: string | null;
  blobSha: string | null;
  byteSize: number;
}

export interface GithubRepoStatsResult {
  sizeKb: number;
  estimatedBytes: number;
  rateLimitRemaining: number | null;
}

export interface GithubArchiveTransport {
  putFile(params: GithubPutFileParams): Promise<GithubPutFileResult>;
  getFile(params: GithubGetFileParams): Promise<GithubGetFileResult>;
  getRepoStats(params: { owner: string; repo: string }): Promise<GithubRepoStatsResult>;
}

// ---------------------------------------------------------------------------
// Built-in In-Memory / Local Verified Fallback Transport
// ---------------------------------------------------------------------------
// When `GITHUB_ARCHIVE_TOKEN` is not set in local development or CI, this
// deterministic store emulates the GitHub Contents API with full blob SHAs,
// commit SHAs, conflict detection, and read-back verification so the 12-step
// state machine runs identically in local/test environments.
const localRepoFiles = new Map<
  string,
  { contentUtf8: string; blobSha: string; commitSha: string; updatedAt: number }
>();

function computeGitBlobSha(contentUtf8: string): string {
  const buf = Buffer.from(contentUtf8, "utf8");
  return createHash("sha256")
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest("hex")
    .slice(0, 40);
}

const localFallbackTransport: GithubArchiveTransport = {
  async putFile(params: GithubPutFileParams): Promise<GithubPutFileResult> {
    const key = `${params.owner}/${params.repo}/${params.branch}/${params.path}`;
    const existing = localRepoFiles.get(key);
    if (existing && params.expectedBlobSha && existing.blobSha !== params.expectedBlobSha) {
      throw new GithubArchiveRemoteError(
        `GitHub 409 Conflict on ${params.path}: blob SHA mismatch.`,
        409,
        true,
      );
    }
    const blobSha = computeGitBlobSha(params.contentUtf8);
    const commitSha = createHash("sha256")
      .update(`${key}:${blobSha}:${params.commitMessage}:${Date.now()}`)
      .digest("hex")
      .slice(0, 40);
    localRepoFiles.set(key, {
      contentUtf8: params.contentUtf8,
      blobSha,
      commitSha,
      updatedAt: Date.now(),
    });
    return {
      commitSha,
      blobSha,
      byteSize: Buffer.byteLength(params.contentUtf8, "utf8"),
    };
  },

  async getFile(params: GithubGetFileParams): Promise<GithubGetFileResult> {
    const key = `${params.owner}/${params.repo}/${params.branch}/${params.path}`;
    const existing = localRepoFiles.get(key);
    if (!existing) {
      return { exists: false, contentUtf8: null, blobSha: null, byteSize: 0 };
    }
    return {
      exists: true,
      contentUtf8: existing.contentUtf8,
      blobSha: existing.blobSha,
      byteSize: Buffer.byteLength(existing.contentUtf8, "utf8"),
    };
  },

  async getRepoStats(params: { owner: string; repo: string }): Promise<GithubRepoStatsResult> {
    const prefix = `${params.owner}/${params.repo}/`;
    let totalBytes = 0;
    for (const [k, v] of localRepoFiles.entries()) {
      if (k.startsWith(prefix)) {
        totalBytes += Buffer.byteLength(v.contentUtf8, "utf8");
      }
    }
    return {
      sizeKb: Math.ceil(totalBytes / 1024),
      estimatedBytes: totalBytes,
      rateLimitRemaining: 5000,
    };
  },
};

// ---------------------------------------------------------------------------
// Live GitHub REST API v3 Transport
// ---------------------------------------------------------------------------
function createLiveGithubTransport(token: string): GithubArchiveTransport {
  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "AerosPay-V4.1-Archiver",
  };

  return {
    async getFile(params: GithubGetFileParams): Promise<GithubGetFileResult> {
      const encodedPath = params.path
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      const url = `https://api.github.com/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(params.branch)}`;

      const res = await fetch(url, {
        method: "GET",
        headers: baseHeaders,
        cache: "no-store",
      });

      if (res.status === 404) {
        return { exists: false, contentUtf8: null, blobSha: null, byteSize: 0 };
      }

      if (res.status === 401 || res.status === 403) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        if (remaining === "0") {
          throw new GithubArchiveRemoteError(
            "GitHub API rate limit exhausted (403 x-ratelimit-remaining=0).",
            429,
            true,
          );
        }
        throw new GithubArchiveRemoteError(
          `GitHub authentication/authorization failed (${res.status}) reading ${params.repo}/${params.path}.`,
          res.status,
          false,
        );
      }

      if (res.status === 429 || res.status >= 500) {
        throw new GithubArchiveRemoteError(
          `GitHub temporary error (${res.status}) reading ${params.repo}/${params.path}.`,
          res.status,
          true,
        );
      }

      if (!res.ok) {
        throw new GithubArchiveRemoteError(
          `GitHub API error (${res.status}) reading ${params.repo}/${params.path}.`,
          res.status,
          false,
        );
      }

      let contentUtf8 = "";
      const json = (await res.json()) as {
        content?: string;
        encoding?: string;
        sha?: string;
        size?: number;
      };
      if (json.content) {
        const rawB64 = json.content.replace(/\s+/g, "");
        contentUtf8 = Buffer.from(rawB64, "base64").toString("utf8");
      } else {
        // Fallback for files > 1 MB where GitHub omits `content` from JSON: fetch raw text
        const rawRes = await fetch(url, {
          method: "GET",
          headers: {
            ...baseHeaders,
            Accept: "application/vnd.github.raw+json",
          },
          cache: "no-store",
        });
        if (rawRes.ok) {
          contentUtf8 = await rawRes.text();
        }
      }

      return {
        exists: true,
        contentUtf8,
        blobSha: json.sha ?? null,
        byteSize: json.size ?? Buffer.byteLength(contentUtf8, "utf8"),
      };
    },

    async putFile(params: GithubPutFileParams): Promise<GithubPutFileResult> {
      const encodedPath = params.path
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      const url = `https://api.github.com/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${encodedPath}`;

      // If caller didn't pass expectedBlobSha, check if file already exists for idempotency
      let existingSha = params.expectedBlobSha ?? null;
      if (!existingSha) {
        const current = await this.getFile({
          owner: params.owner,
          repo: params.repo,
          branch: params.branch,
          path: params.path,
        });
        if (current.exists) {
          existingSha = current.blobSha;
        }
      }

      const body: Record<string, string> = {
        message: params.commitMessage,
        content: Buffer.from(params.contentUtf8, "utf8").toString("base64"),
        branch: params.branch,
      };
      if (existingSha) {
        body.sha = existingSha;
      }

      const res = await fetch(url, {
        method: "PUT",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });

      if (res.status === 401 || res.status === 403) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        if (remaining === "0") {
          throw new GithubArchiveRemoteError(
            "GitHub API rate limit exhausted during upload.",
            429,
            true,
          );
        }
        throw new GithubArchiveRemoteError(
          `GitHub authentication/permission error (${res.status}) writing to ${params.repo}/${params.path}.`,
          res.status,
          false,
        );
      }

      if (res.status === 409 || res.status === 429 || res.status >= 500) {
        throw new GithubArchiveRemoteError(
          `GitHub retryable status (${res.status}) writing to ${params.repo}/${params.path}.`,
          res.status,
          true,
        );
      }

      if (!res.ok) {
        throw new GithubArchiveRemoteError(
          `GitHub upload failed (${res.status}) for ${params.repo}/${params.path}.`,
          res.status,
          false,
        );
      }

      const json = (await res.json()) as {
        content?: { sha?: string; size?: number };
        commit?: { sha?: string };
      };

      return {
        commitSha: json.commit?.sha ?? computeGitBlobSha(params.contentUtf8),
        blobSha: json.content?.sha ?? computeGitBlobSha(params.contentUtf8),
        byteSize: Buffer.byteLength(params.contentUtf8, "utf8"),
      };
    },

    async getRepoStats(params: { owner: string; repo: string }): Promise<GithubRepoStatsResult> {
      const url = `https://api.github.com/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: baseHeaders,
        cache: "no-store",
      });
      const remainingHeader = res.headers.get("x-ratelimit-remaining");
      const rateLimitRemaining = remainingHeader ? Number(remainingHeader) : null;
      if (!res.ok) {
        return { sizeKb: 0, estimatedBytes: 0, rateLimitRemaining };
      }
      const json = (await res.json()) as { size?: number };
      const sizeKb = json.size ?? 0;
      return {
        sizeKb,
        estimatedBytes: sizeKb * 1024,
        rateLimitRemaining,
      };
    },
  };
}

let customTestTransport: GithubArchiveTransport | null = null;

/**
 * Allows automated tests (`scripts/test-v4-1.ts`) to inject a simulated GitHub
 * transport (e.g. to test 401/403 auth errors, 429 rate-limits, corrupt read-back
 * checksums, and network interruptions).
 */
export function setGithubArchiveTransportForTest(
  transport: GithubArchiveTransport | null,
): void {
  customTestTransport = transport;
}

export function getActiveGithubTransport(): GithubArchiveTransport {
  if (customTestTransport) return customTestTransport;
  const cfg = getGithubArchiveEnvConfig();
  if (cfg.hasLiveCredentials) {
    return createLiveGithubTransport(cfg.token);
  }
  return localFallbackTransport;
}

// ---------------------------------------------------------------------------
// Sanitization & JSONL / Partition Path Helpers
// ---------------------------------------------------------------------------

const FORBIDDEN_SECRET_KEYS = new Set([
  "passwordhash",
  "password_hash",
  "securitycodehash",
  "security_code_hash",
  "github_archive_token",
  "session_secret",
  "sessiontoken",
  "session_token",
  "cron_secret",
]);

/**
 * Recursively strips any credential or secret field so password hashes or tokens
 * can NEVER be written to a GitHub archive batch.
 */
export function sanitizeRecordForArchive<T>(record: T): T {
  if (record === null || record === undefined || typeof record !== "object") {
    return record;
  }
  if (record instanceof Date) {
    return record;
  }
  if (Array.isArray(record)) {
    return record.map((item) => sanitizeRecordForArchive(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEYS.has(k.toLowerCase())) {
      continue;
    }
    out[k] = sanitizeRecordForArchive(v);
  }
  return out as T;
}

export function serializeJsonl(records: Record<string, unknown>[]): string {
  if (records.length === 0) return "";
  return (
    records
      .map((r) => JSON.stringify(sanitizeRecordForArchive(r)))
      .join("\n") + "\n"
  );
}

export function parseJsonl<T = Record<string, unknown>>(content: string): T[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function buildPartitionedRepoPaths(params: {
  batchNumber: string;
  datasetKey: ArchiveDatasetKey;
  referenceDate: Date;
  shardGeneration: number;
}): {
  repoKey: GithubArchiveRepoKey;
  shardPrefix: string;
  batchPath: string;
  manifestPath: string;
  monthlyIndexPath: string;
  catalogPath: string;
  yearMonth: string;
} {
  const repoKey = DATASET_TO_GITHUB_REPO[params.datasetKey];
  const yyyy = String(params.referenceDate.getUTCFullYear());
  const mm = String(params.referenceDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(params.referenceDate.getUTCDate()).padStart(2, "0");
  const yearMonth = `${yyyy}-${mm}`;

  const shardPrefix =
    params.shardGeneration > 1 ? `shards/s${params.shardGeneration}/` : "";
  const safeBatch = params.batchNumber.toLowerCase();

  return {
    repoKey,
    shardPrefix,
    batchPath: `${shardPrefix}batches/${yyyy}/${mm}/${dd}/${safeBatch}-${params.datasetKey}.jsonl`,
    manifestPath: `${shardPrefix}manifests/${yyyy}/${mm}/${dd}/${safeBatch}-manifest.json`,
    monthlyIndexPath: `${shardPrefix}index/${yearMonth}/${params.datasetKey}.json`,
    catalogPath: `${shardPrefix}index/catalog.json`,
    yearMonth,
  };
}

export interface MonthlyPartitionIndex {
  schemaVersion: string;
  repoKey: GithubArchiveRepoKey | GithubArchiveRepoKeyV5;
  datasetKey: string;
  yearMonth: string;
  shardGeneration: number;
  updatedAt: string;
  totalBatches: number;
  totalRecords: number;
  batches: Array<{
    batchNumber: string;
    batchPath: string;
    manifestPath: string;
    recordCount: number;
    jsonlSha256: string;
    zipSha256: string;
    periodStart: string | null;
    periodEnd: string | null;
    archivedAt: string;
    /** Compact lookup map of involved user/company/entity IDs in this batch for fast historical queries. */
    entityIds: string[];
  }>;
}

/**
 * Uploads the immutable `.jsonl` batch, immutable `-manifest.json`, updates the
 * partitioned monthly index (`index/YYYY-MM/<datasetKey>.json`) with optimistic
 * concurrency retry, and reads back the `.jsonl` file from GitHub to verify its
 * SHA-256 checksum matches `expectedJsonlSha256` byte-for-byte.
 */
export async function uploadAndVerifyGithubArchiveBatch(params: {
  datasetKey: ArchiveDatasetKey;
  batchNumber: string;
  shardGeneration: number;
  referenceDate: Date;
  jsonlContent: string;
  expectedJsonlSha256: string;
  zipSha256: string;
  manifestObject: Record<string, unknown>;
  recordCount: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  entityIds: string[];
}): Promise<{
  repoKey: GithubArchiveRepoKey;
  repoName: string;
  commitSha: string;
  batchPath: string;
  manifestPath: string;
  indexPath: string;
  verifiedRemoteSha256: string;
  bytesWritten: number;
}> {
  const cfg = getGithubArchiveEnvConfig();
  const cfgV5 = getGithubArchiveEnvConfigV5();
  const transport = getActiveGithubTransport();
  const paths = buildPartitionedRepoPaths({
    batchNumber: params.batchNumber,
    datasetKey: params.datasetKey,
    referenceDate: params.referenceDate,
    shardGeneration: params.shardGeneration,
  });

  const v5RepoKey =
    DATASET_TO_GITHUB_REPO_V5[params.datasetKey as keyof typeof DATASET_TO_GITHUB_REPO_V5];
  const repoName =
    customTestTransport === null && cfg.hasLiveCredentials && v5RepoKey
      ? cfgV5.repos[v5RepoKey]
      : cfg.repos[paths.repoKey];

  // Step A: Upload immutable .jsonl batch file
  const batchUpload = await transport.putFile({
    owner: cfg.owner,
    repo: repoName,
    branch: cfg.branch,
    path: paths.batchPath,
    contentUtf8: params.jsonlContent,
    commitMessage: `archive(${params.datasetKey}): batch ${params.batchNumber} (${params.recordCount} records)`,
  });

  // Step B: Upload immutable manifest JSON file
  const manifestUtf8 = JSON.stringify(params.manifestObject, null, 2) + "\n";
  await transport.putFile({
    owner: cfg.owner,
    repo: repoName,
    branch: cfg.branch,
    path: paths.manifestPath,
    contentUtf8: manifestUtf8,
    commitMessage: `manifest(${params.datasetKey}): ${params.batchNumber} [sha256:${params.expectedJsonlSha256.slice(0, 12)}]`,
  });

  // Step C: Update partitioned monthly index with conflict retry (up to 3 attempts)
  let indexUpdated = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const existingIndexFile = await transport.getFile({
        owner: cfg.owner,
        repo: repoName,
        branch: cfg.branch,
        path: paths.monthlyIndexPath,
      });

      let indexObj: MonthlyPartitionIndex;
      if (existingIndexFile.exists && existingIndexFile.contentUtf8) {
        indexObj = JSON.parse(existingIndexFile.contentUtf8) as MonthlyPartitionIndex;
      } else {
        indexObj = {
          schemaVersion: "V5.0",
          repoKey: paths.repoKey,
          datasetKey: params.datasetKey,
          yearMonth: paths.yearMonth,
          shardGeneration: params.shardGeneration,
          updatedAt: new Date().toISOString(),
          totalBatches: 0,
          totalRecords: 0,
          batches: [],
        };
      }

      // Idempotent upsert of this batch entry inside the monthly index
      const filteredBatches = indexObj.batches.filter(
        (b) => b.batchNumber !== params.batchNumber,
      );
      filteredBatches.push({
        batchNumber: params.batchNumber,
        batchPath: paths.batchPath,
        manifestPath: paths.manifestPath,
        recordCount: params.recordCount,
        jsonlSha256: params.expectedJsonlSha256,
        zipSha256: params.zipSha256,
        periodStart: params.periodStart ? params.periodStart.toISOString() : null,
        periodEnd: params.periodEnd ? params.periodEnd.toISOString() : null,
        archivedAt: new Date().toISOString(),
        entityIds: params.entityIds.slice(0, 200),
      });

      indexObj.batches = filteredBatches;
      indexObj.totalBatches = filteredBatches.length;
      indexObj.totalRecords = filteredBatches.reduce((acc, b) => acc + b.recordCount, 0);
      indexObj.updatedAt = new Date().toISOString();

      await transport.putFile({
        owner: cfg.owner,
        repo: repoName,
        branch: cfg.branch,
        path: paths.monthlyIndexPath,
        contentUtf8: JSON.stringify(indexObj, null, 2) + "\n",
        commitMessage: `index(${params.datasetKey}): register ${params.batchNumber} in ${paths.yearMonth}`,
        expectedBlobSha: existingIndexFile.blobSha,
      });
      indexUpdated = true;
      break;
    } catch (e) {
      if (e instanceof GithubArchiveRemoteError && e.statusCode === 409 && attempt < 3) {
        continue;
      }
      throw e;
    }
  }

  if (!indexUpdated) {
    throw new GithubArchiveRemoteError(
      `Could not update monthly index ${paths.monthlyIndexPath} after 3 attempts.`,
      409,
      true,
    );
  }

  // Step D: Remote Read-Back Verification (CRITICAL — never delete from Neon
  // unless remote file exists and its SHA-256 matches expectedJsonlSha256!)
  const remoteReadback = await transport.getFile({
    owner: cfg.owner,
    repo: repoName,
    branch: cfg.branch,
    path: paths.batchPath,
  });

  if (!remoteReadback.exists || remoteReadback.contentUtf8 === null) {
    throw new GithubArchiveRemoteError(
      `Remote read-back verification failed: ${paths.batchPath} was not found in ${repoName}.`,
      500,
      false,
    );
  }

  const actualRemoteSha256 = createHash("sha256")
    .update(Buffer.from(remoteReadback.contentUtf8, "utf8"))
    .digest("hex");

  if (actualRemoteSha256 !== params.expectedJsonlSha256) {
    throw new GithubArchiveRemoteError(
      `Remote SHA-256 mismatch for ${paths.batchPath}: expected ${params.expectedJsonlSha256}, got ${actualRemoteSha256}. Halting Neon deletion.`,
      500,
      false,
    );
  }

  return {
    repoKey: paths.repoKey,
    repoName,
    commitSha: batchUpload.commitSha,
    batchPath: paths.batchPath,
    manifestPath: paths.manifestPath,
    indexPath: paths.monthlyIndexPath,
    verifiedRemoteSha256: actualRemoteSha256,
    bytesWritten:
      Buffer.byteLength(params.jsonlContent, "utf8") +
      Buffer.byteLength(manifestUtf8, "utf8"),
  };
}

/**
 * Fetches archived JSONL records from a GitHub repository batch path (with
 * fallback to the local `archive_batches` ZIP/manifest payload if offline).
 */
export async function fetchArchivedBatchRecordsFromGithub<T = Record<string, unknown>>(params: {
  repoKey: GithubArchiveRepoKey;
  batchPath: string;
}): Promise<T[] | null> {
  try {
    const cfg = getGithubArchiveEnvConfig();
    const cfgV5 = getGithubArchiveEnvConfigV5();
    const transport = getActiveGithubTransport();
    const primaryRepoName =
      customTestTransport === null &&
      cfg.hasLiveCredentials &&
      params.repoKey === "aeros-archive-ledger"
        ? cfgV5.repos["aeros-archive-payments"]
        : cfg.repos[params.repoKey];
    let file = await transport.getFile({
      owner: cfg.owner,
      repo: primaryRepoName,
      branch: cfg.branch,
      path: params.batchPath,
    });
    if ((!file.exists || !file.contentUtf8) && primaryRepoName !== cfg.repos[params.repoKey]) {
      file = await transport.getFile({
        owner: cfg.owner,
        repo: cfg.repos[params.repoKey],
        branch: cfg.branch,
        path: params.batchPath,
      });
    }
    if (!file.exists || !file.contentUtf8) return null;
    return parseJsonl<T>(file.contentUtf8);
  } catch {
    return null;
  }
}

export function evaluateRepoStorageHealth(
  estimatedBytesUsed: number,
  warningBytes = GITHUB_REPO_WARNING_BYTES,
  hardLimitBytes = GITHUB_REPO_HARD_LIMIT_BYTES,
): "HEALTHY" | "WARNING_STORAGE" | "ROTATION_REQUIRED" {
  if (estimatedBytesUsed >= hardLimitBytes) return "ROTATION_REQUIRED";
  if (estimatedBytesUsed >= warningBytes) return "WARNING_STORAGE";
  return "HEALTHY";
}

// ---------------------------------------------------------------------------
// V5 — 15-Repository Helpers, 900 MB Threshold & Continuation Rotation
// ---------------------------------------------------------------------------

export function evaluateRepoStorageHealthV5(
  estimatedBytesUsed: number,
  warningBytes = GITHUB_V5_REPO_WARNING_BYTES,
  hardLimitBytes = GITHUB_V5_REPO_HARD_LIMIT_BYTES,
): "NORMAL" | "WARNING" | "CRITICAL" {
  if (estimatedBytesUsed >= hardLimitBytes) return "CRITICAL";
  if (estimatedBytesUsed >= warningBytes) return "WARNING";
  return "NORMAL";
}

export function getContinuationRepoName(baseRepoName: string, generation: number): string {
  if (generation <= 1) return baseRepoName;
  return `${baseRepoName}-${generation}`;
}

export function getGithubArchiveEnvConfigV5(): {
  enabled: boolean;
  hasLiveCredentials: boolean;
  owner: string;
  branch: string;
  token: string;
  repos: Record<GithubArchiveRepoKeyV5, string>;
} {
  const base = getGithubArchiveEnvConfig();
  const reposV5: Record<GithubArchiveRepoKeyV5, string> = {} as Record<GithubArchiveRepoKeyV5, string>;
  for (const k of GITHUB_ARCHIVE_REPO_KEYS_V5) {
    const meta = GITHUB_ARCHIVE_REPOS_V5[k];
    const defaultName = meta?.defaultRepoName ?? k;
    const envVar = meta?.envVarName ?? "";
    const override = envVar ? (process.env[envVar] ?? "").trim() : "";
    reposV5[k] = override || defaultName;
  }
  return {
    ...base,
    repos: reposV5,
  };
}

export async function createContinuationArchiveRepository(params: {
  repoKey: string;
  repoName: string;
  description?: string;
}): Promise<{ ok: boolean; repoName: string; error?: string }> {
  const cfg = getGithubArchiveEnvConfig();
  if (!cfg.hasLiveCredentials) {
    // When offline/local/test fallback, register safely in memory/db
    return { ok: true, repoName: params.repoName };
  }
  try {
    const url = "https://api.github.com/user/repos";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "AerosPay-V5-Archiver",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: params.repoName,
        private: true,
        description: params.description ?? `Aeros Pay V5 Historical Archive: ${params.repoKey}`,
        auto_init: true,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, repoName: params.repoName, error: `GitHub API error (${res.status}): ${errText}` };
    }
    return { ok: true, repoName: params.repoName };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Network error creating continuation repo";
    return { ok: false, repoName: params.repoName, error: message };
  }
}

export async function ensureV5RemoteRepositoriesProvisioned(): Promise<{
  checked: number;
  created: string[];
}> {
  const cfg = getGithubArchiveEnvConfigV5();
  if (!cfg.hasLiveCredentials) {
    return { checked: GITHUB_ARCHIVE_REPO_KEYS_V5.length, created: [] };
  }

  const created: string[] = [];
  const existingNames = new Set<string>();

  try {
    const listRes = await fetch(
      "https://api.github.com/user/repos?per_page=100&affiliation=owner",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "AerosPay-V5-Archiver",
        },
        cache: "no-store",
      },
    );
    if (listRes.ok) {
      const reposJson = (await listRes.json()) as Array<{ name?: string }>;
      for (const r of reposJson) {
        if (r.name) existingNames.add(r.name);
      }
    }
  } catch {
    // Fall back to individual checks if listing fails
  }

  for (const repoKey of GITHUB_ARCHIVE_REPO_KEYS_V5) {
    const repoName = cfg.repos[repoKey];
    if (existingNames.has(repoName)) {
      continue;
    }
    const meta = GITHUB_ARCHIVE_REPOS_V5[repoKey];
    try {
      const checkUrl = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(repoName)}`;
      const checkRes = await fetch(checkUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "AerosPay-V5-Archiver",
        },
        cache: "no-store",
      });

      if (checkRes.status === 404) {
        const res = await createContinuationArchiveRepository({
          repoKey,
          repoName,
          description: meta?.description ?? `Aeros Pay V5 Private Archive: ${repoKey}`,
        });
        if (res.ok) {
          created.push(repoName);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        } else if (res.error && res.error.includes("secondary rate limit")) {
          // Stop attempting further repository creations in this window if GitHub's hourly limit is reached
          break;
        }
      }
    } catch {
      // Best-effort pre-provisioning; individual batch uploads still verify & retry
    }
  }

  return { checked: GITHUB_ARCHIVE_REPO_KEYS_V5.length, created };
}

export async function uploadAndVerifyV5CategoryBatch(params: {
  datasetKey: string;
  repoKey: GithubArchiveRepoKeyV5;
  batchNumber: string;
  referenceDate: Date;
  rows: Record<string, unknown>[];
}): Promise<{
  verified: boolean;
  repoName: string;
  commitSha: string | null;
  bytesWritten: number;
  error?: string;
}> {
  if (params.rows.length === 0) {
    const cfg = getGithubArchiveEnvConfigV5();
    return {
      verified: true,
      repoName: cfg.repos[params.repoKey],
      commitSha: null,
      bytesWritten: 0,
    };
  }

  const cfg = getGithubArchiveEnvConfigV5();
  const transport = getActiveGithubTransport();
  const repoName = cfg.repos[params.repoKey];
  const yyyy = String(params.referenceDate.getUTCFullYear());
  const mm = String(params.referenceDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(params.referenceDate.getUTCDate()).padStart(2, "0");
  const safeBatch = params.batchNumber.toLowerCase();
  const batchPath = `batches/${yyyy}/${mm}/${dd}/${safeBatch}-${params.datasetKey}.jsonl`;
  const manifestPath = `manifests/${yyyy}/${mm}/${dd}/${safeBatch}-manifest.json`;

  const jsonlContent = serializeJsonl(params.rows);
  const expectedSha256 = createHash("sha256")
    .update(Buffer.from(jsonlContent, "utf8"))
    .digest("hex");

  try {
    const putBatch = await transport.putFile({
      owner: cfg.owner,
      repo: repoName,
      branch: cfg.branch,
      path: batchPath,
      contentUtf8: jsonlContent,
      commitMessage: `archive(${params.datasetKey}): batch ${params.batchNumber} (${params.rows.length} records)`,
    });

    const manifestContent =
      JSON.stringify(
        {
          schemaVersion: "V5.0",
          batchNumber: params.batchNumber,
          datasetKey: params.datasetKey,
          repoKey: params.repoKey,
          recordCount: params.rows.length,
          jsonlSha256: expectedSha256,
          archivedAt: params.referenceDate.toISOString(),
        },
        null,
        2,
      ) + "\n";

    await transport.putFile({
      owner: cfg.owner,
      repo: repoName,
      branch: cfg.branch,
      path: manifestPath,
      contentUtf8: manifestContent,
      commitMessage: `manifest(${params.datasetKey}): ${params.batchNumber} [sha256:${expectedSha256.slice(0, 12)}]`,
    });

    // Step C: Update partitioned monthly index
    const monthlyIndexPath = `index/${yyyy}-${mm}/${params.datasetKey}.json`;
    try {
      const existingIndexFile = await transport.getFile({
        owner: cfg.owner,
        repo: repoName,
        branch: cfg.branch,
        path: monthlyIndexPath,
      });

      let indexObj: MonthlyPartitionIndex;
      if (existingIndexFile.exists && existingIndexFile.contentUtf8) {
        indexObj = JSON.parse(existingIndexFile.contentUtf8) as MonthlyPartitionIndex;
      } else {
        indexObj = {
          schemaVersion: "V5.0",
          repoKey: params.repoKey,
          datasetKey: params.datasetKey as unknown as ArchiveDatasetKey,
          yearMonth: `${yyyy}-${mm}`,
          shardGeneration: 1,
          updatedAt: new Date().toISOString(),
          totalBatches: 0,
          totalRecords: 0,
          batches: [],
        };
      }

      const filteredBatches = indexObj.batches.filter(
        (b) => b.batchNumber !== params.batchNumber,
      );
      filteredBatches.push({
        batchNumber: params.batchNumber,
        batchPath,
        manifestPath,
        recordCount: params.rows.length,
        jsonlSha256: expectedSha256,
        zipSha256: expectedSha256,
        periodStart: params.referenceDate.toISOString(),
        periodEnd: params.referenceDate.toISOString(),
        archivedAt: new Date().toISOString(),
        entityIds: [],
      });

      indexObj.batches = filteredBatches;
      indexObj.totalBatches = filteredBatches.length;
      indexObj.totalRecords = filteredBatches.reduce((acc, b) => acc + b.recordCount, 0);
      indexObj.updatedAt = new Date().toISOString();

      await transport.putFile({
        owner: cfg.owner,
        repo: repoName,
        branch: cfg.branch,
        path: monthlyIndexPath,
        contentUtf8: JSON.stringify(indexObj, null, 2) + "\n",
        commitMessage: `index(${params.datasetKey}): register ${params.batchNumber} in ${yyyy}-${mm}`,
        expectedBlobSha: existingIndexFile.blobSha,
      });
    } catch {
      // Best-effort index registration
    }

    const readback = await transport.getFile({
      owner: cfg.owner,
      repo: repoName,
      branch: cfg.branch,
      path: batchPath,
    });

    if (!readback.exists || readback.contentUtf8 === null) {
      return {
        verified: false,
        repoName,
        commitSha: null,
        bytesWritten: 0,
        error: `Read-back missing for ${batchPath} in ${repoName}`,
      };
    }

    const actualSha256 = createHash("sha256")
      .update(Buffer.from(readback.contentUtf8, "utf8"))
      .digest("hex");

    if (actualSha256 !== expectedSha256) {
      return {
        verified: false,
        repoName,
        commitSha: null,
        bytesWritten: 0,
        error: `SHA-256 mismatch on ${batchPath}`,
      };
    }

    return {
      verified: true,
      repoName,
      commitSha: putBatch.commitSha,
      bytesWritten:
        Buffer.byteLength(jsonlContent, "utf8") + Buffer.byteLength(manifestContent, "utf8"),
    };
  } catch (err) {
    return {
      verified: false,
      repoName,
      commitSha: null,
      bytesWritten: 0,
      error: err instanceof Error ? err.message : "V5 category upload failed",
    };
  }
}

export {
  GITHUB_ARCHIVE_REPO_KEYS,
  GITHUB_ARCHIVE_REPOS,
  DATASET_TO_GITHUB_REPO,
  GITHUB_ARCHIVE_REPO_KEYS_V5,
  GITHUB_ARCHIVE_REPOS_V5,
  DATASET_TO_GITHUB_REPO_V5,
};

