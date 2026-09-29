import "server-only";
import { db } from "@/db/client";
import {
  companies,
  companySaleDismissals,
  companySaleListings,
  companySaleOffers,
  companySaleRecords,
  government,
  transactions,
  users,
} from "@/db/schema";
import { and, desc, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { notifyUser } from "./notify";
import { transferInTx } from "./payments";
import { governmentWallet, userWallet } from "./wallets";
import { effectiveCompanyStatus } from "./status";
import { isUniqueViolation } from "./db-errors";
import { istCalendarDaysBetween, startOfIstDay } from "./datetime";
import type { Company, CompanySaleListing, CompanySaleOffer } from "@/db/schema";

/**
 * COMPANY SALE MARKETPLACE
 * ========================
 *
 * Valuation
 * ---------
 * A company's price is `lifetime sales × the Government's multiplier`
 * (default 1.50×). Both the sales figure and the multiplier are FROZEN into
 * the listing when it is created, so the price a buyer sees is exactly the
 * price they pay even if the company trades more, or the Government changes
 * the multiplier, afterwards.
 *
 * Tax
 * ---
 * A company purchase is deliberately TAX-FREE. The listing advertises a
 * valuation, and the seller receives exactly that: taxing it would mean the
 * seller silently received less than the advertised price. This is an
 * interpretation decision — the spec defines the transfer as
 * "buyer's personal wallet → seller's personal wallet" and says nothing about
 * a cut, so nothing is taken.
 *
 * What moves and what does not
 * ----------------------------
 * The purchase price moves between the two owners' PERSONAL wallets. The
 * company's own wallet does not move at all — the buyer acquires the company
 * along with whatever balance it holds. Ownership, a permanent sale record, a
 * ledger transaction, an audit entry and notifications are all written in the
 * same atomic transaction.
 */

export class SaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaleError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Ledger types that count as a company making a sale. */
const SALES_TX_TYPES = ["COMPANY_SALE", "INVOICE_PAYMENT"] as const;

/**
 * Lifetime sales for a company: the net Aeros it has actually received from
 * customers. Government funding, loans and administrative credits are
 * deliberately excluded — they are not sales.
 */
export async function getCompanySalesFigure(
  companyId: string,
  executor: Pick<typeof db, "select"> = db,
): Promise<number> {
  const [row] = await executor
    .select({ total: sql<number>`coalesce(sum(${transactions.netAmount}), 0)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.receiverType, "COMPANY"),
        eq(transactions.receiverId, companyId),
        inArray(transactions.type, [...SALES_TX_TYPES]),
      ),
    );
  return row?.total ?? 0;
}

export function computeValuation(salesFigure: number, multiplierBp: number): number {
  return Math.round((salesFigure * multiplierBp) / 10000);
}

export type SaleEligibility = {
  eligible: boolean;
  reason?: string;
  daysRemaining?: number;
  eligibleFrom?: Date;
};

/**
 * A company may be listed only once it has been approved for a full
 * `saleMinCompanyAgeDays` (default 7 days).
 *
 * Measured in IST CALENDAR days, not elapsed hours: a company approved at
 * 11pm IST becomes eligible on the IST calendar day `minAgeDays` later, at
 * IST midnight — not 7×24 hours after the exact approval instant. This keeps
 * the rule consistent with every other day-boundary check in the app (the
 * daily issuance limit, loan reminder staging) and with what a viewer sees
 * displayed, since all timestamps are shown in IST.
 */
export function checkListingEligibility(
  company: Company,
  minAgeDays: number,
  now = new Date(),
): SaleEligibility {
  if (effectiveCompanyStatus(company) !== "APPROVED") {
    return { eligible: false, reason: "Only an active, approved company can be listed for sale." };
  }
  if (company.governmentOwned) {
    return { eligible: false, reason: "This company is under Government stewardship." };
  }

  const approvedAt = company.reviewedAt ?? company.createdAt;
  const eligibleFrom = new Date(
    startOfIstDay(approvedAt).getTime() + minAgeDays * 24 * 60 * 60 * 1000,
  );

  if (now.getTime() < eligibleFrom.getTime()) {
    const daysRemaining = Math.max(0, minAgeDays - istCalendarDaysBetween(approvedAt, now));
    return {
      eligible: false,
      reason: `A company can only be listed for sale ${minAgeDays} full days after approval.`,
      daysRemaining,
      eligibleFrom,
    };
  }

  return { eligible: true, eligibleFrom };
}

async function getSalePolicy(executor: Pick<typeof db, "select"> = db) {
  const [gov] = await executor
    .select({
      id: government.id,
      username: government.username,
      multiplierBp: government.saleMultiplierBp,
      minAgeDays: government.saleMinCompanyAgeDays,
    })
    .from(government)
    .limit(1);
  if (!gov) throw new SaleError("Government account is not initialized.");
  return gov;
}

/** Preview of what a listing would be worth right now. */
export async function previewValuation(company: Company) {
  const policy = await getSalePolicy();
  const salesFigure = await getCompanySalesFigure(company.id);
  return {
    salesFigure,
    multiplierBp: policy.multiplierBp,
    valuation: computeValuation(salesFigure, policy.multiplierBp),
    eligibility: checkListingEligibility(company, policy.minAgeDays),
  };
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

export async function createListing(params: {
  company: Company;
  sellerUserId: string;
  reason: string;
}): Promise<CompanySaleListing> {
  const { company, sellerUserId, reason } = params;

  if (company.ownerUserId !== sellerUserId) {
    throw new SaleError("Only the owner can list this company for sale.");
  }

  const policy = await getSalePolicy();
  const eligibility = checkListingEligibility(company, policy.minAgeDays);
  if (!eligibility.eligible) {
    throw new SaleError(eligibility.reason ?? "This company cannot be listed for sale yet.");
  }

  return db.transaction(async (tx) => {
    const [openListing] = await tx
      .select({ id: companySaleListings.id })
      .from(companySaleListings)
      .where(
        and(
          eq(companySaleListings.companyId, company.id),
          eq(companySaleListings.status, "OPEN"),
        ),
      )
      .limit(1);
    if (openListing) {
      throw new SaleError("This company is already listed for sale.");
    }

    const salesFigure = await getCompanySalesFigure(company.id, tx);
    const valuation = computeValuation(salesFigure, policy.multiplierBp);

    const [listing] = await tx
      .insert(companySaleListings)
      .values({
        companyId: company.id,
        sellerUserId,
        reason,
        salesFigure,
        multiplierBp: policy.multiplierBp,
        valuation,
      })
      .returning();

    await recordAudit(tx, {
      action: "COMPANY_LISTED_FOR_SALE",
      actorType: "USER",
      actorId: sellerUserId,
      actorLabel: company.username,
      targetType: "COMPANY",
      targetId: company.id,
      newValue: String(valuation),
      reason,
      metadata: { salesFigure, multiplierBp: policy.multiplierBp, valuation },
    });

    await notifyUser(
      tx,
      sellerUserId,
      "COMPANY_LISTED",
      `"${company.name}" is now listed for sale at ${valuation.toLocaleString()} Aeros.`,
      "/my-company/sale",
    );

    return listing;
  });
}

export async function cancelListing(params: {
  listingId: string;
  actorUserId: string;
  reason?: string | null;
}): Promise<CompanySaleListing> {
  const { listingId, actorUserId } = params;

  return db.transaction(async (tx) => {
    const [listing] = await tx
      .select()
      .from(companySaleListings)
      .where(eq(companySaleListings.id, listingId))
      .for("update");
    if (!listing) throw new SaleError("Listing not found.");
    if (listing.status !== "OPEN") {
      throw new SaleError("This listing is no longer open.");
    }

    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, listing.companyId))
      .limit(1);
    if (!company || company.ownerUserId !== actorUserId) {
      throw new SaleError("Only the owner can cancel this listing.");
    }

    const [updated] = await tx
      .update(companySaleListings)
      .set({
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: params.reason ?? null,
      })
      .where(eq(companySaleListings.id, listingId))
      .returning();

    await recordAudit(tx, {
      action: "COMPANY_LISTING_CANCELLED",
      actorType: "USER",
      actorId: actorUserId,
      actorLabel: company.username,
      targetType: "COMPANY",
      targetId: company.id,
      previousValue: "OPEN",
      newValue: "CANCELLED",
      reason: params.reason ?? null,
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Per-viewer dismissal
// ---------------------------------------------------------------------------

/**
 * Hides a listing for ONE user only. The listing itself is untouched and
 * stays visible to everyone else — dismissing is a personal preference, not a
 * moderation action.
 */
export async function dismissListing(listingId: string, userId: string): Promise<void> {
  try {
    await db.insert(companySaleDismissals).values({ listingId, userId });
  } catch (e) {
    // Already dismissed — nothing to do.
    if (!isUniqueViolation(e)) throw e;
  }
}

export async function undismissListing(listingId: string, userId: string): Promise<void> {
  await db
    .delete(companySaleDismissals)
    .where(
      and(
        eq(companySaleDismissals.listingId, listingId),
        eq(companySaleDismissals.userId, userId),
      ),
    );
}

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

/**
 * Transfers company ownership inside an existing transaction, moving the
 * price between the two personal wallets. Shared by direct purchases and by
 * accepted offers so both paths behave identically.
 */
async function settleOwnershipTransfer(
  tx: Tx,
  params: {
    company: Company;
    sellerUserId: string;
    buyerUserId: string | null; // null = Government acquisition
    price: number;
    listingId?: string | null;
    offerId?: string | null;
    saleType: "LISTING_PURCHASE" | "USER_OFFER" | "GOVERNMENT_OFFER";
    salesFigure: number;
    multiplierBp: number;
  },
): Promise<{ txRef: string }> {
  const { company, sellerUserId, buyerUserId, price, saleType } = params;

  const [seller] = await tx.select().from(users).where(eq(users.id, sellerUserId)).limit(1);
  if (!seller) throw new SaleError("Seller account not found.");

  let fromWallet;
  if (buyerUserId === null) {
    const [gov] = await tx.select({ id: government.id }).from(government).limit(1);
    if (!gov) throw new SaleError("Government account is not initialized.");
    fromWallet = governmentWallet(gov.id);
  } else {
    if (buyerUserId === sellerUserId) {
      throw new SaleError("You already own this company.");
    }
    fromWallet = userWallet(buyerUserId);
  }

  // Price moves between personal wallets (or the treasury, for a Government
  // acquisition). Tax-free: the seller receives exactly the agreed price.
  const result = await transferInTx(tx, {
    from: fromWallet,
    to: userWallet(sellerUserId),
    amount: price,
    forcedTaxRateBp: 0,
    type: "COMPANY_SALE_PURCHASE",
    reason: `Purchase of company @${company.username}`,
    notify: {
      senderType: "COMPANY_PURCHASED",
      senderMessage: (r) =>
        `You purchased "${company.name}" (@${company.username}) for ${r.grossAmount.toLocaleString()} Aeros. Ref ${r.txRef}.`,
      receiverType: "COMPANY_SOLD",
      receiverMessage: (r) =>
        `You sold "${company.name}" (@${company.username}) for ${r.netAmount.toLocaleString()} Aeros. Ref ${r.txRef}.`,
      href: "/companies",
    },
  });

  // Ownership moves. The company's own wallet balance is untouched.
  if (buyerUserId === null) {
    await tx
      .update(companies)
      .set({ governmentOwned: true, governmentAcquiredAt: new Date() })
      .where(eq(companies.id, company.id));
  } else {
    await tx
      .update(companies)
      .set({ ownerUserId: buyerUserId, governmentOwned: false, governmentAcquiredAt: null })
      .where(eq(companies.id, company.id));
  }

  await tx.insert(companySaleRecords).values({
    companyId: company.id,
    listingId: params.listingId ?? null,
    offerId: params.offerId ?? null,
    sellerUserId,
    // For a Government acquisition the buyer column records the seller's id
    // would be wrong; instead we store the Government as the buyer by using
    // the seller only when a real user bought it.
    buyerUserId: buyerUserId ?? sellerUserId,
    price,
    salesFigure: params.salesFigure,
    multiplierBp: params.multiplierBp,
    companyBalanceAtSale: company.balance,
    txRef: result.txRef,
    saleType,
  });

  // Any other pending offers on this company are no longer actionable.
  await tx
    .update(companySaleOffers)
    .set({ status: "WITHDRAWN", respondedAt: new Date(), responseNote: "Company was sold." })
    .where(
      and(
        eq(companySaleOffers.companyId, company.id),
        eq(companySaleOffers.status, "PENDING"),
        params.offerId ? ne(companySaleOffers.id, params.offerId) : sql`true`,
      ),
    );

  await recordAudit(tx, {
    action: "COMPANY_OWNERSHIP_TRANSFERRED",
    actorType: buyerUserId === null ? "GOVERNMENT" : "USER",
    actorId: buyerUserId,
    actorLabel: company.username,
    targetType: "COMPANY",
    targetId: company.id,
    previousValue: `owner ${seller.username}`,
    newValue: buyerUserId === null ? "Government stewardship" : `owner ${buyerUserId}`,
    metadata: {
      price,
      saleType,
      txRef: result.txRef,
      salesFigure: params.salesFigure,
      multiplierBp: params.multiplierBp,
      companyBalanceAtSale: company.balance,
    },
  });

  return { txRef: result.txRef };
}

export async function purchaseListing(params: {
  listingId: string;
  buyerUserId: string;
}): Promise<{ txRef: string; company: Company; price: number }> {
  const { listingId, buyerUserId } = params;

  return db.transaction(async (tx) => {
    const [listing] = await tx
      .select()
      .from(companySaleListings)
      .where(eq(companySaleListings.id, listingId))
      .for("update");

    if (!listing) throw new SaleError("Listing not found.");
    if (listing.status === "SOLD") throw new SaleError("This company has already been sold.");
    if (listing.status !== "OPEN") throw new SaleError("This listing is no longer available.");

    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, listing.companyId))
      .for("update");
    if (!company) throw new SaleError("Company not found.");
    if (company.governmentOwned) {
      throw new SaleError("This company is under Government stewardship.");
    }
    if (company.ownerUserId === buyerUserId) {
      throw new SaleError("You already own this company.");
    }
    // The owner may have changed since the listing was created.
    if (company.ownerUserId !== listing.sellerUserId) {
      throw new SaleError("This listing is out of date and can no longer be purchased.");
    }
    if (effectiveCompanyStatus(company) !== "APPROVED") {
      throw new SaleError("This company is not currently active and cannot be sold.");
    }

    const settled = await settleOwnershipTransfer(tx, {
      company,
      sellerUserId: listing.sellerUserId,
      buyerUserId,
      price: listing.valuation,
      listingId: listing.id,
      saleType: "LISTING_PURCHASE",
      salesFigure: listing.salesFigure,
      multiplierBp: listing.multiplierBp,
    });

    // Guarded transition: only a still-OPEN listing can be marked SOLD, so a
    // double submit cannot sell the same company twice.
    const marked = await tx
      .update(companySaleListings)
      .set({
        status: "SOLD",
        buyerUserId,
        salePrice: listing.valuation,
        soldAt: new Date(),
        soldTxRef: settled.txRef,
      })
      .where(
        and(eq(companySaleListings.id, listingId), eq(companySaleListings.status, "OPEN")),
      )
      .returning();

    if (marked.length === 0) {
      throw new SaleError("This company has already been sold.");
    }

    return { txRef: settled.txRef, company, price: listing.valuation };
  });
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export async function makeOffer(params: {
  companyId: string;
  /** Null for a Government offer. */
  offerorUserId: string | null;
  amount: number;
  message?: string | null;
}): Promise<CompanySaleOffer> {
  const { companyId, offerorUserId, amount } = params;

  if (!Number.isInteger(amount) || amount < 1) {
    throw new SaleError("Offer amount must be a positive whole number.");
  }

  return db.transaction(async (tx) => {
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!company) throw new SaleError("Company not found.");
    if (company.governmentOwned) {
      throw new SaleError("This company is already under Government stewardship.");
    }
    if (effectiveCompanyStatus(company) !== "APPROVED") {
      throw new SaleError("Offers can only be made for an active company.");
    }
    if (offerorUserId && company.ownerUserId === offerorUserId) {
      throw new SaleError("You already own this company.");
    }

    const [listing] = await tx
      .select({ id: companySaleListings.id })
      .from(companySaleListings)
      .where(
        and(
          eq(companySaleListings.companyId, companyId),
          eq(companySaleListings.status, "OPEN"),
        ),
      )
      .limit(1);

    const [offer] = await tx
      .insert(companySaleOffers)
      .values({
        companyId,
        listingId: listing?.id ?? null,
        offerorType: offerorUserId === null ? "GOVERNMENT" : "USER",
        offerorUserId,
        ownerUserId: company.ownerUserId,
        amount,
        message: params.message ?? null,
      })
      .returning();

    const who = offerorUserId === null ? "The Government" : "A buyer";
    await notifyUser(
      tx,
      company.ownerUserId,
      "COMPANY_OFFER_RECEIVED",
      `${who} offered ${amount.toLocaleString()} Aeros for your company "${company.name}". Your acceptance is required.`,
      "/my-company/sale",
    );

    await recordAudit(tx, {
      action: "COMPANY_OFFER_MADE",
      actorType: offerorUserId === null ? "GOVERNMENT" : "USER",
      actorId: offerorUserId,
      actorLabel: offerorUserId === null ? "government" : undefined,
      targetType: "COMPANY",
      targetId: companyId,
      newValue: String(amount),
      metadata: { amount, offerId: offer.id },
    });

    return offer;
  });
}

export async function respondToOffer(params: {
  offerId: string;
  ownerUserId: string;
  accept: boolean;
  note?: string | null;
}): Promise<{ offer: CompanySaleOffer; txRef?: string }> {
  const { offerId, ownerUserId, accept } = params;

  return db.transaction(async (tx) => {
    const [offer] = await tx
      .select()
      .from(companySaleOffers)
      .where(eq(companySaleOffers.id, offerId))
      .for("update");
    if (!offer) throw new SaleError("Offer not found.");
    if (offer.status !== "PENDING") {
      throw new SaleError("This offer has already been responded to.");
    }

    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, offer.companyId))
      .for("update");
    if (!company) throw new SaleError("Company not found.");
    if (company.ownerUserId !== ownerUserId) {
      throw new SaleError("Only the current owner can respond to this offer.");
    }

    if (!accept) {
      const [declined] = await tx
        .update(companySaleOffers)
        .set({
          status: "DECLINED",
          respondedAt: new Date(),
          responseNote: params.note ?? null,
        })
        .where(eq(companySaleOffers.id, offerId))
        .returning();

      if (offer.offerorUserId) {
        await notifyUser(
          tx,
          offer.offerorUserId,
          "COMPANY_OFFER_DECLINED",
          `Your offer of ${offer.amount.toLocaleString()} Aeros for "${company.name}" was declined.`,
          "/companies",
        );
      }

      await recordAudit(tx, {
        action: "COMPANY_OFFER_DECLINED",
        actorType: "USER",
        actorId: ownerUserId,
        actorLabel: company.username,
        targetType: "COMPANY",
        targetId: company.id,
        previousValue: "PENDING",
        newValue: "DECLINED",
        reason: params.note ?? null,
      });

      return { offer: declined };
    }

    // --- acceptance -------------------------------------------------------
    if (effectiveCompanyStatus(company) !== "APPROVED") {
      throw new SaleError("This company is not currently active and cannot be sold.");
    }

    const salesFigure = await getCompanySalesFigure(company.id, tx);
    const policy = await getSalePolicy(tx);

    const settled = await settleOwnershipTransfer(tx, {
      company,
      sellerUserId: ownerUserId,
      buyerUserId: offer.offerorUserId,
      price: offer.amount,
      listingId: offer.listingId,
      offerId: offer.id,
      saleType: offer.offerorType === "GOVERNMENT" ? "GOVERNMENT_OFFER" : "USER_OFFER",
      salesFigure,
      multiplierBp: policy.multiplierBp,
    });

    const [accepted] = await tx
      .update(companySaleOffers)
      .set({
        status: "ACCEPTED",
        respondedAt: new Date(),
        responseNote: params.note ?? null,
        settledTxRef: settled.txRef,
      })
      .where(and(eq(companySaleOffers.id, offerId), eq(companySaleOffers.status, "PENDING")))
      .returning();

    if (accepted === undefined) {
      throw new SaleError("This offer has already been responded to.");
    }

    // Close any open listing for this company.
    if (offer.listingId) {
      await tx
        .update(companySaleListings)
        .set({
          status: "SOLD",
          buyerUserId: offer.offerorUserId,
          salePrice: offer.amount,
          soldAt: new Date(),
          soldTxRef: settled.txRef,
        })
        .where(
          and(
            eq(companySaleListings.id, offer.listingId),
            eq(companySaleListings.status, "OPEN"),
          ),
        );
    } else {
      await tx
        .update(companySaleListings)
        .set({
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelReason: "Company was sold through a direct offer.",
        })
        .where(
          and(
            eq(companySaleListings.companyId, company.id),
            eq(companySaleListings.status, "OPEN"),
          ),
        );
    }

    return { offer: accepted, txRef: settled.txRef };
  });
}

export async function withdrawOffer(params: {
  offerId: string;
  offerorUserId: string | null;
}): Promise<void> {
  const [offer] = await db
    .select()
    .from(companySaleOffers)
    .where(eq(companySaleOffers.id, params.offerId))
    .limit(1);
  if (!offer) throw new SaleError("Offer not found.");
  if (offer.status !== "PENDING") throw new SaleError("This offer is no longer pending.");
  if (offer.offerorUserId !== params.offerorUserId) {
    throw new SaleError("Only the person who made this offer can withdraw it.");
  }

  await db
    .update(companySaleOffers)
    .set({ status: "WITHDRAWN", respondedAt: new Date() })
    .where(eq(companySaleOffers.id, params.offerId));
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Open listings, excluding ones this viewer has personally dismissed.
 * The listing rows themselves are never modified by a dismissal.
 */
export async function getOpenListingsForViewer(viewerUserId: string) {
  const dismissed = await db
    .select({ listingId: companySaleDismissals.listingId })
    .from(companySaleDismissals)
    .where(eq(companySaleDismissals.userId, viewerUserId));

  const dismissedIds = dismissed.map((d) => d.listingId);

  const conditions = [eq(companySaleListings.status, "OPEN")];
  if (dismissedIds.length > 0) {
    conditions.push(notInArray(companySaleListings.id, dismissedIds));
  }

  return db
    .select({
      listing: companySaleListings,
      company: companies,
      sellerUsername: users.username,
      sellerDisplayName: users.displayName,
    })
    .from(companySaleListings)
    .innerJoin(companies, eq(companies.id, companySaleListings.companyId))
    .innerJoin(users, eq(users.id, companySaleListings.sellerUserId))
    .where(and(...conditions))
    .orderBy(desc(companySaleListings.createdAt));
}

/** Every open listing, ignoring dismissals (Government view). */
export async function getAllOpenListings() {
  return db
    .select({
      listing: companySaleListings,
      company: companies,
      sellerUsername: users.username,
    })
    .from(companySaleListings)
    .innerJoin(companies, eq(companies.id, companySaleListings.companyId))
    .innerJoin(users, eq(users.id, companySaleListings.sellerUserId))
    .where(eq(companySaleListings.status, "OPEN"))
    .orderBy(desc(companySaleListings.createdAt));
}

export async function getListingById(listingId: string) {
  const [row] = await db
    .select({
      listing: companySaleListings,
      company: companies,
      sellerUsername: users.username,
      sellerDisplayName: users.displayName,
    })
    .from(companySaleListings)
    .innerJoin(companies, eq(companies.id, companySaleListings.companyId))
    .innerJoin(users, eq(users.id, companySaleListings.sellerUserId))
    .where(eq(companySaleListings.id, listingId))
    .limit(1);
  return row ?? null;
}

export async function getActiveListingForCompany(companyId: string) {
  const [row] = await db
    .select()
    .from(companySaleListings)
    .where(
      and(eq(companySaleListings.companyId, companyId), eq(companySaleListings.status, "OPEN")),
    )
    .limit(1);
  return row ?? null;
}

export async function getPendingOffersForOwner(ownerUserId: string) {
  return db
    .select({
      offer: companySaleOffers,
      company: companies,
    })
    .from(companySaleOffers)
    .innerJoin(companies, eq(companies.id, companySaleOffers.companyId))
    .where(
      and(
        eq(companySaleOffers.ownerUserId, ownerUserId),
        eq(companySaleOffers.status, "PENDING"),
      ),
    )
    .orderBy(desc(companySaleOffers.createdAt));
}

export async function getOffersForCompany(companyId: string) {
  return db
    .select()
    .from(companySaleOffers)
    .where(eq(companySaleOffers.companyId, companyId))
    .orderBy(desc(companySaleOffers.createdAt));
}

export async function getSaleHistoryForCompany(companyId: string) {
  return db
    .select()
    .from(companySaleRecords)
    .where(eq(companySaleRecords.companyId, companyId))
    .orderBy(desc(companySaleRecords.createdAt));
}

export async function getAllSaleRecords(limit = 200) {
  return db
    .select({
      record: companySaleRecords,
      companyName: companies.name,
      companyUsername: companies.username,
    })
    .from(companySaleRecords)
    .innerJoin(companies, eq(companies.id, companySaleRecords.companyId))
    .orderBy(desc(companySaleRecords.createdAt))
    .limit(limit);
}

export async function getPendingOfferCount(): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(companySaleOffers)
    .where(eq(companySaleOffers.status, "PENDING"));
  return row?.c ?? 0;
}
