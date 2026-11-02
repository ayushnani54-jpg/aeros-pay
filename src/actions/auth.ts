"use server";

import { db, ensureV5SchemaMigrated } from "@/db/client";
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
  v6RegisterInitiateSchema,
  v6EmailVerifySchema,
  v6ActivateGovCodeSchema,
  v6ExistingUserEmailSchema,
  v6PhoneUpdateSchema,
} from "@/lib/validators";
import {
  createEmailVerificationChallenge,
  verifyEmailCode,
} from "@/lib/email-verification";
import { consumeGovernmentActivationCode } from "@/lib/government-activation";
import { requireUser } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import {
  consumeRateLimit,
  loginKey,
  rateLimitMessage,
  registerKey,
  resetRateLimit,
  LOGIN_RULE,
  REGISTER_RULE,
} from "@/lib/ratelimit";
import { redirect } from "next/navigation";

export type ActionResult<T = undefined> =
  | (T extends undefined
      ? { ok: true; data?: undefined; message?: string }
      : { ok: true; data: T; message?: string })
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
  // Before anything else, and before any database work: a registration attempt
  // that is refused here costs one map lookup instead of a transaction.
  const rlKey = await registerKey();
  const rl = consumeRateLimit(rlKey, REGISTER_RULE);
  if (!rl.allowed) return { ok: false, error: rateLimitMessage(rl) };

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
    await ensureV5SchemaMigrated();
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
    // A code can only be burnt once, so a success is proof this was not abuse.
    resetRateLimit(rlKey);
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

  // Rate limited per (client, account) so a flood aimed at one account cannot
  // lock every other account out from the same address.
  const rlKey = await loginKey(username);
  const rl = consumeRateLimit(rlKey, LOGIN_RULE);
  if (!rl.allowed) return { ok: false, error: rateLimitMessage(rl) };

  try {
    await ensureV5SchemaMigrated();
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

    // Correct credentials: clear the counter so earlier typos are forgiven.
    resetRateLimit(rlKey);

    await createUserSession({
      id: user.id,
      username: user.username,
      sessionEpoch: user.sessionEpoch,
    });
  } catch (e) {
    console.error("[loginAction] error:", e);
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unable to sign in right now. Please try again.",
    };
  }
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
  const rawSecurity = formData.get("securityCode");
  const normalizedSecurity = typeof rawSecurity === "string" ? rawSecurity.trim().toUpperCase() : "";

  const parsed = govLoginSchema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
    securityCode: normalizedSecurity,
  });
  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }

  // The Government account is the highest-value credential in the system and
  // there is exactly one of it, so it gets the same limiter as a user login.
  const rlKey = await loginKey(`gov:${parsed.data.username}`);
  const rl = consumeRateLimit(rlKey, LOGIN_RULE);
  if (!rl.allowed) return { ok: false, error: rateLimitMessage(rl) };

  // Generic error for any mismatch — never reveal which field was wrong.
  const genericError = { ok: false as const, error: "Invalid Government credentials." };

  try {
    await ensureV5SchemaMigrated();
    const [gov] = await db
      .select()
      .from(government)
      .where(eq(government.username, parsed.data.username))
      .limit(1);

    if (!gov) return genericError;

    // Verify optional access path code if provided
    const pathCode = (formData.get("pathCode") as string | null)?.trim();
    if (gov.accessPathCode && pathCode && pathCode !== gov.accessPathCode) {
      return genericError;
    }

    const validPassword = await verifySecret(parsed.data.password, gov.passwordHash);
    const validCode = await verifySecret(parsed.data.securityCode, gov.securityCodeHash);
    if (!validPassword || !validCode) return genericError;

    resetRateLimit(rlKey);
    await createGovSession({ id: gov.id, username: gov.username });
  } catch (e) {
    console.error("[govLoginAction] error:", e);
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unable to sign in to Government portal right now.",
    };
  }
  redirect("/gov");
}

export async function govLogoutAction() {
  await clearGovSession();
  redirect("/");
}

// ---------------------------------------------------------------------------
// V6 Identity Infrastructure Actions
// ---------------------------------------------------------------------------

/**
 * Step 1: Initiate new citizen registration with verified email.
 * Checks uniqueness, generates an 8-digit verification code, and stores pending challenge.
 */
export async function v6InitiateRegistrationAction(
  _prev: ActionResult<{ email: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ email: string }>> {
  const rlKey = await registerKey();
  const rl = consumeRateLimit(rlKey, REGISTER_RULE);
  if (!rl.allowed) return { ok: false, error: rateLimitMessage(rl) };

  const parsed = v6RegisterInitiateSchema.safeParse({
    username: formData.get("username"),
    email: formData.get("email"),
    password: formData.get("password"),
    displayName: formData.get("displayName") || undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }

  const { username, email, password } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  try {
    await ensureV5SchemaMigrated();

    // Check if username taken
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (existingUser) {
      return { ok: false, error: "Username is already taken. Please choose another." };
    }

    // Check if email already registered and verified
    const [existingEmail] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.authEmail, normalizedEmail))
      .limit(1);

    if (existingEmail) {
      return { ok: false, error: "This email address is already associated with an account." };
    }

    const passwordHash = await hashSecret(password);

    // Create 8-digit email verification challenge
    const challenge = await createEmailVerificationChallenge({
      email: normalizedEmail,
      username,
      passwordHash,
    });

    return {
      ok: true,
      data: { email: normalizedEmail },
      message: `An 8-digit verification code has been generated for ${normalizedEmail}. Code: ${challenge.code}`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to initiate registration.",
    };
  }
}

/**
 * Step 2: Confirm 8-digit email verification code and instantiate citizen account.
 * Initializes the user as VERIFIED_LIMITED (safe read-only exploration).
 */
export async function v6VerifyEmailAndCreateAccountAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = v6EmailVerifySchema.safeParse({
    email: formData.get("email"),
    code: formData.get("code"),
  });

  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }

  const { email, code } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  try {
    await ensureV5SchemaMigrated();

    const result = await verifyEmailCode({ email: normalizedEmail, code });
    if (!result.ok) {
      return { ok: false, error: result.error ?? "Invalid verification code." };
    }

    if (!result.username || !result.passwordHash) {
      return { ok: false, error: "Verification challenge expired or corrupted. Please sign up again." };
    }

    // Insert user with VERIFIED_LIMITED status
    const [newUser] = await db
      .insert(users)
      .values({
        username: result.username,
        passwordHash: result.passwordHash,
        displayName: result.username,
        authEmail: normalizedEmail,
        authEmailVerified: true,
        authEmailVerifiedAt: new Date(),
        accessLevel: "VERIFIED_LIMITED",
        emailMigrationRequired: false,
        themePreference: "system",
      })
      .returning();

    await recordAudit(db, {
      action: "ACCOUNT_CREATED",
      actorType: "USER",
      actorId: newUser.id,
      actorLabel: newUser.username,
      metadata: { email: normalizedEmail, accessLevel: "VERIFIED_LIMITED" },
    });

    await createUserSession({
      id: newUser.id,
      username: newUser.username,
      sessionEpoch: newUser.sessionEpoch,
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return { ok: false, error: "Username or email is already registered." };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to verify and create account.",
    };
  }

  redirect("/dashboard");
}

/**
 * Step 3: Consume Government-issued 6-digit activation code to unlock ACTIVE_MEMBER tier.
 */
export async function v6ActivateMembershipAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();

  const parsed = v6ActivateGovCodeSchema.safeParse({
    code: formData.get("code"),
  });

  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }

  const { code } = parsed.data;

  try {
    const outcome = await consumeGovernmentActivationCode({
      userId: user.id,
      code,
    });

    if (!outcome.ok) {
      return { ok: false, error: outcome.error ?? "Activation code is invalid or has expired." };
    }

    return {
      ok: true,
      message: "Membership successfully activated! You now have full access to Aeros Pay economic features.",
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to activate membership.",
    };
  }
}

/**
 * Step 4: Existing user migration email submission.
 */
export async function v6SubmitExistingUserEmailAction(
  _prev: ActionResult<{ email: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ email: string }>> {
  const user = await requireUser();

  const parsed = v6ExistingUserEmailSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }

  const normalizedEmail = parsed.data.email.trim().toLowerCase();

  try {
    await ensureV5SchemaMigrated();

    // Check if taken by another user
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.authEmail, normalizedEmail))
      .limit(1);

    if (existing && existing.id !== user.id) {
      return { ok: false, error: "This email is already in use by another account." };
    }

    const challenge = await createEmailVerificationChallenge({
      email: normalizedEmail,
      userId: user.id,
      username: user.username,
    });

    return {
      ok: true,
      data: { email: normalizedEmail },
      message: `An 8-digit verification code has been issued for ${normalizedEmail}. Code: ${challenge.code}`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to initiate email verification.",
    };
  }
}

/**
 * Step 5: Existing user migration email confirmation.
 */
export async function v6VerifyExistingUserEmailAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();

  const parsed = v6EmailVerifySchema.safeParse({
    email: formData.get("email"),
    code: formData.get("code"),
  });

  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }

  const { email, code } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  try {
    await ensureV5SchemaMigrated();

    const result = await verifyEmailCode({ email: normalizedEmail, code });
    if (!result.ok) {
      return { ok: false, error: result.error ?? "Invalid verification code." };
    }

    await db
      .update(users)
      .set({
        authEmail: normalizedEmail,
        authEmailVerified: true,
        authEmailVerifiedAt: new Date(),
        emailMigrationRequired: false,
        accessLevel: "ACTIVE_MEMBER",
      })
      .where(eq(users.id, user.id));

    return {
      ok: true,
      message: "Email successfully verified. Your account is fully active.",
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to verify email.",
    };
  }
}

/**
 * Step 6: Update User Profile & Privacy settings (phone, public contact email, bio, whatsapp consent).
 */
export async function v6UpdateProfilePrivacyAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();

  const parsed = v6PhoneUpdateSchema.safeParse({
    phoneNumber: formData.get("phoneNumber") || "",
    whatsappConsent: formData.get("whatsappConsent") === "true" || formData.get("whatsappConsent") === "on",
    publicContactEmail: formData.get("publicContactEmail") || "",
    bio: formData.get("bio") || "",
  });

  if (!parsed.success) {
    return { ok: false, error: firstZodError(parsed.error) };
  }

  const { phoneNumber, whatsappConsent, publicContactEmail, bio } = parsed.data;

  try {
    await ensureV5SchemaMigrated();

    const updates: Partial<typeof users.$inferInsert> = {
      publicContactEmail: publicContactEmail && publicContactEmail.length > 0 ? publicContactEmail : null,
      bio: bio && bio.length > 0 ? bio : null,
      whatsappConsent: Boolean(whatsappConsent),
      whatsappConsentAt: whatsappConsent ? new Date() : null,
    };

    if (phoneNumber && phoneNumber.length > 0) {
      updates.phoneNumber = phoneNumber;
      updates.phoneVerified = true;
      updates.phoneVerifiedAt = new Date();
    } else {
      updates.phoneNumber = null;
      updates.phoneVerified = false;
      updates.phoneVerifiedAt = null;
    }

    await db
      .update(users)
      .set(updates)
      .where(eq(users.id, user.id));

    return {
      ok: true,
      message: "Profile and contact settings updated successfully.",
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to update profile settings.",
    };
  }
}


