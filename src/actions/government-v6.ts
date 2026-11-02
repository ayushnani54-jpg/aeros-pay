"use server";

import { requireGovernment } from "@/lib/auth";
import { setFeatureFlag } from "@/lib/feature-governance";
import { generateGovernmentActivationCode } from "@/lib/government-activation";
import { db, ensureV5SchemaMigrated } from "@/db/client";
import { governmentPublicContent, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { ActionResult } from "./auth";
import { revalidatePath } from "next/cache";

export async function togglePlatformFeatureFlagAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const gov = await requireGovernment();
  const featureId = (formData.get("featureId") as string)?.trim();
  const enabledStr = formData.get("enabled");
  const enabled = enabledStr === "true" || enabledStr === "on";
  const reason = (formData.get("reason") as string)?.trim() || undefined;

  if (!featureId) {
    return { ok: false, error: "Feature identifier is required." };
  }

  try {
    await setFeatureFlag(featureId, enabled, reason, gov.username);
    revalidatePath("/gov/control-room");
    revalidatePath("/");
    return {
      ok: true,
      message: `Feature ${featureId} updated to ${enabled ? "ENABLED" : "DISABLED"}.`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to update feature flag.",
    };
  }
}

export async function generateCitizenActivationCodeAction(
  _prev: ActionResult<{ code: string; username: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ code: string; username: string }>> {
  const gov = await requireGovernment();
  const identifier = (formData.get("username") as string)?.trim().toLowerCase();
  const notes = (formData.get("adminNotes") as string)?.trim() || undefined;

  if (!identifier) {
    return { ok: false, error: "Citizen username is required." };
  }

  try {
    await ensureV5SchemaMigrated();
    const [targetUser] = await db
      .select({ id: users.id, username: users.username, accessLevel: users.accessLevel })
      .from(users)
      .where(eq(users.username, identifier))
      .limit(1);

    if (!targetUser) {
      return { ok: false, error: `Citizen @${identifier} not found.` };
    }

    const { code } = await generateGovernmentActivationCode({
      userId: targetUser.id,
      adminUsername: gov.username,
      adminNotes: notes,
    });

    revalidatePath("/gov/control-room");
    return {
      ok: true,
      data: { code, username: targetUser.username },
      message: `Activation code generated for @${targetUser.username}: ${code}`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to generate activation code.",
    };
  }
}

export async function updateGovernmentPublicContentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const gov = await requireGovernment();
  const key = (formData.get("key") as string)?.trim();
  const value = (formData.get("value") as string)?.trim();

  if (!key || !value) {
    return { ok: false, error: "Content key and value are required." };
  }

  try {
    await ensureV5SchemaMigrated();
    await db
      .update(governmentPublicContent)
      .set({
        value,
        updatedBy: gov.username,
        updatedAt: new Date(),
      })
      .where(eq(governmentPublicContent.key, key));

    revalidatePath("/gov/control-room");
    revalidatePath("/");
    return {
      ok: true,
      message: `Public link '${key}' updated successfully.`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to update public content.",
    };
  }
}
