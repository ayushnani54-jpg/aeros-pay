import "server-only";
import { db } from "@/db/client";
import { companies, government, taxMatrix } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { recordAudit } from "./audit";
import { resolveTaxRateBp, type TaxContext as V2TaxRateInputs } from "./tax";
import type { WalletKind, WalletRef } from "./wallets";

/**
 * TAX MATRIX (V3) — THE SINGLE PLACE A LIVE TAX RATE IS DECIDED
 * ===========================================================================
 *
 * V2 decided a rate from the pair of wallet kinds alone (src/lib/tax.ts
 * `resolveTaxRateBp`). V3 adds a Government-configurable matrix over
 *
 *     (payer wallet type) x (recipient wallet type) x (transaction context)
 *
 * and this module is the only server-side entry point that turns those facts
 * into a rate. `src/lib/tax.ts` keeps the V2 rules and is now used purely as
 * THIS module's fallback — the logic lives in one place and was not forked.
 *
 * ABSENCE MEANS "INHERIT"
 * -----------------------
 * The `tax_matrix` table ships EMPTY and is seeded with nothing. A missing
 * row — or a present row whose `rateBp` is NULL — means "inherit", and the
 * resolver falls straight through to `resolveTaxRateBp` with exactly the
 * inputs V2 gave it. So an Aeros Pay install where the Government has
 * configured nothing new taxes identically to V2, to the Aero.
 *
 * WHY A CLIENT CANNOT STEER IT
 * ----------------------------
 * `resolveTaxDecision` takes three things and no rates at all:
 *
 *   1. the payer's `WalletRef`      — established by the session / wallet
 *                                     context the server already verified
 *   2. the recipient's `WalletRef`  — resolved by the server from a username
 *                                     or an entity id
 *   3. a `TaxTransactionContext`    — a TypeScript literal chosen by the code
 *                                     path that is running, never parsed from
 *                                     a request
 *
 * Every NUMBER it uses (the matrix row, `government.taxRateBp`,
 * `government.companyTaxRateBp`, a per-company override) is read here, from
 * the database, inside the caller's transaction. Nothing a caller passes can
 * raise or lower a rate, so no form field, query string or cookie can either.
 * `isTaxTransactionContext` exists for the one place a later phase might
 * genuinely receive a context string (a Government configuration form), and
 * an unrecognised value is rejected rather than defaulted.
 *
 * HISTORICAL TRANSACTIONS ARE NEVER RE-PRICED
 * -------------------------------------------
 * A rate is resolved once, at the moment of the movement, and the result is
 * SNAPSHOT onto the ledger row (`transactions.taxRateBpApplied`) and onto the
 * invoice (`invoices.taxRateBp`). Editing the matrix later changes future
 * decisions only; nothing recomputes a settled row.
 */

export const TAX_TRANSACTION_CONTEXTS = [
  "DIRECT_TRANSFER",
  "INVOICE_PAYMENT",
  "MARKETPLACE_ORDER",
  "CONTRACT_PAYMENT",
  "LOAN_REPAYMENT",
  "PROMOTION_CHARGE",
  "GOVERNMENT_ON_BEHALF",
] as const;

export type TaxTransactionContext = (typeof TAX_TRANSACTION_CONTEXTS)[number];

/** Narrows an untrusted string to a known context, or returns null. */
export function isTaxTransactionContext(value: unknown): value is TaxTransactionContext {
  return (
    typeof value === "string" &&
    (TAX_TRANSACTION_CONTEXTS as readonly string[]).includes(value)
  );
}

export class TaxMatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxMatrixError";
  }
}

/** Anything that can run a `select` — `db` or an open transaction. */
type Executor = Pick<typeof db, "select">;

export type TaxDecision = {
  /** Basis points, e.g. 500 = 5.00%. */
  rateBp: number;
  /** Where the rate came from. "V2_FALLBACK" means the matrix said nothing. */
  source: "MATRIX" | "V2_FALLBACK";
  payerType: WalletKind;
  recipientType: WalletKind;
  context: TaxTransactionContext;
  /** The V2 inputs that were (or would have been) used. Handy for the
   * Government's explain-this-rate view; never taken from a caller. */
  fallbackInputs: V2TaxRateInputs;
};

/** Reads a company's per-company override, or null when it has none. */
async function companyOverrideRateBp(
  executor: Executor,
  ref: WalletRef,
): Promise<number | null> {
  if (ref.kind !== "COMPANY") return null;
  const [row] = await executor
    .select({ taxRateBp: companies.taxRateBp })
    .from(companies)
    .where(eq(companies.id, ref.id))
    .limit(1);
  return row?.taxRateBp ?? null;
}

/**
 * Resolves the rate that applies to a movement, consulting the matrix first
 * and falling back to the V2 rules when the matrix is unconfigured for that
 * combination.
 *
 * Pass the SAME executor the surrounding payment is using, so the rates read
 * here are the ones under the payment's own row locks.
 */
export async function resolveTaxDecision(
  executor: Executor,
  params: {
    payer: WalletRef;
    recipient: WalletRef;
    context: TaxTransactionContext;
  },
): Promise<TaxDecision> {
  const { payer, recipient, context } = params;

  if (!isTaxTransactionContext(context)) {
    throw new TaxMatrixError(`Unknown tax context: ${String(context)}`);
  }

  const [gov] = await executor
    .select({
      taxRateBp: government.taxRateBp,
      companyTaxRateBp: government.companyTaxRateBp,
    })
    .from(government)
    .limit(1);
  if (!gov) throw new TaxMatrixError("Government account is not initialized.");

  const fallbackInputs: V2TaxRateInputs = {
    personalRateBp: gov.taxRateBp,
    defaultCompanyRateBp: gov.companyTaxRateBp,
    senderCompanyRateBp: await companyOverrideRateBp(executor, payer),
    receiverCompanyRateBp: await companyOverrideRateBp(executor, recipient),
  };

  const [configured] = await executor
    .select({ rateBp: taxMatrix.rateBp })
    .from(taxMatrix)
    .where(
      and(
        eq(taxMatrix.payerType, payer.kind),
        eq(taxMatrix.recipientType, recipient.kind),
        eq(taxMatrix.context, context),
      ),
    )
    .limit(1);

  if (configured && configured.rateBp !== null) {
    return {
      rateBp: configured.rateBp,
      source: "MATRIX",
      payerType: payer.kind,
      recipientType: recipient.kind,
      context,
      fallbackInputs,
    };
  }

  return {
    // The V2 function, unchanged and unforked.
    rateBp: resolveTaxRateBp(payer, recipient, fallbackInputs),
    source: "V2_FALLBACK",
    payerType: payer.kind,
    recipientType: recipient.kind,
    context,
    fallbackInputs,
  };
}

/** Convenience wrapper for call sites that only need the number. */
export async function resolveEffectiveTaxRateBp(
  executor: Executor,
  params: { payer: WalletRef; recipient: WalletRef; context: TaxTransactionContext },
): Promise<number> {
  return (await resolveTaxDecision(executor, params)).rateBp;
}

// ---------------------------------------------------------------------------
// Government configuration (no UI in this phase — a later phase builds that)
// ---------------------------------------------------------------------------

export async function listTaxMatrix() {
  return db
    .select()
    .from(taxMatrix)
    .orderBy(asc(taxMatrix.payerType), asc(taxMatrix.recipientType), asc(taxMatrix.context));
}

/**
 * Sets (or clears) one cell of the matrix.
 *
 * `rateBp === null` stores an explicit "inherit" row, which behaves exactly
 * like no row at all — the V2 fallback applies. Existing ledger rows and
 * existing invoices are untouched: only decisions made after this call see
 * the new value.
 */
export async function setTaxMatrixRate(params: {
  payerType: WalletKind;
  recipientType: WalletKind;
  context: TaxTransactionContext;
  rateBp: number | null;
  governmentId: string;
  governmentUsername: string;
  note?: string | null;
}) {
  const { payerType, recipientType, context, rateBp } = params;

  if (!isTaxTransactionContext(context)) {
    throw new TaxMatrixError(`Unknown tax context: ${String(context)}`);
  }
  if (rateBp !== null && (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000)) {
    throw new TaxMatrixError("Tax rate must be a whole number of basis points between 0 and 10000.");
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(taxMatrix)
      .where(
        and(
          eq(taxMatrix.payerType, payerType),
          eq(taxMatrix.recipientType, recipientType),
          eq(taxMatrix.context, context),
        ),
      )
      .limit(1);

    const values = {
      payerType,
      recipientType,
      context,
      rateBp,
      note: params.note ?? null,
      updatedAt: new Date(),
      updatedBy: params.governmentUsername,
    };

    const [row] = existing
      ? await tx.update(taxMatrix).set(values).where(eq(taxMatrix.id, existing.id)).returning()
      : await tx.insert(taxMatrix).values(values).returning();

    await recordAudit(tx, {
      action: "TAX_MATRIX_RATE_CHANGED",
      actorType: "GOVERNMENT",
      actorId: params.governmentId,
      actorLabel: params.governmentUsername,
      targetType: "TAX_MATRIX",
      targetId: row.id,
      previousValue: existing ? String(existing.rateBp) : null,
      newValue: String(rateBp),
      metadata: { payerType, recipientType, context, rateBp },
    });

    return row;
  });
}

/** Removes a cell entirely, restoring pure V2 behaviour for it. */
export async function clearTaxMatrixRate(params: {
  payerType: WalletKind;
  recipientType: WalletKind;
  context: TaxTransactionContext;
  governmentId: string;
  governmentUsername: string;
}) {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(taxMatrix)
      .where(
        and(
          eq(taxMatrix.payerType, params.payerType),
          eq(taxMatrix.recipientType, params.recipientType),
          eq(taxMatrix.context, params.context),
        ),
      )
      .returning({ id: taxMatrix.id, rateBp: taxMatrix.rateBp });

    if (deleted.length === 0) return null;

    await recordAudit(tx, {
      action: "TAX_MATRIX_RATE_CLEARED",
      actorType: "GOVERNMENT",
      actorId: params.governmentId,
      actorLabel: params.governmentUsername,
      targetType: "TAX_MATRIX",
      targetId: deleted[0].id,
      previousValue: String(deleted[0].rateBp),
      newValue: null,
      metadata: {
        payerType: params.payerType,
        recipientType: params.recipientType,
        context: params.context,
      },
    });

    return deleted[0];
  });
}
