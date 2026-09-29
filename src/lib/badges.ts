import "server-only";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { recordAudit } from "./audit";
import { notifyUser } from "./notify";
import type { User } from "@/db/schema";

/**
 * GOVERNMENT BADGES (V3 Phase G, spec §§19,20)
 * ===========================================================================
 *
 * The Government can mark an account two ways:
 *
 *   OFFICIAL GOVERNMENT USER   `users.is_official_government_user`
 *   GOVERNMENT MEMBER          `users.is_government_member`
 *
 * BOTH ARE LABELS. NEITHER IS A CREDENTIAL.
 * ---------------------------------------------------------------------------
 * This is the single most important thing about this file, so it is worth
 * being precise about how it is guaranteed rather than merely intended.
 *
 * Administrative authority in this app comes from ONE place: a Government
 * session cookie, minted only by a successful username + password +
 * security-code login against the `government` row, and checked by
 * `requireGovernment()` in src/lib/auth.ts. That function reads the signed
 * Government session and the `government` table. It does not query `users` at
 * all, so there is no value any row in `users` could hold that would make
 * `requireGovernment()` succeed. A badged user calling a Government-only
 * server action is refused for exactly the same reason an unbadged one is:
 * they have no Government session.
 *
 * User-side capability comes from `users.status` and wallet ownership
 * (src/lib/status.ts). Those functions take `Pick<User, "status" |
 * "suspendedUntil">` — a type that does not even CONTAIN the badge columns —
 * so a badge cannot influence what a user may do either.
 *
 * WHAT THIS FILE IS ALLOWED TO DO. Two things:
 *   * `setUserBadges` — the Government writes the labels, with an audit row.
 *   * `badgesOf` — presentation code asks "which labels does this row carry",
 *     and gets back a plain `UserBadges` value with no methods and no
 *     authority attached.
 *
 * There is deliberately NO function here called `isGovernmentAdmin`,
 * `canActAsGovernment`, or anything else that turns a badge into a decision.
 * If a future change wants one, it has to add it here and defeat the test in
 * scripts/test/test_v3_social.ts, which scans the source of auth.ts,
 * session.ts, status.ts and proxy.ts and fails if either column name appears
 * in any of them.
 */

/** The two labels a user row can carry. A value, never a permission. */
export type UserBadges = {
  official: boolean;
  member: boolean;
};

export const NO_BADGES: UserBadges = { official: false, member: false };

/**
 * Reads the two label columns off a user row.
 *
 * The parameter type is the narrowest possible: exactly the two boolean
 * columns and nothing else. A caller cannot accidentally pass this a
 * permission decision, and this function cannot accidentally make one.
 */
export function badgesOf(
  user: Pick<User, "isOfficialGovernmentUser" | "isGovernmentMember">,
): UserBadges {
  return {
    official: user.isOfficialGovernmentUser === true,
    member: user.isGovernmentMember === true,
  };
}

/** True when a row carries at least one label — for deciding whether to render. */
export function hasAnyBadge(badges: UserBadges): boolean {
  return badges.official || badges.member;
}

export class BadgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadgeError";
  }
}

/**
 * Sets (or clears) a user's badges.
 *
 * The CALLER must already have established Government authority — every server
 * action that reaches this starts with `requireGovernment()`. This function
 * takes the acting Government's id and username only to write them onto the
 * audit row; it does not and cannot re-derive authority from them, which is
 * why the action layer is where the check lives.
 *
 * Nothing else about the account changes. Status, balance, session epoch,
 * company ownership and every capability are untouched: an Official Government
 * User keeps running their company and using the Market exactly as before
 * (spec §19).
 */
export async function setUserBadges(params: {
  userId: string;
  official: boolean;
  member: boolean;
  governmentId: string;
  governmentUsername: string;
}): Promise<User> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(users)
      .where(eq(users.id, params.userId))
      .for("update");
    if (!existing) throw new BadgeError("That account does not exist.");

    const before = badgesOf(existing);
    const after: UserBadges = { official: params.official, member: params.member };

    if (before.official === after.official && before.member === after.member) {
      return existing;
    }

    const [updated] = await tx
      .update(users)
      .set({
        isOfficialGovernmentUser: after.official,
        isGovernmentMember: after.member,
        badgesUpdatedAt: new Date(),
        badgesUpdatedBy: params.governmentUsername,
      })
      .where(eq(users.id, params.userId))
      .returning();
    if (!updated) throw new BadgeError("That account changed while you were updating it.");

    await recordAudit(tx, {
      action: "USER_BADGES_UPDATED",
      actorType: "GOVERNMENT",
      actorId: params.governmentId,
      actorLabel: params.governmentUsername,
      targetType: "USER",
      targetId: params.userId,
      previousValue: describeBadges(before),
      newValue: describeBadges(after),
      reason: "Identity labels only — these columns grant no authority.",
    });

    await notifyUser(
      tx,
      params.userId,
      "BADGES_UPDATED",
      after.official || after.member
        ? `The Government has marked your account: ${describeBadges(after)}. This is a label only — it does not change what your account can do.`
        : "The Government has removed the labels from your account.",
      "/profile",
    );

    return updated;
  });
}

/** Human-readable form of a badge pair, for audit rows and notifications. */
export function describeBadges(badges: UserBadges): string {
  const parts: string[] = [];
  if (badges.official) parts.push("Official Government User");
  if (badges.member) parts.push("Government Member");
  return parts.length === 0 ? "none" : parts.join(" + ");
}
