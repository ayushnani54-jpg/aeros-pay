import "server-only";
import { db } from "@/db/client";
import { auditLogs } from "@/db/schema";

type Executor = Pick<typeof db, "insert">;

export async function recordAudit(
  executor: Executor,
  entry: {
    action: string;
    actorType: "GOVERNMENT" | "USER";
    actorId?: string | null;
    actorLabel?: string | null;
    targetType?: string | null;
    targetId?: string | null;
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
    metadata: entry.metadata ?? null,
  });
}
