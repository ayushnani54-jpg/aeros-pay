import "server-only";
import { createHash } from "crypto";
import { deflateRawSync } from "zlib";
import { db } from "@/db/client";
import {
  accountingCheckpoints,
  archiveBatches,
  companies,
  government,
  marketCandles,
  marketOrders,
  refundRequests,
  retentionSettings,
  transactions,
  users,
  type AccountingCheckpoint,
  type ArchiveBatch,
  type Transaction,
} from "@/db/schema";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { csvHeader, csvRow, UTF8_BOM } from "./csv";
import {
  ARCHIVE_CLEAR_CONFIRM_PHRASE,
  CURRENCY_NAME,
  type ArchiveDatasetKey,
} from "./constants";

/**
 * ARCHIVE CENTER & CORE ACCOUNTING PRESERVATION (V4, Spec §§8, 9, 10, 11)
 * ============================================================================
 *
 * Financial record classification (Spec §9):
 *   Category A — Authoritative balances & permanent supply (`users.balance`,
 *                `companies.balance`, `government.balance`, `government.totalSupply`,
 *                `government.retiredSupply`). NEVER deleted.
 *   Category B — Durable accounting & reconciliation anchors (`accounting_checkpoints`,
 *                `issuance_requests`, `company_sale_records`, `invoices`, `loans`,
 *                `loan_payments`, `marketplace_contracts`, `exchange_purchases`,
 *                and `transactions` rows that anchor them or participate in a
 *                reversal chain). NEVER deleted.
 *   Category C — Operational transaction history (`TRANSFER`, invoice-free
 *                `COMPANY_SALE`, `COMPANY_PAYMENT`, `GOVERNMENT_FUNDING`,
 *                `GOVERNMENT_PAYMENT`, `GOVERNMENT_RECEIPT`,
 *                `ADMIN_ADJUSTMENT_CREDIT`, `ADMIN_ADJUSTMENT_DEBIT`,
 *                `COMPANY_ADJUSTMENT_CREDIT`, `COMPANY_ADJUSTMENT_DEBIT`,
 *                `MARKET_TRADE_BUY`, `MARKET_TRADE_SELL`) and terminal
 *                operational records (`settled_market_orders`, `closed_refunds`).
 *                Eligible for Archive-Before-Clearing once older than the
 *                retention cutoff AND packaged into a verified `.zip` archive.
 *   Category D — Temporary/telemetry/candle cache (`old_market_candles`,
 *                expired notifications, updates, support messages, etc.).
 */

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Pure Node.js Standard PKZIP Builder (RFC 1951 DEFLATE + IEEE 802.3 CRC-32)
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

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Builds a valid standard `.zip` archive buffer from a list of named files.
 */
export function buildZipArchive(
  entries: Array<{ name: string; content: Buffer | string }>,
): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const rawBuf =
      typeof entry.content === "string"
        ? Buffer.from(entry.content, "utf8")
        : entry.content;
    const compressedBuf = deflateRawSync(rawBuf, { level: 6 });
    const crc = crc32(rawBuf);

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    localHeader.writeUInt16LE(20, 4); // version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(8, 8); // compression method: 8 = deflate
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(localHeader, 30);

    localChunks.push(localHeader, compressedBuf);

    // Central directory file header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(8, 10); // deflate
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    nameBuf.copy(centralHeader, 46);

    centralChunks.push(centralHeader);
    offset += localHeader.length + compressedBuf.length;
  }

  const centralDirSize = centralChunks.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

// ---------------------------------------------------------------------------
// Sequence helpers
// ---------------------------------------------------------------------------

async function nextArchiveBatchNumber(tx: Pick<typeof db, "execute">): Promise<string> {
  const res = await tx.execute<{ nextval: string }>(
    sql`SELECT nextval('archive_batch_number_seq') AS nextval`,
  );
  const seq = String(res.rows[0]?.nextval ?? "1").padStart(6, "0");
  return `ARC-${seq}`;
}

async function nextCheckpointNumber(tx: Pick<typeof db, "execute">): Promise<string> {
  const res = await tx.execute<{ nextval: string }>(
    sql`SELECT nextval('accounting_checkpoint_number_seq') AS nextval`,
  );
  const seq = String(res.rows[0]?.nextval ?? "1").padStart(6, "0");
  return `CHK-${seq}`;
}

// ---------------------------------------------------------------------------
// Category C Eligible Transaction-History Predicate (Spec §§8, 9, 10, 11)
// ---------------------------------------------------------------------------

export const CATEGORY_C_ELIGIBLE_TX_TYPES = [
  "TRANSFER",
  "COMPANY_SALE",
  "COMPANY_PAYMENT",
  "GOVERNMENT_FUNDING",
  "GOVERNMENT_PAYMENT",
  "GOVERNMENT_RECEIPT",
  "ADMIN_ADJUSTMENT_CREDIT",
  "ADMIN_ADJUSTMENT_DEBIT",
  "COMPANY_ADJUSTMENT_CREDIT",
  "COMPANY_ADJUSTMENT_DEBIT",
  "MARKET_TRADE_BUY",
  "MARKET_TRADE_SELL",
] as const;

/**
 * Fetches Category C operational `transactions` rows older than `cutoffDate`
 * that are safe to archive and clear without breaking any foreign key,
 * reversal chain, active refund request, or reconciliation invariant.
 */
export async function fetchEligibleTransactionsForArchive(
  cutoffDate: Date,
  limit = 500,
): Promise<Transaction[]> {
  return db
    .select()
    .from(transactions)
    .where(
      and(
        lte(transactions.createdAt, cutoffDate),
        inArray(transactions.type, [...CATEGORY_C_ELIGIBLE_TX_TYPES]),
        sql`${transactions.invoiceId} IS NULL`,
        sql`${transactions.reversesTransactionId} IS NULL`,
        // Never clear a transaction that is reversed by another transaction
        sql`NOT EXISTS (
          SELECT 1 FROM "transactions" r
          WHERE r."reverses_transaction_id" = ${transactions.id}
        )`,
        // Never clear a transaction referenced by a refund request
        sql`NOT EXISTS (
          SELECT 1 FROM "refund_requests" rf
          WHERE rf."source_tx_ref" = ${transactions.txRef}
             OR rf."settlement_tx_ref" = ${transactions.txRef}
        )`,
      ),
    )
    .orderBy(asc(transactions.createdAt), asc(transactions.id))
    .limit(limit);
}

/**
 * Computes a complete live accounting snapshot of all wallets, supply, and
 * cumulative archived counters.
 */
export async function getAccountingPreservationSnapshot() {
  const [[gov], [userRollup], [companyRollup], [checkpointRollup]] = await Promise.all([
    db.select().from(government).limit(1),
    db
      .select({
        userHeld: sql<number>`coalesce(sum(${users.balance}), 0)::int`,
        userCount: sql<number>`count(*)::int`,
        archivedUserCredits: sql<number>`coalesce(sum(${users.archivedCredits}), 0)::int`,
        archivedUserDebits: sql<number>`coalesce(sum(${users.archivedDebits}), 0)::int`,
      })
      .from(users),
    db
      .select({
        companyHeld: sql<number>`coalesce(sum(${companies.balance}), 0)::int`,
        companyCount: sql<number>`count(*)::int`,
        archivedCompanyCredits: sql<number>`coalesce(sum(${companies.archivedCredits}), 0)::int`,
        archivedCompanyDebits: sql<number>`coalesce(sum(${companies.archivedDebits}), 0)::int`,
        archivedCompanySalesNet: sql<number>`coalesce(sum(${companies.archivedSalesNet}), 0)::int`,
      })
      .from(companies),
    db
      .select({
        checkpointCount: sql<number>`count(*)::int`,
        totalClearedTx: sql<number>`coalesce(sum(${accountingCheckpoints.clearedTxCount}), 0)::int`,
        totalGrossCleared: sql<number>`coalesce(sum(${accountingCheckpoints.grossVolumeCleared}), 0)::int`,
        totalTaxCleared: sql<number>`coalesce(sum(${accountingCheckpoints.taxVolumeCleared}), 0)::int`,
      })
      .from(accountingCheckpoints),
  ]);

  const treasury = gov?.balance ?? 0;
  const totalSupply = gov?.totalSupply ?? 0;
  const retiredSupply = gov?.retiredSupply ?? 0;
  const userHeld = userRollup?.userHeld ?? 0;
  const companyHeld = companyRollup?.companyHeld ?? 0;
  const accounted = treasury + userHeld + companyHeld + retiredSupply;

  return {
    treasury,
    userHeld,
    companyHeld,
    retiredSupply,
    accounted,
    totalSupply,
    supplyBalanced: accounted === totalSupply,
    archivedGovernmentCredits: gov?.archivedCredits ?? 0,
    archivedGovernmentDebits: gov?.archivedDebits ?? 0,
    archivedTaxCollected: gov?.archivedTaxCollected ?? 0,
    archivedGovernmentTxCount: gov?.archivedTxCount ?? 0,
    archivedUserCredits: userRollup?.archivedUserCredits ?? 0,
    archivedUserDebits: userRollup?.archivedUserDebits ?? 0,
    archivedCompanyCredits: companyRollup?.archivedCompanyCredits ?? 0,
    archivedCompanyDebits: companyRollup?.archivedCompanyDebits ?? 0,
    archivedCompanySalesNet: companyRollup?.archivedCompanySalesNet ?? 0,
    checkpointCount: checkpointRollup?.checkpointCount ?? 0,
    totalClearedTx: checkpointRollup?.totalClearedTx ?? 0,
    totalGrossCleared: checkpointRollup?.totalGrossCleared ?? 0,
    totalTaxCleared: checkpointRollup?.totalTaxCleared ?? 0,
  };
}

/**
 * Preview counts of records eligible for archiving across the 4 datasets.
 */
export async function getArchiveEligibilityPreview() {
  const [settings] = await db.select().from(retentionSettings).limit(1);
  const txDays = settings?.transactionHistoryRetentionDays ?? 30;
  const orderDays = settings?.settledOrderHistoryRetentionDays ?? 30;
  const refundDays = settings?.closedRefundRetentionDays ?? 30;
  const candleDays = settings?.marketCandleRetentionDays ?? 90;

  const now = Date.now();
  const txCutoff = new Date(now - txDays * 86_400_000);
  const orderCutoff = new Date(now - orderDays * 86_400_000);
  const refundCutoff = new Date(now - refundDays * 86_400_000);
  const candleCutoff = new Date(now - Math.max(2, candleDays) * 86_400_000);

  const [eligibleTx, [ordersCount], [refundsCount], [candlesCount]] = await Promise.all([
    fetchEligibleTransactionsForArchive(txCutoff, 500),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketOrders)
      .where(lte(marketOrders.createdAt, orderCutoff)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(refundRequests)
      .where(
        and(
          inArray(refundRequests.status, ["COMPLETED", "REJECTED"]),
          lte(refundRequests.createdAt, refundCutoff),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(marketCandles)
      .where(lte(marketCandles.bucketStart, candleCutoff)),
  ]);

  return {
    configuredDays: {
      transactions_history: settings?.transactionHistoryRetentionDays ?? null,
      settled_market_orders: settings?.settledOrderHistoryRetentionDays ?? null,
      closed_refunds: settings?.closedRefundRetentionDays ?? null,
      old_market_candles: settings?.marketCandleRetentionDays ?? 90,
    },
    eligibleCounts: {
      transactions_history: eligibleTx.length,
      settled_market_orders: ordersCount?.count ?? 0,
      closed_refunds: refundsCount?.count ?? 0,
      old_market_candles: candlesCount?.count ?? 0,
    },
  };
}

/**
 * Creates a structured, downloadable, checksummed `.zip` archive batch for an
 * eligible historical dataset.
 *
 * Creating an archive batch NEVER deletes any rows. Rows can only be cleared
 * after the archive is verified (`verifyArchiveBatch`) and the Government
 * confirms clearing (`clearArchiveBatch`).
 */
export async function createArchiveBatch(params: {
  govId: string;
  govUsername: string;
  datasetKey: ArchiveDatasetKey;
  olderThanDays: number;
}): Promise<ArchiveBatch> {
  const [gov] = await db.select().from(government).limit(1);
  if (!gov || !gov.archiveCenterEnabled) {
    throw new ArchiveError(
      "The Archive Center is currently disabled. Enable it in Government Feature Controls first.",
    );
  }

  const now = new Date();
  const cutoffDate = new Date(now.getTime() - params.olderThanDays * 86_400_000);

  let recordIds: string[] = [];
  let recordsJson: Record<string, unknown>[] = [];
  let csvColumns: string[] = [];
  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;

  if (params.datasetKey === "transactions_history") {
    const rows = await fetchEligibleTransactionsForArchive(cutoffDate, 500);
    if (rows.length === 0) {
      throw new ArchiveError(
        `No eligible Category C transaction-history records found older than ${params.olderThanDays} day(s). Protected accounting anchors (issuance, invoices, loans, company sales, reversals) are never eligible for deletion.`,
      );
    }
    recordIds = rows.map((r) => r.id);
    periodStart = rows[0].createdAt;
    periodEnd = rows[rows.length - 1].createdAt;
    csvColumns = [
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
    ];
    recordsJson = rows.map((r) => ({
      id: r.id,
      txRef: r.txRef,
      type: r.type,
      senderType: r.senderType,
      senderId: r.senderId,
      senderUsername: r.senderUsername,
      receiverType: r.receiverType,
      receiverId: r.receiverId,
      receiverUsername: r.receiverUsername,
      grossAmount: r.grossAmount,
      taxAmount: r.taxAmount,
      netAmount: r.netAmount,
      taxRateBpApplied: r.taxRateBpApplied,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    }));
  } else if (params.datasetKey === "settled_market_orders") {
    const rows = await db
      .select()
      .from(marketOrders)
      .where(lte(marketOrders.createdAt, cutoffDate))
      .orderBy(asc(marketOrders.createdAt), asc(marketOrders.id))
      .limit(500);
    if (rows.length === 0) {
      throw new ArchiveError(
        `No settled synthetic market orders found older than ${params.olderThanDays} day(s).`,
      );
    }
    recordIds = rows.map((r) => r.id);
    periodStart = rows[0].createdAt;
    periodEnd = rows[rows.length - 1].createdAt;
    csvColumns = [
      "id",
      "orderNumber",
      "userId",
      "side",
      "quantity",
      "expectedPrice",
      "executionPrice",
      "totalAeros",
      "realizedPnlDelta",
      "status",
      "txRef",
      "methodologyVersion",
      "createdAt",
    ];
    recordsJson = rows.map((r) => ({
      id: r.id,
      orderNumber: r.orderNumber,
      userId: r.userId,
      side: r.side,
      quantity: r.quantity,
      expectedPrice: r.expectedPrice,
      executionPrice: r.executionPrice,
      totalAeros: r.totalAeros,
      realizedPnlDelta: r.realizedPnlDelta,
      status: r.status,
      txRef: r.txRef,
      methodologyVersion: r.methodologyVersion,
      createdAt: r.createdAt.toISOString(),
    }));
  } else if (params.datasetKey === "closed_refunds") {
    const rows = await db
      .select()
      .from(refundRequests)
      .where(
        and(
          inArray(refundRequests.status, ["COMPLETED", "REJECTED"]),
          lte(refundRequests.createdAt, cutoffDate),
        ),
      )
      .orderBy(asc(refundRequests.createdAt), asc(refundRequests.id))
      .limit(500);
    if (rows.length === 0) {
      throw new ArchiveError(
        `No completed or rejected refund requests found older than ${params.olderThanDays} day(s).`,
      );
    }
    recordIds = rows.map((r) => r.id);
    periodStart = rows[0].createdAt;
    periodEnd = rows[rows.length - 1].createdAt;
    csvColumns = [
      "id",
      "refundNumber",
      "userId",
      "refundType",
      "sourceTxRef",
      "requestedAerosAmount",
      "approvedAerosAmount",
      "status",
      "settlementTxRef",
      "reason",
      "governmentDecisionNote",
      "createdAt",
    ];
    recordsJson = rows.map((r) => ({
      id: r.id,
      refundNumber: r.refundNumber,
      userId: r.userId,
      refundType: r.refundType,
      sourceTxRef: r.sourceTxRef,
      requestedAerosAmount: r.requestedAerosAmount,
      approvedAerosAmount: r.approvedAerosAmount,
      status: r.status,
      settlementTxRef: r.settlementTxRef,
      reason: r.reason,
      governmentDecisionNote: r.governmentDecisionNote,
      createdAt: r.createdAt.toISOString(),
    }));
  } else {
    // old_market_candles: always keep at least the latest 48 hours of candles
    const minCandleCutoff = new Date(
      Math.min(cutoffDate.getTime(), now.getTime() - 2 * 86_400_000),
    );
    const rows = await db
      .select()
      .from(marketCandles)
      .where(lte(marketCandles.bucketStart, minCandleCutoff))
      .orderBy(asc(marketCandles.bucketStart), asc(marketCandles.id))
      .limit(1000);
    if (rows.length === 0) {
      throw new ArchiveError(
        `No historical market candles found older than the safe cutoff (${minCandleCutoff.toISOString()}). Recent 48h candles are always kept for live charts.`,
      );
    }
    recordIds = rows.map((r) => r.id);
    periodStart = rows[0].bucketStart;
    periodEnd = rows[rows.length - 1].bucketStart;
    csvColumns = [
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
      "methodologyVersion",
    ];
    recordsJson = rows.map((r) => ({
      id: r.id,
      timeframe: r.timeframe,
      bucketStart: r.bucketStart.toISOString(),
      openPrice: r.openPrice,
      highPrice: r.highPrice,
      lowPrice: r.lowPrice,
      closePrice: r.closePrice,
      volumeUnits: r.volumeUnits,
      volumeAeros: r.volumeAeros,
      tradeCount: r.tradeCount,
      methodologyVersion: r.methodologyVersion,
    }));
  }

  const accountingSnapshot = await getAccountingPreservationSnapshot();

  return db.transaction(async (tx) => {
    const batchNumber = await nextArchiveBatchNumber(tx);

    const jsonContent = JSON.stringify(
      {
        batchNumber,
        datasetKey: params.datasetKey,
        exportedAt: now.toISOString(),
        cutoffDate: cutoffDate.toISOString(),
        recordCount: recordsJson.length,
        records: recordsJson,
      },
      null,
      2,
    );

    const csvLines = [
      UTF8_BOM + csvHeader(csvColumns),
      ...recordsJson.map((r) => csvRow(csvColumns.map((col) => r[col]))),
    ];
    const csvContent = csvLines.join("");

    const accountingContent = JSON.stringify(
      {
        capturedAt: now.toISOString(),
        currency: CURRENCY_NAME,
        ...accountingSnapshot,
      },
      null,
      2,
    );

    const jsonHash = sha256Hex(jsonContent);
    const csvHash = sha256Hex(csvContent);
    const accountingHash = sha256Hex(accountingContent);
    const verificationToken = `VRF-${sha256Hex(`${batchNumber}:${jsonHash}:${recordsJson.length}`).slice(0, 8).toUpperCase()}`;

    const manifestObj = {
      archiveVersion: "V4.0",
      schemaVersion: "0008",
      application: "Aeros Pay V4",
      batchNumber,
      datasetKey: params.datasetKey,
      createdAt: now.toISOString(),
      cutoffDate: cutoffDate.toISOString(),
      periodStart: periodStart?.toISOString() ?? null,
      periodEnd: periodEnd?.toISOString() ?? null,
      recordCount: recordsJson.length,
      verificationToken,
      accountingSnapshot,
      files: [
        {
          path: `data/${params.datasetKey}.json`,
          byteSize: Buffer.byteLength(jsonContent, "utf8"),
          sha256: jsonHash,
        },
        {
          path: `data/${params.datasetKey}.csv`,
          byteSize: Buffer.byteLength(csvContent, "utf8"),
          sha256: csvHash,
        },
        {
          path: "accounting-snapshot.json",
          byteSize: Buffer.byteLength(accountingContent, "utf8"),
          sha256: accountingHash,
        },
      ],
    };

    const manifestContent = JSON.stringify(manifestObj, null, 2);

    const zipBuffer = buildZipArchive([
      { name: "manifest.json", content: manifestContent },
      { name: "accounting-snapshot.json", content: accountingContent },
      { name: `data/${params.datasetKey}.json`, content: jsonContent },
      { name: `data/${params.datasetKey}.csv`, content: csvContent },
    ]);

    const zipChecksum = sha256Hex(zipBuffer);

    const [created] = await tx
      .insert(archiveBatches)
      .values({
        batchNumber,
        datasetKey: params.datasetKey,
        archiveVersion: "V4.0",
        schemaVersion: "0008",
        cutoffDate,
        periodStart,
        periodEnd,
        recordCount: recordsJson.length,
        sha256Checksum: zipChecksum,
        verificationToken,
        manifestJson: manifestObj,
        recordIdsJson: recordIds,
        zipPayloadBase64: zipBuffer.toString("base64"),
        byteSize: zipBuffer.length,
        status: "CREATED",
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
      newValue: `${created.batchNumber} (${created.datasetKey}): ${created.recordCount} records, ${created.byteSize} bytes`,
      metadata: {
        batchNumber: created.batchNumber,
        datasetKey: created.datasetKey,
        recordCount: created.recordCount,
        sha256Checksum: created.sha256Checksum,
        verificationToken: created.verificationToken,
      },
    });

    return created;
  });
}

/**
 * Marks an archive batch as downloaded when the Government streams the `.zip`
 * file from `/api/gov/archive/[batchId]`.
 */
export async function markArchiveBatchDownloaded(batchId: string): Promise<ArchiveBatch | null> {
  const [batch] = await db
    .select()
    .from(archiveBatches)
    .where(eq(archiveBatches.id, batchId))
    .limit(1);
  if (!batch) return null;

  if (batch.status === "CREATED") {
    const [updated] = await db
      .update(archiveBatches)
      .set({ status: "DOWNLOADED", downloadedAt: new Date() })
      .where(eq(archiveBatches.id, batch.id))
      .returning();
    return updated;
  }

  return batch;
}

/**
 * Verifies an archive batch by recomputing the `.zip` binary's SHA-256 checksum
 * and matching the `verificationToken` from `manifest.json`.
 *
 * An archive batch MUST be verified before `clearArchiveBatch` will allow any
 * records to be cleared (Spec §10).
 */
export async function verifyArchiveBatch(params: {
  govId: string;
  govUsername: string;
  batchId: string;
  verificationToken: string;
}): Promise<ArchiveBatch> {
  return db.transaction(async (tx) => {
    const [batch] = await tx
      .select()
      .from(archiveBatches)
      .where(eq(archiveBatches.id, params.batchId))
      .for("update");

    if (!batch) {
      throw new ArchiveError("Archive batch not found.");
    }
    if (batch.status === "CLEARED") {
      throw new ArchiveError(
        `Archive batch ${batch.batchNumber} has already been cleared.`,
      );
    }

    const tokenInput = params.verificationToken.trim().toUpperCase();
    if (
      tokenInput !== batch.verificationToken.toUpperCase() &&
      tokenInput !== batch.sha256Checksum.slice(0, 12).toUpperCase() &&
      tokenInput !== batch.sha256Checksum.toUpperCase()
    ) {
      throw new ArchiveError(
        "Verification token mismatch. Open manifest.json inside the downloaded ZIP and enter the exact verificationToken (or SHA-256 checksum).",
      );
    }

    const zipBytes = Buffer.from(batch.zipPayloadBase64, "base64");
    const recomputedHash = sha256Hex(zipBytes);
    if (recomputedHash !== batch.sha256Checksum) {
      throw new ArchiveError(
        "Archive integrity check failed: stored ZIP payload hash does not match expected SHA-256 checksum.",
      );
    }

    const now = new Date();
    const [verified] = await tx
      .update(archiveBatches)
      .set({
        status: "VERIFIED",
        downloadedAt: batch.downloadedAt ?? now,
        verifiedAt: now,
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
        sha256Checksum: batch.sha256Checksum,
      },
    });

    return verified;
  });
}

/**
 * Safely clears the exact historical records covered by a VERIFIED archive
 * batch while preserving 100% of wallet balances, supply invariants, cumulative
 * credit/debit counters, company lifetime sales figures, and an immutable
 * `accounting_checkpoints` row (Spec §§8, 9, 10, 11).
 */
export async function clearArchiveBatch(params: {
  govId: string;
  govUsername: string;
  batchId: string;
  verificationToken: string;
  confirmPhrase: string;
}): Promise<{
  batch: ArchiveBatch;
  checkpoint: AccountingCheckpoint | null;
  clearedCount: number;
}> {
  if (params.confirmPhrase.trim() !== ARCHIVE_CLEAR_CONFIRM_PHRASE) {
    throw new ArchiveError(
      `Please type the exact confirmation phrase: ${ARCHIVE_CLEAR_CONFIRM_PHRASE}`,
    );
  }

  return db.transaction(async (tx: Tx) => {
    const [gov] = await tx.select().from(government).for("update");
    if (!gov || !gov.archiveCenterEnabled) {
      throw new ArchiveError("Archive Center is currently disabled.");
    }

    const [batch] = await tx
      .select()
      .from(archiveBatches)
      .where(eq(archiveBatches.id, params.batchId))
      .for("update");

    if (!batch) {
      throw new ArchiveError("Archive batch not found.");
    }
    if (batch.status === "CLEARED" || batch.clearedAt !== null) {
      throw new ArchiveError(
        `Archive batch ${batch.batchNumber} has already been cleared (idempotent guard).`,
      );
    }
    if (batch.status !== "VERIFIED") {
      throw new ArchiveError(
        `Archive batch ${batch.batchNumber} must be downloaded and VERIFIED before its records can be cleared.`,
      );
    }

    const tokenInput = params.verificationToken.trim().toUpperCase();
    if (
      tokenInput !== batch.verificationToken.toUpperCase() &&
      tokenInput !== batch.sha256Checksum.slice(0, 12).toUpperCase() &&
      tokenInput !== batch.sha256Checksum.toUpperCase()
    ) {
      throw new ArchiveError("Invalid verification token for this archive batch.");
    }

    // Re-verify ZIP checksum immediately before deletion
    const zipBytes = Buffer.from(batch.zipPayloadBase64, "base64");
    if (sha256Hex(zipBytes) !== batch.sha256Checksum) {
      throw new ArchiveError(
        "Archive payload checksum mismatch — aborting clear operation.",
      );
    }

    const targetIds = Array.isArray(batch.recordIdsJson)
      ? (batch.recordIdsJson as string[])
      : [];

    if (targetIds.length === 0) {
      throw new ArchiveError("Archive batch contains no record IDs to clear.");
    }

    let clearedCount = 0;
    let createdCheckpoint: AccountingCheckpoint | null = null;

    if (batch.datasetKey === "transactions_history") {
      // Lock and inspect the target transaction rows that still exist
      const rowsToDelete = await tx
        .select()
        .from(transactions)
        .where(
          and(
            inArray(transactions.id, targetIds),
            inArray(transactions.type, [...CATEGORY_C_ELIGIBLE_TX_TYPES]),
            sql`${transactions.invoiceId} IS NULL`,
            sql`${transactions.reversesTransactionId} IS NULL`,
            sql`NOT EXISTS (
              SELECT 1 FROM "transactions" r
              WHERE r."reverses_transaction_id" = ${transactions.id}
            )`,
            sql`NOT EXISTS (
              SELECT 1 FROM "refund_requests" rf
              WHERE rf."source_tx_ref" = ${transactions.txRef}
                 OR rf."settlement_tx_ref" = ${transactions.txRef}
            )`,
          ),
        )
        .orderBy(asc(transactions.createdAt), asc(transactions.id))
        .for("update");

      if (rowsToDelete.length === 0) {
        throw new ArchiveError(
          "No eligible transaction rows remain to be cleared for this batch.",
        );
      }

      // Compute cumulative accounting rollups per wallet before deleting rows
      let grossVolumeCleared = 0;
      let taxVolumeCleared = 0;
      let netVolumeCleared = 0;
      let govCreditsDelta = 0;
      let govDebitsDelta = 0;
      let govTaxDelta = 0;
      let govTxCountDelta = 0;

      const userRollups = new Map<
        string,
        { credits: number; debits: number; count: number }
      >();
      const companyRollups = new Map<
        string,
        { credits: number; debits: number; count: number; salesNet: number }
      >();

      for (const r of rowsToDelete) {
        grossVolumeCleared += r.grossAmount;
        taxVolumeCleared += r.taxAmount;
        netVolumeCleared += r.netAmount;

        // Sender debit accounting
        if (r.senderType === "USER" && r.senderId) {
          const cur = userRollups.get(r.senderId) ?? { credits: 0, debits: 0, count: 0 };
          cur.debits += r.grossAmount;
          cur.count += 1;
          userRollups.set(r.senderId, cur);
        } else if (r.senderType === "COMPANY" && r.senderId) {
          const cur = companyRollups.get(r.senderId) ?? {
            credits: 0,
            debits: 0,
            count: 0,
            salesNet: 0,
          };
          cur.debits += r.grossAmount;
          cur.count += 1;
          companyRollups.set(r.senderId, cur);
        } else if (r.senderType === "GOVERNMENT") {
          govDebitsDelta += r.grossAmount;
          govTxCountDelta += 1;
        }

        // Receiver credit accounting
        if (r.receiverType === "USER" && r.receiverId) {
          const cur = userRollups.get(r.receiverId) ?? { credits: 0, debits: 0, count: 0 };
          cur.credits += r.netAmount;
          if (r.senderId !== r.receiverId) cur.count += 1;
          userRollups.set(r.receiverId, cur);
        } else if (r.receiverType === "COMPANY" && r.receiverId) {
          const cur = companyRollups.get(r.receiverId) ?? {
            credits: 0,
            debits: 0,
            count: 0,
            salesNet: 0,
          };
          cur.credits += r.netAmount;
          if (r.senderId !== r.receiverId) cur.count += 1;
          if (r.type === "COMPANY_SALE" || r.type === "INVOICE_PAYMENT") {
            cur.salesNet += r.netAmount;
          }
          companyRollups.set(r.receiverId, cur);
        } else if (r.receiverType === "GOVERNMENT") {
          govCreditsDelta += r.netAmount;
          govTxCountDelta += 1;
        }

        // Tax collected by the Government Treasury on this transaction
        if (r.taxAmount > 0) {
          govTaxDelta += r.taxAmount;
          govCreditsDelta += r.taxAmount;
          if (r.senderType !== "GOVERNMENT" && r.receiverType !== "GOVERNMENT") {
            govTxCountDelta += 1;
          }
        }
      }

      // Persist cumulative counters on users, companies, and government
      for (const [userId, delta] of userRollups.entries()) {
        await tx
          .update(users)
          .set({
            archivedCredits: sql`${users.archivedCredits} + ${delta.credits}`,
            archivedDebits: sql`${users.archivedDebits} + ${delta.debits}`,
            archivedTxCount: sql`${users.archivedTxCount} + ${delta.count}`,
          })
          .where(eq(users.id, userId));
      }

      for (const [companyId, delta] of companyRollups.entries()) {
        await tx
          .update(companies)
          .set({
            archivedCredits: sql`${companies.archivedCredits} + ${delta.credits}`,
            archivedDebits: sql`${companies.archivedDebits} + ${delta.debits}`,
            archivedTxCount: sql`${companies.archivedTxCount} + ${delta.count}`,
            archivedSalesNet: sql`${companies.archivedSalesNet} + ${delta.salesNet}`,
          })
          .where(eq(companies.id, companyId));
      }

      if (govCreditsDelta > 0 || govDebitsDelta > 0 || govTaxDelta > 0 || govTxCountDelta > 0) {
        await tx
          .update(government)
          .set({
            archivedCredits: sql`${government.archivedCredits} + ${govCreditsDelta}`,
            archivedDebits: sql`${government.archivedDebits} + ${govDebitsDelta}`,
            archivedTaxCollected: sql`${government.archivedTaxCollected} + ${govTaxDelta}`,
            archivedTxCount: sql`${government.archivedTxCount} + ${govTxCountDelta}`,
          })
          .where(eq(government.id, gov.id));
      }

      // Delete the archived Category C rows from `transactions`
      const deleteIds = rowsToDelete.map((r) => r.id);
      const deletedRows = await tx
        .delete(transactions)
        .where(inArray(transactions.id, deleteIds))
        .returning({ id: transactions.id });
      clearedCount = deletedRows.length;

      // Verify post-delete supply & balance invariant inside the transaction!
      const [[userSum], [companySum], [govAfter]] = await Promise.all([
        tx
          .select({ total: sql<number>`coalesce(sum(${users.balance}), 0)::int` })
          .from(users),
        tx
          .select({ total: sql<number>`coalesce(sum(${companies.balance}), 0)::int` })
          .from(companies),
        tx.select().from(government).where(eq(government.id, gov.id)).limit(1),
      ]);

      const treasuryBal = govAfter?.balance ?? 0;
      const userHeldBal = userSum?.total ?? 0;
      const companyHeldBal = companySum?.total ?? 0;
      const retiredBal = govAfter?.retiredSupply ?? 0;
      const totalSupplyBal = govAfter?.totalSupply ?? 0;

      if (treasuryBal + userHeldBal + companyHeldBal + retiredBal !== totalSupplyBal) {
        throw new ArchiveError(
          "CRITICAL INVARIANT VIOLATION: Supply balance mismatch detected during archive clear. Rolling back transaction.",
        );
      }

      const checkpointNumber = await nextCheckpointNumber(tx);
      const periodStart = rowsToDelete[0].createdAt;
      const periodEnd = rowsToDelete[rowsToDelete.length - 1].createdAt;

      const walletRollupsObj = {
        government: {
          creditsCleared: govCreditsDelta,
          debitsCleared: govDebitsDelta,
          taxCleared: govTaxDelta,
          txCountCleared: govTxCountDelta,
          closingBalance: treasuryBal,
        },
        users: Object.fromEntries(userRollups.entries()),
        companies: Object.fromEntries(companyRollups.entries()),
      };

      const checkpointHash = sha256Hex(
        JSON.stringify({
          checkpointNumber,
          archiveBatchId: batch.id,
          archiveSha256: batch.sha256Checksum,
          clearedCount,
          grossVolumeCleared,
          taxVolumeCleared,
          netVolumeCleared,
          totalSupplyBal,
          treasuryBal,
          userHeldBal,
          companyHeldBal,
        }),
      );

      const [cp] = await tx
        .insert(accountingCheckpoints)
        .values({
          checkpointNumber,
          archiveBatchId: batch.id,
          periodStart,
          periodEnd,
          clearedTxCount: clearedCount,
          grossVolumeCleared,
          taxVolumeCleared,
          netVolumeCleared,
          totalSupplySnapshot: totalSupplyBal,
          retiredSupplySnapshot: retiredBal,
          treasuryBalanceSnapshot: treasuryBal,
          userHeldBalanceSnapshot: userHeldBal,
          companyHeldBalanceSnapshot: companyHeldBal,
          walletRollupsJson: walletRollupsObj,
          checkpointHash,
          createdByGovId: params.govId,
        })
        .returning();

      createdCheckpoint = cp;
    } else if (batch.datasetKey === "settled_market_orders") {
      const deleted = await tx
        .delete(marketOrders)
        .where(inArray(marketOrders.id, targetIds))
        .returning({ id: marketOrders.id });
      clearedCount = deleted.length;
    } else if (batch.datasetKey === "closed_refunds") {
      const deleted = await tx
        .delete(refundRequests)
        .where(
          and(
            inArray(refundRequests.id, targetIds),
            inArray(refundRequests.status, ["COMPLETED", "REJECTED"]),
          ),
        )
        .returning({ id: refundRequests.id });
      clearedCount = deleted.length;
    } else if (batch.datasetKey === "old_market_candles") {
      const deleted = await tx
        .delete(marketCandles)
        .where(inArray(marketCandles.id, targetIds))
        .returning({ id: marketCandles.id });
      clearedCount = deleted.length;
    } else {
      throw new ArchiveError(`Unsupported archive dataset: ${batch.datasetKey}`);
    }

    const [updatedBatch] = await tx
      .update(archiveBatches)
      .set({
        status: "CLEARED",
        clearedAt: new Date(),
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
      newValue: `CLEARED (${clearedCount} records removed${createdCheckpoint ? `, checkpoint ${createdCheckpoint.checkpointNumber}` : ""})`,
      reason: ARCHIVE_CLEAR_CONFIRM_PHRASE,
      metadata: {
        batchNumber: batch.batchNumber,
        datasetKey: batch.datasetKey,
        clearedCount,
        checkpointNumber: createdCheckpoint?.checkpointNumber ?? null,
        checkpointHash: createdCheckpoint?.checkpointHash ?? null,
      },
    });

    return {
      batch: updatedBatch,
      checkpoint: createdCheckpoint,
      clearedCount,
    };
  });
}

export async function getArchiveBatchesList(limit = 50): Promise<
  Array<Omit<ArchiveBatch, "zipPayloadBase64">>
> {
  return db
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
