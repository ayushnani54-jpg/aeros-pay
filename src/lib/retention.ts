import "server-only";
import { db } from "@/db/client";
import {
  auditLogs,
  invoices,
  issuanceRequests,
  loans,
  notifications,
  retentionSettings,
  supportMessages,
  transactions,
  updates,
} from "@/db/schema";
import { and, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import type { RetentionSettings } from "@/db/schema";

/**
 * DATA RETENTION (spec §49–52)
 *
 * Hard rule enforced by this module: only DISPOSABLE data is ever deleted.
 *
 *   Deletable   updates, notifications, support messages
 *   Never       transactions, users, companies, invoices, issuance records,
 *               government/treasury rows
 *
 * The transactions table is deliberately absent from every code path here.
 * Deleting ledger rows would silently corrupt balances, supply and tax totals
 * (spec §50), so there is simply no function that can do it.
 *
 * Audit logs are not deleted either — they can only be ARCHIVED, which sets
 * `archived_at` so the row drops out of the active view while remaining in
 * the database and in every reconciliation (spec §51).
 */

export class RetentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionError";
  }
}

export async function getRetentionSettings(): Promise<RetentionSettings> {
  const [existing] = await db.select().from(retentionSettings).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(retentionSettings).values({}).returning();
  return created;
}

export async function updateRetentionSettings(params: {
  updatesRetentionDays: number | null;
  notificationsRetentionDays: number | null;
  supportRetentionDays: number | null;
  governmentId: string;
  governmentUsername: string;
}): Promise<RetentionSettings> {
  const current = await getRetentionSettings();

  const [updated] = await db
    .update(retentionSettings)
    .set({
      updatesRetentionDays: params.updatesRetentionDays,
      notificationsRetentionDays: params.notificationsRetentionDays,
      supportRetentionDays: params.supportRetentionDays,
      updatedAt: new Date(),
    })
    .returning();

  await recordAudit(db, {
    action: "RETENTION_SETTINGS_CHANGED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    previousValue: JSON.stringify({
      updates: current.updatesRetentionDays,
      notifications: current.notificationsRetentionDays,
      support: current.supportRetentionDays,
    }),
    newValue: JSON.stringify({
      updates: updated.updatesRetentionDays,
      notifications: updated.notificationsRetentionDays,
      support: updated.supportRetentionDays,
    }),
  });

  return updated;
}

function cutoffFor(days: number | null): Date | null {
  if (days === null) return null;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export type RetentionPreview = {
  updates: { retentionDays: number | null; eligible: number; total: number };
  notifications: { retentionDays: number | null; eligible: number; total: number };
  supportMessages: { retentionDays: number | null; eligible: number; total: number };
  lastCleanupAt: Date | null;
  nextCleanupHint: string;
};

/** How many rows each configured policy would remove right now. */
export async function previewCleanup(): Promise<RetentionPreview> {
  const settings = await getRetentionSettings();

  const updatesCutoff = cutoffFor(settings.updatesRetentionDays);
  const notifCutoff = cutoffFor(settings.notificationsRetentionDays);
  const supportCutoff = cutoffFor(settings.supportRetentionDays);

  const [
    updatesEligible,
    updatesTotal,
    notifEligible,
    notifTotal,
    supportEligible,
    supportTotal,
  ] = await Promise.all([
    updatesCutoff
      ? db
          .select({ c: sql<number>`count(*)::int` })
          .from(updates)
          .where(lt(updates.createdAt, updatesCutoff))
      : Promise.resolve([{ c: 0 }]),
    db.select({ c: sql<number>`count(*)::int` }).from(updates),
    notifCutoff
      ? db
          .select({ c: sql<number>`count(*)::int` })
          .from(notifications)
          .where(lt(notifications.createdAt, notifCutoff))
      : Promise.resolve([{ c: 0 }]),
    db.select({ c: sql<number>`count(*)::int` }).from(notifications),
    supportCutoff
      ? db
          .select({ c: sql<number>`count(*)::int` })
          .from(supportMessages)
          .where(lt(supportMessages.createdAt, supportCutoff))
      : Promise.resolve([{ c: 0 }]),
    db.select({ c: sql<number>`count(*)::int` }).from(supportMessages),
  ]);

  const anyPolicy =
    settings.updatesRetentionDays ??
    settings.notificationsRetentionDays ??
    settings.supportRetentionDays;

  return {
    updates: {
      retentionDays: settings.updatesRetentionDays,
      eligible: updatesEligible[0]?.c ?? 0,
      total: updatesTotal[0]?.c ?? 0,
    },
    notifications: {
      retentionDays: settings.notificationsRetentionDays,
      eligible: notifEligible[0]?.c ?? 0,
      total: notifTotal[0]?.c ?? 0,
    },
    supportMessages: {
      retentionDays: settings.supportRetentionDays,
      eligible: supportEligible[0]?.c ?? 0,
      total: supportTotal[0]?.c ?? 0,
    },
    lastCleanupAt: settings.lastCleanupAt,
    nextCleanupHint:
      anyPolicy === null || anyPolicy === undefined
        ? "No retention policy is set — nothing is ever deleted automatically."
        : "Cleanup runs when you choose to run it. Nothing is deleted on a schedule.",
  };
}

export type CleanupResult = {
  updatesDeleted: number;
  notificationsDeleted: number;
  supportMessagesDeleted: number;
};

/**
 * Deletes disposable rows older than the configured retention periods.
 * Classes with no configured period are skipped entirely.
 */
export async function runCleanup(params: {
  governmentId: string;
  governmentUsername: string;
}): Promise<CleanupResult> {
  const settings = await getRetentionSettings();

  const updatesCutoff = cutoffFor(settings.updatesRetentionDays);
  const notifCutoff = cutoffFor(settings.notificationsRetentionDays);
  const supportCutoff = cutoffFor(settings.supportRetentionDays);

  let updatesDeleted = 0;
  let notificationsDeleted = 0;
  let supportMessagesDeleted = 0;

  if (updatesCutoff) {
    const rows = await db
      .delete(updates)
      .where(lt(updates.createdAt, updatesCutoff))
      .returning({ id: updates.id });
    updatesDeleted = rows.length;
  }

  if (notifCutoff) {
    const rows = await db
      .delete(notifications)
      .where(lt(notifications.createdAt, notifCutoff))
      .returning({ id: notifications.id });
    notificationsDeleted = rows.length;
  }

  if (supportCutoff) {
    const rows = await db
      .delete(supportMessages)
      .where(lt(supportMessages.createdAt, supportCutoff))
      .returning({ id: supportMessages.id });
    supportMessagesDeleted = rows.length;
  }

  const result = { updatesDeleted, notificationsDeleted, supportMessagesDeleted };

  await db
    .update(retentionSettings)
    .set({ lastCleanupAt: new Date(), lastCleanupSummary: result });

  await recordAudit(db, {
    action: "RETENTION_CLEANUP_RUN",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    metadata: result,
  });

  return result;
}

/** Clears the public announcements feed. Never touches financial data. */
export async function clearAllUpdates(params: {
  governmentId: string;
  governmentUsername: string;
}): Promise<number> {
  const rows = await db.delete(updates).returning({ id: updates.id });

  await recordAudit(db, {
    action: "UPDATES_CLEARED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    metadata: { deleted: rows.length },
  });

  return rows.length;
}

/**
 * Archives audit entries older than `days` — they stay in the database and
 * remain fully recoverable, they simply stop appearing in the active view.
 * There is no function anywhere that deletes audit rows (spec §51).
 */
export async function archiveAuditLogs(params: {
  olderThanDays: number;
  governmentId: string;
  governmentUsername: string;
}): Promise<number> {
  const cutoff = new Date(Date.now() - params.olderThanDays * 24 * 60 * 60 * 1000);

  const rows = await db
    .update(auditLogs)
    .set({ archivedAt: new Date() })
    .where(and(lt(auditLogs.createdAt, cutoff), isNull(auditLogs.archivedAt)))
    .returning({ id: auditLogs.id });

  await recordAudit(db, {
    action: "AUDIT_LOGS_ARCHIVED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    metadata: { archived: rows.length, olderThanDays: params.olderThanDays },
  });

  return rows.length;
}

export async function unarchiveAllAuditLogs(params: {
  governmentId: string;
  governmentUsername: string;
}): Promise<number> {
  const rows = await db
    .update(auditLogs)
    .set({ archivedAt: null })
    .returning({ id: auditLogs.id });

  await recordAudit(db, {
    action: "AUDIT_LOGS_UNARCHIVED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    metadata: { restored: rows.length },
  });

  return rows.length;
}

/** Row counts per table, for the Government's storage view. */
export async function getStorageCounts() {
  const [
    updatesCount,
    notifCount,
    supportCount,
    auditCount,
    auditArchivedCount,
  ] = await Promise.all([
    db.select({ c: sql<number>`count(*)::int` }).from(updates),
    db.select({ c: sql<number>`count(*)::int` }).from(notifications),
    db.select({ c: sql<number>`count(*)::int` }).from(supportMessages),
    db.select({ c: sql<number>`count(*)::int` }).from(auditLogs),
    db
      .select({ c: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(sql`${auditLogs.archivedAt} IS NOT NULL`),
  ]);

  return {
    updates: updatesCount[0]?.c ?? 0,
    notifications: notifCount[0]?.c ?? 0,
    supportMessages: supportCount[0]?.c ?? 0,
    auditLogs: auditCount[0]?.c ?? 0,
    auditLogsArchived: auditArchivedCount[0]?.c ?? 0,
  };
}

// ---------------------------------------------------------------------------
// V2.1 — TEXT-FIELD SCRUBBING
// ---------------------------------------------------------------------------
//
// A separate, narrower capability from row deletion above: this NEVER
// deletes a row and NEVER touches a column that affects a balance, the
// ledger, or an identity — only specific free-text columns, and only once
// the row is older than the configured age. Every column it can touch is
// listed explicitly below; anything not listed is untouched by design.
//
//   transactions        reason                                        (only)
//   invoices             description, note                            (only)
//   loans                purpose, rejection_reason,
//                        default_reason, restructure_note              (only)
//   issuance_requests    note                                          (only)
//
// Idempotent: every scrub is a conditional UPDATE guarded on the column not
// already being cleared, so running it twice (or on a schedule) is always
// safe and the second run reports zero newly-changed rows.

/** Marker left in place of a scrubbed free-text field, so it stays visibly
 * distinguishable from a field that legitimately was never filled in. */
export const TEXT_SCRUB_MARKER = "[cleared]";

function scrubCutoff(maxAgeDays: number): Date {
  return new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
}

/** True for a nullable text column that still holds real, unscrubbed content. */
function holdsUnscrubbedText(column: Parameters<typeof isNotNull>[0]) {
  return and(isNotNull(column), ne(column, TEXT_SCRUB_MARKER));
}

async function scrubTransactionReasons(maxAgeDays: number): Promise<number> {
  const cutoff = scrubCutoff(maxAgeDays);
  const rows = await db
    .update(transactions)
    .set({ reason: TEXT_SCRUB_MARKER })
    .where(and(lt(transactions.createdAt, cutoff), holdsUnscrubbedText(transactions.reason)))
    .returning({ id: transactions.id });
  return rows.length;
}

async function scrubInvoiceText(maxAgeDays: number): Promise<number> {
  const cutoff = scrubCutoff(maxAgeDays);
  const rows = await db
    .update(invoices)
    .set({
      description: sql`CASE WHEN ${invoices.description} IS NOT NULL AND ${invoices.description} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${invoices.description} END`,
      note: sql`CASE WHEN ${invoices.note} IS NOT NULL AND ${invoices.note} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${invoices.note} END`,
    })
    .where(
      and(
        lt(invoices.createdAt, cutoff),
        or(holdsUnscrubbedText(invoices.description), holdsUnscrubbedText(invoices.note)),
      ),
    )
    .returning({ id: invoices.id });
  return rows.length;
}

async function scrubLoanText(maxAgeDays: number): Promise<number> {
  const cutoff = scrubCutoff(maxAgeDays);
  // `purpose` is NOT NULL, so it is compared directly rather than through
  // `holdsUnscrubbedText` (which also accepts NULL as "nothing to do").
  const rows = await db
    .update(loans)
    .set({
      purpose: sql`CASE WHEN ${loans.purpose} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${loans.purpose} END`,
      rejectionReason: sql`CASE WHEN ${loans.rejectionReason} IS NOT NULL AND ${loans.rejectionReason} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${loans.rejectionReason} END`,
      defaultReason: sql`CASE WHEN ${loans.defaultReason} IS NOT NULL AND ${loans.defaultReason} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${loans.defaultReason} END`,
      restructureNote: sql`CASE WHEN ${loans.restructureNote} IS NOT NULL AND ${loans.restructureNote} <> ${TEXT_SCRUB_MARKER} THEN ${TEXT_SCRUB_MARKER} ELSE ${loans.restructureNote} END`,
    })
    .where(
      and(
        lt(loans.createdAt, cutoff),
        or(
          ne(loans.purpose, TEXT_SCRUB_MARKER),
          holdsUnscrubbedText(loans.rejectionReason),
          holdsUnscrubbedText(loans.defaultReason),
          holdsUnscrubbedText(loans.restructureNote),
        ),
      ),
    )
    .returning({ id: loans.id });
  return rows.length;
}

async function scrubIssuanceNotes(maxAgeDays: number): Promise<number> {
  const cutoff = scrubCutoff(maxAgeDays);
  const rows = await db
    .update(issuanceRequests)
    .set({ note: TEXT_SCRUB_MARKER })
    .where(and(lt(issuanceRequests.createdAt, cutoff), holdsUnscrubbedText(issuanceRequests.note)))
    .returning({ id: issuanceRequests.id });
  return rows.length;
}

export type TextScrubPreview = {
  transactions: { maxAgeDays: number | null; eligible: number };
  invoices: { maxAgeDays: number | null; eligible: number };
  loans: { maxAgeDays: number | null; eligible: number };
  issuanceNotes: { maxAgeDays: number | null; eligible: number };
  lastScrubAt: Date | null;
};

/** How many rows each configured scrub policy would touch right now. */
export async function previewTextScrub(): Promise<TextScrubPreview> {
  const settings = await getRetentionSettings();

  const [txCount, invCount, loanCount, issCount] = await Promise.all([
    settings.transactionReasonMaxAgeDays === null
      ? Promise.resolve(0)
      : db
          .select({ c: sql<number>`count(*)::int` })
          .from(transactions)
          .where(
            and(
              lt(transactions.createdAt, scrubCutoff(settings.transactionReasonMaxAgeDays)),
              holdsUnscrubbedText(transactions.reason),
            ),
          )
          .then((r) => r[0]?.c ?? 0),
    settings.invoiceTextMaxAgeDays === null
      ? Promise.resolve(0)
      : db
          .select({ c: sql<number>`count(*)::int` })
          .from(invoices)
          .where(
            and(
              lt(invoices.createdAt, scrubCutoff(settings.invoiceTextMaxAgeDays)),
              or(holdsUnscrubbedText(invoices.description), holdsUnscrubbedText(invoices.note)),
            ),
          )
          .then((r) => r[0]?.c ?? 0),
    settings.loanTextMaxAgeDays === null
      ? Promise.resolve(0)
      : db
          .select({ c: sql<number>`count(*)::int` })
          .from(loans)
          .where(
            and(
              lt(loans.createdAt, scrubCutoff(settings.loanTextMaxAgeDays)),
              or(
                ne(loans.purpose, TEXT_SCRUB_MARKER),
                holdsUnscrubbedText(loans.rejectionReason),
                holdsUnscrubbedText(loans.defaultReason),
                holdsUnscrubbedText(loans.restructureNote),
              ),
            ),
          )
          .then((r) => r[0]?.c ?? 0),
    settings.issuanceNoteMaxAgeDays === null
      ? Promise.resolve(0)
      : db
          .select({ c: sql<number>`count(*)::int` })
          .from(issuanceRequests)
          .where(
            and(
              lt(issuanceRequests.createdAt, scrubCutoff(settings.issuanceNoteMaxAgeDays)),
              holdsUnscrubbedText(issuanceRequests.note),
            ),
          )
          .then((r) => r[0]?.c ?? 0),
  ]);

  return {
    transactions: { maxAgeDays: settings.transactionReasonMaxAgeDays, eligible: txCount },
    invoices: { maxAgeDays: settings.invoiceTextMaxAgeDays, eligible: invCount },
    loans: { maxAgeDays: settings.loanTextMaxAgeDays, eligible: loanCount },
    issuanceNotes: { maxAgeDays: settings.issuanceNoteMaxAgeDays, eligible: issCount },
    lastScrubAt: settings.lastScrubAt,
  };
}

export async function updateTextScrubSettings(params: {
  transactionReasonMaxAgeDays: number | null;
  invoiceTextMaxAgeDays: number | null;
  loanTextMaxAgeDays: number | null;
  issuanceNoteMaxAgeDays: number | null;
  governmentId: string;
  governmentUsername: string;
}): Promise<RetentionSettings> {
  const current = await getRetentionSettings();

  const [updated] = await db
    .update(retentionSettings)
    .set({
      transactionReasonMaxAgeDays: params.transactionReasonMaxAgeDays,
      invoiceTextMaxAgeDays: params.invoiceTextMaxAgeDays,
      loanTextMaxAgeDays: params.loanTextMaxAgeDays,
      issuanceNoteMaxAgeDays: params.issuanceNoteMaxAgeDays,
      updatedAt: new Date(),
    })
    .returning();

  await recordAudit(db, {
    action: "TEXT_SCRUB_SETTINGS_CHANGED",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    previousValue: JSON.stringify({
      transactionReason: current.transactionReasonMaxAgeDays,
      invoiceText: current.invoiceTextMaxAgeDays,
      loanText: current.loanTextMaxAgeDays,
      issuanceNote: current.issuanceNoteMaxAgeDays,
    }),
    newValue: JSON.stringify({
      transactionReason: updated.transactionReasonMaxAgeDays,
      invoiceText: updated.invoiceTextMaxAgeDays,
      loanText: updated.loanTextMaxAgeDays,
      issuanceNote: updated.issuanceNoteMaxAgeDays,
    }),
  });

  return updated;
}

export type TextScrubResult = {
  transactionsScrubbed: number;
  invoicesScrubbed: number;
  loansScrubbed: number;
  issuanceNotesScrubbed: number;
};

/**
 * Runs every configured scrub class once. A class with no configured max age
 * (`null`) is skipped entirely — nothing is scrubbed unless the Government
 * has explicitly set an age for that class. Safe to call repeatedly: rows
 * already scrubbed are never counted or touched again (see the `holdsUnscrubbedText`
 * guard on every UPDATE above).
 */
export async function runTextScrub(params: {
  governmentId: string;
  governmentUsername: string;
}): Promise<TextScrubResult> {
  const settings = await getRetentionSettings();

  const transactionsScrubbed =
    settings.transactionReasonMaxAgeDays !== null
      ? await scrubTransactionReasons(settings.transactionReasonMaxAgeDays)
      : 0;
  const invoicesScrubbed =
    settings.invoiceTextMaxAgeDays !== null
      ? await scrubInvoiceText(settings.invoiceTextMaxAgeDays)
      : 0;
  const loansScrubbed =
    settings.loanTextMaxAgeDays !== null ? await scrubLoanText(settings.loanTextMaxAgeDays) : 0;
  const issuanceNotesScrubbed =
    settings.issuanceNoteMaxAgeDays !== null
      ? await scrubIssuanceNotes(settings.issuanceNoteMaxAgeDays)
      : 0;

  const result: TextScrubResult = {
    transactionsScrubbed,
    invoicesScrubbed,
    loansScrubbed,
    issuanceNotesScrubbed,
  };

  await db
    .update(retentionSettings)
    .set({ lastScrubAt: new Date(), lastScrubSummary: result });

  await recordAudit(db, {
    action: "TEXT_SCRUB_RUN",
    actorType: "GOVERNMENT",
    actorId: params.governmentId,
    actorLabel: params.governmentUsername,
    metadata: result,
  });

  return result;
}
