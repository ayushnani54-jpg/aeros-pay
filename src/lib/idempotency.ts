import "server-only";
import { createHash } from "node:crypto";
import { db } from "@/db/client";
import { idempotencyKeys, retentionSettings } from "@/db/schema";
import { and, eq, lt } from "drizzle-orm";
import { isUniqueViolation } from "./db-errors";
import type { IdempotencyKey } from "@/db/schema";

/**
 * IDEMPOTENCY FOR RETRYABLE FINANCIAL ACTIONS (V3)
 * ===========================================================================
 *
 * The problem: a user taps "Pay" twice, or a flaky connection makes a client
 * retry a request it never saw the answer to. Without a key, the second
 * attempt is indistinguishable from a genuine second payment.
 *
 * The contract this module implements:
 *
 *   first call        performs the action and RECORDS what it produced
 *   identical retry   returns the FIRST result; the action does not run again
 *   concurrent dup    fails cleanly with `IdempotencyInProgressError` — it
 *                     never double-spends and never waits on a lock it would
 *                     lose anyway
 *   same key, other   rejected with `IdempotencyConflictError`; a key can
 *   facts             never be reused to smuggle through a different payment
 *   previous failure  may be retried, and exactly one retrier claims it
 *
 * WHY THE CLAIM IS ITS OWN TRANSACTION
 * ------------------------------------
 * The `INSERT` that claims the key commits on its own, BEFORE the action runs.
 * That is what makes a concurrent duplicate visible to the second caller
 * instead of leaving it blocked on an uncommitted row. The action itself then
 * runs in one ordinary `db.transaction`, so it keeps the whole existing
 * discipline from src/lib/payments.ts: deterministic wallet lock ordering via
 * `lockWallets`, conditional atomic debits, ledger row and notifications all
 * committing together or not at all.
 *
 * The cost of that split is a key row left behind when the action fails: it is
 * marked FAILED rather than deleted, and a later retry re-claims it with a
 * guarded UPDATE, so the failure is auditable and the retry is still
 * single-winner.
 *
 * Rows are short-lived. `expiresAt` is set from
 * `retention_settings.idempotency_key_retention_days` (24 hours by default),
 * and `purgeExpiredIdempotencyKeys` is what the retention engine calls.
 */

export const DEFAULT_IDEMPOTENCY_TTL_HOURS = 24;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 120;

export class IdempotencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyError";
  }
}

/** The key exists but belongs to a different request. */
export class IdempotencyConflictError extends IdempotencyError {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}

/** Another caller is performing this exact action right now. */
export class IdempotencyInProgressError extends IdempotencyError {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyInProgressError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Facts that identify a request. Only primitives, so the digest is stable. */
export type RequestFacts = Record<string, string | number | boolean | null | undefined>;

/**
 * Deterministic digest of the server-normalised request facts.
 *
 * Keys are sorted and `undefined` is dropped, so the same facts always hash
 * the same way regardless of object construction order.
 */
export function fingerprintRequest(facts: RequestFacts): string {
  const normalised = Object.keys(facts)
    .filter((k) => facts[k] !== undefined)
    .sort()
    .map((k) => [k, facts[k]] as const);
  return createHash("sha256").update(JSON.stringify(normalised)).digest("hex");
}

export type IdempotentResult<T> = {
  value: T;
  /** True when the action was NOT run because a previous call already did it. */
  replayed: boolean;
  key: string;
  txRef: string | null;
  entityType: string | null;
  entityId: string | null;
};

/** What `perform` hands back so a later replay can reconstruct the answer. */
export type PerformOutcome<T> = {
  value: T;
  txRef?: string | null;
  entityType?: string | null;
  entityId?: string | null;
};

async function ttlHoursFromSettings(): Promise<number> {
  const [settings] = await db
    .select({ days: retentionSettings.idempotencyKeyRetentionDays })
    .from(retentionSettings)
    .limit(1);
  const days = settings?.days ?? null;
  if (days === null || !Number.isInteger(days) || days < 1) {
    return DEFAULT_IDEMPOTENCY_TTL_HOURS;
  }
  return days * 24;
}

/**
 * Runs `perform` at most once per `key`.
 *
 * `replay` is deliberately REQUIRED: only the call site knows how to rebuild
 * its own result type from the reference that was recorded, and making it
 * mandatory stops anyone from writing a "replay" path that silently returns a
 * wrong or empty answer.
 */
export async function runIdempotent<T>(params: {
  key: string;
  /** The action family, e.g. "MARKETPLACE_ORDER_PAY". Keys never cross scopes. */
  scope: string;
  actor: { type: "USER" | "COMPANY" | "GOVERNMENT"; id: string | null };
  /** Server-established facts that define this request. */
  facts: RequestFacts;
  perform: (tx: Tx) => Promise<PerformOutcome<T>>;
  replay: (record: IdempotencyKey) => Promise<T>;
  /** Overrides the retention-derived TTL. */
  ttlHours?: number;
}): Promise<IdempotentResult<T>> {
  const { key, scope, actor } = params;

  if (typeof key !== "string" || key.trim().length === 0) {
    throw new IdempotencyError("An idempotency key is required.");
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new IdempotencyError(
      `An idempotency key may be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }

  const requestHash = fingerprintRequest(params.facts);
  const ttlHours = params.ttlHours ?? (await ttlHoursFromSettings());
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  // --- claim the key (own transaction, committed before the action runs) ----
  let record: IdempotencyKey | null = null;

  // Bounded retry: the only way a claim can fail twice is if the key was
  // purged by retention between our INSERT and our SELECT.
  for (let attempt = 0; attempt < 2 && record === null; attempt++) {
    try {
      const [inserted] = await db
        .insert(idempotencyKeys)
        .values({
          key,
          scope,
          actorType: actor.type,
          actorId: actor.id,
          requestHash,
          status: "IN_PROGRESS",
          expiresAt,
        })
        .returning();
      record = inserted;
      break;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }

    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);

    if (!existing) continue; // purged underneath us — try to claim again

    if (existing.scope !== scope) {
      throw new IdempotencyConflictError(
        "This idempotency key was already used for a different action.",
      );
    }
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(
        "This idempotency key was already used for a different request.",
      );
    }

    if (existing.status === "SUCCEEDED") {
      return {
        value: await params.replay(existing),
        replayed: true,
        key,
        txRef: existing.resultTxRef,
        entityType: existing.resultEntityType,
        entityId: existing.resultEntityId,
      };
    }

    if (existing.status === "IN_PROGRESS") {
      throw new IdempotencyInProgressError(
        "This request is already being processed. Please wait for it to finish.",
      );
    }

    // FAILED — retryable, but exactly one retrier may claim it. The guarded
    // UPDATE is the race winner; everyone else is told it is in progress.
    const reclaimed = await db
      .update(idempotencyKeys)
      .set({
        status: "IN_PROGRESS",
        errorMessage: null,
        completedAt: null,
        expiresAt,
      })
      .where(and(eq(idempotencyKeys.id, existing.id), eq(idempotencyKeys.status, "FAILED")))
      .returning();

    if (reclaimed.length === 0) {
      throw new IdempotencyInProgressError(
        "This request is already being processed. Please wait for it to finish.",
      );
    }
    record = reclaimed[0];
  }

  if (!record) {
    throw new IdempotencyError("Could not claim this idempotency key. Please try again.");
  }

  // --- we own the key: perform the action in one ordinary transaction ------
  const claimed = record;
  try {
    const outcome = await db.transaction((tx) => params.perform(tx));

    await db
      .update(idempotencyKeys)
      .set({
        status: "SUCCEEDED",
        resultTxRef: outcome.txRef ?? null,
        resultEntityType: outcome.entityType ?? null,
        resultEntityId: outcome.entityId ?? null,
        errorMessage: null,
        completedAt: new Date(),
      })
      .where(eq(idempotencyKeys.id, claimed.id));

    return {
      value: outcome.value,
      replayed: false,
      key,
      txRef: outcome.txRef ?? null,
      entityType: outcome.entityType ?? null,
      entityId: outcome.entityId ?? null,
    };
  } catch (e) {
    // The action's own transaction has already rolled back, so nothing moved.
    // Mark the key FAILED (guarded, so we only ever demote our own claim) and
    // let the original error reach the caller unchanged.
    const message = e instanceof Error ? e.message : String(e);
    await db
      .update(idempotencyKeys)
      .set({ status: "FAILED", errorMessage: message.slice(0, 2000), completedAt: new Date() })
      .where(
        and(eq(idempotencyKeys.id, claimed.id), eq(idempotencyKeys.status, "IN_PROGRESS")),
      );
    throw e;
  }
}

export async function getIdempotencyRecord(key: string): Promise<IdempotencyKey | null> {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  return row ?? null;
}

/**
 * Deletes every key past its expiry, for the retention engine.
 *
 * An expired IN_PROGRESS row is deleted too: it means a process died mid-action
 * more than a full TTL ago, and leaving it would block that key forever. The
 * action it was claiming either committed (and is visible in the ledger) or
 * rolled back, so no money depends on the row.
 */
export async function purgeExpiredIdempotencyKeys(now = new Date()): Promise<number> {
  const rows = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.expiresAt, now))
    .returning({ id: idempotencyKeys.id });
  return rows.length;
}
