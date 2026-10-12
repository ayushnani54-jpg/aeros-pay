import "server-only";
import { db } from "@/db/client";
import {
  companies,
  companyPartnerships,
  government,
  partnershipSettlements,
  type CompanyPartnership,
  type PartnershipSettlement,
} from "@/db/schema";
import { desc, eq, or } from "drizzle-orm";
import { recordAudit } from "./audit";
import { transferInTx } from "./payments";
import { companyWallet, governmentWallet } from "./wallets";
import { canCompanyTrade } from "./status";
import { CURRENCY_NAME, DEFAULT_PARTNERSHIP_SHARE_BP, DEFAULT_PARTNERSHIP_TAX_RATE_BP } from "./constants";

/**
 * AEROS PAY V5 — COMPANY-TO-COMPANY PARTNERSHIPS & SETTLEMENT ENGINE
 * ==================================================================
 * Workflow:
 * 1. Initiator Company proposes partnership to Partner Company (`PROPOSED`).
 * 2. Partner Company accepts (`ACCEPTED_BY_PARTNER`) or rejects (`REJECTED_BY_PARTNER`).
 * 3. Government reviews and approves (`APPROVED_BY_GOVERNMENT`) or rejects (`REJECTED_BY_GOVERNMENT`),
 *    setting/confirming the tax rate and division terms (default 50/50 = 5000/5000 bp).
 * 4. Atomic settlement (`executePartnershipSettlement`):
 *    - Never creates or destroys Aeros (`SUPPLY_INVARIANT` preserved 100%).
 *    - Deducts Government tax (`govTaxDeducted`) and transfers Partner share (`partnerPayout`)
 *      from the revenue-receiving initiator company to the partner company and Treasury.
 *    - `initiatorPayout + partnerPayout + govTaxDeducted === grossAmount`.
 */

export class PartnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartnershipError";
  }
}

export function calculatePartnershipSplit(params: {
  grossAmount: number;
  initiatorShareBp?: number;
  partnerShareBp?: number;
  govTaxRateBp?: number;
}): {
  grossAmount: number;
  govTaxDeducted: number;
  netDistributable: number;
  initiatorPayout: number;
  partnerPayout: number;
} {
  const gross = Math.trunc(params.grossAmount);
  if (gross < 1) {
    throw new PartnershipError("Gross settlement amount must be at least 1 Aeros.");
  }
  const initBp = params.initiatorShareBp ?? DEFAULT_PARTNERSHIP_SHARE_BP;
  const partBp = params.partnerShareBp ?? DEFAULT_PARTNERSHIP_SHARE_BP;
  if (initBp + partBp !== 10000) {
    throw new PartnershipError("Company shares must sum to 10,000 basis points (100%).");
  }
  const taxBp = params.govTaxRateBp ?? DEFAULT_PARTNERSHIP_TAX_RATE_BP;
  const govTaxDeducted = Math.floor((gross * taxBp) / 10000);
  const netDistributable = gross - govTaxDeducted;
  const partnerPayout = Math.floor((netDistributable * partBp) / 10000);
  const initiatorPayout = netDistributable - partnerPayout;

  return {
    grossAmount: gross,
    govTaxDeducted,
    netDistributable,
    initiatorPayout,
    partnerPayout,
  };
}

export async function proposeCompanyPartnership(params: {
  initiatorCompanyId: string;
  partnerCompanyUsername: string;
  actorUserId: string;
  title: string;
  termsDescription: string;
  initiatorShareBp?: number;
  partnerShareBp?: number;
}): Promise<CompanyPartnership> {
  const initBp = params.initiatorShareBp ?? DEFAULT_PARTNERSHIP_SHARE_BP;
  const partBp = params.partnerShareBp ?? DEFAULT_PARTNERSHIP_SHARE_BP;
  if (initBp + partBp !== 10000) {
    throw new PartnershipError("Partnership division shares must total 100% (10,000 bp).");
  }

  return db.transaction(async (tx) => {
    const [initiator] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, params.initiatorCompanyId));
    if (!initiator || !canCompanyTrade(initiator)) {
      throw new PartnershipError("Initiating company is not active.");
    }
    if (initiator.ownerUserId !== params.actorUserId) {
      throw new PartnershipError("You do not own the initiating company.");
    }

    const cleanUsername = params.partnerCompanyUsername.trim().toLowerCase().replace(/^@/, "");
    const [partner] = await tx
      .select()
      .from(companies)
      .where(eq(companies.username, cleanUsername));
    if (!partner || !canCompanyTrade(partner)) {
      throw new PartnershipError(`Target company @${cleanUsername} was not found or is not active.`);
    }
    if (partner.id === initiator.id) {
      throw new PartnershipError("A company cannot form a partnership with itself.");
    }

    const partnershipNumber = `PRT-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 899)}`;

    const [created] = await tx
      .insert(companyPartnerships)
      .values({
        partnershipNumber,
        initiatorCompanyId: initiator.id,
        partnerCompanyId: partner.id,
        title: params.title.trim(),
        termsDescription: params.termsDescription.trim(),
        initiatorShareBp: initBp,
        partnerShareBp: partBp,
        status: "PROPOSED",
        govTaxRateBp: DEFAULT_PARTNERSHIP_TAX_RATE_BP,
      })
      .returning();

    await recordAudit(tx, {
      action: "PARTNERSHIP_PROPOSED",
      actorType: "COMPANY",
      actorId: initiator.id,
      actorLabel: initiator.username,
      targetType: "COMPANY_PARTNERSHIP",
      targetId: created.id,
      newValue: `${partnershipNumber}: @${initiator.username} -> @${partner.username} (${initBp / 100}% / ${partBp / 100}%)`,
    });

    return created;
  });
}

export async function respondToCompanyPartnership(params: {
  partnershipId: string;
  actorUserId: string;
  decision: "ACCEPT" | "REJECT";
  rejectionReason?: string;
}): Promise<CompanyPartnership> {
  return db.transaction(async (tx) => {
    const [partnership] = await tx
      .select()
      .from(companyPartnerships)
      .where(eq(companyPartnerships.id, params.partnershipId))
      .for("update");
    if (!partnership || partnership.status !== "PROPOSED") {
      throw new PartnershipError("Partnership proposal not found or already responded to.");
    }

    const [partnerComp] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, partnership.partnerCompanyId));
    if (!partnerComp || partnerComp.ownerUserId !== params.actorUserId) {
      throw new PartnershipError("Only the owner of the invited partner company can respond to this proposal.");
    }

    const nextStatus =
      params.decision === "ACCEPT" ? "ACCEPTED_BY_PARTNER" : "REJECTED_BY_PARTNER";

    const [updated] = await tx
      .update(companyPartnerships)
      .set({
        status: nextStatus,
        rejectionReason: params.rejectionReason?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(companyPartnerships.id, partnership.id))
      .returning();

    await recordAudit(tx, {
      action: `PARTNERSHIP_${nextStatus}`,
      actorType: "COMPANY",
      actorId: partnerComp.id,
      actorLabel: partnerComp.username,
      targetType: "COMPANY_PARTNERSHIP",
      targetId: partnership.id,
      previousValue: "PROPOSED",
      newValue: nextStatus,
    });

    return updated;
  });
}

export async function reviewPartnershipByGovernment(params: {
  partnershipId: string;
  decision: "APPROVE" | "REJECT";
  govTaxRateBp?: number;
  rejectionReason?: string;
  govId: string;
  govUsername: string;
}): Promise<CompanyPartnership> {
  return db.transaction(async (tx) => {
    const [partnership] = await tx
      .select()
      .from(companyPartnerships)
      .where(eq(companyPartnerships.id, params.partnershipId))
      .for("update");
    if (!partnership) {
      throw new PartnershipError("Partnership not found.");
    }
    if (partnership.status !== "ACCEPTED_BY_PARTNER") {
      throw new PartnershipError(
        "Partnership must be accepted by the partner company before Government review.",
      );
    }

    const nextStatus =
      params.decision === "APPROVE"
        ? "APPROVED_BY_GOVERNMENT"
        : "REJECTED_BY_GOVERNMENT";
    const taxBp = params.govTaxRateBp ?? partnership.govTaxRateBp;

    const [updated] = await tx
      .update(companyPartnerships)
      .set({
        status: nextStatus,
        govTaxRateBp: taxBp,
        rejectionReason: params.rejectionReason?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(companyPartnerships.id, partnership.id))
      .returning();

    await recordAudit(tx, {
      action: `PARTNERSHIP_${nextStatus}`,
      actorType: "GOVERNMENT",
      actorId: params.govId,
      actorLabel: params.govUsername,
      targetType: "COMPANY_PARTNERSHIP",
      targetId: partnership.id,
      previousValue: "ACCEPTED_BY_PARTNER",
      newValue: `${nextStatus} (tax=${taxBp}bp)`,
    });

    return updated;
  });
}

/**
 * Executes an atomic revenue/profit settlement between the two partnered companies.
 */
export async function executePartnershipSettlement(params: {
  partnershipId: string;
  actorUserId: string;
  grossAmount: number;
  referenceNote: string;
}): Promise<PartnershipSettlement> {
  return db.transaction(async (tx) => {
    const [partnership] = await tx
      .select()
      .from(companyPartnerships)
      .where(eq(companyPartnerships.id, params.partnershipId))
      .for("update");
    if (!partnership || partnership.status !== "APPROVED_BY_GOVERNMENT") {
      throw new PartnershipError(
        "Only Government-approved active partnerships can execute settlements.",
      );
    }

    const [initiatorComp] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, partnership.initiatorCompanyId))
      .for("update");
    const [partnerComp] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, partnership.partnerCompanyId))
      .for("update");

    if (!initiatorComp || !partnerComp) {
      throw new PartnershipError("Partner companies not found.");
    }
    if (
      initiatorComp.ownerUserId !== params.actorUserId &&
      partnerComp.ownerUserId !== params.actorUserId
    ) {
      throw new PartnershipError("Unauthorized to execute settlement for this partnership.");
    }

    const split = calculatePartnershipSplit({
      grossAmount: params.grossAmount,
      initiatorShareBp: partnership.initiatorShareBp,
      partnerShareBp: partnership.partnerShareBp,
      govTaxRateBp: partnership.govTaxRateBp,
    });

    const totalOutflowFromInitiator = split.partnerPayout + split.govTaxDeducted;
    if (initiatorComp.balance < totalOutflowFromInitiator) {
      throw new PartnershipError(
        `Initiator company (@${initiatorComp.username}) has insufficient balance (${initiatorComp.balance} ${CURRENCY_NAME}) to distribute partner share & tax (${totalOutflowFromInitiator} ${CURRENCY_NAME}).`,
      );
    }

    const [gov] = await tx.select().from(government).limit(1);
    if (!gov) {
      throw new PartnershipError("Government treasury not initialized.");
    }

    const settlementNumber = `STL-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 899)}`;

    let partnerTxRef = "NONE";
    if (split.partnerPayout > 0) {
      const pRes = await transferInTx(tx, {
        from: companyWallet(initiatorComp.id),
        to: companyWallet(partnerComp.id),
        amount: split.partnerPayout,
        type: "COMPANY_PAYMENT",
        reason: `Partnership ${partnership.partnershipNumber} settlement (${settlementNumber}): ${params.referenceNote}`,
        forcedTaxRateBp: 0,
      });
      partnerTxRef = pRes.txRef;
    }

    let govTxRef = "NONE";
    if (split.govTaxDeducted > 0) {
      const gRes = await transferInTx(tx, {
        from: companyWallet(initiatorComp.id),
        to: governmentWallet(gov.id),
        amount: split.govTaxDeducted,
        type: "GOVERNMENT_RECEIPT",
        reason: `Partnership tax (${partnership.govTaxRateBp / 100}%) for ${settlementNumber}`,
        forcedTaxRateBp: 0,
      });
      govTxRef = gRes.txRef;
    }

    const [settlement] = await tx
      .insert(partnershipSettlements)
      .values({
        settlementNumber,
        partnershipId: partnership.id,
        grossAmount: split.grossAmount,
        initiatorPayout: split.initiatorPayout,
        partnerPayout: split.partnerPayout,
        govTaxDeducted: split.govTaxDeducted,
        referenceNote: params.referenceNote.trim(),
        initiatorTxRef: settlementNumber,
        partnerTxRef,
        govTxRef,
      })
      .returning();

    await tx
      .update(companyPartnerships)
      .set({
        totalSettledVolumeAeros: partnership.totalSettledVolumeAeros + split.grossAmount,
        updatedAt: new Date(),
      })
      .where(eq(companyPartnerships.id, partnership.id));

    await recordAudit(tx, {
      action: "PARTNERSHIP_SETTLEMENT_EXECUTED",
      actorType: "COMPANY",
      actorId: initiatorComp.id,
      actorLabel: initiatorComp.username,
      targetType: "PARTNERSHIP_SETTLEMENT",
      targetId: settlement.id,
      newValue: `${settlementNumber}: gross=${split.grossAmount}, init=${split.initiatorPayout}, partner=${split.partnerPayout}, tax=${split.govTaxDeducted}`,
    });

    return settlement;
  });
}

export async function listPartnershipsForCompany(companyId: string): Promise<
  Array<{
    partnership: CompanyPartnership;
    initiatorName: string;
    initiatorUsername: string;
    partnerName: string;
    partnerUsername: string;
    settlements: PartnershipSettlement[];
  }>
> {
  const rows = await db
    .select()
    .from(companyPartnerships)
    .where(
      or(
        eq(companyPartnerships.initiatorCompanyId, companyId),
        eq(companyPartnerships.partnerCompanyId, companyId),
      ),
    )
    .orderBy(desc(companyPartnerships.createdAt));

  return enrichPartnerships(rows);
}

export async function listAllPartnershipsForGov(): Promise<
  Array<{
    partnership: CompanyPartnership;
    initiatorName: string;
    initiatorUsername: string;
    partnerName: string;
    partnerUsername: string;
    settlements: PartnershipSettlement[];
  }>
> {
  const rows = await db
    .select()
    .from(companyPartnerships)
    .orderBy(desc(companyPartnerships.createdAt))
    .limit(100);

  return enrichPartnerships(rows);
}

async function enrichPartnerships(rows: CompanyPartnership[]) {
  const out = [];
  for (const p of rows) {
    const [initComp] = await db
      .select({ name: companies.name, username: companies.username })
      .from(companies)
      .where(eq(companies.id, p.initiatorCompanyId))
      .limit(1);
    const [partComp] = await db
      .select({ name: companies.name, username: companies.username })
      .from(companies)
      .where(eq(companies.id, p.partnerCompanyId))
      .limit(1);
    const settlements = await db
      .select()
      .from(partnershipSettlements)
      .where(eq(partnershipSettlements.partnershipId, p.id))
      .orderBy(desc(partnershipSettlements.createdAt))
      .limit(20);

    out.push({
      partnership: p,
      initiatorName: initComp?.name ?? "Company",
      initiatorUsername: initComp?.username ?? "company",
      partnerName: partComp?.name ?? "Partner",
      partnerUsername: partComp?.username ?? "partner",
      settlements,
    });
  }
  return out;
}
