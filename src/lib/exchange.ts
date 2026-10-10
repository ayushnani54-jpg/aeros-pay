import "server-only";
import { db } from "@/db/client";
import {
  exchangePackagePolicies,
  exchangePurchases,
  government,
  users,
  type ExchangePackagePolicy,
  type ExchangePurchase,
} from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { notifyUser } from "./notify";
import { transferInTx } from "./payments";
import { governmentWallet, userWallet } from "./wallets";
import { canUserSend } from "./status";
import { CURRENCY_NAME, DEFAULT_EXCHANGE_DISCLOSURE } from "./constants";

export class ExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExchangeError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function nextPurchaseNumber(tx: Pick<typeof db, "execute">): Promise<string> {
  const res = await tx.execute<{ nextval: string }>(
    sql`SELECT nextval('exchange_purchase_number_seq') AS nextval`,
  );
  const seq = String(res.rows[0]?.nextval ?? "1").padStart(6, "0");
  return `EX-${seq}`;
}

/**
 * Ensures the starter Exchange package policies exist if the table is empty.
 */
export async function ensureStarterExchangePolicies(): Promise<void> {
  const existing = await db
    .select({ id: exchangePackagePolicies.id })
    .from(exchangePackagePolicies)
    .limit(1);
  if (existing.length > 0) return;

  await db
    .insert(exchangePackagePolicies)
    .values([
      {
        policyCode: "PKG-STARTER",
        version: 1,
        title: "Starter Aeros Pack",
        description: "Entry package for acquiring virtual Aeros from the Government Treasury.",
        inrPrice: 99,
        aerosAmount: 500,
        bonusAeros: 0,
        totalAeros: 500,
        active: true,
        disclosureText: DEFAULT_EXCHANGE_DISCLOSURE,
      },
      {
        policyCode: "PKG-STANDARD",
        version: 1,
        title: "Standard Aeros Pack",
        description: "Mid-size package with a Government-set bonus allocation.",
        inrPrice: 249,
        aerosAmount: 1300,
        bonusAeros: 100,
        totalAeros: 1400,
        active: true,
        disclosureText: DEFAULT_EXCHANGE_DISCLOSURE,
      },
      {
        policyCode: "PKG-ENTERPRISE",
        version: 1,
        title: "Enterprise Aeros Pack",
        description: "High-allocation virtual Aeros package for active citizens and company founders.",
        inrPrice: 499,
        aerosAmount: 2700,
        bonusAeros: 300,
        totalAeros: 3000,
        active: true,
        disclosureText: DEFAULT_EXCHANGE_DISCLOSURE,
      },
    ])
    .onConflictDoNothing();
}

export async function getActiveExchangePolicies(): Promise<ExchangePackagePolicy[]> {
  await ensureStarterExchangePolicies();
  return db
    .select()
    .from(exchangePackagePolicies)
    .where(eq(exchangePackagePolicies.active, true))
    .orderBy(exchangePackagePolicies.inrPrice, exchangePackagePolicies.policyCode);
}

export async function getAllExchangePolicies(): Promise<ExchangePackagePolicy[]> {
  await ensureStarterExchangePolicies();
  return db
    .select()
    .from(exchangePackagePolicies)
    .orderBy(desc(exchangePackagePolicies.createdAt), desc(exchangePackagePolicies.version));
}

export async function getUserExchangePurchases(
  userId: string,
  limit = 50,
): Promise<ExchangePurchase[]> {
  return db
    .select()
    .from(exchangePurchases)
    .where(eq(exchangePurchases.userId, userId))
    .orderBy(desc(exchangePurchases.createdAt))
    .limit(limit);
}

export async function getGovExchangePurchases(limit = 100): Promise<
  Array<{
    purchase: ExchangePurchase;
    username: string;
    displayName: string;
  }>
> {
  return db
    .select({
      purchase: exchangePurchases,
      username: users.username,
      displayName: users.displayName,
    })
    .from(exchangePurchases)
    .innerJoin(users, eq(users.id, exchangePurchases.userId))
    .orderBy(desc(exchangePurchases.createdAt))
    .limit(limit);
}

/**
 * Creates a new versioned Exchange package policy (or supersedes the existing
 * active version for the same `policyCode`).
 *
 * Package prices and contents are strictly controlled by the Government and
 * NEVER change automatically when the synthetic market moves (spec §5).
 */
export async function upsertExchangePackagePolicy(params: {
  govId: string;
  govUsername: string;
  policyCode: string;
  title: string;
  description: string | null;
  inrPrice: number;
  aerosAmount: number;
  bonusAeros: number;
  active: boolean;
  disclosureText: string;
}): Promise<ExchangePackagePolicy> {
  const code = params.policyCode.trim().toUpperCase();
  const totalAeros = params.aerosAmount + params.bonusAeros;

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(exchangePackagePolicies)
      .where(eq(exchangePackagePolicies.policyCode, code))
      .orderBy(desc(exchangePackagePolicies.version))
      .for("update");

    const latest = existing[0] ?? null;
    const nextVersion = latest ? latest.version + 1 : 1;

    if (latest) {
      await tx
        .update(exchangePackagePolicies)
        .set({ active: false, supersededAt: new Date() })
        .where(
          and(
            eq(exchangePackagePolicies.policyCode, code),
            eq(exchangePackagePolicies.active, true),
          ),
        );
    }

    const [created] = await tx
      .insert(exchangePackagePolicies)
      .values({
        policyCode: code,
        version: nextVersion,
        title: params.title.trim(),
        description: params.description?.trim() || null,
        inrPrice: params.inrPrice,
        aerosAmount: params.aerosAmount,
        bonusAeros: params.bonusAeros,
        totalAeros,
        active: params.active,
        disclosureText: params.disclosureText.trim(),
        createdByGovId: params.govId,
      })
      .returning();

    await recordAudit(tx, {
      action: latest ? "EXCHANGE_POLICY_VERSION_CREATED" : "EXCHANGE_POLICY_CREATED",
      actorType: "GOVERNMENT",
      actorId: params.govId,
      actorLabel: params.govUsername,
      targetType: "EXCHANGE_POLICY",
      targetId: created.id,
      previousValue: latest
        ? `${latest.policyCode} v${latest.version}: ₹${latest.inrPrice} -> ${latest.totalAeros} ${CURRENCY_NAME} (active=${latest.active})`
        : null,
      newValue: `${created.policyCode} v${created.version}: ₹${created.inrPrice} -> ${created.totalAeros} ${CURRENCY_NAME} (active=${created.active})`,
      metadata: {
        policyCode: created.policyCode,
        version: created.version,
        inrPrice: created.inrPrice,
        aerosAmount: created.aerosAmount,
        bonusAeros: created.bonusAeros,
        totalAeros: created.totalAeros,
        active: created.active,
      },
    });

    return created;
  });
}

/**
 * Submits a user request to acquire an Aeros Exchange package.
 *
 * SECURITY & COMPLIANCE (spec §5):
 * - Enforces `government.exchangeEnabled` server-side.
 * - Never marks a package purchase as financially paid or credits Aeros merely
 *   because a user clicked a button.
 * - Freezes a complete snapshot of the active package policy on the purchase
 *   row (`AWAITING_CONFIRMATION`), requiring explicit Government verification
 *   before Treasury Aeros are transferred.
 */
export async function requestExchangePurchase(params: {
  userId: string;
  policyId: string;
  paymentReference?: string | null;
  idempotencyKey?: string | null;
}): Promise<ExchangePurchase> {
  return db.transaction(async (tx) => {
    const [gov] = await tx.select().from(government).limit(1);
    if (!gov || !gov.exchangeEnabled) {
      throw new ExchangeError(
        "Aeros Exchange is currently disabled by the Government.",
      );
    }

    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, params.userId))
      .for("update");
    if (!user) throw new ExchangeError("User account not found.");
    if (!canUserSend(user)) {
      throw new ExchangeError(
        user.status === "BANNED"
          ? "Banned accounts cannot request Aeros Exchange packages."
          : "Suspended accounts cannot request Aeros Exchange packages right now.",
      );
    }

    if (params.idempotencyKey) {
      const [existingByKey] = await tx
        .select()
        .from(exchangePurchases)
        .where(eq(exchangePurchases.idempotencyKey, params.idempotencyKey))
        .limit(1);
      if (existingByKey) {
        if (existingByKey.userId !== params.userId) {
          throw new ExchangeError("Idempotency key conflict.");
        }
        return existingByKey;
      }
    }

    const [policy] = await tx
      .select()
      .from(exchangePackagePolicies)
      .where(eq(exchangePackagePolicies.id, params.policyId))
      .limit(1);
    if (!policy || !policy.active) {
      throw new ExchangeError(
        "This Exchange package is no longer active. Please refresh and select a current package.",
      );
    }

    // Prevent duplicate pending requests for the same package by the same user
    const [existingPending] = await tx
      .select()
      .from(exchangePurchases)
      .where(
        and(
          eq(exchangePurchases.userId, user.id),
          eq(exchangePurchases.policyId, policy.id),
          eq(exchangePurchases.status, "AWAITING_CONFIRMATION"),
        ),
      )
      .limit(1);
    if (existingPending) {
      throw new ExchangeError(
        `You already have a pending request (${existingPending.purchaseNumber}) for this package awaiting Government confirmation.`,
      );
    }

    const purchaseNumber = await nextPurchaseNumber(tx);

    const [created] = await tx
      .insert(exchangePurchases)
      .values({
        purchaseNumber,
        userId: user.id,
        policyId: policy.id,
        policyCodeSnapshot: policy.policyCode,
        policyVersionSnapshot: policy.version,
        packageTitleSnapshot: policy.title,
        inrPriceSnapshot: policy.inrPrice,
        aerosAmountSnapshot: policy.aerosAmount,
        bonusAerosSnapshot: policy.bonusAeros,
        totalAerosSnapshot: policy.totalAeros,
        disclosureSnapshot: policy.disclosureText,
        paymentMode: "MANUAL_GOV_CONFIRMATION",
        paymentReference: params.paymentReference?.trim() || null,
        status: "AWAITING_CONFIRMATION",
        idempotencyKey: params.idempotencyKey || null,
      })
      .returning();

    await recordAudit(tx, {
      action: "EXCHANGE_PURCHASE_REQUESTED",
      actorType: "USER",
      actorId: user.id,
      actorLabel: user.username,
      targetType: "EXCHANGE_PURCHASE",
      targetId: created.id,
      newValue: `${created.purchaseNumber}: ${created.packageTitleSnapshot} (v${created.policyVersionSnapshot}) — ₹${created.inrPriceSnapshot} for ${created.totalAerosSnapshot} ${CURRENCY_NAME}`,
      metadata: {
        purchaseNumber: created.purchaseNumber,
        policyCode: created.policyCodeSnapshot,
        policyVersion: created.policyVersionSnapshot,
        inrPrice: created.inrPriceSnapshot,
        totalAeros: created.totalAerosSnapshot,
        paymentMode: created.paymentMode,
      },
    });

    return created;
  });
}

/**
 * Allows a user to cancel their own pending Exchange purchase request before
 * the Government has credited or cancelled it.
 */
export async function cancelMyExchangePurchase(params: {
  userId: string;
  purchaseId: string;
}): Promise<ExchangePurchase> {
  return db.transaction(async (tx) => {
    const [purchase] = await tx
      .select()
      .from(exchangePurchases)
      .where(eq(exchangePurchases.id, params.purchaseId))
      .for("update");

    if (!purchase || purchase.userId !== params.userId) {
      throw new ExchangeError("Exchange request not found.");
    }
    if (purchase.status !== "AWAITING_CONFIRMATION") {
      throw new ExchangeError("Only pending requests can be cancelled.");
    }

    const [updated] = await tx
      .update(exchangePurchases)
      .set({
        status: "CANCELLED",
        cancelledAt: new Date(),
        reviewNote: "Cancelled by user before confirmation.",
      })
      .where(eq(exchangePurchases.id, purchase.id))
      .returning();

    return updated;
  });
}

/**
 * Government manual/dev confirmation or cancellation of an Exchange purchase.
 *
 * When `decision === "CREDITED"`, transfers `totalAerosSnapshot` from the
 * Government Treasury to the buyer's personal wallet via `transferInTx`
 * (`type: "EXCHANGE_PURCHASE"`, `taxExempt: true`), preserving the supply
 * invariant (`treasury + userHeld + companyHeld == totalSupply`).
 */
export async function reviewExchangePurchase(params: {
  govId: string;
  govUsername: string;
  purchaseId: string;
  decision: "CREDITED" | "CANCELLED";
  reviewNote?: string | null;
}): Promise<ExchangePurchase> {
  return db.transaction(async (tx: Tx) => {
    const [purchase] = await tx
      .select()
      .from(exchangePurchases)
      .where(eq(exchangePurchases.id, params.purchaseId))
      .for("update");

    if (!purchase) {
      throw new ExchangeError("Exchange purchase request not found.");
    }
    if (purchase.status !== "AWAITING_CONFIRMATION") {
      throw new ExchangeError(
        `This purchase (${purchase.purchaseNumber}) has already been ${purchase.status.toLowerCase()}.`,
      );
    }

    const note = params.reviewNote?.trim() || null;

    if (params.decision === "CANCELLED") {
      const [cancelled] = await tx
        .update(exchangePurchases)
        .set({
          status: "CANCELLED",
          reviewedByGovId: params.govId,
          reviewNote: note,
          cancelledAt: new Date(),
        })
        .where(eq(exchangePurchases.id, purchase.id))
        .returning();

      await notifyUser(
        tx,
        purchase.userId,
        "EXCHANGE_PURCHASE_CANCELLED",
        `Your Aeros Exchange request ${purchase.purchaseNumber} (${purchase.packageTitleSnapshot}) was cancelled by the Government.${note ? ` Note: ${note}` : ""}`,
        "/exchange",
      );

      await recordAudit(tx, {
        action: "EXCHANGE_PURCHASE_CANCELLED",
        actorType: "GOVERNMENT",
        actorId: params.govId,
        actorLabel: params.govUsername,
        targetType: "EXCHANGE_PURCHASE",
        targetId: purchase.id,
        previousValue: "AWAITING_CONFIRMATION",
        newValue: "CANCELLED",
        reason: note,
        metadata: { purchaseNumber: purchase.purchaseNumber },
      });

      return cancelled;
    }

    // CREDITED: transfer virtual Aeros from Government Treasury to user wallet
    const transfer = await transferInTx(tx, {
      from: governmentWallet(params.govId),
      to: userWallet(purchase.userId),
      amount: purchase.totalAerosSnapshot,
      type: "EXCHANGE_PURCHASE",
      reason: `Aeros Exchange ${purchase.purchaseNumber}: ${purchase.packageTitleSnapshot} (v${purchase.policyVersionSnapshot})`,
      forcedTaxRateBp: 0,
    });

    const [credited] = await tx
      .update(exchangePurchases)
      .set({
        status: "CREDITED",
        creditedTxRef: transfer.txRef,
        reviewedByGovId: params.govId,
        reviewNote: note,
        creditedAt: new Date(),
      })
      .where(eq(exchangePurchases.id, purchase.id))
      .returning();

    await notifyUser(
      tx,
      purchase.userId,
      "EXCHANGE_PURCHASE_CREDITED",
      `Your Aeros Exchange acquisition ${purchase.purchaseNumber} has been confirmed: +${purchase.totalAerosSnapshot.toLocaleString()} ${CURRENCY_NAME} (ref ${transfer.txRef}).`,
      "/exchange",
    );

    await recordAudit(tx, {
      action: "EXCHANGE_PURCHASE_CREDITED",
      actorType: "GOVERNMENT",
      actorId: params.govId,
      actorLabel: params.govUsername,
      targetType: "EXCHANGE_PURCHASE",
      targetId: purchase.id,
      previousValue: "AWAITING_CONFIRMATION",
      newValue: `CREDITED (${transfer.txRef})`,
      reason: note,
      metadata: {
        purchaseNumber: purchase.purchaseNumber,
        txRef: transfer.txRef,
        totalAeros: purchase.totalAerosSnapshot,
        inrPriceSnapshot: purchase.inrPriceSnapshot,
      },
    });

    return credited;
  });
}
