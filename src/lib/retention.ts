import "server-only";
import { db } from "@/db/client";
import {
  auditLogs,
  notifications,
  retentionSettings,
  supportMessages,
  updates,
} from "@/db/schema";
import { and, isNull, lt, sql } from "drizzle-orm";
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
