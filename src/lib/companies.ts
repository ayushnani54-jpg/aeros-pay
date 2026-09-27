import "server-only";
import { db } from "@/db/client";
import { companies, government, users } from "@/db/schema";
import { and, eq, ne } from "drizzle-orm";
import {
  COMPANY_APPROVAL_FUNDING_AMOUNT,
  COMPANY_DESCRIPTION_MAX_WORDS,
} from "./constants";
import { isUniqueViolation } from "./db-errors";
import { recordAudit } from "./audit";
import { notifyUser, publishUpdate } from "./notify";
import { payCompanyFromTreasury } from "./payments";
import { canUserCreateCompany, effectiveCompanyStatus } from "./status";
import type { Company } from "@/db/schema";

export class CompanyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyError";
  }
}

/** Counts words the same way the UI hint does, so the server-side limit and
 * the on-screen counter never disagree. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export function assertDescriptionWithinLimit(description: string): void {
  const words = countWords(description);
  if (words > COMPANY_DESCRIPTION_MAX_WORDS) {
    throw new CompanyError(
      `Company description must be ${COMPANY_DESCRIPTION_MAX_WORDS} words or fewer (yours is ${words}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export async function applyForCompany(params: {
  ownerUserId: string;
  name: string;
  username: string;
  category: string;
  reason: string;
  description: string;
}): Promise<Company> {
  const { ownerUserId, name, username, category, reason, description } = params;

  // Enforced server-side — the client-side counter is only a convenience.
  assertDescriptionWithinLimit(description);

  return db.transaction(async (tx) => {
    const [owner] = await tx.select().from(users).where(eq(users.id, ownerUserId)).for("update");
    if (!owner) throw new CompanyError("Your account could not be found.");
    if (!canUserCreateCompany(owner)) {
      throw new CompanyError(
        "Your account must be active to create a company.",
      );
    }

    // A company username must not collide with a user username either — both
    // are payable handles, so they share one namespace.
    const [userClash] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (userClash) {
      throw new CompanyError("That username is already taken.");
    }

    const [existingPending] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.ownerUserId, ownerUserId), eq(companies.status, "PENDING")))
      .limit(1);
    if (existingPending) {
      throw new CompanyError(
        "You already have a company application awaiting Government review.",
      );
    }

    let company: Company;
    try {
      const [inserted] = await tx
        .insert(companies)
        .values({ ownerUserId, name, username, category, reason, description })
        .returning();
      company = inserted;
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new CompanyError("That company username is already taken.");
      }
      throw e;
    }

    await recordAudit(tx, {
      action: "COMPANY_APPLICATION_SUBMITTED",
      actorType: "USER",
      actorId: ownerUserId,
      actorLabel: owner.username,
      targetType: "COMPANY",
      targetId: company.id,
      newValue: "PENDING",
      metadata: { name, username, category },
    });

    await notifyUser(
      tx,
      ownerUserId,
      "COMPANY_APPLICATION_SUBMITTED",
      `Your company application for "${name}" was submitted and is awaiting Government review.`,
      "/my-company",
    );

    return company;
  });
}

// ---------------------------------------------------------------------------
// Government review
// ---------------------------------------------------------------------------

/**
 * Approves a company and funds it from the treasury in one atomic step.
 *
 * If the treasury cannot cover the funding, nothing happens at all — the
 * company is not left approved-but-unfunded (spec §16).
 */
export async function approveCompany(params: {
  companyId: string;
  governmentId: string;
  governmentUsername: string;
  fundingAmount?: number;
}): Promise<{ company: Company; txRef: string; amount: number }> {
  const { companyId, governmentId, governmentUsername } = params;
  const amount = params.fundingAmount ?? COMPANY_APPROVAL_FUNDING_AMOUNT;

  const approved = await db.transaction(async (tx) => {
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update");
    if (!company) throw new CompanyError("Company not found.");
    if (company.status === "APPROVED") {
      throw new CompanyError("This company is already approved.");
    }
    if (company.status === "REVOKED") {
      throw new CompanyError("This company has been revoked and cannot be approved.");
    }

    const [govRow] = await tx
      .select()
      .from(government)
      .where(eq(government.id, governmentId))
      .for("update");
    if (!govRow) throw new CompanyError("Government account not found.");
    if (govRow.balance < amount) {
      throw new CompanyError(
        `Government treasury has insufficient Aeros to fund this company (${amount.toLocaleString()} required, ${govRow.balance.toLocaleString()} available).`,
      );
    }

    const [updated] = await tx
      .update(companies)
      .set({
        status: "APPROVED",
        reviewedAt: new Date(),
        reviewedBy: governmentUsername,
        rejectionReason: null,
      })
      .where(eq(companies.id, companyId))
      .returning();

    await recordAudit(tx, {
      action: "COMPANY_APPROVED",
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: governmentUsername,
      targetType: "COMPANY",
      targetId: companyId,
      previousValue: company.status,
      newValue: "APPROVED",
      metadata: { name: company.name, username: company.username },
    });

    return updated;
  });

  // Funding is its own atomic transfer. The balance check above makes a
  // failure here very unlikely, but if it does fail the approval stands and
  // the Government can fund manually — the ledger is never left inconsistent.
  const funding = await payCompanyFromTreasury({
    governmentId,
    companyId,
    amount,
    reason: "Company approval funding",
    type: "COMPANY_FUNDING",
  });

  await db
    .update(companies)
    .set({ fundedAt: new Date() })
    .where(eq(companies.id, companyId));

  await notifyUser(
    db,
    approved.ownerUserId,
    "COMPANY_APPROVED",
    `Your company "${approved.name}" (@${approved.username}) was approved and funded with ${amount.toLocaleString()} Aeros.`,
    "/my-company",
  );

  await publishUpdate(db, {
    title: `New company approved: ${approved.name}`,
    content: `${approved.name} (@${approved.username}) has been approved and is now open for business.`,
    authorLabel: "Government",
  });

  return { company: approved, txRef: funding.txRef, amount };
}

export async function rejectCompany(params: {
  companyId: string;
  governmentId: string;
  governmentUsername: string;
  reason: string;
}): Promise<Company> {
  const { companyId, governmentId, governmentUsername, reason } = params;

  return db.transaction(async (tx) => {
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update");
    if (!company) throw new CompanyError("Company not found.");
    if (company.status === "APPROVED") {
      throw new CompanyError(
        "This company is already approved. Suspend or revoke it instead of rejecting.",
      );
    }

    const [updated] = await tx
      .update(companies)
      .set({
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewedBy: governmentUsername,
        rejectionReason: reason,
      })
      .where(eq(companies.id, companyId))
      .returning();

    await recordAudit(tx, {
      action: "COMPANY_REJECTED",
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: governmentUsername,
      targetType: "COMPANY",
      targetId: companyId,
      previousValue: company.status,
      newValue: "REJECTED",
      reason,
      metadata: { name: company.name, username: company.username },
    });

    await notifyUser(
      tx,
      company.ownerUserId,
      "COMPANY_REJECTED",
      `Your company application for "${company.name}" was not approved. Reason: ${reason}`,
      "/my-company",
    );

    return updated;
  });
}

/** Government may correct a company's public-facing fields (spec §15). */
export async function editCompanyProfile(params: {
  companyId: string;
  governmentId: string;
  governmentUsername: string;
  name?: string;
  username?: string;
  description?: string;
  category?: string;
}): Promise<Company> {
  const { companyId, governmentId, governmentUsername } = params;

  if (params.description !== undefined) {
    assertDescriptionWithinLimit(params.description);
  }

  return db.transaction(async (tx) => {
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update");
    if (!company) throw new CompanyError("Company not found.");

    if (params.username && params.username !== company.username) {
      const [userClash] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, params.username))
        .limit(1);
      if (userClash) throw new CompanyError("That username is already taken.");

      const [companyClash] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.username, params.username), ne(companies.id, companyId)))
        .limit(1);
      if (companyClash) throw new CompanyError("That company username is already taken.");
    }

    const changes: Partial<typeof companies.$inferInsert> = {};
    if (params.name !== undefined) changes.name = params.name;
    if (params.username !== undefined) changes.username = params.username;
    if (params.description !== undefined) changes.description = params.description;
    if (params.category !== undefined) changes.category = params.category;

    if (Object.keys(changes).length === 0) return company;

    let updated: Company;
    try {
      const [row] = await tx
        .update(companies)
        .set(changes)
        .where(eq(companies.id, companyId))
        .returning();
      updated = row;
    } catch (e) {
      if (isUniqueViolation(e)) throw new CompanyError("That company username is already taken.");
      throw e;
    }

    await recordAudit(tx, {
      action: "COMPANY_PROFILE_EDITED",
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: governmentUsername,
      targetType: "COMPANY",
      targetId: companyId,
      previousValue: JSON.stringify({
        name: company.name,
        username: company.username,
        category: company.category,
      }),
      newValue: JSON.stringify({
        name: updated.name,
        username: updated.username,
        category: updated.category,
      }),
      metadata: { changed: Object.keys(changes) },
    });

    await notifyUser(
      tx,
      company.ownerUserId,
      "COMPANY_PROFILE_EDITED",
      `Government updated your company profile for "${updated.name}".`,
      "/my-company",
    );

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Suspension / revocation (separate from the owner's personal account, §44)
// ---------------------------------------------------------------------------

export async function setCompanyStatus(params: {
  companyId: string;
  governmentId: string;
  governmentUsername: string;
  status: "APPROVED" | "SUSPENDED" | "REVOKED";
  reason?: string | null;
  suspendedUntil?: Date | null;
}): Promise<Company> {
  const { companyId, governmentId, governmentUsername, status, reason } = params;

  return db.transaction(async (tx) => {
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("update");
    if (!company) throw new CompanyError("Company not found.");

    const changes: Partial<typeof companies.$inferInsert> = { status };

    if (status === "SUSPENDED") {
      changes.suspendedAt = new Date();
      changes.suspendedUntil = params.suspendedUntil ?? null;
      changes.suspensionReason = reason ?? null;
    } else if (status === "APPROVED") {
      changes.suspendedAt = null;
      changes.suspendedUntil = null;
      changes.suspensionReason = null;
      changes.revokedAt = null;
      changes.revokeReason = null;
    } else if (status === "REVOKED") {
      changes.revokedAt = new Date();
      changes.revokeReason = reason ?? null;
    }

    const [updated] = await tx
      .update(companies)
      .set(changes)
      .where(eq(companies.id, companyId))
      .returning();

    const action =
      status === "SUSPENDED"
        ? "COMPANY_SUSPENDED"
        : status === "REVOKED"
          ? "COMPANY_REVOKED"
          : "COMPANY_RESTORED";

    await recordAudit(tx, {
      action,
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: governmentUsername,
      targetType: "COMPANY",
      targetId: companyId,
      previousValue: company.status,
      newValue: status,
      reason: reason ?? null,
      metadata: {
        name: company.name,
        suspendedUntil: params.suspendedUntil?.toISOString() ?? null,
      },
    });

    const message =
      status === "SUSPENDED"
        ? `Your company "${company.name}" has been suspended.${reason ? ` Reason: ${reason}` : ""}`
        : status === "REVOKED"
          ? `Your company "${company.name}" has been revoked.${reason ? ` Reason: ${reason}` : ""}`
          : `Your company "${company.name}" has been restored to active status.`;

    await notifyUser(tx, company.ownerUserId, action, message, "/my-company");

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Companies the given user owns, whatever their status. */
export async function getCompaniesForOwner(ownerUserId: string): Promise<Company[]> {
  return db.select().from(companies).where(eq(companies.ownerUserId, ownerUserId));
}

/** The user's companies that are currently usable as a payment context. */
export async function getTradableCompaniesForOwner(ownerUserId: string): Promise<Company[]> {
  const rows = await getCompaniesForOwner(ownerUserId);
  return rows.filter((c) => effectiveCompanyStatus(c) === "APPROVED");
}

export async function getCompanyById(companyId: string): Promise<Company | null> {
  const [row] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  return row ?? null;
}

export async function getCompanyByUsername(username: string): Promise<Company | null> {
  const [row] = await db
    .select()
    .from(companies)
    .where(eq(companies.username, username))
    .limit(1);
  return row ?? null;
}

/**
 * Verifies that `companyId` really belongs to `ownerUserId` and is tradable.
 * Every company-context action calls this — the context cookie is only a
 * hint and is never trusted on its own.
 */
export async function requireOwnedCompany(
  ownerUserId: string,
  companyId: string,
): Promise<Company> {
  const company = await getCompanyById(companyId);
  if (!company || company.ownerUserId !== ownerUserId) {
    throw new CompanyError("Company not found.");
  }
  if (effectiveCompanyStatus(company) !== "APPROVED") {
    throw new CompanyError("This company is not active.");
  }
  return company;
}

/** The effective tax rate for a company (its own override, else the default). */
export async function resolveCompanyTaxRateBp(company: Company): Promise<number> {
  if (company.taxRateBp !== null) return company.taxRateBp;
  const [gov] = await db.select({ rate: government.companyTaxRateBp }).from(government).limit(1);
  return gov?.rate ?? 500;
}
