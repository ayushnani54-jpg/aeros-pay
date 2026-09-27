import "server-only";
import { db } from "@/db/client";
import { users, government } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getUserSession, getGovSession } from "./session";
import type { User, Government } from "@/db/schema";

export async function getCurrentUser(): Promise<User | null> {
  const session = await getUserSession();
  if (!session) return null;
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, session.sub))
    .limit(1);
  return user ?? null;
}

export async function getCurrentGovernment(): Promise<Government | null> {
  const session = await getGovSession();
  if (!session) return null;
  const [gov] = await db
    .select()
    .from(government)
    .where(eq(government.id, session.sub))
    .limit(1);
  return gov ?? null;
}

/** Throws if there is no authenticated, active user. Use in server actions
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
