import "server-only";
import { db } from "@/db/client";
import { auditLogs } from "@/db/schema";

type Executor = Pick<typeof db, "insert">;

/**
 * Records an administrative or system event.
 *
 * V2 adds first-class `previousValue` / `newValue` / `reason` columns so an
 * audit row is readable on its own without having to interpret the metadata
 * blob (spec §48). `metadata` remains available for anything structured.
 */
export async function recordAudit(
  executor: Executor,
  entry: {
    action: string;
    actorType: "GOVERNMENT" | "USER" | "COMPANY";
    actorId?: string | null;
    actorLabel?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    previousValue?: string | null;
    newValue?: string | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  await executor.insert(auditLogs).values({
    action: entry.action,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    actorLabel: entry.actorLabel ?? null,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    previousValue: entry.previousValue ?? null,
    newValue: entry.newValue ?? null,
    reason: entry.reason ?? null,
    metadata: entry.metadata ?? null,
  });
}
