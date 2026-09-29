import "server-only";
import { db } from "@/db/client";
import { companies, users } from "@/db/schema";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { Company, User } from "@/db/schema";

/**
 * Account status, V2.
 *
 * A timed suspension is stored as status = SUSPENDED plus a `suspendedUntil`
 * timestamp. Once that timestamp passes the account is treated as ACTIVE by
 * every server-side check immediately — no Government action and no scheduled
 * job is required (spec §8).
 *
 * The stored row is also healed lazily (see `healExpiredSuspensions`) so the
 * database eventually reflects reality, but correctness never depends on that
 * healing having happened: `effectiveUserStatus` is the single source of truth
 * and it is computed, not read.
 */
export type EffectiveStatus = "ACTIVE" | "SUSPENDED" | "BANNED";

type SuspendableUser = Pick<User, "status" | "suspendedUntil">;
type SuspendableCompany = Pick<Company, "status" | "suspendedUntil">;

export function effectiveUserStatus(user: SuspendableUser, now = new Date()): EffectiveStatus {
  if (user.status === "BANNED") return "BANNED";
  if (user.status === "SUSPENDED") {
    // A suspension with no end date is indefinite until Government lifts it.
    if (user.suspendedUntil && user.suspendedUntil.getTime() <= now.getTime()) {
      return "ACTIVE";
    }
    return "SUSPENDED";
  }
  return "ACTIVE";
}

/** True when the row still says SUSPENDED but the suspension window has passed. */
export function hasExpiredSuspension(user: SuspendableUser, now = new Date()): boolean {
  return (
    user.status === "SUSPENDED" &&
    !!user.suspendedUntil &&
    user.suspendedUntil.getTime() <= now.getTime()
  );
}

export function canUserSend(user: SuspendableUser): boolean {
  return effectiveUserStatus(user) === "ACTIVE";
}

export function canUserReceive(user: SuspendableUser): boolean {
  // A suspended account may still receive (it is paused, not cut off).
  // A banned account may not participate economically at all (spec §9).
  return effectiveUserStatus(user) !== "BANNED";
}

export function canUserLogIn(user: SuspendableUser): boolean {
  // Suspended users can still log in and view their account (spec §8).
  return effectiveUserStatus(user) !== "BANNED";
}

export function canUserCreateCompany(user: SuspendableUser): boolean {
  return effectiveUserStatus(user) === "ACTIVE";
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export type EffectiveCompanyStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "SUSPENDED"
  | "REVOKED";

export function effectiveCompanyStatus(
  company: SuspendableCompany,
  now = new Date(),
): EffectiveCompanyStatus {
  if (company.status === "SUSPENDED") {
    if (company.suspendedUntil && company.suspendedUntil.getTime() <= now.getTime()) {
      return "APPROVED";
    }
    return "SUSPENDED";
  }
  return company.status;
}

export function hasExpiredCompanySuspension(
  company: SuspendableCompany,
  now = new Date(),
): boolean {
  return (
    company.status === "SUSPENDED" &&
    !!company.suspendedUntil &&
    company.suspendedUntil.getTime() <= now.getTime()
  );
}

/** A company can trade only while effectively APPROVED. */
export function canCompanyTrade(company: SuspendableCompany): boolean {
  return effectiveCompanyStatus(company) === "APPROVED";
}

/**
 * Whether a company has a PUBLIC page at all (V3 Phase F, spec §21).
 *
 * This is the rule that makes a printed QR code stop working. A company QR
 * contains the company's public-profile URL and nothing else — there is no code
 * registry, no token and no scan log — so "revoking the code" is simply this
 * predicate turning false and `/c/<username>` answering 404 from then on.
 *
 * PENDING and SUSPENDED stay visible (a suspension is a pause, and a pending
 * application is the owner's own page). REVOKED and REJECTED do not: a revoked
 * company has been taken out of the economy and a rejected one never entered
 * it, so neither has a public presence for a code to resolve to.
 */
export function isCompanyPubliclyVisible(
  company: SuspendableCompany,
  now = new Date(),
): boolean {
  const status = effectiveCompanyStatus(company, now);
  return status !== "REVOKED" && status !== "REJECTED";
}

/** A suspended company may still receive; a revoked one may not. */
export function canCompanyReceive(company: SuspendableCompany): boolean {
  const status = effectiveCompanyStatus(company);
  return status === "APPROVED" || status === "SUSPENDED";
}

// ---------------------------------------------------------------------------
// Lazy healing
// ---------------------------------------------------------------------------

type Executor = Pick<typeof db, "update">;

/**
 * Flips rows whose timed suspension has elapsed back to ACTIVE/APPROVED.
 *
 * This is a convenience so the stored data matches what the server already
 * enforces — it is never load-bearing. It is safe to call often and cheap when
 * there is nothing to heal (the WHERE clause matches no rows).
 */
export async function healExpiredSuspensions(executor: Executor = db): Promise<void> {
  const now = new Date();

  await executor
    .update(users)
    .set({ status: "ACTIVE", suspendedUntil: null, suspendedAt: null, suspensionReason: null })
    .where(
      and(
        eq(users.status, "SUSPENDED"),
        isNotNull(users.suspendedUntil),
        lte(users.suspendedUntil, now),
      ),
    );

  await executor
    .update(companies)
    .set({ status: "APPROVED", suspendedUntil: null, suspendedAt: null, suspensionReason: null })
    .where(
      and(
        eq(companies.status, "SUSPENDED"),
        isNotNull(companies.suspendedUntil),
        lte(companies.suspendedUntil, now),
      ),
    );
}

/** Human-readable remaining suspension time, e.g. "2 days, 3 hours". */
export function formatSuspensionRemaining(until: Date, now = new Date()): string {
  const ms = until.getTime() - now.getTime();
  if (ms <= 0) return "expired";

  const minutes = Math.floor(ms / 60000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (parts.length === 0) parts.push(`${mins} minute${mins === 1 ? "" : "s"}`);
  return parts.join(", ");
}
