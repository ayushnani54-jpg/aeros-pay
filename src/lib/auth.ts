import "server-only";
import { cache } from "react";
import { db } from "@/db/client";
import { users, government, companies } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  getUserSession,
  getGovSession,
  getCompanyContextId,
} from "./session";
import { effectiveCompanyStatus, effectiveUserStatus, type EffectiveStatus } from "./status";
import type { Company, Government, User } from "@/db/schema";
import { userWallet, companyWallet, type WalletRef } from "./wallets";

/**
 * Returns the authenticated user, or null.
 *
 * Also enforces the session epoch: a token minted before the Government reset
 * this user's password no longer matches `users.session_epoch` and is treated
 * as invalid, which is what makes a password reset actually end existing
 * sessions (spec §4).
 */
/**
 * Wrapped in React's `cache()` so the layout and the page it renders share a
 * single database read per request instead of each issuing their own.
 *
 * Every page here is dynamic (it shows live balances), so before this the
 * layout and page were duplicating the same user and company queries on every
 * single navigation — which is a meaningful part of why navigation felt slow.
 * The cache is per-request, so it never serves one request's data to another.
 */
export const getCurrentUser = cache(async function getCurrentUser(): Promise<User | null> {
  const session = await getUserSession();
  if (!session) return null;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.sub))
    .limit(1);

  if (!user) return null;
  if ((session.epoch ?? 0) !== user.sessionEpoch) return null;

  return user;
});

export const getCurrentGovernment = cache(async function getCurrentGovernment(): Promise<Government | null> {
  const session = await getGovSession();
  if (!session) return null;
  const [gov] = await db
    .select()
    .from(government)
    .where(eq(government.id, session.sub))
    .limit(1);
  return gov ?? null;
});

/** Throws if there is no authenticated user. Use in server actions
 * and server components that require a logged-in normal user. */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("NOT_AUTHENTICATED");
  }
  return user;
}

/** Throws if there is no authenticated Government session. */
export async function requireGovernment(): Promise<Government> {
  const gov = await getCurrentGovernment();
  if (!gov) {
    throw new Error("NOT_AUTHENTICATED_GOVERNMENT");
  }
  return gov;
}

/**
 * The Control Room is the deepest administrative area. It requires the same
 * server-side Government authorization as the rest of the panel — its
 * separation is organisational, never a security measure. Obscurity is not
 * access control (spec §10).
 */
export async function requireControlRoom(): Promise<Government> {
  return requireGovernment();
}

// ---------------------------------------------------------------------------
// Active wallet context
// ---------------------------------------------------------------------------

export type ActingContext = {
  user: User;
  /** Null when acting personally. */
  company: Company | null;
  /** The wallet the user is currently spending from. */
  wallet: WalletRef;
  /** Label for the active wallet, e.g. "@ayush" or "@ayushfitness". */
  handle: string;
  displayLabel: string;
  balance: number;
  effectiveStatus: EffectiveStatus;
  /** Every approved company this user owns, for the context switcher. */
  availableCompanies: Company[];
};

/**
 * Resolves which wallet the logged-in user is currently acting as.
 *
 * The company-context cookie is only a hint. This function re-reads the
 * company from the database and falls back to the personal wallet unless the
 * company genuinely exists, is owned by this user, and is currently approved.
 */
export const getActingContext = cache(async function getActingContext(): Promise<ActingContext | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const owned = await getOwnedCompanies(user.id);

  const availableCompanies = owned.filter(
    (c) => effectiveCompanyStatus(c) === "APPROVED" && !c.governmentOwned,
  );

  const contextId = await getCompanyContextId();
  const company =
    contextId != null
      ? (availableCompanies.find((c) => c.id === contextId) ?? null)
      : null;

  if (company) {
    return {
      user,
      company,
      wallet: companyWallet(company.id),
      handle: `@${company.username}`,
      displayLabel: company.name,
      balance: company.balance,
      effectiveStatus: effectiveUserStatus(user),
      availableCompanies,
    };
  }

  return {
    user,
    company: null,
    wallet: userWallet(user.id),
    handle: `@${user.username}`,
    displayLabel: user.displayName,
    balance: user.balance,
    effectiveStatus: effectiveUserStatus(user),
    availableCompanies,
  };
});

export async function requireActingContext(): Promise<ActingContext> {
  const ctx = await getActingContext();
  if (!ctx) throw new Error("NOT_AUTHENTICATED");
  return ctx;
}

/** All companies a user owns, including pending/rejected ones. Per-request cached. */
export const getOwnedCompanies = cache(async function getOwnedCompanies(
  userId: string,
): Promise<Company[]> {
  return db.select().from(companies).where(eq(companies.ownerUserId, userId));
});
