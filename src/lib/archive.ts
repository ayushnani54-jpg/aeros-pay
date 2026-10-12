import "server-only";
import { createHash } from "crypto";
import { deflateRawSync, inflateRawSync } from "zlib";
import { db } from "@/db/client";
import {
  accountingCheckpoints,
  archiveBatches,
  archivedRecordLedger,
  archiveJobRuns,
  archiveRepositories,
  auditLogs,
  companies,
  companySaleListings,
  companySaleOffers,
  exchangePurchases,
  government,
  invoices,
  issuanceRequests,
  loanInstalments,
  loans,
  marketCandles,
  marketOrders,
  marketPositions,
  marketplaceContracts,
  marketplaceOffers,
  marketplaceOrders,
  refundRequests,
  retentionSettings,
  transactions,
  users,
  type AccountingCheckpoint,
  type ArchiveBatch,
  type ArchiveJobRun,
  type ArchiveRepository,
  type Transaction,
} from "@/db/schema";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { recordAudit } from "./audit";
import {
  ARCHIVE_CLEAR_CONFIRM_PHRASE,
  ARCHIVE_DATASET_KEYS,
  DATASET_TO_GITHUB_REPO,
  DEFAULT_GITHUB_ARCHIVE_MIN_AGE_HOURS,
  GITHUB_ARCHIVE_REPOS,
  GITHUB_ARCHIVE_REPO_KEYS,
  GITHUB_ARCHIVE_REPO_KEYS_V5,
  GITHUB_BATCH_MAX_RECORDS,
  GITHUB_REPO_HARD_LIMIT_BYTES,
  GITHUB_REPO_WARNING_BYTES,
  GITHUB_V5_REPO_HARD_LIMIT_BYTES,
  GITHUB_V5_REPO_WARNING_BYTES,
  type ArchiveDatasetKey,
  type GithubArchiveRepoKey,
} from "./constants";
import {
  createContinuationArchiveRepository,
  ensureV5RemoteRepositoriesProvisioned,
  evaluateRepoStorageHealth,
  evaluateRepoStorageHealthV5,
  fetchArchivedBatchRecordsFromGithub,
  getContinuationRepoName,
  getGithubArchiveEnvConfig,
  getGithubArchiveEnvConfigV5,
  GithubArchiveRemoteError,
  parseJsonl,
  sanitizeRecordForArchive,
  serializeJsonl,
  uploadAndVerifyGithubArchiveBatch,
} from "./github-archive";

/**
 * AEROS PAY V4 & V4.1 — ARCHIVE CENTER, 5-REPO GITHUB ARCHIVER & ACCOUNTING PRESERVATION
 * ======================================================================================
 *
 * Preserves all V4.0 Archive-Before-Clearing and Core Accounting Preservation guarantees
 * AND adds the V4.1 5-Repository GitHub Permanent Archive Architecture & 12-Step
 * Resumable 24-Hour Archival State Machine.
 */

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Deterministic ZIP Builder (Pure Node `zlib` + CRC32) & Reader
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  content: Buffer;
}

/**
 * Builds a deterministic standard `.zip` buffer from a list of files.
 */
export function buildDeterministicZip(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  const dosTime = (12 << 11) | (0 << 5) | 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const uncompressed = entry.content;
    const compressed = deflateRawSync(uncompressed, { level: 6 });
    const crc = crc32(uncompressed);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export function buildZipArchive(
  entries: Array<{ name: string; content: Buffer | string }>,
): Buffer {
  return buildDeterministicZip(
    entries.map((e) => ({
      name: e.name,
      content: typeof e.content === "string" ? Buffer.from(e.content, "utf8") : e.content,
    })),
  );
}

/**
 * Extracts all entries from a deterministic `.zip` buffer generated by `buildDeterministicZip`.
 */
export function extractDeterministicZipEntries(
  zipBuffer: Buffer,
): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  let pos = 0;
  while (pos + 30 <= zipBuffer.length) {
    const sig = zipBuffer.readUInt32LE(pos);
    if (sig !== 0x04034b50) break;
    const method = zipBuffer.readUInt16LE(pos + 8);
    const compSize = zipBuffer.readUInt32LE(pos + 18);
    const nameLen = zipBuffer.readUInt16LE(pos + 26);
    const extraLen = zipBuffer.readUInt16LE(pos + 28);
    const name = zipBuffer.subarray(pos + 30, pos + 30 + nameLen).toString("utf8");
    const dataStart = pos + 30 + nameLen + extraLen;
    const compData = zipBuffer.subarray(dataStart, dataStart + compSize);
    out[name] = method === 8 ? inflateRawSync(compData) : Buffer.from(compData);
    pos = dataStart + compSize;
  }
  return out;
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function deriveVerificationToken(batchNumber: string, sha256Checksum: string): string {
  const digest = sha256Hex(`${batchNumber}:${sha256Checksum}`).toUpperCase();
  return `VRF-${digest.slice(0, 12)}`;
}

function toCsvValue(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (val instanceof Date) return val.toISOString();
  const str = typeof val === "object" ? JSON.stringify(val) : String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function recordsToCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.join(",");
  const body = rows.map((r) => columns.map((c) => toCsvValue(r[c])).join(","));
  return [header, ...body].join("\n") + "\n";
}

async function nextArchiveBatchNumber(tx: Pick<typeof db, "execute">): Promise<string> {
  const res = await tx.execute<{ nextval: string }>(
    sql`SELECT nextval('archive_batch_number_seq') AS nextval`,
  );
  const seq = String(res.rows[0]?.nextval ?? "1").padStart(6, "0");
  return `ARC-${seq}`;
}

async function nextCheckpointNumber(tx: Pick<typeof db, "execute">): Promise<string> {
  const res = await tx.execute<{ nextval: string }>(
    sql`SELECT nextval('accounting_checkpoint_seq') AS nextval`,
  );
  const seq = String(res.rows[0]?.nextval ?? "1").padStart(6, "0");
  return `CHK-${seq}`;
}

// ---------------------------------------------------------------------------
// Ensure 5 Canonical GitHub Repositories Exist in `archive_repositories`
// ---------------------------------------------------------------------------

export async function ensureArchiveRepositoriesSeeded(): Promise<ArchiveRepository[]> {
  const cfg = getGithubArchiveEnvConfig();
  for (const repoKey of GITHUB_ARCHIVE_REPO_KEYS) {
    const repoName = cfg.repos[repoKey];
    await db
      .insert(archiveRepositories)
      .values({
        repoKey,
        repoOwner: cfg.owner,
        repoName,
        branch: cfg.branch,
        shardGeneration: 1,
        warningThresholdBytes: GITHUB_REPO_WARNING_BYTES,
        hardLimitBytes: GITHUB_REPO_HARD_LIMIT_BYTES,
        healthStatus: cfg.hasLiveCredentials ? "HEALTHY" : "HEALTHY",
      })
      .onConflictDoNothing();
  }
  return db.select().from(archiveRepositories).orderBy(asc(archiveRepositories.repoKey));
}

// ---------------------------------------------------------------------------
// Protected Ledger Reference Discovery (Category A & B Protection)
// ---------------------------------------------------------------------------

/**
 * Collects every `tx_ref` and `transaction.id` that is anchored by another
 * reconciliation-verified table (`issuance_requests`, `invoices`, `company_loans`,
 * `company_loan_instalments`, `company_sale_listings`, `company_sale_offers`,
 * `marketplace_contracts`, `exchange_purchases`, `refund_requests`, or a
 * reversal chain).
 *
 * Any transaction row in this set is Category A/B and is NEVER eligible for
 * deletion from `transactions` while its anchor row remains in Neon.
 */
async function getProtectedTransactionRefs(txOrDb: typeof db | Tx = db): Promise<{
  protectedTxRefs: Set<string>;
  protectedTxIds: Set<string>;
}> {
  const [
    issuanceRows,
    invoiceRows,
    loanRows,
    instalmentRows,
    saleListingRows,
    saleOfferRows,
    contractRows,
    exchangeRows,
    refundRows,
    reversalRows,
  ] = await Promise.all([
    txOrDb
      .select({ ref: issuanceRequests.executedTxRef })
      .from(issuanceRequests)
      .where(sql`${issuanceRequests.executedTxRef} IS NOT NULL`),
    txOrDb
      .select({ ref: invoices.paidTxRef })
      .from(invoices)
      .where(sql`${invoices.paidTxRef} IS NOT NULL`),
    txOrDb
      .select({ ref: loans.disbursementTxRef })
      .from(loans)
      .where(sql`${loans.disbursementTxRef} IS NOT NULL`),
    txOrDb
      .select({ ref: loanInstalments.paidTxRef })
      .from(loanInstalments)
      .where(sql`${loanInstalments.paidTxRef} IS NOT NULL`),
    txOrDb
      .select({ ref: companySaleListings.soldTxRef })
      .from(companySaleListings)
      .where(sql`${companySaleListings.soldTxRef} IS NOT NULL`),
    txOrDb
      .select({ ref: companySaleOffers.settledTxRef })
      .from(companySaleOffers)
      .where(sql`${companySaleOffers.settledTxRef} IS NOT NULL`),
    txOrDb
      .select({ ref: marketplaceContracts.paidTxRef })
      .from(marketplaceContracts)
      .where(sql`${marketplaceContracts.paidTxRef} IS NOT NULL`),
    txOrDb
      .select({ ref: exchangePurchases.creditedTxRef })
      .from(exchangePurchases)
      .where(sql`${exchangePurchases.creditedTxRef} IS NOT NULL`),
    txOrDb
      .select({
        sourceRef: refundRequests.sourceTxRef,
        settleRef: refundRequests.settlementTxRef,
      })
      .from(refundRequests),
    txOrDb
      .select({
        id: transactions.id,
        reversesId: transactions.reversesTransactionId,
      })
      .from(transactions)
      .where(sql`${transactions.reversesTransactionId} IS NOT NULL`),
  ]);

  const protectedTxRefs = new Set<string>();
  const addRef = (r: string | null | undefined) => {
    if (r) protectedTxRefs.add(r);
  };

  issuanceRows.forEach((r) => addRef(r.ref));
  invoiceRows.forEach((r) => addRef(r.ref));
  loanRows.forEach((r) => addRef(r.ref));
  instalmentRows.forEach((r) => addRef(r.ref));
  saleListingRows.forEach((r) => addRef(r.ref));
  saleOfferRows.forEach((r) => addRef(r.ref));
  contractRows.forEach((r) => addRef(r.ref));
  exchangeRows.forEach((r) => addRef(r.ref));
  refundRows.forEach((r) => {
    addRef(r.sourceRef);
    addRef(r.settleRef);
  });

  const protectedTxIds = new Set<string>();
  reversalRows.forEach((r) => {
    protectedTxIds.add(r.id);
    if (r.reversesId) protectedTxIds.add(r.reversesId);
  });

  return { protectedTxRefs, protectedTxIds };
}

const ARCHIVABLE_TX_TYPES = [
  "TRANSFER",
  "GOVERNMENT_FUNDING",
  "ADMIN_ADJUSTMENT_CREDIT",
  "ADMIN_ADJUSTMENT_DEBIT",
  "COMPANY_FUNDING",
  "COMPANY_SALE",
  "COMPANY_PAYMENT",
  "GOVERNMENT_PAYMENT",
  "GOVERNMENT_RECEIPT",
  "COMPANY_ADJUSTMENT_CREDIT",
  "COMPANY_ADJUSTMENT_DEBIT",
  "GOVERNMENT_ON_BEHALF",
  "MARKET_TRADE_BUY",
  "MARKET_TRADE_SELL",
] as const;

export const CATEGORY_C_ELIGIBLE_TX_TYPES = ARCHIVABLE_TX_TYPES;

export async function getAccountingPreservationSnapshot(txOrDb: typeof db | Tx = db) {
  const [gov] = await txOrDb.select().from(government).limit(1);
  const [userSums] = await txOrDb
    .select({
      activeUserBalances: sql<number>`coalesce(sum(case when ${users.status} <> 'BANNED' then ${users.balance} else 0 end), 0)::int`,
      retiredBannedBalances: sql<number>`coalesce(sum(case when ${users.status} = 'BANNED' then ${users.balance} else 0 end), 0)::int`,
      archivedUserCredits: sql<number>`coalesce(sum(${users.archivedCredits}), 0)::int`,
      archivedUserDebits: sql<number>`coalesce(sum(${users.archivedDebits}), 0)::int`,
      archivedUserTxCount: sql<number>`coalesce(sum(${users.archivedTxCount}), 0)::int`,
    })
    .from(users);

  const [companySums] = await txOrDb
    .select({
      companyBalances: sql<number>`coalesce(sum(${companies.balance}), 0)::int`,
      archivedCompanyCredits: sql<number>`coalesce(sum(${companies.archivedCredits}), 0)::int`,
      archivedCompanyDebits: sql<number>`coalesce(sum(${companies.archivedDebits}), 0)::int`,
      archivedCompanySalesNet: sql<number>`coalesce(sum(${companies.archivedSalesNet}), 0)::int`,
    })
    .from(companies);

  const [checkpointSums] = await txOrDb
    .select({
      checkpointCount: count(),
      totalClearedTx: sql<number>`coalesce(sum(${accountingCheckpoints.clearedTxCount}), 0)::int`,
      totalGrossCleared: sql<number>`coalesce(sum(${accountingCheckpoints.grossVolumeCleared}), 0)::int`,
      totalTaxCleared: sql<number>`coalesce(sum(${accountingCheckpoints.taxVolumeCleared}), 0)::int`,
      totalNetCleared: sql<number>`coalesce(sum(${accountingCheckpoints.netVolumeCleared}), 0)::int`,
    })
    .from(accountingCheckpoints);

  const treasuryBalance = gov?.balance ?? 0;
  const totalSupply = gov?.totalSupply ?? 0;
  const retiredSupply = Math.max(
    gov?.retiredSupply ?? 0,
    userSums?.retiredBannedBalances ?? 0,
  );
  const userHeldBalance = userSums?.activeUserBalances ?? 0;
  const companyHeldBalance = companySums?.companyBalances ?? 0;
  const accounted =
    treasuryBalance + userHeldBalance + companyHeldBalance + retiredSupply;

  return {
    capturedAt: new Date().toISOString(),
    totalSupply,
    treasuryBalance,
    userHeldBalance,
    companyHeldBalance,
    retiredSupply,
    accounted,
    supplyBalanced: accounted === totalSupply,
    archivedTaxCollected: gov?.archivedTaxCollected ?? 0,
    archivedTreasuryCredits: gov?.archivedCredits ?? 0,
    archivedTreasuryDebits: gov?.archivedDebits ?? 0,
    archivedUserCredits: userSums?.archivedUserCredits ?? 0,
    archivedUserDebits: userSums?.archivedUserDebits ?? 0,
    archivedCompanyCredits: companySums?.archivedCompanyCredits ?? 0,
    archivedCompanyDebits: companySums?.archivedCompanyDebits ?? 0,
    archivedCompanySalesNet: companySums?.archivedCompanySalesNet ?? 0,
    checkpointCount: checkpointSums?.checkpointCount ?? 0,
    totalClearedTx: checkpointSums?.totalClearedTx ?? 0,
    totalGrossCleared: checkpointSums?.totalGrossCleared ?? 0,
    totalTaxCleared: checkpointSums?.totalTaxCleared ?? 0,
    totalNetCleared: checkpointSums?.totalNetCleared ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Dataset Selection & Eligibility Logic Across All 11 Datasets (5 GitHub Repos)
// ---------------------------------------------------------------------------

async function getAlreadyArchivedIdSet(
  txOrDb: typeof db | Tx,
  datasetKey: ArchiveDatasetKey,
): Promise<Set<string>> {
  const rows = await txOrDb
    .select({ recordId: archivedRecordLedger.recordId })
    .from(archivedRecordLedger)
    .where(eq(archivedRecordLedger.datasetKey, datasetKey));
  return new Set(rows.map((r) => r.recordId));
}

export interface DatasetSelectionResult {
  datasetKey: ArchiveDatasetKey;
  repoKey: GithubArchiveRepoKey;
  rows: Record<string, unknown>[];
  recordIds: string[];
  csvColumns: string[];
  periodStart: Date | null;
  periodEnd: Date | null;
  entityIds: string[];
  /** True when the rows in this dataset can be safely deleted from Neon after remote GitHub verification. */
  canPruneFromNeon: boolean;
}

export async function selectEligibleDatasetRecords(params: {
  txOrDb?: typeof db | Tx;
  datasetKey: ArchiveDatasetKey;
  cutoffDate: Date;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  excludeAlreadyArchived?: boolean;
  maxRecords?: number;
}): Promise<DatasetSelectionResult> {
  const txOrDb = params.txOrDb ?? db;
  const datasetKey = params.datasetKey;
  const repoKey = DATASET_TO_GITHUB_REPO[datasetKey];
  const maxRecords = params.maxRecords ?? GITHUB_BATCH_MAX_RECORDS;
  const effectiveUpperDate =
    params.dateTo && params.dateTo.getTime() < params.cutoffDate.getTime()
      ? params.dateTo
      : params.cutoffDate;

  const alreadyArchived = params.excludeAlreadyArchived
    ? await getAlreadyArchivedIdSet(txOrDb, datasetKey)
    : new Set<string>();

  const filterOutArchived = <T extends { id: string; createdAt?: Date }>(list: T[]): T[] => {
    return list
      .filter((item) => {
        if (alreadyArchived.has(String(item.id))) return false;
        if (params.dateFrom && item.createdAt && item.createdAt < params.dateFrom) return false;
        return true;
      })
      .slice(0, maxRecords);
  };

  if (datasetKey === "transactions_history") {
    const { protectedTxRefs, protectedTxIds } = await getProtectedTransactionRefs(txOrDb);
    const candidates = await txOrDb
      .select()
      .from(transactions)
      .where(
        and(
          lt(transactions.createdAt, effectiveUpperDate),
          isNull(transactions.invoiceId),
          isNull(transactions.reversesTransactionId),
          inArray(transactions.type, [...ARCHIVABLE_TX_TYPES]),
        ),
      )
      .orderBy(asc(transactions.createdAt), asc(transactions.id))
      .limit(maxRecords * 2);

    const eligible = filterOutArchived(
      candidates.filter(
        (r) => !protectedTxRefs.has(r.txRef) && !protectedTxIds.has(r.id),
      ),
    );
    const entityIds = Array.from(
      new Set(
        eligible
          .flatMap((r) => [r.senderId, r.receiverId, r.senderUsername, r.receiverUsername])
          .filter((x): x is string => Boolean(x)),
      ),
    );
    return {
      datasetKey,
      repoKey,
      rows: eligible as unknown as Record<string, unknown>[],
      recordIds: eligible.map((r) => r.id),
      csvColumns: [
        "id",
        "txRef",
        "type",
        "senderType",
        "senderId",
        "senderUsername",
        "receiverType",
        "receiverId",
        "receiverUsername",
        "grossAmount",
        "taxAmount",
        "netAmount",
        "taxRateBpApplied",
        "reason",
        "createdAt",
      ],
      periodStart: eligible[0]?.createdAt ?? null,
      periodEnd: eligible[eligible.length - 1]?.createdAt ?? null,
      entityIds,
      canPruneFromNeon: true,
    };
  }

  if (datasetKey === "settled_market_orders") {
    const candidates = await txOrDb
      .select()
      .from(marketOrders)
      .where(
        and(
          lt(marketOrders.createdAt, effectiveUpperDate),
          inArray(marketOrders.status, ["EXECUTED", "REJECTED", "CANCELLED"]),
        ),
      )
      .orderBy(asc(marketOrders.createdAt), asc(marketOrders.id))
      .limit(maxRecords * 2);
    const eligible = filterOutArchived(candidates);
    const entityIds = Array.from(new Set(eligible.map((r) => r.userId)));
    return {
      datasetKey,
      repoKey,
      rows: eligible as unknown as Record<string, unknown>[],
      recordIds: eligible.map((r) => r.id),
      csvColumns: [
        "id",
        "orderNumber",
        "userId",
        "side",
        "quantity",
        "expectedPrice",
        "executionPrice",
        "totalAeros",
        "costBasisDelta",
        "realizedPnlDelta",
        "status",
        "txRef",
        "methodologyVersion",
        "createdAt",
      ],
      periodStart: eligible[0]?.createdAt ?? null,
      periodEnd: eligible[eligible.length - 1]?.createdAt ?? null,
      entityIds,
      canPruneFromNeon: true,
    };
  }

  if (datasetKey === "closed_refunds") {
    const candidates = await txOrDb
      .select()
      .from(refundRequests)
      .where(
        and(
          lt(refundRequests.createdAt, effectiveUpperDate),
          inArray(refundRequests.status, ["COMPLETED", "REJECTED"]),
        ),
      )
      .orderBy(asc(refundRequests.createdAt), asc(refundRequests.id))
      .limit(maxRecords * 2);
    const eligible = filterOutArchived(candidates);
    const entityIds = Array.from(new Set(eligible.map((r) => r.userId)));
    return {
      datasetKey,
      repoKey,
      rows: eligible as unknown as Record<string, unknown>[],
      recordIds: eligible.map((r) => r.id),
      csvColumns: [
        "id",
        "refundNumber",
        "userId",
        "refundType",
        "sourceTxRef",
        "exchangePurchaseId",
        "requestedAerosAmount",
        "approvedAerosAmount",
        "inrReferenceAmount",
        "reason",
        "status",
        "governmentDecisionNote",
        "settlementTxRef",
        "createdAt",
        "completedAt",
        "rejectedAt",
      ],
      periodStart: eligible[0]?.createdAt ?? null,
      periodEnd: eligible[eligible.length - 1]?.createdAt ?? null,
      entityIds,
      canPruneFromNeon: true,
    };
  }

  if (datasetKey === "old_market_candles") {
    const safetyMaxCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const candleCutoff =
      effectiveUpperDate.getTime() > safetyMaxCutoff.getTime()
        ? safetyMaxCutoff
        : effectiveUpperDate;
    const candidates = await txOrDb
      .select()
      .from(marketCandles)
      .where(lt(marketCandles.bucketStart, candleCutoff))
      .orderBy(asc(marketCandles.bucketStart), asc(marketCandles.id))
      .limit(maxRecords * 2);
    const eligible = candidates
      .filter((c) => !alreadyArchived.has(c.id))
      .slice(0, maxRecords);
    return {
      datasetKey,
      repoKey,
      rows: eligible as unknown as Record<string, unknown>[],
      recordIds: eligible.map((r) => r.id),
      csvColumns: [
        "id",
        "timeframe",
        "bucketStart",
        "openPrice",
        "highPrice",
        "lowPrice",
        "closePrice",
        "volumeUnits",
        "volumeAeros",
        "tradeCount",
        "buyUnits",
        "sellUnits",
        "isHighVolatility",
        "methodologyVersion",
        "createdAt",
      ],
      periodStart: eligible[0]?.bucketStart ?? null,
      periodEnd: eligible[eligible.length - 1]?.bucketStart ?? null,
      entityIds: [],
      canPruneFromNeon: true,
    };
  }

  if (datasetKey === "closed_exchange_purchases") {
    // Only archive purchases not currently referenced by an open refund request
    const linkedRefunds = await txOrDb
      .select({ pid: refundRequests.exchangePurchaseId })
      .from(refundRequests)
      .where(sql`${refundRequests.exchangePurchaseId} IS NOT NULL`);
    const linkedIds = new Set(linkedRefunds.map((r) => r.pid).filter(Boolean));

    const candidates = await txOrDb
      .select()
      .from(exchangePurchases)
      .where(
        and(
          lt(exchangePurchases.createdAt, effectiveUpperDate),
          inArray(exchangePurchases.status, ["CREDITED", "CANCELLED", "REFUNDED"]),
        ),
      )
      .orderBy(asc(exchangePurchases.createdAt), asc(exchangePurchases.id))
      .limit(maxRecords * 2);
    const eligible = filterOutArchived(candidates.filter((c) => !linkedIds.has(c.id)));
    const entityIds = Array.from(new Set(eligible.map((r) => r.userId)));
    return {
      datasetKey,
      repoKey,
      rows: eligible as unknown as Record<string, unknown>[],
      recordIds: eligible.map((r) => r.id),
      csvColumns: [
        "id",
        "purchaseNumber",
        "userId",
        "policyCodeSnapshot",
        "policyVersionSnapshot",
        "packageTitleSnapshot",
        "inrPriceSnapshot",
        "totalAerosSnapshot",
        "paymentMode",
        "status",
        "creditedTxRef",
        "createdAt",
        "creditedAt",
      ],
      periodStart: eligible[0]?.createdAt ?? null,
      periodEnd: eligible[eligible.length - 1]?.createdAt ?? null,
      entityIds,
      canPruneFromNeon: true,
    };
  }

  if (datasetKey === "settled_contracts") {
    const candidates = await txOrDb
      .select()
      .from(marketplaceContracts)
      .where(
        and(
          lt(marketplaceContracts.createdAt, effectiveUpperDate),
          inArray(marketplaceContracts.status, ["COMPLETED", "CANCELLED", "EXPIRED"]),
        ),
      )
      .orderBy(asc(marketplaceContracts.createdAt), asc(marketplaceContracts.id))
      .limit(maxRecords * 2);
    const eligible = filterOutArchived(candidates);
    const entityIds = Array.from(
      new Set(
        eligible
          .flatMap((r) => [r.issuerCompanyId, r.awardedToUserId, r.awardedToCompanyId])
          .filter((x): x is string => Boolean(x)),
      ),
    );
    return {
      datasetKey,
      repoKey,
      rows: eligible as unknown as Record<string, unknown>[],
      recordIds: eligible.map((r) => r.id),
      csvColumns: [
        "id",
        "contractNumber",
        "issuerType",
        "issuerCompanyId",
        "title",
        "budget",
        "status",
        "awardedToType",
        "awardedToUserId",
        "awardedToCompanyId",
        "paidTxRef",
        "createdAt",
        "closedAt",
      ],
      periodStart: eligible[0]?.createdAt ?? null,
      periodEnd: eligible[eligible.length - 1]?.createdAt ?? null,
      entityIds,
      // Terminal CANCELLED/EXPIRED contracts with no invoice reference can be pruned;
      // COMPLETED contracts with paid_tx_ref are archived to GitHub and kept as lightweight anchors
      canPruneFromNeon: false,
    };
  }

  if (datasetKey === "repaid_loans") {
    const candidates = await txOrDb
      .select()
      .from(loans)
      .where(
        and(
          lt(loans.createdAt, effectiveUpperDate),
          inArray(loans.status, ["PAID", "REJECTED", "CANCELLED"]),
        ),
      )
      .orderBy(asc(loans.createdAt), asc(loans.id))
      .limit(maxRecords * 2);
    const eligible = filterOutArchived(candidates);
    const entityIds = Array.from(new Set(eligible.map((r) => r.companyId)));
    return {
      datasetKey,
      repoKey,
      rows: eligible as unknown as Record<string, unknown>[],
      recordIds: eligible.map((r) => r.id),
      csvColumns: [
        "id",
        "loanNumber",
        "companyId",
        "principal",
        "interestRateBp",
        "totalInterest",
        "totalPayable",
        "instalmentCount",
        "status",
        "disbursementTxRef",
        "createdAt",
        "completedAt",
      ],
      periodStart: eligible[0]?.createdAt ?? null,
      periodEnd: eligible[eligible.length - 1]?.createdAt ?? null,
      entityIds,
      canPruneFromNeon: false,
    };
  }

  if (datasetKey === "settled_invoices") {
    const candidates = await txOrDb
      .select()
      .from(invoices)
      .where(
        and(
          lt(invoices.createdAt, effectiveUpperDate),
          inArray(invoices.status, ["PAID", "CANCELLED", "EXPIRED"]),
        ),
      )
      .orderBy(asc(invoices.createdAt), asc(invoices.id))
      .limit(maxRecords * 2);
    const eligible = filterOutArchived(candidates);
    const entityIds = Array.from(
      new Set(
        eligible
          .flatMap((r) => [r.companyId, r.buyerUserId, r.recipientCompanyId])
          .filter((x): x is string => Boolean(x)),
      ),
    );
    return {
      datasetKey,
      repoKey,
      rows: eligible as unknown as Record<string, unknown>[],
      recordIds: eligible.map((r) => r.id),
      csvColumns: [
        "id",
        "invoiceNumber",
        "companyId",
        "recipientType",
        "buyerUserId",
        "recipientCompanyId",
        "itemName",
        "quantity",
        "unitPrice",
        "subtotal",
        "taxAmount",
        "total",
        "status",
        "paidTxRef",
        "createdAt",
        "paidAt",
      ],
      periodStart: eligible[0]?.createdAt ?? null,
      periodEnd: eligible[eligible.length - 1]?.createdAt ?? null,
      entityIds,
      canPruneFromNeon: false,
    };
  }

  if (datasetKey === "completed_marketplace_orders") {
    const candidates = await txOrDb
      .select()
      .from(marketplaceOrders)
      .where(
        and(
          lt(marketplaceOrders.createdAt, effectiveUpperDate),
          inArray(marketplaceOrders.status, ["COMPLETED", "CANCELLED", "EXPIRED"]),
        ),
      )
      .orderBy(asc(marketplaceOrders.createdAt), asc(marketplaceOrders.id))
      .limit(maxRecords * 2);
    const eligible = filterOutArchived(candidates);
    const entityIds = Array.from(
      new Set(
        eligible
          .flatMap((r) => [r.sellerCompanyId, r.buyerUserId, r.buyerCompanyId])
          .filter((x): x is string => Boolean(x)),
      ),
    );
    return {
      datasetKey,
      repoKey,
      rows: eligible as unknown as Record<string, unknown>[],
      recordIds: eligible.map((r) => r.id),
      csvColumns: [
        "id",
        "orderNumber",
        "offerId",
        "sellerCompanyId",
        "buyerType",
        "buyerUserId",
        "buyerCompanyId",
        "itemTitleSnapshot",
        "quantity",
        "unitPrice",
        "subtotal",
        "taxAmount",
        "total",
        "status",
        "createdAt",
        "completedAt",
      ],
      periodStart: eligible[0]?.createdAt ?? null,
      periodEnd: eligible[eligible.length - 1]?.createdAt ?? null,
      entityIds,
      canPruneFromNeon: false,
    };
  }

  if (datasetKey === "closed_company_sales") {
    const candidates = await txOrDb
      .select()
      .from(companySaleListings)
      .where(
        and(
          lt(companySaleListings.createdAt, effectiveUpperDate),
          inArray(companySaleListings.status, ["SOLD", "CANCELLED"]),
        ),
      )
      .orderBy(asc(companySaleListings.createdAt), asc(companySaleListings.id))
      .limit(maxRecords * 2);
    const eligible = filterOutArchived(candidates);
    const entityIds = Array.from(
      new Set(
        eligible
          .flatMap((r) => [r.companyId, r.sellerUserId, r.buyerUserId])
          .filter((x): x is string => Boolean(x)),
      ),
    );
    return {
      datasetKey,
      repoKey,
      rows: eligible as unknown as Record<string, unknown>[],
      recordIds: eligible.map((r) => r.id),
      csvColumns: [
        "id",
        "companyId",
        "sellerUserId",
        "salesFigure",
        "multiplierBp",
        "valuation",
        "status",
        "buyerUserId",
        "salePrice",
        "soldTxRef",
        "createdAt",
        "soldAt",
      ],
      periodStart: eligible[0]?.createdAt ?? null,
      periodEnd: eligible[eligible.length - 1]?.createdAt ?? null,
      entityIds,
      canPruneFromNeon: false,
    };
  }

  // audit_logs_history
  const candidates = await txOrDb
    .select()
    .from(auditLogs)
    .where(lt(auditLogs.createdAt, effectiveUpperDate))
    .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
    .limit(maxRecords * 2);
  const eligible = filterOutArchived(candidates);
  const entityIds = Array.from(
    new Set(
      eligible
        .flatMap((r) => [r.actorId, r.targetId])
        .filter((x): x is string => Boolean(x)),
    ),
  );
  return {
    datasetKey: "audit_logs_history",
    repoKey: "aeros-archive-audit",
    rows: eligible as unknown as Record<string, unknown>[],
    recordIds: eligible.map((r) => r.id),
    csvColumns: [
      "id",
      "action",
      "actorType",
      "actorId",
      "actorLabel",
      "targetType",
      "targetId",
      "previousValue",
      "newValue",
      "reason",
      "createdAt",
    ],
    periodStart: eligible[0]?.createdAt ?? null,
    periodEnd: eligible[eligible.length - 1]?.createdAt ?? null,
    entityIds,
    canPruneFromNeon: true,
  };
}

/**
 * Preview counts of eligible historical rows across datasets (used by `/gov/archive`).
 */
export async function getArchiveEligibilityPreview(olderThanDays?: number) {
  const [settings] = await db.select().from(retentionSettings).limit(1);
  const txDays = olderThanDays ?? settings?.transactionHistoryRetentionDays ?? 1;
  const orderDays = olderThanDays ?? settings?.settledOrderHistoryRetentionDays ?? 1;
  const refundDays = olderThanDays ?? settings?.closedRefundRetentionDays ?? 1;
  const candleDays = Math.max(2, olderThanDays ?? settings?.marketCandleRetentionDays ?? 2);
  const default24hCutoff = new Date(
    Date.now() - DEFAULT_GITHUB_ARCHIVE_MIN_AGE_HOURS * 60 * 60 * 1000,
  );

  const txCutoff = new Date(Date.now() - txDays * 86_400_000);
  const orderCutoff = new Date(Date.now() - orderDays * 86_400_000);
  const refundCutoff = new Date(Date.now() - refundDays * 86_400_000);
  const candleCutoff = new Date(Date.now() - candleDays * 86_400_000);

  const [
    txSel,
    mktOrdSel,
    rfdSel,
    candleSel,
    exchSel,
    contractSel,
    loanSel,
    invSel,
    mpOrdSel,
    saleSel,
    auditSel,
  ] = await Promise.all([
    selectEligibleDatasetRecords({
      datasetKey: "transactions_history",
      cutoffDate: olderThanDays !== undefined ? txCutoff : default24hCutoff,
      excludeAlreadyArchived: true,
    }),
    selectEligibleDatasetRecords({
      datasetKey: "settled_market_orders",
      cutoffDate: olderThanDays !== undefined ? orderCutoff : default24hCutoff,
      excludeAlreadyArchived: true,
    }),
    selectEligibleDatasetRecords({
      datasetKey: "closed_refunds",
      cutoffDate: olderThanDays !== undefined ? refundCutoff : default24hCutoff,
      excludeAlreadyArchived: true,
    }),
    selectEligibleDatasetRecords({
      datasetKey: "old_market_candles",
      cutoffDate: candleCutoff,
      excludeAlreadyArchived: true,
    }),
    selectEligibleDatasetRecords({
      datasetKey: "closed_exchange_purchases",
      cutoffDate: default24hCutoff,
      excludeAlreadyArchived: true,
    }),
    selectEligibleDatasetRecords({
      datasetKey: "settled_contracts",
      cutoffDate: default24hCutoff,
      excludeAlreadyArchived: true,
    }),
    selectEligibleDatasetRecords({
      datasetKey: "repaid_loans",
      cutoffDate: default24hCutoff,
      excludeAlreadyArchived: true,
    }),
    selectEligibleDatasetRecords({
      datasetKey: "settled_invoices",
      cutoffDate: default24hCutoff,
      excludeAlreadyArchived: true,
    }),
    selectEligibleDatasetRecords({
      datasetKey: "completed_marketplace_orders",
      cutoffDate: default24hCutoff,
      excludeAlreadyArchived: true,
    }),
    selectEligibleDatasetRecords({
      datasetKey: "closed_company_sales",
      cutoffDate: default24hCutoff,
      excludeAlreadyArchived: true,
    }),
    selectEligibleDatasetRecords({
      datasetKey: "audit_logs_history",
      cutoffDate: default24hCutoff,
      excludeAlreadyArchived: true,
    }),
  ]);

  return {
    cutoffs: {
      transactions_history: txCutoff.toISOString(),
      settled_market_orders: orderCutoff.toISOString(),
      closed_refunds: refundCutoff.toISOString(),
      old_market_candles: candleCutoff.toISOString(),
      default24h: default24hCutoff.toISOString(),
    },
    eligibleCounts: {
      transactions_history: txSel.rows.length,
      settled_market_orders: mktOrdSel.rows.length,
      closed_refunds: rfdSel.rows.length,
      old_market_candles: candleSel.rows.length,
      closed_exchange_purchases: exchSel.rows.length,
      settled_contracts: contractSel.rows.length,
      repaid_loans: loanSel.rows.length,
      settled_invoices: invSel.rows.length,
      completed_marketplace_orders: mpOrdSel.rows.length,
      closed_company_sales: saleSel.rows.length,
      audit_logs_history: auditSel.rows.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Complete V4.1 Archive Center 4-State Overview (Spec §7)
// ---------------------------------------------------------------------------

export async function getArchiveCenterV41Overview() {
  const repos = await ensureArchiveRepositoriesSeeded();
  const githubEnv = getGithubArchiveEnvConfig();

  const [
    eligibility,
    activeUsersCount,
    activeCompaniesCount,
    openLoansCount,
    pendingInvoicesCount,
    openContractsCount,
    activeOffersCount,
    openMarketplaceOrdersCount,
    openPositionsCount,
    failedBatches,
  ] = await Promise.all([
    getArchiveEligibilityPreview(),
    db.select({ c: count() }).from(users),
    db.select({ c: count() }).from(companies).where(eq(companies.status, "APPROVED")),
    db
      .select({ c: count() })
      .from(loans)
      .where(inArray(loans.status, ["PENDING", "APPROVED", "ACTIVE", "RESTRUCTURED"])),
    db.select({ c: count() }).from(invoices).where(eq(invoices.status, "PENDING")),
    db
      .select({ c: count() })
      .from(marketplaceContracts)
      .where(inArray(marketplaceContracts.status, ["OPEN", "AWARDED"])),
    db
      .select({ c: count() })
      .from(marketplaceOffers)
      .where(eq(marketplaceOffers.status, "ACTIVE")),
    db
      .select({ c: count() })
      .from(marketplaceOrders)
      .where(
        inArray(marketplaceOrders.status, [
          "PENDING",
          "ACCEPTED",
          "WAITING_FOR_INVOICE",
          "PAYMENT_DUE",
          "PAID",
        ]),
      ),
    db
      .select({ c: count() })
      .from(marketPositions)
      .where(sql`${marketPositions.unitsHeld} > 0 OR ${marketPositions.shortUnitsHeld} > 0`),
    db
      .select()
      .from(archiveBatches)
      .where(
        inArray(archiveBatches.stateMachineStatus, ["FAILED_RETRYABLE", "DEGRADED_HALTED"]),
      )
      .orderBy(desc(archiveBatches.createdAt))
      .limit(20),
  ]);

  return {
    githubEnv: {
      enabled: githubEnv.enabled,
      hasLiveCredentials: githubEnv.hasLiveCredentials,
      owner: githubEnv.owner,
      branch: githubEnv.branch,
      modeLabel: githubEnv.hasLiveCredentials
        ? "LIVE GITHUB PRIVATE REPOSITORIES"
        : "LOCAL VERIFIED ARCHIVE STORE (Configure GITHUB_ARCHIVE_TOKEN for remote GitHub push)",
    },
    repositories: repos.map((r) => ({
      ...r,
      meta: GITHUB_ARCHIVE_REPOS[r.repoKey as GithubArchiveRepoKey],
      usagePercent: Math.min(
        100,
        Math.round((r.estimatedBytesUsed / Math.max(1, r.hardLimitBytes)) * 100),
      ),
    })),
    awaitingArchivalCounts: eligibility.eligibleCounts,
    failedOrHaltedBatches: failedBatches,
    neonOperationalCounts: {
      registeredUsers: activeUsersCount[0]?.c ?? 0,
      approvedCompanies: activeCompaniesCount[0]?.c ?? 0,
      activeLoans: openLoansCount[0]?.c ?? 0,
      pendingInvoices: pendingInvoicesCount[0]?.c ?? 0,
      openContracts: openContractsCount[0]?.c ?? 0,
      activeMarketplaceListings: activeOffersCount[0]?.c ?? 0,
      openMarketplaceOrders: openMarketplaceOrdersCount[0]?.c ?? 0,
      openMarketPositions: openPositionsCount[0]?.c ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Step 1: Generate Verified ZIP & Push to GitHub Archive Repository
// ---------------------------------------------------------------------------

export async function createArchiveBatch(params: {
  govId: string;
  govUsername: string;
  datasetKey: ArchiveDatasetKey;
  olderThanDays: number;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  pushToGithub?: boolean;
}): Promise<ArchiveBatch> {
  if (!Number.isInteger(params.olderThanDays) || params.olderThanDays < 0) {
    throw new ArchiveError("olderThanDays must be a non-negative whole number.");
  }

  const [gov] = await db.select().from(government).limit(1);
  if (!gov) throw new ArchiveError("Government account not initialized.");
  if (!gov.archiveCenterEnabled) {
    throw new ArchiveError("Archive Center is currently disabled by the Government.");
  }

  await ensureArchiveRepositoriesSeeded();

  const cutoffDate =
    params.olderThanDays === 0
      ? new Date(Date.now() + 60_000)
      : new Date(Date.now() - params.olderThanDays * 86_400_000);

  const selection = await selectEligibleDatasetRecords({
    datasetKey: params.datasetKey,
    cutoffDate,
    dateFrom: params.dateFrom ?? null,
    dateTo: params.dateTo ?? null,
    excludeAlreadyArchived: false,
  });

  if (selection.rows.length === 0) {
    throw new ArchiveError(
      `No eligible records found in '${params.datasetKey}' for cutoff ${cutoffDate.toISOString()}.`,
    );
  }

  const accountingSnapshot = await getAccountingPreservationSnapshot(db);
  if (!accountingSnapshot.supplyBalanced) {
    throw new ArchiveError(
      "Cannot generate archive while a supply discrepancy exists. Run reconciliation first.",
    );
  }

  const sanitizedRows = sanitizeRecordForArchive(selection.rows);
  const jsonlText = serializeJsonl(sanitizedRows);
  const jsonlBuf = Buffer.from(jsonlText, "utf8");
  const jsonlSha256 = sha256Hex(jsonlBuf);

  const dataJsonBuf = Buffer.from(JSON.stringify(sanitizedRows, null, 2), "utf8");
  const dataCsvBuf = Buffer.from(recordsToCsv(sanitizedRows, selection.csvColumns), "utf8");
  const accountingBuf = Buffer.from(JSON.stringify(accountingSnapshot, null, 2), "utf8");

  const dataJsonSha256 = sha256Hex(dataJsonBuf);
  const dataCsvSha256 = sha256Hex(dataCsvBuf);
  const accountingSha256 = sha256Hex(accountingBuf);

  const [repoRow] = await db
    .select()
    .from(archiveRepositories)
    .where(eq(archiveRepositories.repoKey, selection.repoKey))
    .limit(1);

  let activeShard = repoRow?.shardGeneration ?? 1;
  if (repoRow && repoRow.estimatedBytesUsed >= repoRow.hardLimitBytes) {
    activeShard = repoRow.shardGeneration + 1;
  }

  const batch = await db.transaction(async (tx: Tx) => {
    const batchNumber = await nextArchiveBatchNumber(tx);

    const manifest = {
      archiveVersion: "V4.1",
      schemaVersion: "0009",
      batchNumber,
      datasetKey: params.datasetKey,
      repoKey: selection.repoKey,
      shardGeneration: activeShard,
      generatedAt: new Date().toISOString(),
      generatedBy: params.govUsername,
      cutoffDate: cutoffDate.toISOString(),
      periodStart: selection.periodStart ? selection.periodStart.toISOString() : null,
      periodEnd: selection.periodEnd ? selection.periodEnd.toISOString() : null,
      recordCount: sanitizedRows.length,
      files: {
        [`data/${params.datasetKey}.jsonl`]: {
          byteSize: jsonlBuf.length,
          sha256: jsonlSha256,
        },
        [`data/${params.datasetKey}.json`]: {
          byteSize: dataJsonBuf.length,
          sha256: dataJsonSha256,
        },
        [`data/${params.datasetKey}.csv`]: {
          byteSize: dataCsvBuf.length,
          sha256: dataCsvSha256,
        },
        "accounting-snapshot.json": {
          byteSize: accountingBuf.length,
          sha256: accountingSha256,
        },
      },
      accountingSnapshot,
      // Keep a compact candle preview when archiving old_market_candles so chart zoom-out can read it directly
      ...(params.datasetKey === "old_market_candles"
        ? { archivedCandlesPreview: sanitizedRows.slice(-200) }
        : {}),
    };

    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    const zipBuffer = buildDeterministicZip([
      { name: "manifest.json", content: manifestBuf },
      { name: "accounting-snapshot.json", content: accountingBuf },
      { name: `data/${params.datasetKey}.jsonl`, content: jsonlBuf },
      { name: `data/${params.datasetKey}.json`, content: dataJsonBuf },
      { name: `data/${params.datasetKey}.csv`, content: dataCsvBuf },
    ]);

    const sha256Checksum = sha256Hex(zipBuffer);
    const verificationToken = deriveVerificationToken(batchNumber, sha256Checksum);

    const finalManifest = {
      ...manifest,
      zipSha256Checksum: sha256Checksum,
      jsonlSha256Checksum: jsonlSha256,
      verificationToken,
    };
    const finalManifestBuf = Buffer.from(JSON.stringify(finalManifest, null, 2), "utf8");
    const finalZipBuffer = buildDeterministicZip([
      { name: "manifest.json", content: finalManifestBuf },
      { name: "accounting-snapshot.json", content: accountingBuf },
      { name: `data/${params.datasetKey}.jsonl`, content: jsonlBuf },
      { name: `data/${params.datasetKey}.json`, content: dataJsonBuf },
      { name: `data/${params.datasetKey}.csv`, content: dataCsvBuf },
    ]);

    const finalSha256 = sha256Hex(finalZipBuffer);
    const finalToken = deriveVerificationToken(batchNumber, finalSha256);

    const [created] = await tx
      .insert(archiveBatches)
      .values({
        batchNumber,
        datasetKey: params.datasetKey,
        archiveVersion: "V4.1",
        schemaVersion: "0009",
        cutoffDate,
        periodStart: selection.periodStart,
        periodEnd: selection.periodEnd,
        recordCount: sanitizedRows.length,
        sha256Checksum: finalSha256,
        verificationToken: finalToken,
        manifestJson: {
          ...finalManifest,
          zipSha256Checksum: finalSha256,
          verificationToken: finalToken,
        },
        recordIdsJson: selection.recordIds,
        zipPayloadBase64: finalZipBuffer.toString("base64"),
        byteSize: finalZipBuffer.length,
        status: "CREATED",
        repoKey: selection.repoKey,
        repoName: repoRow?.repoName ?? selection.repoKey,
        shardGeneration: activeShard,
        stateMachineStatus: "UPLOADING",
        createdByGovId: params.govId,
      })
      .returning();

    await recordAudit(tx, {
      action: "ARCHIVE_BATCH_CREATED",
      actorType: "GOVERNMENT",
      actorId: params.govId,
      actorLabel: params.govUsername,
      targetType: "ARCHIVE_BATCH",
      targetId: created.id,
      newValue: `${batchNumber} (${params.datasetKey} -> ${selection.repoKey}, ${sanitizedRows.length} records, sha256=${finalSha256.slice(0, 16)}…)`,
      metadata: {
        batchNumber,
        datasetKey: params.datasetKey,
        repoKey: selection.repoKey,
        recordCount: sanitizedRows.length,
        byteSize: finalZipBuffer.length,
        sha256Checksum: finalSha256,
        jsonlSha256,
        verificationToken: finalToken,
      },
    });

    return created;
  });

  // Upload to GitHub & verify remote read-back (Step 7, 8, 9 of 12-step state machine)
  if (params.pushToGithub !== false) {
    try {
      const ghResult = await uploadAndVerifyGithubArchiveBatch({
        datasetKey: params.datasetKey,
        batchNumber: batch.batchNumber,
        shardGeneration: activeShard,
        referenceDate: selection.periodEnd ?? new Date(),
        jsonlContent: jsonlText,
        expectedJsonlSha256: jsonlSha256,
        zipSha256: batch.sha256Checksum,
        manifestObject: batch.manifestJson as Record<string, unknown>,
        recordCount: batch.recordCount,
        periodStart: selection.periodStart,
        periodEnd: selection.periodEnd,
        entityIds: selection.entityIds,
      });

      const now = new Date();
      const [updatedBatch] = await db
        .update(archiveBatches)
        .set({
          repoKey: ghResult.repoKey,
          repoName: ghResult.repoName,
          remoteCommitSha: ghResult.commitSha,
          remoteBatchPath: ghResult.batchPath,
          remoteManifestPath: ghResult.manifestPath,
          remoteIndexPath: ghResult.indexPath,
          verifiedRemoteSha256: ghResult.verifiedRemoteSha256,
          stateMachineStatus: "VERIFIED",
          lastError: null,
        })
        .where(eq(archiveBatches.id, batch.id))
        .returning();

      // Record in archived_record_ledger
      if (selection.recordIds.length > 0) {
        await db
          .insert(archivedRecordLedger)
          .values(
            selection.recordIds.map((rid) => ({
              datasetKey: params.datasetKey,
              recordId: rid,
              batchId: batch.id,
              repoKey: ghResult.repoKey,
              remoteBatchPath: ghResult.batchPath,
              recordCreatedAt: selection.periodEnd,
              archivedAt: now,
            })),
          )
          .onConflictDoNothing();
      }

      const nextBytes = (repoRow?.estimatedBytesUsed ?? 0) + ghResult.bytesWritten;
      const nextHealth = evaluateRepoStorageHealth(
        nextBytes,
        repoRow?.warningThresholdBytes ?? GITHUB_REPO_WARNING_BYTES,
        repoRow?.hardLimitBytes ?? GITHUB_REPO_HARD_LIMIT_BYTES,
      );

      await db
        .update(archiveRepositories)
        .set({
          shardGeneration: activeShard,
          estimatedBytesUsed: nextBytes,
          totalBatchesPushed: sql`${archiveRepositories.totalBatchesPushed} + 1`,
          totalRecordsArchived: sql`${archiveRepositories.totalRecordsArchived} + ${batch.recordCount}`,
          lastCommitSha: ghResult.commitSha,
          lastPushAt: now,
          lastVerifiedAt: now,
          healthStatus: nextHealth,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(archiveRepositories.repoKey, ghResult.repoKey));

      return updatedBatch;
    } catch (err) {
      const isRetryable =
        err instanceof GithubArchiveRemoteError ? err.retryable : true;
      const errMsg = err instanceof Error ? err.message : "GitHub upload failed.";
      const nextRetryAt = new Date(Date.now() + 15 * 60 * 1000);

      const [failedBatch] = await db
        .update(archiveBatches)
        .set({
          stateMachineStatus: isRetryable ? "FAILED_RETRYABLE" : "DEGRADED_HALTED",
          retryCount: sql`${archiveBatches.retryCount} + 1`,
          lastError: errMsg,
          nextRetryAt: isRetryable ? nextRetryAt : null,
        })
        .where(eq(archiveBatches.id, batch.id))
        .returning();

      await db
        .update(archiveRepositories)
        .set({
          healthStatus: "ERROR",
          lastError: errMsg,
          updatedAt: new Date(),
        })
        .where(eq(archiveRepositories.repoKey, selection.repoKey));

      return failedBatch;
    }
  }

  return batch;
}

/**
 * Generates a "Download All" multi-category `.zip` bundle across all datasets
 * that currently have records or selected categories, never silently omitting
 * any failing category (Spec §7).
 */
export async function createDownloadAllArchiveBundle(params: {
  govId: string;
  govUsername: string;
  olderThanDays?: number;
  categories?: ArchiveDatasetKey[];
}): Promise<ArchiveBatch> {
  const [gov] = await db.select().from(government).limit(1);
  if (!gov) throw new ArchiveError("Government account not initialized.");
  if (!gov.archiveCenterEnabled) {
    throw new ArchiveError("Archive Center is currently disabled by the Government.");
  }

  const targetCategories =
    params.categories && params.categories.length > 0
      ? params.categories
      : [...ARCHIVE_DATASET_KEYS];

  const days = params.olderThanDays ?? 0;
  const cutoffDate =
    days === 0
      ? new Date(Date.now() + 60_000)
      : new Date(Date.now() - days * 86_400_000);

  const accountingSnapshot = await getAccountingPreservationSnapshot(db);
  const zipEntries: ZipEntryInput[] = [];
  const categorySummaries: Record<
    string,
    {
      repoKey: string;
      recordCount: number;
      jsonlSha256: string;
      csvSha256: string;
      periodStart: string | null;
      periodEnd: string | null;
    }
  > = {};

  let totalRecords = 0;

  for (const cat of targetCategories) {
    const sel = await selectEligibleDatasetRecords({
      datasetKey: cat,
      cutoffDate,
      excludeAlreadyArchived: false,
      maxRecords: 1000,
    });
    const sanitized = sanitizeRecordForArchive(sel.rows);
    const jsonlBuf = Buffer.from(serializeJsonl(sanitized), "utf8");
    const jsonBuf = Buffer.from(JSON.stringify(sanitized, null, 2), "utf8");
    const csvBuf = Buffer.from(recordsToCsv(sanitized, sel.csvColumns), "utf8");

    zipEntries.push(
      { name: `${sel.repoKey}/${cat}.jsonl`, content: jsonlBuf },
      { name: `${sel.repoKey}/${cat}.json`, content: jsonBuf },
      { name: `${sel.repoKey}/${cat}.csv`, content: csvBuf },
    );

    categorySummaries[cat] = {
      repoKey: sel.repoKey,
      recordCount: sanitized.length,
      jsonlSha256: sha256Hex(jsonlBuf),
      csvSha256: sha256Hex(csvBuf),
      periodStart: sel.periodStart ? sel.periodStart.toISOString() : null,
      periodEnd: sel.periodEnd ? sel.periodEnd.toISOString() : null,
    };
    totalRecords += sanitized.length;
  }

  const accountingBuf = Buffer.from(JSON.stringify(accountingSnapshot, null, 2), "utf8");
  zipEntries.unshift({ name: "accounting-snapshot.json", content: accountingBuf });

  return db.transaction(async (tx: Tx) => {
    const batchNumber = await nextArchiveBatchNumber(tx);
    const manifest = {
      archiveVersion: "V4.1",
      schemaVersion: "0009",
      bundleType: "DOWNLOAD_ALL_MULTI_REPO",
      batchNumber,
      generatedAt: new Date().toISOString(),
      generatedBy: params.govUsername,
      cutoffDate: cutoffDate.toISOString(),
      totalRecords,
      categoriesIncluded: targetCategories,
      categorySummaries,
      accountingSnapshot,
    };

    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    const finalZip = buildDeterministicZip([
      { name: "manifest.json", content: manifestBuf },
      ...zipEntries,
    ]);
    const finalSha256 = sha256Hex(finalZip);
    const finalToken = deriveVerificationToken(batchNumber, finalSha256);

    const [created] = await tx
      .insert(archiveBatches)
      .values({
        batchNumber,
        datasetKey: "download_all_bundle",
        archiveVersion: "V4.1",
        schemaVersion: "0009",
        cutoffDate,
        periodStart: null,
        periodEnd: new Date(),
        recordCount: totalRecords,
        sha256Checksum: finalSha256,
        verificationToken: finalToken,
        manifestJson: {
          ...manifest,
          zipSha256Checksum: finalSha256,
          verificationToken: finalToken,
        },
        recordIdsJson: [],
        zipPayloadBase64: finalZip.toString("base64"),
        byteSize: finalZip.length,
        status: "VERIFIED",
        repoKey: "aeros-archive-ledger",
        repoName: "multi-repo-bundle",
        shardGeneration: 1,
        stateMachineStatus: "COMPLETED",
        isDownloadAllBundle: true,
        verifiedAt: new Date(),
        createdByGovId: params.govId,
      })
      .returning();

    await recordAudit(tx, {
      action: "ARCHIVE_DOWNLOAD_ALL_BUNDLE_CREATED",
      actorType: "GOVERNMENT",
      actorId: params.govId,
      actorLabel: params.govUsername,
      targetType: "ARCHIVE_BATCH",
      targetId: created.id,
      newValue: `${batchNumber}: ${targetCategories.length} categories, ${totalRecords} records`,
      metadata: {
        batchNumber,
        categoriesCount: targetCategories.length,
        totalRecords,
        byteSize: finalZip.length,
        sha256Checksum: finalSha256,
      },
    });

    return created;
  });
}

// ---------------------------------------------------------------------------
// Step 2: Verify Archive Batch Integrity
// ---------------------------------------------------------------------------

export async function verifyArchiveBatch(params: {
  govId: string;
  govUsername: string;
  batchId: string;
  verificationToken: string;
}): Promise<ArchiveBatch> {
  return db.transaction(async (tx: Tx) => {
    const [batch] = await tx
      .select()
      .from(archiveBatches)
      .where(eq(archiveBatches.id, params.batchId))
      .for("update");

    if (!batch) throw new ArchiveError("Archive batch not found.");
    if (batch.status === "CLEARED") {
      return batch;
    }

    const zipBuffer = Buffer.from(batch.zipPayloadBase64, "base64");
    const recomputedSha = sha256Hex(zipBuffer);
    if (recomputedSha !== batch.sha256Checksum) {
      throw new ArchiveError(
        "Archive payload checksum mismatch! Batch failed integrity verification and cannot be cleared.",
      );
    }

    const expectedToken = deriveVerificationToken(batch.batchNumber, batch.sha256Checksum);
    const normalizedInput = params.verificationToken.trim().toUpperCase();
    if (
      normalizedInput !== batch.verificationToken.toUpperCase() &&
      normalizedInput !== expectedToken &&
      normalizedInput !== batch.sha256Checksum.toUpperCase()
    ) {
      throw new ArchiveError(
        "Invalid verification token or SHA-256 checksum. Download and inspect manifest.json first.",
      );
    }

    const now = new Date();
    const [updated] = await tx
      .update(archiveBatches)
      .set({
        status: "VERIFIED",
        stateMachineStatus:
          batch.stateMachineStatus === "COMPLETED" ? "COMPLETED" : "VERIFIED",
        verifiedAt: now,
        downloadedAt: batch.downloadedAt ?? now,
      })
      .where(eq(archiveBatches.id, batch.id))
      .returning();

    await recordAudit(tx, {
      action: "ARCHIVE_BATCH_VERIFIED",
      actorType: "GOVERNMENT",
      actorId: params.govId,
      actorLabel: params.govUsername,
      targetType: "ARCHIVE_BATCH",
      targetId: batch.id,
      previousValue: batch.status,
      newValue: "VERIFIED",
      metadata: {
        batchNumber: batch.batchNumber,
        datasetKey: batch.datasetKey,
        sha256Checksum: batch.sha256Checksum,
      },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Step 3: Clear Verified Archive & Persist Immutable Accounting Checkpoint
// ---------------------------------------------------------------------------

export async function clearArchiveBatch(params: {
  govId: string;
  govUsername: string;
  batchId: string;
  verificationToken: string;
  confirmPhrase: string;
}): Promise<{
  batch: ArchiveBatch;
  clearedCount: number;
  checkpoint: AccountingCheckpoint | null;
}> {
  if (params.confirmPhrase.trim() !== ARCHIVE_CLEAR_CONFIRM_PHRASE) {
    throw new ArchiveError(
      `Confirmation phrase must be exactly "${ARCHIVE_CLEAR_CONFIRM_PHRASE}".`,
    );
  }

  const [gov] = await db.select().from(government).limit(1);
  if (!gov) throw new ArchiveError("Government account not initialized.");
  if (!gov.archiveCenterEnabled) {
    throw new ArchiveError("Archive Center is currently disabled by the Government.");
  }

  return db.transaction(async (tx: Tx) => {
    const [batch] = await tx
      .select()
      .from(archiveBatches)
      .where(eq(archiveBatches.id, params.batchId))
      .for("update");

    if (!batch) throw new ArchiveError("Archive batch not found.");
    if (batch.isDownloadAllBundle) {
      throw new ArchiveError(
        "Multi-category Download All bundles are read-only exports. Clear individual verified dataset batches instead.",
      );
    }
    if (batch.status === "CLEARED") {
      throw new ArchiveError("This archive batch has already been cleared.");
    }
    if (batch.status !== "VERIFIED" && batch.stateMachineStatus !== "VERIFIED") {
      throw new ArchiveError(
        "Archive batch must be VERIFIED before any records can be cleared.",
      );
    }
    if (
      batch.stateMachineStatus === "FAILED_RETRYABLE" ||
      batch.stateMachineStatus === "DEGRADED_HALTED"
    ) {
      throw new ArchiveError(
        `Cannot clear batch ${batch.batchNumber}: remote GitHub verification is in state ${batch.stateMachineStatus}.`,
      );
    }

    const normalizedToken = params.verificationToken.trim().toUpperCase();
    if (
      normalizedToken !== batch.verificationToken.toUpperCase() &&
      normalizedToken !== batch.sha256Checksum.toUpperCase()
    ) {
      throw new ArchiveError("Verification token does not match this archive batch.");
    }

    const zipBuffer = Buffer.from(batch.zipPayloadBase64, "base64");
    if (sha256Hex(zipBuffer) !== batch.sha256Checksum) {
      throw new ArchiveError("Archive ZIP checksum verification failed. Aborting clear.");
    }

    const recordIds = Array.isArray(batch.recordIdsJson)
      ? (batch.recordIdsJson as string[]).filter((x) => typeof x === "string")
      : [];

    if (recordIds.length === 0) {
      throw new ArchiveError("Archive batch contains no record IDs to clear.");
    }

    let clearedCount = 0;
    let createdCheckpoint: AccountingCheckpoint | null = null;
    const now = new Date();

    if (batch.datasetKey === "transactions_history") {
      const { protectedTxRefs, protectedTxIds } = await getProtectedTransactionRefs(tx);

      const rowsToClear = await tx
        .select()
        .from(transactions)
        .where(
          and(
            inArray(transactions.id, recordIds),
            isNull(transactions.invoiceId),
            isNull(transactions.reversesTransactionId),
            inArray(transactions.type, [...ARCHIVABLE_TX_TYPES]),
          ),
        )
        .for("update");

      const safeRows = rowsToClear.filter(
        (r) => !protectedTxRefs.has(r.txRef) && !protectedTxIds.has(r.id),
      );

      if (safeRows.length > 0) {
        const userRollups = new Map<
          string,
          { credits: number; debits: number; txCount: number }
        >();
        const companyRollups = new Map<
          string,
          { credits: number; debits: number; txCount: number; salesNet: number }
        >();
        let govTaxDelta = 0;
        let govCreditsDelta = 0;
        let govDebitsDelta = 0;
        let grossSum = 0;
        let taxSum = 0;
        let netSum = 0;

        for (const r of safeRows) {
          grossSum += r.grossAmount;
          taxSum += r.taxAmount;
          netSum += r.netAmount;
          govTaxDelta += r.taxAmount;

          if (r.senderType === "USER" && r.senderId) {
            const cur = userRollups.get(r.senderId) ?? {
              credits: 0,
              debits: 0,
              txCount: 0,
            };
            cur.debits += r.grossAmount;
            cur.txCount += 1;
            userRollups.set(r.senderId, cur);
          } else if (r.senderType === "COMPANY" && r.senderId) {
            const cur = companyRollups.get(r.senderId) ?? {
              credits: 0,
              debits: 0,
              txCount: 0,
              salesNet: 0,
            };
            cur.debits += r.grossAmount;
            cur.txCount += 1;
            companyRollups.set(r.senderId, cur);
          } else if (r.senderType === "GOVERNMENT") {
            govDebitsDelta += r.grossAmount;
          }

          if (r.receiverType === "USER" && r.receiverId) {
            const cur = userRollups.get(r.receiverId) ?? {
              credits: 0,
              debits: 0,
              txCount: 0,
            };
            cur.credits += r.netAmount;
            cur.txCount += 1;
            userRollups.set(r.receiverId, cur);
          } else if (r.receiverType === "COMPANY" && r.receiverId) {
            const cur = companyRollups.get(r.receiverId) ?? {
              credits: 0,
              debits: 0,
              txCount: 0,
              salesNet: 0,
            };
            cur.credits += r.netAmount;
            cur.txCount += 1;
            if (r.type === "COMPANY_SALE" || r.type === "INVOICE_PAYMENT") {
              cur.salesNet += r.netAmount;
            }
            companyRollups.set(r.receiverId, cur);
          } else if (r.receiverType === "GOVERNMENT") {
            govCreditsDelta += r.netAmount;
          }
        }

        for (const [uid, delta] of userRollups.entries()) {
          await tx
            .update(users)
            .set({
              archivedCredits: sql`${users.archivedCredits} + ${delta.credits}`,
              archivedDebits: sql`${users.archivedDebits} + ${delta.debits}`,
              archivedTxCount: sql`${users.archivedTxCount} + ${delta.txCount}`,
            })
            .where(eq(users.id, uid));
        }

        for (const [cid, delta] of companyRollups.entries()) {
          await tx
            .update(companies)
            .set({
              archivedCredits: sql`${companies.archivedCredits} + ${delta.credits}`,
              archivedDebits: sql`${companies.archivedDebits} + ${delta.debits}`,
              archivedTxCount: sql`${companies.archivedTxCount} + ${delta.txCount}`,
              archivedSalesNet: sql`${companies.archivedSalesNet} + ${delta.salesNet}`,
            })
            .where(eq(companies.id, cid));
        }

        await tx
          .update(government)
          .set({
            archivedTaxCollected: sql`${government.archivedTaxCollected} + ${govTaxDelta}`,
            archivedCredits: sql`${government.archivedCredits} + ${govCreditsDelta}`,
            archivedDebits: sql`${government.archivedDebits} + ${govDebitsDelta}`,
          })
          .where(eq(government.id, gov.id));

        const safeIds = safeRows.map((r) => r.id);
        const deleted = await tx
          .delete(transactions)
          .where(inArray(transactions.id, safeIds))
          .returning({ id: transactions.id });
        clearedCount = deleted.length;

        const postSnapshot = await getAccountingPreservationSnapshot(tx);
        if (!postSnapshot.supplyBalanced) {
          throw new ArchiveError(
            "Supply invariant check failed after transaction clearing; rolling back.",
          );
        }

        const checkpointNumber = await nextCheckpointNumber(tx);
        const periodStart = safeRows[0].createdAt;
        const periodEnd = safeRows[safeRows.length - 1].createdAt;
        const walletRollupsJson = {
          usersUpdated: userRollups.size,
          companiesUpdated: companyRollups.size,
          govTaxDelta,
          govCreditsDelta,
          govDebitsDelta,
        };
        const checkpointHash = sha256Hex(
          JSON.stringify({
            checkpointNumber,
            archiveBatchId: batch.id,
             archiveSha256: batch.sha256Checksum,
            clearedCount,
            grossSum,
            taxSum,
            netSum,
            totalSupply: postSnapshot.totalSupply,
            treasuryBalance: postSnapshot.treasuryBalance,
            userHeldBalance: postSnapshot.userHeldBalance,
            companyHeldBalance: postSnapshot.companyHeldBalance,
            retiredSupply: postSnapshot.retiredSupply,
          }),
        );

        const [chk] = await tx
          .insert(accountingCheckpoints)
          .values({
            checkpointNumber,
            archiveBatchId: batch.id,
            periodStart,
            periodEnd,
            clearedTxCount: clearedCount,
            grossVolumeCleared: grossSum,
            taxVolumeCleared: taxSum,
            netVolumeCleared: netSum,
            totalSupplySnapshot: postSnapshot.totalSupply,
            retiredSupplySnapshot: postSnapshot.retiredSupply,
            treasuryBalanceSnapshot: postSnapshot.treasuryBalance,
            userHeldBalanceSnapshot: postSnapshot.userHeldBalance,
            companyHeldBalanceSnapshot: postSnapshot.companyHeldBalance,
            walletRollupsJson,
            checkpointHash,
            createdByGovId: params.govId,
          })
          .returning();

        createdCheckpoint = chk;
      }
    } else if (batch.datasetKey === "settled_market_orders") {
      const deleted = await tx
        .delete(marketOrders)
        .where(
          and(
            inArray(marketOrders.id, recordIds),
            inArray(marketOrders.status, ["EXECUTED", "REJECTED", "CANCELLED"]),
          ),
        )
        .returning({ id: marketOrders.id });
      clearedCount = deleted.length;
    } else if (batch.datasetKey === "closed_refunds") {
      const deleted = await tx
        .delete(refundRequests)
        .where(
          and(
            inArray(refundRequests.id, recordIds),
            inArray(refundRequests.status, ["COMPLETED", "REJECTED"]),
          ),
        )
        .returning({ id: refundRequests.id });
      clearedCount = deleted.length;
    } else if (batch.datasetKey === "old_market_candles") {
      const safetyMaxCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const deleted = await tx
        .delete(marketCandles)
        .where(
          and(
            inArray(marketCandles.id, recordIds),
            lt(marketCandles.bucketStart, safetyMaxCutoff),
          ),
        )
        .returning({ id: marketCandles.id });
      clearedCount = deleted.length;
    } else if (batch.datasetKey === "closed_exchange_purchases") {
      const linkedRefunds = await tx
        .select({ pid: refundRequests.exchangePurchaseId })
        .from(refundRequests)
        .where(sql`${refundRequests.exchangePurchaseId} IS NOT NULL`);
      const linkedSet = new Set(linkedRefunds.map((r) => r.pid).filter(Boolean));
      const deletableIds = recordIds.filter((id) => !linkedSet.has(id));
      if (deletableIds.length > 0) {
        const deleted = await tx
          .delete(exchangePurchases)
          .where(
            and(
              inArray(exchangePurchases.id, deletableIds),
              inArray(exchangePurchases.status, ["CREDITED", "CANCELLED", "REFUNDED"]),
            ),
          )
          .returning({ id: exchangePurchases.id });
        clearedCount = deleted.length;
      }
    } else if (batch.datasetKey === "audit_logs_history") {
      const deleted = await tx
        .delete(auditLogs)
        .where(inArray(auditLogs.id, recordIds))
        .returning({ id: auditLogs.id });
      clearedCount = deleted.length;
    }

    await tx
      .update(archivedRecordLedger)
      .set({ clearedFromNeonAt: now })
      .where(eq(archivedRecordLedger.batchId, batch.id));

    const [updatedBatch] = await tx
      .update(archiveBatches)
      .set({
        status: "CLEARED",
        stateMachineStatus: "COMPLETED",
        clearedAt: now,
        clearedRecordCount: clearedCount,
      })
      .where(eq(archiveBatches.id, batch.id))
      .returning();

    await recordAudit(tx, {
      action: "ARCHIVE_BATCH_CLEARED",
      actorType: "GOVERNMENT",
      actorId: params.govId,
      actorLabel: params.govUsername,
      targetType: "ARCHIVE_BATCH",
      targetId: batch.id,
      previousValue: "VERIFIED",
      newValue: `CLEARED (${clearedCount} records removed from Neon; permanent archive in ${batch.repoKey})`,
      metadata: {
        batchNumber: batch.batchNumber,
        datasetKey: batch.datasetKey,
        repoKey: batch.repoKey,
        clearedCount,
        checkpointNumber: createdCheckpoint?.checkpointNumber ?? null,
        sha256Checksum: batch.sha256Checksum,
      },
    });

    return {
      batch: updatedBatch,
      clearedCount,
      checkpoint: createdCheckpoint,
    };
  });
}

// ---------------------------------------------------------------------------
// V4.1 Automated 24-Hour Resumable GitHub Archival Cycle (12-Step State Machine)
// ---------------------------------------------------------------------------

export interface GithubArchivalCycleSummary {
  ranAt: string;
  olderThanHours: number;
  retriedCount: number;
  archivedBatches: Array<{
    batchNumber: string;
    datasetKey: ArchiveDatasetKey;
    repoKey: GithubArchiveRepoKey;
    recordCount: number;
    clearedCount: number;
    stateMachineStatus: string;
    remoteCommitSha: string | null;
  }>;
  errors: Array<{ datasetKey: string; error: string }>;
}

/**
 * Retries any `FAILED_RETRYABLE` batch in `archive_batches` by re-uploading its
 * stored deterministic `.jsonl` payload to GitHub and verifying the remote SHA-256.
 */
export async function retryFailedGithubArchiveBatch(batchId: string): Promise<ArchiveBatch> {
  const [batch] = await db
    .select()
    .from(archiveBatches)
    .where(eq(archiveBatches.id, batchId))
    .limit(1);
  if (!batch) throw new ArchiveError("Archive batch not found.");

  const zipBuf = Buffer.from(batch.zipPayloadBase64, "base64");
  const entries = extractDeterministicZipEntries(zipBuf);
  const jsonlBuf = entries[`data/${batch.datasetKey}.jsonl`];
  if (!jsonlBuf) {
    throw new ArchiveError("Batch ZIP does not contain a .jsonl entry to retry.");
  }

  const jsonlContent = jsonlBuf.toString("utf8");
  const expectedJsonlSha256 = sha256Hex(jsonlBuf);

  try {
    const ghResult = await uploadAndVerifyGithubArchiveBatch({
      datasetKey: batch.datasetKey as ArchiveDatasetKey,
      batchNumber: batch.batchNumber,
      shardGeneration: batch.shardGeneration,
      referenceDate: batch.periodEnd ?? batch.createdAt,
      jsonlContent,
      expectedJsonlSha256,
      zipSha256: batch.sha256Checksum,
      manifestObject: batch.manifestJson as Record<string, unknown>,
      recordCount: batch.recordCount,
      periodStart: batch.periodStart,
      periodEnd: batch.periodEnd,
      entityIds: [],
    });

    const now = new Date();
    const [updated] = await db
      .update(archiveBatches)
      .set({
        status: "VERIFIED",
        stateMachineStatus: "VERIFIED",
        remoteCommitSha: ghResult.commitSha,
        remoteBatchPath: ghResult.batchPath,
        remoteManifestPath: ghResult.manifestPath,
        remoteIndexPath: ghResult.indexPath,
        verifiedRemoteSha256: ghResult.verifiedRemoteSha256,
        verifiedAt: now,
        lastError: null,
        nextRetryAt: null,
      })
      .where(eq(archiveBatches.id, batch.id))
      .returning();

    const recordIds = Array.isArray(batch.recordIdsJson)
      ? (batch.recordIdsJson as string[])
      : [];
    if (recordIds.length > 0) {
      await db
        .insert(archivedRecordLedger)
        .values(
          recordIds.map((rid) => ({
            datasetKey: batch.datasetKey,
            recordId: rid,
            batchId: batch.id,
            repoKey: ghResult.repoKey,
            remoteBatchPath: ghResult.batchPath,
            recordCreatedAt: batch.periodEnd,
            archivedAt: now,
          })),
        )
        .onConflictDoNothing();
    }

    await db
      .update(archiveRepositories)
      .set({
        totalBatchesPushed: sql`${archiveRepositories.totalBatchesPushed} + 1`,
        totalRecordsArchived: sql`${archiveRepositories.totalRecordsArchived} + ${batch.recordCount}`,
        lastCommitSha: ghResult.commitSha,
        lastPushAt: now,
        lastVerifiedAt: now,
        healthStatus: "HEALTHY",
        lastError: null,
        updatedAt: now,
      })
      .where(eq(archiveRepositories.repoKey, ghResult.repoKey));

    return updated;
  } catch (err) {
    const isRetryable =
      err instanceof GithubArchiveRemoteError ? err.retryable : true;
    const errMsg = err instanceof Error ? err.message : "Retry failed.";
    const [failed] = await db
      .update(archiveBatches)
      .set({
        stateMachineStatus: isRetryable ? "FAILED_RETRYABLE" : "DEGRADED_HALTED",
        retryCount: sql`${archiveBatches.retryCount} + 1`,
        lastError: errMsg,
        nextRetryAt: isRetryable ? new Date(Date.now() + 15 * 60 * 1000) : null,
      })
      .where(eq(archiveBatches.id, batch.id))
      .returning();
    return failed;
  }
}

/**
 * Executes the bounded, resumable 24-hour GitHub archival cycle across all
 * 5 repositories. Safe to call from `/api/cron/cleanup`, `/gov/archive`, or tests.
 */
export async function run24HourGithubArchivalCycle(params?: {
  olderThanHours?: number;
  autoClearPrunable?: boolean;
  datasets?: ArchiveDatasetKey[];
}): Promise<GithubArchivalCycleSummary> {
  const olderThanHours = params?.olderThanHours ?? DEFAULT_GITHUB_ARCHIVE_MIN_AGE_HOURS;
  const autoClearPrunable = params?.autoClearPrunable ?? true;
  const targetDatasets = params?.datasets ?? [...ARCHIVE_DATASET_KEYS];

  const [gov] = await db.select().from(government).limit(1);
  if (!gov || !gov.archiveCenterEnabled) {
    return {
      ranAt: new Date().toISOString(),
      olderThanHours,
      retriedCount: 0,
      archivedBatches: [],
      errors: [],
    };
  }

  await ensureArchiveRepositoriesSeeded();

  const summary: GithubArchivalCycleSummary = {
    ranAt: new Date().toISOString(),
    olderThanHours,
    retriedCount: 0,
    archivedBatches: [],
    errors: [],
  };

  // Phase A: Resume any FAILED_RETRYABLE batches first
  const retryableBatches = await db
    .select()
    .from(archiveBatches)
    .where(eq(archiveBatches.stateMachineStatus, "FAILED_RETRYABLE"))
    .orderBy(asc(archiveBatches.createdAt))
    .limit(3);

  for (const rb of retryableBatches) {
    const retried = await retryFailedGithubArchiveBatch(rb.id);
    if (retried.stateMachineStatus === "VERIFIED") {
      summary.retriedCount += 1;
      if (autoClearPrunable) {
        try {
          await clearArchiveBatch({
            govId: gov.id,
            govUsername: gov.username,
            batchId: retried.id,
            verificationToken: retried.verificationToken,
            confirmPhrase: ARCHIVE_CLEAR_CONFIRM_PHRASE,
          });
        } catch {
          // Non-fatal if dataset is non-prunable
        }
      }
    }
  }

  // Phase B: Select & archive newly eligible records (>= olderThanHours old)
  const cutoffDate = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);

  for (const datasetKey of targetDatasets) {
    try {
      const sel = await selectEligibleDatasetRecords({
        datasetKey,
        cutoffDate,
        excludeAlreadyArchived: true,
        maxRecords: GITHUB_BATCH_MAX_RECORDS,
      });

      if (sel.rows.length === 0) continue;

      const olderThanDaysApprox = Math.max(0, Math.floor(olderThanHours / 24));
      const created = await createArchiveBatch({
        govId: gov.id,
        govUsername: gov.username,
        datasetKey,
        olderThanDays: olderThanDaysApprox,
        dateTo: cutoffDate,
        pushToGithub: true,
      });

      let clearedCount = 0;
      if (created.stateMachineStatus === "VERIFIED") {
        // Mark batch status VERIFIED since remote read-back SHA-256 succeeded
        await verifyArchiveBatch({
          govId: gov.id,
          govUsername: gov.username,
          batchId: created.id,
          verificationToken: created.verificationToken,
        });

        if (autoClearPrunable && sel.canPruneFromNeon) {
          const clearedRes = await clearArchiveBatch({
            govId: gov.id,
            govUsername: gov.username,
            batchId: created.id,
            verificationToken: created.verificationToken,
            confirmPhrase: ARCHIVE_CLEAR_CONFIRM_PHRASE,
          });
          clearedCount = clearedRes.clearedCount;
        }
      } else if (created.lastError) {
        summary.errors.push({ datasetKey, error: created.lastError });
      }

      summary.archivedBatches.push({
        batchNumber: created.batchNumber,
        datasetKey,
        repoKey: sel.repoKey,
        recordCount: created.recordCount,
        clearedCount,
        stateMachineStatus: created.stateMachineStatus,
        remoteCommitSha: created.remoteCommitSha,
      });
    } catch (e) {
      summary.errors.push({
        datasetKey,
        error: e instanceof Error ? e.message : "Archival step error",
      });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Paginated Historical Transaction Retrieval (Neon + GitHub Archive Fallback)
// ---------------------------------------------------------------------------

export interface HistoricalTransactionRecord extends Transaction {
  archiveSource?: "NEON_LIVE" | "GITHUB_ARCHIVE";
  archiveBatchNumber?: string;
}

/**
 * Retrieves transactions for a wallet (`userId` or `companyId`) with optional
 * search/type/date filters and seamless fallback into verified GitHub archive
 * batches when `includeArchived = true`.
 */
export async function getWalletTransactionsWithArchiveFallback(params: {
  walletId: string;
  walletType: "USER" | "COMPANY";
  limit?: number;
  offset?: number;
  txTypeFilter?: string | null;
  searchQuery?: string | null;
  includeArchived?: boolean;
}): Promise<{
  records: HistoricalTransactionRecord[];
  liveCount: number;
  archivedCountIncluded: number;
  hasMore: boolean;
}> {
  const limit = Math.max(10, Math.min(200, params.limit ?? 50));
  const offset = Math.max(0, params.offset ?? 0);

  const liveRows = await db
    .select()
    .from(transactions)
    .where(
      or(
        and(
          eq(transactions.senderType, params.walletType),
          eq(transactions.senderId, params.walletId),
        ),
        and(
          eq(transactions.receiverType, params.walletType),
          eq(transactions.receiverId, params.walletId),
        ),
      ),
    )
    .orderBy(desc(transactions.createdAt))
    .limit(300);

  const combined: HistoricalTransactionRecord[] = liveRows.map((r) => ({
    ...r,
    archiveSource: "NEON_LIVE",
  }));

  let archivedCountIncluded = 0;

  if (params.includeArchived) {
    const seenIds = new Set(combined.map((r) => r.id));
    const txBatches = await db
      .select()
      .from(archiveBatches)
      .where(eq(archiveBatches.datasetKey, "transactions_history"))
      .orderBy(desc(archiveBatches.createdAt))
      .limit(10);

    for (const b of txBatches) {
      let batchRecords: Record<string, unknown>[] | null = null;
      if (b.remoteBatchPath) {
        batchRecords = await fetchArchivedBatchRecordsFromGithub({
          repoKey: "aeros-archive-ledger",
          batchPath: b.remoteBatchPath,
        });
      }
      if (!batchRecords) {
        try {
          const entries = extractDeterministicZipEntries(
            Buffer.from(b.zipPayloadBase64, "base64"),
          );
          const jsonlEntry = entries["data/transactions_history.jsonl"];
          if (jsonlEntry) {
            batchRecords = parseJsonl(jsonlEntry.toString("utf8"));
          }
        } catch {
          batchRecords = null;
        }
      }

      if (!batchRecords) continue;

      for (const raw of batchRecords) {
        const id = String(raw.id ?? "");
        if (!id || seenIds.has(id)) continue;
        const isSender =
          raw.senderType === params.walletType && raw.senderId === params.walletId;
        const isReceiver =
          raw.receiverType === params.walletType && raw.receiverId === params.walletId;
        if (!isSender && !isReceiver) continue;

        seenIds.add(id);
        archivedCountIncluded += 1;
        combined.push({
          id,
          txRef: String(raw.txRef ?? ""),
          type: raw.type as Transaction["type"],
          senderType: raw.senderType as Transaction["senderType"],
          senderId: (raw.senderId as string) ?? null,
          senderUsername: String(raw.senderUsername ?? ""),
          receiverType: raw.receiverType as Transaction["receiverType"],
          receiverId: (raw.receiverId as string) ?? null,
          receiverUsername: String(raw.receiverUsername ?? ""),
          grossAmount: Number(raw.grossAmount ?? 0),
          taxAmount: Number(raw.taxAmount ?? 0),
          netAmount: Number(raw.netAmount ?? 0),
          taxRateBpApplied: Number(raw.taxRateBpApplied ?? 0),
          reason: (raw.reason as string) ?? null,
          invoiceId: (raw.invoiceId as string) ?? null,
          reversesTransactionId: (raw.reversesTransactionId as string) ?? null,
          createdAt: new Date(String(raw.createdAt ?? new Date().toISOString())),
          archiveSource: "GITHUB_ARCHIVE",
          archiveBatchNumber: b.batchNumber,
        });
      }
    }
  }

  // Apply optional filters
  const q = (params.searchQuery ?? "").trim().toLowerCase();
  const tf = (params.txTypeFilter ?? "").trim();

  const filtered = combined
    .filter((tx) => {
      if (tf && tf !== "ALL" && tx.type !== tf) return false;
      if (q) {
        const hay = `${tx.txRef} ${tx.senderUsername} ${tx.receiverUsername} ${tx.reason ?? ""} ${tx.type}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const page = filtered.slice(offset, offset + limit);
  return {
    records: page,
    liveCount: liveRows.length,
    archivedCountIncluded,
    hasMore: filtered.length > offset + limit,
  };
}

export async function markArchiveBatchDownloaded(batchId: string): Promise<void> {
  await db
    .update(archiveBatches)
    .set({
      downloadedAt: new Date(),
      status: sql`CASE WHEN ${archiveBatches.status} = 'CREATED' THEN 'DOWNLOADED'::archive_batch_status ELSE ${archiveBatches.status} END`,
    })
    .where(eq(archiveBatches.id, batchId));
}

export async function getArchiveBatchesList(limit = 50): Promise<
  Array<Omit<ArchiveBatch, "zipPayloadBase64">>
> {
  const rows = await db
    .select({
      id: archiveBatches.id,
      batchNumber: archiveBatches.batchNumber,
      datasetKey: archiveBatches.datasetKey,
      archiveVersion: archiveBatches.archiveVersion,
      schemaVersion: archiveBatches.schemaVersion,
      cutoffDate: archiveBatches.cutoffDate,
      periodStart: archiveBatches.periodStart,
      periodEnd: archiveBatches.periodEnd,
      recordCount: archiveBatches.recordCount,
      sha256Checksum: archiveBatches.sha256Checksum,
      verificationToken: archiveBatches.verificationToken,
      manifestJson: archiveBatches.manifestJson,
      recordIdsJson: archiveBatches.recordIdsJson,
      byteSize: archiveBatches.byteSize,
      status: archiveBatches.status,
      repoKey: archiveBatches.repoKey,
      repoName: archiveBatches.repoName,
      shardGeneration: archiveBatches.shardGeneration,
      stateMachineStatus: archiveBatches.stateMachineStatus,
      remoteCommitSha: archiveBatches.remoteCommitSha,
      remoteBatchPath: archiveBatches.remoteBatchPath,
      remoteManifestPath: archiveBatches.remoteManifestPath,
      remoteIndexPath: archiveBatches.remoteIndexPath,
      verifiedRemoteSha256: archiveBatches.verifiedRemoteSha256,
      retryCount: archiveBatches.retryCount,
      lastError: archiveBatches.lastError,
      nextRetryAt: archiveBatches.nextRetryAt,
      isDownloadAllBundle: archiveBatches.isDownloadAllBundle,
      createdByGovId: archiveBatches.createdByGovId,
      createdAt: archiveBatches.createdAt,
      downloadedAt: archiveBatches.downloadedAt,
      verifiedAt: archiveBatches.verifiedAt,
      clearedAt: archiveBatches.clearedAt,
      clearedRecordCount: archiveBatches.clearedRecordCount,
    })
    .from(archiveBatches)
    .orderBy(desc(archiveBatches.createdAt))
    .limit(limit);

  return rows;
}

export async function getAccountingCheckpointsList(
  limit = 50,
): Promise<AccountingCheckpoint[]> {
  return db
    .select()
    .from(accountingCheckpoints)
    .orderBy(desc(accountingCheckpoints.createdAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// AEROS PAY V5 — 15-REPOSITORY SEEDING, 900 MB ROLLOVER & MANUAL ARCHIVE JOB RUNNER
// ---------------------------------------------------------------------------

export async function ensureV5ArchiveRepositoriesSeeded(): Promise<ArchiveRepository[]> {
  const cfg = getGithubArchiveEnvConfigV5();
  for (const repoKey of GITHUB_ARCHIVE_REPO_KEYS_V5) {
    const repoName = cfg.repos[repoKey];
    await db
      .insert(archiveRepositories)
      .values({
        repoKey,
        repoOwner: cfg.owner,
        repoName,
        branch: cfg.branch,
        shardGeneration: 1,
        warningThresholdBytes: GITHUB_V5_REPO_WARNING_BYTES,
        hardLimitBytes: GITHUB_V5_REPO_HARD_LIMIT_BYTES,
        healthStatus: "HEALTHY",
        isActiveForWrites: true,
      })
      .onConflictDoNothing();
  }
  return db.select().from(archiveRepositories).orderBy(asc(archiveRepositories.repoKey));
}

export interface V5RepositoryStorageStatus {
  repoKey: string;
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
  lastPushAt: Date | null;
  lastVerifiedAt: Date | null;
  lastError: string | null;
}

export async function getV5RepositoriesStorageStatus(): Promise<{
  repositories: V5RepositoryStorageStatus[];
  warningCount: number;
  criticalCount: number;
  hasStorageAlerts: boolean;
}> {
  const rows = await ensureV5ArchiveRepositoriesSeeded();
  const v5KeysSet = new Set<string>(GITHUB_ARCHIVE_REPO_KEYS_V5);

  const repositories: V5RepositoryStorageStatus[] = rows
    .filter((r) => v5KeysSet.has(r.repoKey))
    .map((r) => {
      const status = evaluateRepoStorageHealthV5(
        r.estimatedBytesUsed,
        GITHUB_V5_REPO_WARNING_BYTES,
        GITHUB_V5_REPO_HARD_LIMIT_BYTES,
      );
      const gen = r.shardGeneration || 1;
      const activeName =
        r.continuationRepoName ||
        (gen > 1 ? getContinuationRepoName(r.repoName, gen) : r.repoName);
      const nextContinuationRepoName = getContinuationRepoName(r.repoName, gen + 1);
      const percentOfLimit = Number(
        ((r.estimatedBytesUsed / GITHUB_V5_REPO_HARD_LIMIT_BYTES) * 100).toFixed(2),
      );
      return {
        repoKey: r.repoKey,
        baseRepoName: r.repoName,
        activeRepoName: activeName,
        shardGeneration: gen,
        estimatedBytesUsed: r.estimatedBytesUsed,
        warningThresholdBytes: GITHUB_V5_REPO_WARNING_BYTES,
        hardLimitBytes: GITHUB_V5_REPO_HARD_LIMIT_BYTES,
        percentOfLimit,
        healthStatus: status,
        nextContinuationRepoName,
        totalBatchesPushed: r.totalBatchesPushed,
        totalRecordsArchived: r.totalRecordsArchived,
        lastPushAt: r.lastPushAt,
        lastVerifiedAt: r.lastVerifiedAt,
        lastError: r.lastError,
      };
    });

  const warningCount = repositories.filter((r) => r.healthStatus === "WARNING").length;
  const criticalCount = repositories.filter((r) => r.healthStatus === "CRITICAL").length;

  return {
    repositories,
    warningCount,
    criticalCount,
    hasStorageAlerts: warningCount > 0 || criticalCount > 0,
  };
}

export async function getLatestArchiveJobRuns(limit = 15): Promise<ArchiveJobRun[]> {
  return db
    .select()
    .from(archiveJobRuns)
    .orderBy(desc(archiveJobRuns.startedAt))
    .limit(limit);
}

/**
 * Starts or resumes a durable V5 GitHub Archive Job Run (`Start GitHub Archive` button
 * or 24-hour automatic schedule). Enforces concurrency protection so two jobs cannot
 * collide, tracks live stage progression, handles 900 MB continuation rollover, and
 * verifies remote SHA-256 checksums before any Neon cleanup.
 */
export async function startOrResumeV5ArchiveJob(params: {
  triggerType: "MANUAL_GOV" | "SCHEDULED_24H";
  olderThanHours?: number;
  autoClearPrunable?: boolean;
  triggeredByGovId?: string | null;
  triggeredByUsername?: string | null;
}): Promise<ArchiveJobRun> {
  const olderThanHours = params.olderThanHours ?? DEFAULT_GITHUB_ARCHIVE_MIN_AGE_HOURS;
  const autoClearPrunable = params.autoClearPrunable ?? true;

  await ensureV5ArchiveRepositoriesSeeded();

  // Concurrency guard: check if a job is currently locked & active (< 10 minutes old)
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  const [activeJob] = await db
    .select()
    .from(archiveJobRuns)
    .where(
      and(
        eq(archiveJobRuns.isLocked, true),
        sql`${archiveJobRuns.updatedAt} > ${tenMinAgo}`,
      ),
    )
    .orderBy(desc(archiveJobRuns.startedAt))
    .limit(1);

  if (activeJob) {
    return activeJob;
  }

  const jobNumber = `AJR-${Date.now().toString(36).toUpperCase()}`;
  const [jobRow] = await db
    .insert(archiveJobRuns)
    .values({
      jobNumber,
      status: "RUNNING",
      currentPhase: "PREPARING",
      batchesTotal: ARCHIVE_DATASET_KEYS.length,
      batchesCompleted: 0,
      recordsProcessed: 0,
      recordsVerified: 0,
      recordsRetainedErrors: 0,
      initiatedByGovId: params.triggeredByGovId ?? null,
      isLocked: true,
    })
    .returning();

  const updateStage = async (
    status: ArchiveJobRun["status"],
    patch?: Partial<{
      currentPhase: string;
      currentCategory: string | null;
      currentRepo: string | null;
      batchesCompleted: number;
      recordsProcessed: number;
      recordsVerified: number;
      recordsRetainedErrors: number;
      lastError: string | null;
      isLocked: boolean;
      completedAt: Date | null;
    }>,
  ) => {
    const [updated] = await db
      .update(archiveJobRuns)
      .set({
        status,
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(archiveJobRuns.id, jobRow.id))
      .returning();
    return updated;
  };

  try {
    // Ensure all 15 dedicated private V5 archive repositories exist on GitHub
    await ensureV5RemoteRepositoriesProvisioned();

    // Check 900 MB storage thresholds & roll over any repository at/above 900 MB
    const repoRows = await db.select().from(archiveRepositories);
    for (const repo of repoRows) {
      const health = evaluateRepoStorageHealthV5(repo.estimatedBytesUsed);
      if (health === "CRITICAL") {
        const nextGen = (repo.shardGeneration || 1) + 1;
        const nextName = getContinuationRepoName(repo.repoName, nextGen);
        await createContinuationArchiveRepository({
          repoKey: `${repo.repoKey}-${nextGen}`,
          repoName: nextName,
          description: `Aeros Pay V5 Continuation Archive (${repo.repoKey} shard #${nextGen})`,
        });
        await db
          .update(archiveRepositories)
          .set({
            shardGeneration: nextGen,
            continuationRepoKey: `${repo.repoKey}-${nextGen}`,
            continuationRepoName: nextName,
            estimatedBytesUsed: 0,
            healthStatus: "HEALTHY",
            updatedAt: new Date(),
          })
          .where(eq(archiveRepositories.repoKey, repo.repoKey));
      }
    }

    await updateStage("RUNNING", {
      currentPhase: "READING",
    });

    await updateStage("RUNNING", {
      currentPhase: "UPLOADING",
    });

    const cycleSummary = await run24HourGithubArchivalCycle({
      olderThanHours,
      autoClearPrunable,
    });

    const totalUploaded = cycleSummary.archivedBatches.reduce(
      (acc, b) => acc + b.recordCount,
      0,
    );
    const totalVerified = cycleSummary.archivedBatches
      .filter((b) => b.stateMachineStatus === "VERIFIED" || b.stateMachineStatus === "COMPLETED")
      .reduce((acc, b) => acc + b.recordCount, 0);
    const totalCleaned = cycleSummary.archivedBatches.reduce(
      (acc, b) => acc + b.clearedCount,
      0,
    );

    await updateStage("RUNNING", {
      currentPhase: "VERIFYING",
      recordsProcessed: totalUploaded,
      recordsVerified: totalVerified,
    });

    await updateStage("RUNNING", {
      currentPhase: "INTEGRITY_CHECK",
    });

    if (autoClearPrunable && totalCleaned > 0) {
      await updateStage("RUNNING", {
        currentPhase: "CLEANUP",
      });
    }

    const finalJob = await updateStage("COMPLETED", {
      currentPhase: "COMPLETED",
      currentCategory: null,
      currentRepo: null,
      batchesCompleted: ARCHIVE_DATASET_KEYS.length,
      recordsProcessed: totalUploaded,
      recordsVerified: totalVerified,
      recordsRetainedErrors: cycleSummary.errors.length,
      isLocked: false,
      completedAt: new Date(),
    });

    return finalJob;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Archive job execution failed.";
    return updateStage("FAILED", {
      currentPhase: "FAILED",
      lastError: errMsg,
      isLocked: false,
      completedAt: new Date(),
    });
  }
}


