import "server-only";
import { db } from "@/db/client";
import { companies, ipComplaints } from "@/db/schema";
import { alias } from "drizzle-orm/pg-core";
import { desc, eq, sql } from "drizzle-orm";
import { recordAudit } from "./audit";
import { notifyUser } from "./notify";
import { setCompanyStatus } from "./companies";
import { effectiveCompanyStatus } from "./status";
import type { Company, IpComplaint } from "@/db/schema";

/**
 * Company IP / copyright complaints (spec §45–47).
 *
 * Important deliberate omission: there is NO automatic rule that resolves a
 * complaint in favour of whichever company has more sales or activity. Sales
 * figures are shown to the Government as context only. Every outcome is an
 * explicit Government decision with a written reason, recorded in the audit
 * log (spec §46).
 */

export class IpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function nextComplaintNumber(tx: Tx): Promise<string> {
  const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(ipComplaints);
  return `IP-${String((row?.count ?? 0) + 1).padStart(5, "0")}`;
}

export async function submitComplaint(params: {
  complainant: Company;
  accusedCompanyUsername: string;
  reason: string;
  description: string;
  evidence: string;
  referenceMaterial?: string | null;
}): Promise<IpComplaint> {
  const { complainant, accusedCompanyUsername } = params;

  if (effectiveCompanyStatus(complainant) !== "APPROVED") {
    throw new IpError("Only an active company can file a complaint.");
  }

  return db.transaction(async (tx) => {
    const [accused] = await tx
      .select()
      .from(companies)
      .where(eq(companies.username, accusedCompanyUsername))
      .limit(1);

    if (!accused) throw new IpError("No company found with that username.");
    if (accused.id === complainant.id) {
      throw new IpError("A company cannot file a complaint against itself.");
    }

    const complaintNumber = await nextComplaintNumber(tx);

    const [complaint] = await tx
      .insert(ipComplaints)
      .values({
        complaintNumber,
        complainantCompanyId: complainant.id,
        accusedCompanyId: accused.id,
        reason: params.reason,
        description: params.description,
        evidence: params.evidence,
        referenceMaterial: params.referenceMaterial ?? null,
      })
      .returning();

    await recordAudit(tx, {
      action: "IP_COMPLAINT_SUBMITTED",
      actorType: "COMPANY",
      actorId: complainant.id,
      actorLabel: complainant.name,
      targetType: "COMPANY",
      targetId: accused.id,
      reason: params.reason,
      metadata: { complaintNumber, accused: accused.username },
    });

    await notifyUser(
      tx,
      complainant.ownerUserId,
      "IP_COMPLAINT_SUBMITTED",
      `Your IP complaint ${complaintNumber} against @${accused.username} was submitted for Government review.`,
      "/my-company/complaints",
    );

    return complaint;
  });
}

export type IpDecision =
  | "DISMISSED"
  | "WARNING"
  | "STRIKE"
  | "SECOND_STRIKE"
  | "TEMPORARY_SUSPENSION"
  | "PERMANENT_REVOCATION";

const DECISION_LABELS: Record<IpDecision, string> = {
  DISMISSED: "dismissed",
  WARNING: "issued a warning to",
  STRIKE: "issued a strike against",
  SECOND_STRIKE: "issued a second strike against",
  TEMPORARY_SUSPENSION: "temporarily suspended",
  PERMANENT_REVOCATION: "permanently revoked",
};

/** Strikes added to the accused company by each decision. */
const STRIKE_WEIGHT: Record<IpDecision, number> = {
  DISMISSED: 0,
  WARNING: 0,
  STRIKE: 1,
  SECOND_STRIKE: 2,
  TEMPORARY_SUSPENSION: 1,
  PERMANENT_REVOCATION: 0,
};

export async function decideComplaint(params: {
  complaintId: string;
  governmentId: string;
  governmentUsername: string;
  decision: IpDecision;
  reason: string;
  suspendUntil?: Date | null;
}): Promise<IpComplaint> {
  const { complaintId, governmentId, governmentUsername, decision, reason } = params;

  if (!reason.trim()) {
    throw new IpError("Every IP decision must include a written reason.");
  }

  const decided = await db.transaction(async (tx) => {
    const [complaint] = await tx
      .select()
      .from(ipComplaints)
      .where(eq(ipComplaints.id, complaintId))
      .for("update");
    if (!complaint) throw new IpError("Complaint not found.");
    if (complaint.status === "RESOLVED") {
      throw new IpError("This complaint has already been decided.");
    }

    const [accused] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, complaint.accusedCompanyId))
      .for("update");
    if (!accused) throw new IpError("The accused company no longer exists.");

    const [updated] = await tx
      .update(ipComplaints)
      .set({
        status: "RESOLVED",
        decision,
        decisionReason: reason,
        decidedAt: new Date(),
        decidedBy: governmentUsername,
      })
      .where(eq(ipComplaints.id, complaintId))
      .returning();

    const addedStrikes = STRIKE_WEIGHT[decision];
    if (addedStrikes > 0) {
      await tx
        .update(companies)
        .set({ strikes: sql`${companies.strikes} + ${addedStrikes}` })
        .where(eq(companies.id, accused.id));
    }

    await recordAudit(tx, {
      action: "IP_COMPLAINT_DECIDED",
      actorType: "GOVERNMENT",
      actorId: governmentId,
      actorLabel: governmentUsername,
      targetType: "IP_COMPLAINT",
      targetId: complaintId,
      previousValue: complaint.status,
      newValue: decision,
      reason,
      metadata: {
        complaintNumber: complaint.complaintNumber,
        accused: accused.username,
        addedStrikes,
      },
    });

    await notifyUser(
      tx,
      accused.ownerUserId,
      "IP_DECISION",
      `Government ${DECISION_LABELS[decision]} your company "${accused.name}" following IP complaint ${complaint.complaintNumber}. Reason: ${reason}`,
      "/my-company",
    );

    const [complainant] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, complaint.complainantCompanyId))
      .limit(1);
    if (complainant) {
      await notifyUser(
        tx,
        complainant.ownerUserId,
        "IP_DECISION",
        `Your IP complaint ${complaint.complaintNumber} has been decided: ${decision.replace(/_/g, " ").toLowerCase()}.`,
        "/my-company/complaints",
      );
    }

    return { complaint: updated, accusedId: accused.id };
  });

  // Enforcement actions run as their own audited status change so the company
  // status trail stays readable on its own.
  if (decision === "TEMPORARY_SUSPENSION") {
    await setCompanyStatus({
      companyId: decided.accusedId,
      governmentId,
      governmentUsername,
      status: "SUSPENDED",
      reason: `IP decision: ${reason}`,
      suspendedUntil: params.suspendUntil ?? null,
    });
  } else if (decision === "PERMANENT_REVOCATION") {
    await setCompanyStatus({
      companyId: decided.accusedId,
      governmentId,
      governmentUsername,
      status: "REVOKED",
      reason: `IP decision: ${reason}`,
    });
  }

  return decided.complaint;
}

export async function setComplaintUnderReview(complaintId: string): Promise<void> {
  await db
    .update(ipComplaints)
    .set({ status: "UNDER_REVIEW" })
    .where(eq(ipComplaints.id, complaintId));
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const complainantCo = alias(companies, "complainant_co");
const accusedCo = alias(companies, "accused_co");

const complaintSelection = {
  complaint: ipComplaints,
  complainantName: complainantCo.name,
  complainantUsername: complainantCo.username,
  accusedName: accusedCo.name,
  accusedUsername: accusedCo.username,
  accusedStrikes: accusedCo.strikes,
};

export async function getAllComplaints(limit = 200) {
  return db
    .select(complaintSelection)
    .from(ipComplaints)
    .innerJoin(complainantCo, eq(complainantCo.id, ipComplaints.complainantCompanyId))
    .innerJoin(accusedCo, eq(accusedCo.id, ipComplaints.accusedCompanyId))
    .orderBy(desc(ipComplaints.createdAt))
    .limit(limit);
}

export async function getComplaintById(complaintId: string) {
  const [row] = await db
    .select(complaintSelection)
    .from(ipComplaints)
    .innerJoin(complainantCo, eq(complainantCo.id, ipComplaints.complainantCompanyId))
    .innerJoin(accusedCo, eq(accusedCo.id, ipComplaints.accusedCompanyId))
    .where(eq(ipComplaints.id, complaintId))
    .limit(1);
  return row ?? null;
}

export async function getComplaintsForCompany(companyId: string) {
  const filed = await db
    .select(complaintSelection)
    .from(ipComplaints)
    .innerJoin(complainantCo, eq(complainantCo.id, ipComplaints.complainantCompanyId))
    .innerJoin(accusedCo, eq(accusedCo.id, ipComplaints.accusedCompanyId))
    .where(eq(ipComplaints.complainantCompanyId, companyId))
    .orderBy(desc(ipComplaints.createdAt));

  const against = await db
    .select(complaintSelection)
    .from(ipComplaints)
    .innerJoin(complainantCo, eq(complainantCo.id, ipComplaints.complainantCompanyId))
    .innerJoin(accusedCo, eq(accusedCo.id, ipComplaints.accusedCompanyId))
    .where(eq(ipComplaints.accusedCompanyId, companyId))
    .orderBy(desc(ipComplaints.createdAt));

  return { filed, against };
}

export async function getOpenComplaintCount(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ipComplaints)
    .where(sql`${ipComplaints.status} <> 'RESOLVED'`);
  return row?.count ?? 0;
}
