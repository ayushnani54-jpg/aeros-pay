import "server-only";
import { db } from "@/db/client";
import {
  companies,
  government,
  jobApplications,
  jobs,
  users,
  type Job,
  type JobApplication,
} from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { recordAudit } from "./audit";
import { transferInTx } from "./payments";
import { companyWallet, governmentWallet, userWallet } from "./wallets";
import { canCompanyTrade, canUserReceive, canUserSend } from "./status";
import { CURRENCY_NAME } from "./constants";

/**
 * AEROS PAY V5 — JOBS & CITIZEN EMPLOYMENT ENGINE
 * ===============================================
 * - Government can offer jobs to Citizens (Users).
 * - Registered Companies can offer jobs to Citizens (Users).
 * - Companies can NEVER offer jobs to other Companies (strictly enforced).
 * - Full lifecycle: OPEN -> Application -> Hired (IN_PROGRESS) -> COMPLETED & Paid.
 */

export class JobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobError";
  }
}

export async function createJobPosting(params: {
  employerType: "GOVERNMENT" | "COMPANY";
  employerCompanyId?: string | null;
  actorId: string;
  actorLabel: string;
  title: string;
  category: string;
  description: string;
  requirements: string;
  compensationAeros: number;
}): Promise<Job> {
  if (!Number.isInteger(params.compensationAeros) || params.compensationAeros < 1) {
    throw new JobError("Job compensation must be a positive whole number of Aeros.");
  }

  return db.transaction(async (tx) => {
    if (params.employerType === "COMPANY") {
      if (!params.employerCompanyId) {
        throw new JobError("Company ID is required for company job postings.");
      }
      const [comp] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, params.employerCompanyId))
        .for("update");
      if (!comp || !canCompanyTrade(comp)) {
        throw new JobError("Company is not active or eligible to post jobs.");
      }
      if (comp.balance < params.compensationAeros) {
        throw new JobError(
          `Company balance (${comp.balance} ${CURRENCY_NAME}) is insufficient to cover job compensation (${params.compensationAeros} ${CURRENCY_NAME}).`,
        );
      }
    } else {
      const [gov] = await tx.select().from(government).for("update").limit(1);
      if (!gov || gov.balance < params.compensationAeros) {
        throw new JobError("Government Treasury has insufficient balance for this job posting.");
      }
    }

    const jobNumber = `JOB-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 899)}`;

    const [created] = await tx
      .insert(jobs)
      .values({
        jobNumber,
        employerType: params.employerType,
        employerCompanyId: params.employerType === "COMPANY" ? params.employerCompanyId! : null,
        title: params.title.trim(),
        category: params.category.trim(),
        description: params.description.trim(),
        requirements: params.requirements.trim(),
        compensationAeros: params.compensationAeros,
        status: "OPEN",
      })
      .returning();

    await recordAudit(tx, {
      action: "JOB_POSTED",
      actorType: params.employerType === "GOVERNMENT" ? "GOVERNMENT" : "COMPANY",
      actorId: params.actorId,
      actorLabel: params.actorLabel,
      targetType: "JOB",
      targetId: created.id,
      newValue: `${jobNumber}: ${created.title} (${created.compensationAeros} ${CURRENCY_NAME})`,
    });

    return created;
  });
}

/**
 * Citizens (Users) apply for open jobs. Companies cannot apply for jobs.
 */
export async function applyForJob(params: {
  jobId: string;
  userId: string;
  coverNote: string;
}): Promise<JobApplication> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, params.userId));
    if (!user || !canUserSend(user)) {
      throw new JobError("Your citizen account is not eligible to apply for jobs.");
    }

    const [job] = await tx
      .select()
      .from(jobs)
      .where(eq(jobs.id, params.jobId))
      .for("update");
    if (!job || job.status !== "OPEN") {
      throw new JobError("This job is no longer open for applications.");
    }

    if (job.employerType === "COMPANY" && job.employerCompanyId) {
      const [comp] = await tx
        .select()
        .from(companies)
        .where(eq(companies.id, job.employerCompanyId));
      if (comp && comp.ownerUserId === user.id) {
        throw new JobError("You cannot apply to a job posted by your own company.");
      }
    }

    const [existing] = await tx
      .select()
      .from(jobApplications)
      .where(
        and(
          eq(jobApplications.jobId, job.id),
          eq(jobApplications.userId, user.id),
        ),
      )
      .limit(1);
    if (existing) {
      throw new JobError("You have already applied for this job.");
    }

    const [createdApp] = await tx
      .insert(jobApplications)
      .values({
        jobId: job.id,
        userId: user.id,
        coverNote: params.coverNote.trim(),
        status: "PENDING",
      })
      .returning();

    await recordAudit(tx, {
      action: "JOB_APPLICATION_SUBMITTED",
      actorType: "USER",
      actorId: user.id,
      actorLabel: user.username,
      targetType: "JOB",
      targetId: job.id,
      newValue: `Application by @${user.username} for ${job.jobNumber}`,
    });

    return createdApp;
  });
}

/**
 * Employer reviews an application and either accepts (hiring the citizen) or rejects it.
 */
export async function reviewJobApplication(params: {
  applicationId: string;
  decision: "ACCEPT" | "REJECT";
  actorType: "GOVERNMENT" | "COMPANY";
  actorCompanyId?: string | null;
  actorId: string;
  actorLabel: string;
}): Promise<JobApplication> {
  return db.transaction(async (tx) => {
    const [app] = await tx
      .select()
      .from(jobApplications)
      .where(eq(jobApplications.id, params.applicationId))
      .for("update");
    if (!app || app.status !== "PENDING") {
      throw new JobError("Application not found or already reviewed.");
    }

    const [job] = await tx
      .select()
      .from(jobs)
      .where(eq(jobs.id, app.jobId))
      .for("update");
    if (!job || job.status !== "OPEN") {
      throw new JobError("Job is no longer open.");
    }

    if (params.actorType === "GOVERNMENT" && job.employerType !== "GOVERNMENT") {
      throw new JobError("Only the hiring company can review applications for this job.");
    }
    if (
      params.actorType === "COMPANY" &&
      (job.employerType !== "COMPANY" || job.employerCompanyId !== params.actorCompanyId)
    ) {
      throw new JobError("Unauthorized to review applications for this job.");
    }

    const nextStatus = params.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED";
    const [updatedApp] = await tx
      .update(jobApplications)
      .set({
        status: nextStatus,
        reviewedAt: new Date(),
      })
      .where(eq(jobApplications.id, app.id))
      .returning();

    if (params.decision === "ACCEPT") {
      await tx
        .update(jobs)
        .set({
          status: "IN_PROGRESS",
          hiredUserId: app.userId,
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
    }

    await recordAudit(tx, {
      action: `JOB_APPLICATION_${nextStatus}`,
      actorType: params.actorType,
      actorId: params.actorId,
      actorLabel: params.actorLabel,
      targetType: "JOB_APPLICATION",
      targetId: app.id,
      newValue: `${job.jobNumber}: ${nextStatus}`,
    });

    return updatedApp;
  });
}

/**
 * Completes an active job and settles the compensation payment to the hired Citizen atomically.
 */
export async function completeAndPayJob(params: {
  jobId: string;
  actorType: "GOVERNMENT" | "COMPANY";
  actorCompanyId?: string | null;
  actorId: string;
  actorLabel: string;
}): Promise<{ job: Job; txRef: string }> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(jobs)
      .where(eq(jobs.id, params.jobId))
      .for("update");
    if (!job) throw new JobError("Job not found.");
    if (job.status !== "IN_PROGRESS" || !job.hiredUserId) {
      throw new JobError("Only jobs currently in progress with a hired citizen can be completed and paid.");
    }

    if (params.actorType === "GOVERNMENT" && job.employerType !== "GOVERNMENT") {
      throw new JobError("Unauthorized to complete this company job.");
    }
    if (
      params.actorType === "COMPANY" &&
      (job.employerType !== "COMPANY" || job.employerCompanyId !== params.actorCompanyId)
    ) {
      throw new JobError("Unauthorized to complete this job.");
    }

    const [worker] = await tx
      .select()
      .from(users)
      .where(eq(users.id, job.hiredUserId))
      .for("update");
    if (!worker || !canUserReceive(worker)) {
      throw new JobError("Hired citizen account cannot receive payments.");
    }

    const [gov] = await tx.select().from(government).limit(1);
    if (!gov) {
      throw new JobError("Government treasury not initialized.");
    }

    const fromWallet =
      job.employerType === "GOVERNMENT"
        ? governmentWallet(gov.id)
        : companyWallet(job.employerCompanyId!);

    const paymentRes = await transferInTx(tx, {
      from: fromWallet,
      to: userWallet(worker.id),
      amount: job.compensationAeros,
      type: "CONTRACT_PAYMENT",
      reason: `Job completion payment ${job.jobNumber}: ${job.title}`,
      ...(job.employerType === "GOVERNMENT" ? { forcedTaxRateBp: 0 } : {}),
    });

    const [updatedJob] = await tx
      .update(jobs)
      .set({
        status: "COMPLETED",
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id))
      .returning();

    await recordAudit(tx, {
      action: "JOB_COMPLETED_AND_PAID",
      actorType: params.actorType,
      actorId: params.actorId,
      actorLabel: params.actorLabel,
      targetType: "JOB",
      targetId: job.id,
      previousValue: "IN_PROGRESS",
      newValue: `COMPLETED (${job.compensationAeros} ${CURRENCY_NAME} paid to @${worker.username}, tx=${paymentRes.txRef})`,
    });

    return { job: updatedJob, txRef: paymentRes.txRef };
  });
}

export async function listPublicJobs(limit = 50): Promise<
  Array<{
    job: Job;
    employerName: string;
    employerHandle: string;
  }>
> {
  const allJobs = await db
    .select()
    .from(jobs)
    .orderBy(desc(jobs.createdAt))
    .limit(limit);

  const compIds = Array.from(
    new Set(allJobs.map((j) => j.employerCompanyId).filter((id): id is string => Boolean(id))),
  );
  const compMap = new Map<string, { name: string; username: string }>();
  for (const cid of compIds) {
    const [c] = await db
      .select({ name: companies.name, username: companies.username })
      .from(companies)
      .where(eq(companies.id, cid))
      .limit(1);
    if (c) compMap.set(cid, c);
  }

  return allJobs.map((j) => {
    if (j.employerType === "GOVERNMENT") {
      return {
        job: j,
        employerName: "Government of Aeros",
        employerHandle: "government",
      };
    }
    const comp = j.employerCompanyId ? compMap.get(j.employerCompanyId) : null;
    return {
      job: j,
      employerName: comp?.name ?? "Registered Company",
      employerHandle: comp?.username ?? "company",
    };
  });
}

export async function listUserJobApplications(userId: string): Promise<
  Array<{
    application: JobApplication;
    job: Job;
  }>
> {
  return db
    .select({
      application: jobApplications,
      job: jobs,
    })
    .from(jobApplications)
    .innerJoin(jobs, eq(jobs.id, jobApplications.jobId))
    .where(eq(jobApplications.userId, userId))
    .orderBy(desc(jobApplications.createdAt));
}

export async function listApplicationsForEmployer(params: {
  employerType: "GOVERNMENT" | "COMPANY";
  employerCompanyId?: string | null;
}): Promise<
  Array<{
    application: JobApplication;
    job: Job;
    applicantUsername: string;
    applicantDisplayName: string;
  }>
> {
  const whereCond =
    params.employerType === "GOVERNMENT"
      ? eq(jobs.employerType, "GOVERNMENT")
      : and(
          eq(jobs.employerType, "COMPANY"),
          eq(jobs.employerCompanyId, params.employerCompanyId!),
        );

  return db
    .select({
      application: jobApplications,
      job: jobs,
      applicantUsername: users.username,
      applicantDisplayName: users.displayName,
    })
    .from(jobApplications)
    .innerJoin(jobs, eq(jobs.id, jobApplications.jobId))
    .innerJoin(users, eq(users.id, jobApplications.userId))
    .where(whereCond)
    .orderBy(desc(jobApplications.createdAt));
}
