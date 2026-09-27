"use server";

import { db } from "@/db/client";
import { government, registrationCodes, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { hashSecret, verifySecret } from "@/lib/password";
import {
  createGovSession,
  createUserSession,
  clearGovSession,
  clearUserSession,
} from "@/lib/session";
import {
  govLoginSchema,
  loginSchema,
  registerSchema,
} from "@/lib/validators";
import { recordAudit } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { redirect } from "next/navigation";

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function firstZodError(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "issues" in err &&
    Array.isArray((err as { issues: unknown[] }).issues)
  ) {
    const issues = (err as { issues: { message: string }[] }).issues;
    return issues[0]?.message ?? "Invalid input.";
  }
  return "Invalid input.";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function registerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = registerSchema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
    displayName: formData.get("displayName"),
    registrationCode: formData.get("registrationCode"),
  });

  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }

  const { username, password, displayName, registrationCode } = parsed.data;

  try {
    const newUserId = await db.transaction(async (tx) => {
      const [code] = await tx
        .select()
        .from(registrationCodes)
        .where(eq(registrationCodes.code, registrationCode))
        .for("update");

      if (!code) {
        throw new Error("Invalid registration code.");
      }
      if (code.status === "USED") {
        throw new Error("This registration code has already been used.");
      }
      if (code.status === "REVOKED") {
        throw new Error("This registration code has been revoked.");
      }

      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username))
        .limit(1);
      if (existing) {
        throw new Error("Username already exists.");
      }

      const passwordHash = await hashSecret(password);

      let insertedId: string;
      try {
        const [inserted] = await tx
          .insert(users)
          .values({
            username,
            passwordHash,
            displayName,
            registrationCodeId: code.id,
          })
          .returning({ id: users.id });
        insertedId = inserted.id;
      } catch (e) {
        // Fallback guard against a race the pre-check above couldn't catch:
        // the username unique constraint is the final source of truth.
        if (isUniqueViolation(e)) {
          throw new Error("Username already exists.");
        }
        throw e;
      }

      await tx
        .update(registrationCodes)
        .set({ status: "USED", usedAt: new Date(), usedByUserId: insertedId })
        .where(eq(registrationCodes.id, code.id));

      await recordAudit(tx, {
        action: "ACCOUNT_CREATED",
        actorType: "USER",
        actorId: insertedId,
        actorLabel: username,
        targetType: "REGISTRATION_CODE",
        targetId: code.id,
        metadata: { code: registrationCode },
      });

      return insertedId;
    });

    await createUserSession({ id: newUserId, username });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Registration failed." };
  }

  redirect("/dashboard");
}

// ---------------------------------------------------------------------------
// User login / logout
// ---------------------------------------------------------------------------

export async function loginAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = loginSchema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }

  const username = parsed.data.username.trim().toLowerCase();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  if (!user) {
    return { ok: false, error: "Invalid username or password." };
  }

  const validPassword = await verifySecret(parsed.data.password, user.passwordHash);
  if (!validPassword) {
    return { ok: false, error: "Invalid username or password." };
  }

  await createUserSession({ id: user.id, username: user.username });
  redirect("/dashboard");
}

export async function logoutAction() {
  await clearUserSession();
  redirect("/login");
}

// ---------------------------------------------------------------------------
// Government login / logout
// ---------------------------------------------------------------------------

export async function govLoginAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = govLoginSchema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
    securityCode: formData.get("securityCode"),
  });
  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }

  const [gov] = await db
    .select()
    .from(government)
    .where(eq(government.username, parsed.data.username))
    .limit(1);

  // Generic error for any mismatch — never reveal which field was wrong.
  const genericError = { ok: false as const, error: "Invalid Government credentials." };

  if (!gov) return genericError;

  const validPassword = await verifySecret(parsed.data.password, gov.passwordHash);
  const validCode = await verifySecret(parsed.data.securityCode, gov.securityCodeHash);
  if (!validPassword || !validCode) return genericError;

  await createGovSession({ id: gov.id, username: gov.username });
  redirect("/gov");
}

export async function govLogoutAction() {
  await clearGovSession();
  redirect("/government/login");
}
