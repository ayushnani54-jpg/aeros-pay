import "server-only";
import { db } from "@/db/client";
import {
  companies,
  government,
  marketplaceOffers,
  promotionCampaigns,
} from "@/db/schema";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { companyWallet, governmentWallet } from "./wallets";
import { effectiveCompanyStatus } from "./status";
import { transferInTx, PaymentError } from "./payments";
import { notifyUser } from "./notify";
import { recordAudit } from "./audit";
import { isUniqueViolation } from "./db-errors";
import { istDateKey } from "./datetime";
import {
  OFFICIAL_PROMOTION_KINDS,
  PROMOTION_CTA_MAX_LENGTH,
  PROMOTION_DESCRIPTION_MAX_LENGTH,
  PROMOTION_HEADING_MAX_LENGTH,
  PROMOTION_MAX_DURATION_DAYS,
  type OfficialPromotionKind,
} from "./constants";
import type { Company, PromotionCampaign } from "@/db/schema";

/**
 * PROMOTIONS / ADVERTISING (V3 Phase E, spec §24)
 * ===========================================================================
 *
 * A company promotes one of its own ACTIVE offers in a single global ad slot.
 * The Government approves it, sets the daily rate, and may also run its own
 * official promotions for free. A viewer can dismiss an ad with X.
 *
 * NO ANALYTICS. AT ALL.
 * ---------------------
 * Nothing in this module — and no column in the schema — records an
 * impression, a click, a dismissal or a view. The dismiss button is pure
 * client state in src/components/promotion-slot.tsx: it is not persisted to a
 * row, not to a cookie and not to local storage, so it lasts exactly as long as
 * the page does. That is the honest reading of "store nothing".
 *
 * ONE ACTIVE CAMPAIGN, GLOBALLY, GUARANTEED BY POSTGRES
 * ----------------------------------------------------
 * `promotion_single_active_slot` is a UNIQUE index on `status` restricted to
 * rows where status = 'ACTIVE'. A second activation is therefore rejected by
 * the database even under a perfect race. `activatePromotion` catches that
 * rejection and turns it into "the slot is taken" rather than crashing, which
 * is the whole handling requirement.
 *
 * THE DAILY CHARGE IS IDEMPOTENT PER IST CALENDAR DAY
 * --------------------------------------------------
 * There is no scheduler in this app yet (Phase I adds one), so the charge runs
 * lazily when a page renders the ad slot. That makes idempotency load-bearing:
 * two page loads in the same second must not bill twice.
 *
 * The claim is ONE conditional UPDATE:
 *
 *     UPDATE promotion_campaigns
 *        SET last_charged_on = <today IST>
 *      WHERE id = ? AND status = 'ACTIVE'
 *        AND (last_charged_on IS NULL OR last_charged_on < <today IST>)
 *
 * Whoever's UPDATE returns a row owns today's charge; everybody else gets zero
 * rows and does nothing. `last_charged_on` is a plain `date` holding the IST
 * calendar day (`istDateKey`), so "already charged today" is one equality test
 * that no clock skew and no server timezone can confuse. The transfer happens
 * in the same transaction as the claim, so if the payment fails the claim rolls
 * back with it and tomorrow is not skipped.
 *
 * IF THE COMPANY CANNOT PAY
 * -------------------------
 * `debitWallet` is a conditional UPDATE (`WHERE balance >= amount`), so an
 * unaffordable charge simply does not happen: no negative balance is
 * reachable, and no Aeros are invented to cover it. The whole charging
 * transaction rolls back and the campaign is then PAUSED in its own
 * transaction, the owner is notified and the Government gets an audit row. A
 * paused campaign frees the slot and is resumable once the company has funds.
 */

export class PromotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromotionError";
  }
}

/** Thrown when the single global ACTIVE slot is already taken. */
export class PromotionSlotTakenError extends PromotionError {
  constructor(message: string) {
    super(message);
    this.name = "PromotionSlotTakenError";
  }
}

function cleanText(value: string | null | undefined, max: number): string {
  return (value ?? "").trim().slice(0, max);
}

export type PromotionPolicy = {
  enabled: boolean;
  dailyRate: number;
  updatedAt: Date | null;
};

export async function getPromotionPolicy(): Promise<PromotionPolicy> {
  const [row] = await db
    .select({
      enabled: government.promotionsEnabled,
      dailyRate: government.promotionDailyRate,
      updatedAt: government.promotionPolicyUpdatedAt,
    })
    .from(government)
    .limit(1);
  if (!row) throw new PromotionError("Government account is not initialized.");
  return row;
}

/** Government sets the master switch and the daily rate (spec §24). */
export async function setPromotionPolicy(params: {
  governmentId: string;
  actorLabel: string;
  enabled: boolean;
  dailyRate: number;
}): Promise<PromotionPolicy> {
  // Checked BEFORE any truncation: silently rounding 12.5 to 12 would be the
  // server deciding a rate the Government did not type.
  const dailyRate = params.dailyRate;
  if (!Number.isInteger(dailyRate) || dailyRate < 0 || dailyRate > 1_000_000) {
    throw new PromotionError("The daily rate must be a whole number between 0 and 1,000,000.");
  }

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        enabled: government.promotionsEnabled,
        dailyRate: government.promotionDailyRate,
      })
      .from(government)
      .where(eq(government.id, params.governmentId))
      .for("update");
    if (!before) throw new PromotionError("Government account is not initialized.");

    const [row] = await tx
      .update(government)
      .set({
        promotionsEnabled: params.enabled,
        promotionDailyRate: dailyRate,
        promotionPolicyUpdatedAt: new Date(),
      })
      .where(eq(government.id, params.governmentId))
      .returning({
        enabled: government.promotionsEnabled,
        dailyRate: government.promotionDailyRate,
        updatedAt: government.promotionPolicyUpdatedAt,
      });

    await recordAudit(tx, {
      action: "PROMOTION_POLICY_UPDATED",
      actorType: "GOVERNMENT",
      actorId: params.governmentId,
      actorLabel: params.actorLabel,
      targetType: "POLICY",
      previousValue: `${before.enabled ? "on" : "off"} @ ${before.dailyRate}/day`,
      newValue: `${params.enabled ? "on" : "off"} @ ${dailyRate}/day`,
      metadata: { enabled: params.enabled, dailyRate },
    });

    return row;
  });
}

// ---------------------------------------------------------------------------
// Requesting a campaign
// ---------------------------------------------------------------------------

export type PromotionRequestInput = {
  offerId: string;
  heading: string;
  shortDescription: string;
  ctaLabel: string;
  requestedDurationDays: number;
};

/**
 * A company asks to promote ONE OF ITS OWN ACTIVE offers.
 *
 * `destination` is built here from the offer's id — the company does not supply
 * a URL, so an ad cannot be pointed at an arbitrary path.
 */
export async function requestPromotion(params: {
  company: Company;
  input: PromotionRequestInput;
}): Promise<PromotionCampaign> {
  const heading = cleanText(params.input.heading, PROMOTION_HEADING_MAX_LENGTH);
  const shortDescription = cleanText(
    params.input.shortDescription,
    PROMOTION_DESCRIPTION_MAX_LENGTH,
  );
  const ctaLabel = cleanText(params.input.ctaLabel, PROMOTION_CTA_MAX_LENGTH) || "View offer";
  const days = Math.trunc(params.input.requestedDurationDays);

  if (heading.length === 0) throw new PromotionError("A heading is required.");
  if (shortDescription.length === 0) throw new PromotionError("A short description is required.");
  if (!Number.isInteger(days) || days < 1 || days > PROMOTION_MAX_DURATION_DAYS) {
    throw new PromotionError(`Choose between 1 and ${PROMOTION_MAX_DURATION_DAYS} days.`);
  }

  const policy = await getPromotionPolicy();
  if (!policy.enabled) {
    throw new PromotionError("The Government has switched promotions off for now.");
  }

  return db.transaction(async (tx) => {
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, params.company.id))
      .for("update");
    if (!company) throw new PromotionError("That company no longer exists.");
    if (effectiveCompanyStatus(company) !== "APPROVED") {
      throw new PromotionError("Only an active company can run a promotion.");
    }

    const [offer] = await tx
      .select()
      .from(marketplaceOffers)
      .where(eq(marketplaceOffers.id, params.input.offerId))
      .limit(1);
    if (!offer) throw new PromotionError("That listing does not exist.");
    if (offer.companyId !== company.id) {
      throw new PromotionError("A company can only promote its own listing.");
    }
    if (offer.status !== "ACTIVE") {
      throw new PromotionError("Only an ACTIVE listing can be promoted.");
    }

    // One live request or campaign per company at a time, so the approval queue
    // cannot be flooded by one company.
    const [existing] = await tx
      .select({ id: promotionCampaigns.id, status: promotionCampaigns.status })
      .from(promotionCampaigns)
      .where(
        and(
          eq(promotionCampaigns.companyId, company.id),
          sql`${promotionCampaigns.status} IN ('PENDING', 'APPROVED', 'ACTIVE', 'PAUSED')`,
        ),
      )
      .limit(1);
    if (existing) {
      throw new PromotionError(
        `${company.name} already has a ${existing.status.toLowerCase()} promotion. Finish or cancel it first.`,
      );
    }

    const [campaign] = await tx
      .insert(promotionCampaigns)
      .values({
        companyId: company.id,
        offerId: offer.id,
        heading,
        shortDescription,
        ctaLabel,
        // Built server-side from the offer's own id.
        destination: `/market/offers/${offer.id}`,
        requestedDurationDays: days,
        // Snapshot of the live rate at request time; re-snapshot at approval so
        // the campaign is priced by the rate in force when it was approved.
        dailyRate: policy.dailyRate,
        status: "PENDING",
      })
      .returning();

    await recordAudit(tx, {
      action: "PROMOTION_REQUESTED",
      actorType: "COMPANY",
      actorId: company.id,
      actorLabel: company.name,
      targetType: "PROMOTION",
      targetId: campaign.id,
      metadata: { heading, days, dailyRate: policy.dailyRate, offerId: offer.id },
    });

    return campaign;
  });
}

// ---------------------------------------------------------------------------
// Government review
// ---------------------------------------------------------------------------

export async function reviewPromotion(params: {
  campaignId: string;
  approve: boolean;
  reason?: string | null;
  actorLabel: string;
  governmentId: string;
}): Promise<PromotionCampaign> {
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(promotionCampaigns)
      .where(eq(promotionCampaigns.id, params.campaignId))
      .for("update");
    if (!campaign) throw new PromotionError("Campaign not found.");
    if (campaign.status !== "PENDING") {
      throw new PromotionError(`This campaign is already ${campaign.status}.`);
    }

    const reason = cleanText(params.reason, 500);
    if (!params.approve && reason.length === 0) {
      throw new PromotionError("A rejection reason is required.");
    }

    // The rate is re-read and frozen AT APPROVAL, so a later policy change can
    // never re-price a campaign that is already running.
    const [gov] = await tx
      .select({ dailyRate: government.promotionDailyRate })
      .from(government)
      .limit(1);
    if (!gov) throw new PromotionError("Government account is not initialized.");

    const [updated] = await tx
      .update(promotionCampaigns)
      .set({
        status: params.approve ? "APPROVED" : "REJECTED",
        dailyRate: params.approve ? gov.dailyRate : campaign.dailyRate,
        reviewedAt: new Date(),
        reviewedBy: params.actorLabel,
        rejectionReason: params.approve ? null : reason,
      })
      .where(
        and(
          eq(promotionCampaigns.id, campaign.id),
          eq(promotionCampaigns.status, "PENDING"),
        ),
      )
      .returning();
    if (!updated) throw new PromotionError("This campaign changed while you were reviewing it.");

    if (campaign.companyId) {
      const [company] = await tx
        .select({ ownerUserId: companies.ownerUserId, name: companies.name })
        .from(companies)
        .where(eq(companies.id, campaign.companyId))
        .limit(1);
      if (company) {
        await notifyUser(
          tx,
          company.ownerUserId,
          params.approve ? "PROMOTION_APPROVED" : "PROMOTION_REJECTED",
          params.approve
            ? `Your promotion "${campaign.heading}" was approved at ${gov.dailyRate.toLocaleString()} Aeros per day. Activate it when you are ready.`
            : `Your promotion "${campaign.heading}" was rejected: ${reason}`,
          "/my-company/promotions",
        );
      }
    }

    await recordAudit(tx, {
      action: params.approve ? "PROMOTION_APPROVED" : "PROMOTION_REJECTED",
      actorType: "GOVERNMENT",
      actorId: params.governmentId,
      actorLabel: params.actorLabel,
      targetType: "PROMOTION",
      targetId: campaign.id,
      previousValue: "PENDING",
      newValue: params.approve ? "APPROVED" : "REJECTED",
      reason: reason || null,
      metadata: { dailyRate: gov.dailyRate },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Activation / pausing / cancelling
// ---------------------------------------------------------------------------

/**
 * Takes the single global ad slot.
 *
 * APPROVED or PAUSED → ACTIVE. The database's partial unique index is what
 * actually enforces "at most one", so this function's job is to ASK and then
 * report the answer gracefully: a unique violation becomes
 * `PromotionSlotTakenError`, never an unhandled crash.
 */
export async function activatePromotion(params: {
  campaignId: string;
  /** The company that owns it, or null for a Government/system promotion. */
  companyId: string | null;
}): Promise<PromotionCampaign> {
  const policy = await getPromotionPolicy();
  if (!policy.enabled) {
    throw new PromotionError("The Government has switched promotions off for now.");
  }

  try {
    return await db.transaction(async (tx) => {
      const [campaign] = await tx
        .select()
        .from(promotionCampaigns)
        .where(eq(promotionCampaigns.id, params.campaignId))
        .for("update");
      if (!campaign) throw new PromotionError("Campaign not found.");
      if (campaign.companyId !== params.companyId) {
        throw new PromotionError("That campaign does not belong to you.");
      }
      if (campaign.status === "ACTIVE") return campaign;
      if (campaign.status !== "APPROVED" && campaign.status !== "PAUSED") {
        throw new PromotionError(
          campaign.status === "PENDING"
            ? "This campaign is still waiting for Government approval."
            : `This campaign is ${campaign.status} and cannot be activated.`,
        );
      }

      // A company campaign must still point at a live listing.
      if (campaign.offerId) {
        const [offer] = await tx
          .select({ status: marketplaceOffers.status })
          .from(marketplaceOffers)
          .where(eq(marketplaceOffers.id, campaign.offerId))
          .limit(1);
        if (!offer) throw new PromotionError("The listing this promotion points at is gone.");
        if (offer.status !== "ACTIVE") {
          throw new PromotionError(
            "The listing this promotion points at is not active. Resume it first.",
          );
        }
      }

      const now = new Date();
      // A resumed campaign keeps the end date it was given when it first went
      // live; a fresh one gets its full requested run from now.
      const expiresAt =
        campaign.activatedAt && campaign.expiresAt
          ? campaign.expiresAt
          : new Date(now.getTime() + campaign.requestedDurationDays * 24 * 60 * 60 * 1000);

      const [updated] = await tx
        .update(promotionCampaigns)
        .set({
          status: "ACTIVE",
          activatedAt: campaign.activatedAt ?? now,
          expiresAt,
          pausedAt: null,
        })
        .where(
          and(
            eq(promotionCampaigns.id, campaign.id),
            sql`${promotionCampaigns.status} IN ('APPROVED', 'PAUSED')`,
          ),
        )
        .returning();
      if (!updated) throw new PromotionError("This campaign changed while you were activating it.");

      return updated;
    });
  } catch (e) {
    if (isUniqueViolation(e)) {
      // The single-slot index refused it. This is an expected outcome, not a bug.
      throw new PromotionSlotTakenError(
        "Another promotion is running in the ad slot right now. Try again once it finishes.",
      );
    }
    throw e;
  }
}

/** ACTIVE → PAUSED. Frees the slot; the campaign keeps its end date. */
export async function pausePromotion(params: {
  campaignId: string;
  companyId: string | null;
  reason?: string | null;
}): Promise<PromotionCampaign> {
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(promotionCampaigns)
      .where(eq(promotionCampaigns.id, params.campaignId))
      .for("update");
    if (!campaign) throw new PromotionError("Campaign not found.");
    if (campaign.companyId !== params.companyId) {
      throw new PromotionError("That campaign does not belong to you.");
    }
    if (campaign.status === "PAUSED") return campaign;
    if (campaign.status !== "ACTIVE") {
      throw new PromotionError(`This campaign is ${campaign.status} and cannot be paused.`);
    }

    const [updated] = await tx
      .update(promotionCampaigns)
      .set({ status: "PAUSED", pausedAt: new Date() })
      .where(and(eq(promotionCampaigns.id, campaign.id), eq(promotionCampaigns.status, "ACTIVE")))
      .returning();
    if (!updated) throw new PromotionError("This campaign changed while you were pausing it.");
    return updated;
  });
}

export async function cancelPromotion(params: {
  campaignId: string;
  companyId: string | null;
  byGovernment?: boolean;
  actorLabel?: string;
}): Promise<PromotionCampaign> {
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(promotionCampaigns)
      .where(eq(promotionCampaigns.id, params.campaignId))
      .for("update");
    if (!campaign) throw new PromotionError("Campaign not found.");
    if (!params.byGovernment && campaign.companyId !== params.companyId) {
      throw new PromotionError("That campaign does not belong to you.");
    }
    if (campaign.status === "CANCELLED") return campaign;
    if (campaign.status === "COMPLETED") {
      throw new PromotionError("This campaign has already finished.");
    }

    const [updated] = await tx
      .update(promotionCampaigns)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(
        and(
          eq(promotionCampaigns.id, campaign.id),
          sql`${promotionCampaigns.status} IN ('PENDING', 'APPROVED', 'ACTIVE', 'PAUSED')`,
        ),
      )
      .returning();
    if (!updated) throw new PromotionError("This campaign changed while you were cancelling it.");

    if (params.byGovernment) {
      await recordAudit(tx, {
        action: "PROMOTION_CANCELLED_BY_GOVERNMENT",
        actorType: "GOVERNMENT",
        actorLabel: params.actorLabel ?? "Government",
        targetType: "PROMOTION",
        targetId: campaign.id,
        previousValue: campaign.status,
        newValue: "CANCELLED",
      });
    }

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Official / system promotions (no company, no charge)
// ---------------------------------------------------------------------------

export function isOfficialPromotionKind(value: unknown): value is OfficialPromotionKind {
  return (
    typeof value === "string" && (OFFICIAL_PROMOTION_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The Government's own promotions: New Player Bonus, Government Demand,
 * Limited Opportunity.
 *
 * `companyId` is NULL and `dailyRate` is 0, so `runPromotionCharges` skips them
 * entirely — the Treasury does not bill itself, and no Aeros move.
 */
export async function createOfficialPromotion(params: {
  governmentId: string;
  actorLabel: string;
  kind: OfficialPromotionKind;
  heading: string;
  shortDescription: string;
  ctaLabel: string;
  destination: string;
  durationDays: number;
  /** Activate it straight away, if the slot is free. */
  activate?: boolean;
}): Promise<PromotionCampaign> {
  if (!isOfficialPromotionKind(params.kind)) {
    throw new PromotionError("Unknown official promotion kind.");
  }
  const heading = cleanText(params.heading, PROMOTION_HEADING_MAX_LENGTH);
  const shortDescription = cleanText(params.shortDescription, PROMOTION_DESCRIPTION_MAX_LENGTH);
  const ctaLabel = cleanText(params.ctaLabel, PROMOTION_CTA_MAX_LENGTH) || "Learn more";
  const days = Math.trunc(params.durationDays);

  if (heading.length === 0) throw new PromotionError("A heading is required.");
  if (shortDescription.length === 0) throw new PromotionError("A short description is required.");
  if (!Number.isInteger(days) || days < 1 || days > PROMOTION_MAX_DURATION_DAYS) {
    throw new PromotionError(`Choose between 1 and ${PROMOTION_MAX_DURATION_DAYS} days.`);
  }

  // Only in-app destinations: an ad can never point off the app.
  const destination = cleanText(params.destination, 200) || "/market";
  if (!destination.startsWith("/") || destination.startsWith("//")) {
    throw new PromotionError("The destination must be an in-app path starting with /.");
  }

  const campaign = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(promotionCampaigns)
      .values({
        companyId: null,
        offerId: null,
        heading,
        shortDescription,
        ctaLabel,
        destination,
        requestedDurationDays: days,
        // Official promotions are free, by construction.
        dailyRate: 0,
        status: "APPROVED",
        reviewedAt: new Date(),
        reviewedBy: params.actorLabel,
      })
      .returning();

    await recordAudit(tx, {
      action: "OFFICIAL_PROMOTION_CREATED",
      actorType: "GOVERNMENT",
      actorId: params.governmentId,
      actorLabel: params.actorLabel,
      targetType: "PROMOTION",
      targetId: row.id,
      newValue: params.kind,
      metadata: { kind: params.kind, heading, days, destination },
    });

    return row;
  });

  if (params.activate) {
    return activatePromotion({ campaignId: campaign.id, companyId: null });
  }
  return campaign;
}

// ---------------------------------------------------------------------------
// The lazy daily charge
// ---------------------------------------------------------------------------

export type ChargeOutcome = {
  campaignId: string | null;
  /** What actually happened, for tests and for the Government panel. */
  result:
    | "NO_ACTIVE_CAMPAIGN"
    | "ALREADY_CHARGED_TODAY"
    | "CHARGED"
    | "FREE_OFFICIAL"
    | "PAUSED_INSUFFICIENT_FUNDS"
    | "COMPLETED";
  amount: number;
  txRef: string | null;
  istDay: string;
};

/**
 * Charges the ACTIVE campaign for today (IST), completes it if it has run its
 * course, and pauses it if the company cannot pay.
 *
 * Safe and cheap to call from any page render:
 *   * one indexed read of the single ACTIVE row;
 *   * the charge claim is one conditional UPDATE, so the second and every
 *     later call on the same IST day does no work at all;
 *   * it never throws for an expected outcome — a caller renders an ad either
 *     way, so a billing problem must not take the page down.
 */
export async function runPromotionCharges(now = new Date()): Promise<ChargeOutcome> {
  const istDay = istDateKey(now);

  const [active] = await db
    .select()
    .from(promotionCampaigns)
    .where(eq(promotionCampaigns.status, "ACTIVE"))
    .limit(1);

  if (!active) {
    return { campaignId: null, result: "NO_ACTIVE_CAMPAIGN", amount: 0, txRef: null, istDay };
  }

  // Run its course: ACTIVE → COMPLETED, guarded so only one caller does it.
  if (active.expiresAt && active.expiresAt.getTime() <= now.getTime()) {
    const done = await db
      .update(promotionCampaigns)
      .set({ status: "COMPLETED", completedAt: now })
      .where(and(eq(promotionCampaigns.id, active.id), eq(promotionCampaigns.status, "ACTIVE")))
      .returning({ id: promotionCampaigns.id });
    if (done.length > 0 && active.companyId) {
      const [company] = await db
        .select({ ownerUserId: companies.ownerUserId })
        .from(companies)
        .where(eq(companies.id, active.companyId))
        .limit(1);
      if (company) {
        await notifyUser(
          db,
          company.ownerUserId,
          "PROMOTION_COMPLETED",
          `Your promotion "${active.heading}" has finished its run. Total charged: ${active.totalCharged.toLocaleString()} Aeros.`,
          "/my-company/promotions",
        );
      }
    }
    return { campaignId: active.id, result: "COMPLETED", amount: 0, txRef: null, istDay };
  }

  // Government / system promotions are free: no company to bill and a zero rate.
  if (!active.companyId || active.dailyRate === 0) {
    return { campaignId: active.id, result: "FREE_OFFICIAL", amount: 0, txRef: null, istDay };
  }

  if (active.lastChargedOn === istDay) {
    return {
      campaignId: active.id,
      result: "ALREADY_CHARGED_TODAY",
      amount: 0,
      txRef: null,
      istDay,
    };
  }

  const companyId = active.companyId;
  const amount = active.dailyRate;

  try {
    const txRef = await db.transaction(async (tx) => {
      // THE CLAIM. One conditional UPDATE; whoever gets a row owns today's
      // charge. Because it is inside this transaction, a failed payment rolls
      // the claim back and tomorrow's (or a later retry's) charge is unaffected.
      const claimed = await tx
        .update(promotionCampaigns)
        .set({ lastChargedOn: istDay })
        .where(
          and(
            eq(promotionCampaigns.id, active.id),
            eq(promotionCampaigns.status, "ACTIVE"),
            or(
              isNull(promotionCampaigns.lastChargedOn),
              sql`${promotionCampaigns.lastChargedOn} < ${istDay}`,
            ),
          ),
        )
        .returning({ id: promotionCampaigns.id });
      if (claimed.length === 0) return null; // someone else already charged today

      const [gov] = await tx.select({ id: government.id }).from(government).limit(1);
      if (!gov) throw new PromotionError("Government account is not initialized.");

      const result = await transferInTx(tx, {
        from: companyWallet(companyId),
        to: governmentWallet(gov.id),
        amount,
        // The charge IS a payment to the Treasury; taxing it on top would be
        // the Government taxing its own fee.
        forcedTaxRateBp: 0,
        type: "PROMOTION_CHARGE",
        taxContext: "PROMOTION_CHARGE",
        reason: `Promotion slot — ${istDay} IST`,
        // A suspended company still owes for a slot it is occupying; the slot
        // is released by pausing the campaign, not by refusing the charge.
        skipSenderCheck: true,
        notify: {
          senderType: "PROMOTION_CHARGED",
          senderMessage: (r) =>
            `${amount.toLocaleString()} Aeros charged for today's promotion slot. Ref ${r.txRef}.`,
        },
      });

      await tx
        .update(promotionCampaigns)
        .set({ totalCharged: sql`${promotionCampaigns.totalCharged} + ${amount}` })
        .where(eq(promotionCampaigns.id, active.id));

      return result.txRef;
    });

    if (txRef === null) {
      return {
        campaignId: active.id,
        result: "ALREADY_CHARGED_TODAY",
        amount: 0,
        txRef: null,
        istDay,
      };
    }
    return { campaignId: active.id, result: "CHARGED", amount, txRef, istDay };
  } catch (e) {
    // The only expected failure is "the company cannot afford it". Nothing
    // moved (the conditional debit simply did not fire) and the claim rolled
    // back with the transaction, so the campaign is simply paused.
    const insufficient =
      e instanceof PaymentError && /[Ii]nsufficient/.test(e.message);
    if (!insufficient) throw e;

    await db.transaction(async (tx) => {
      const paused = await tx
        .update(promotionCampaigns)
        .set({ status: "PAUSED", pausedAt: new Date() })
        .where(and(eq(promotionCampaigns.id, active.id), eq(promotionCampaigns.status, "ACTIVE")))
        .returning({ id: promotionCampaigns.id });
      if (paused.length === 0) return;

      const [company] = await tx
        .select({ ownerUserId: companies.ownerUserId, name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      if (company) {
        await notifyUser(
          tx,
          company.ownerUserId,
          "PROMOTION_PAUSED",
          `Your promotion "${active.heading}" was paused: ${company.name} could not cover today's ${amount.toLocaleString()} Aeros slot charge. Top up the company wallet and resume it.`,
          "/my-company/promotions",
        );
      }

      await recordAudit(tx, {
        action: "PROMOTION_PAUSED_INSUFFICIENT_FUNDS",
        actorType: "GOVERNMENT",
        actorLabel: "System",
        targetType: "PROMOTION",
        targetId: active.id,
        previousValue: "ACTIVE",
        newValue: "PAUSED",
        reason: "The company could not cover the daily promotion charge.",
        metadata: { amount, istDay },
      });
    });

    return {
      campaignId: active.id,
      result: "PAUSED_INSUFFICIENT_FUNDS",
      amount: 0,
      txRef: null,
      istDay,
    };
  }
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export type LiveAd = {
  id: string;
  heading: string;
  shortDescription: string;
  ctaLabel: string;
  destination: string;
  /** Null for a Government / system promotion. */
  companyName: string | null;
  companyUsername: string | null;
  official: boolean;
};

/**
 * The single ad to show, or null.
 *
 * Reading it records nothing: there is no impression counter to increment.
 */
export async function getLiveAd(): Promise<LiveAd | null> {
  const [row] = await db
    .select({
      campaign: promotionCampaigns,
      companyName: companies.name,
      companyUsername: companies.username,
    })
    .from(promotionCampaigns)
    .leftJoin(companies, eq(companies.id, promotionCampaigns.companyId))
    .where(eq(promotionCampaigns.status, "ACTIVE"))
    .limit(1);
  if (!row) return null;

  return {
    id: row.campaign.id,
    heading: row.campaign.heading,
    shortDescription: row.campaign.shortDescription,
    ctaLabel: row.campaign.ctaLabel,
    destination: row.campaign.destination,
    companyName: row.companyName ?? null,
    companyUsername: row.companyUsername ?? null,
    official: row.campaign.companyId === null,
  };
}

export async function getCampaignsForCompany(
  companyId: string,
  limit = 50,
): Promise<PromotionCampaign[]> {
  return db
    .select()
    .from(promotionCampaigns)
    .where(eq(promotionCampaigns.companyId, companyId))
    .orderBy(desc(promotionCampaigns.createdAt))
    .limit(limit);
}

export type CampaignRow = {
  campaign: PromotionCampaign;
  companyName: string | null;
  companyUsername: string | null;
  offerTitle: string | null;
};

export async function listCampaigns(
  filter: "PENDING" | "ALL" = "ALL",
  limit = 100,
): Promise<CampaignRow[]> {
  return db
    .select({
      campaign: promotionCampaigns,
      companyName: companies.name,
      companyUsername: companies.username,
      offerTitle: marketplaceOffers.title,
    })
    .from(promotionCampaigns)
    .leftJoin(companies, eq(companies.id, promotionCampaigns.companyId))
    .leftJoin(marketplaceOffers, eq(marketplaceOffers.id, promotionCampaigns.offerId))
    .where(filter === "PENDING" ? eq(promotionCampaigns.status, "PENDING") : undefined)
    .orderBy(desc(promotionCampaigns.createdAt))
    .limit(limit);
}

export async function getCampaignById(campaignId: string): Promise<PromotionCampaign | null> {
  const [row] = await db
    .select()
    .from(promotionCampaigns)
    .where(eq(promotionCampaigns.id, campaignId))
    .limit(1);
  return row ?? null;
}

export async function countPendingCampaigns(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(promotionCampaigns)
    .where(eq(promotionCampaigns.status, "PENDING"));
  return row?.count ?? 0;
}
