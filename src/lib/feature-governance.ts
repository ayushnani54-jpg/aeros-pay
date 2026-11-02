import "server-only";
import { db, ensureV5SchemaMigrated } from "@/db/client";
import { platformFeatureFlags, type PlatformFeatureFlag } from "@/db/schema";
import { eq } from "drizzle-orm";

export const DEFAULT_FEATURE_FLAGS: Record<string, { enabled: boolean; displayName: string; description: string }> = {
  aeros_exchange: {
    enabled: false,
    displayName: "Aeros Exchange",
    description: "INR-to-Aeros purchases and package policies (Temporarily paused for V6 rollout)",
  },
  trading_terminal: {
    enabled: false,
    displayName: "Synthetic Trading Terminal",
    description: "AMI spot trading and hedge-style leverage positions (Temporarily paused for V6 rollout)",
  },
  marketplace: {
    enabled: true,
    displayName: "Public Marketplace",
    description: "Goods, services, and order escrow",
  },
  aeros_media: {
    enabled: true,
    displayName: "Aeros Media",
    description: "Text-only community feed and social posts",
  },
  jobs: {
    enabled: true,
    displayName: "Citizen Jobs & Employment",
    description: "Corporate and government job bounties",
  },
  partnerships: {
    enabled: true,
    displayName: "Corporate Partnerships",
    description: "Inter-company joint ventures and 50/50 revenue sharing",
  },
  companies: {
    enabled: true,
    displayName: "Corporate Accounts & Invoicing",
    description: "Company registration, invoicing, and corporate balances",
  },
  citizen_transfers: {
    enabled: true,
    displayName: "Citizen Transfers",
    description: "Direct P2P Aeros transfers between citizens",
  },
};

/**
 * Retrieves all registered feature flags, merged with defaults.
 */
export async function getPlatformFeatureFlags(): Promise<PlatformFeatureFlag[]> {
  try {
    await ensureV5SchemaMigrated();
    const flags = await db.select().from(platformFeatureFlags);
    if (!flags || flags.length === 0) {
      return Object.entries(DEFAULT_FEATURE_FLAGS).map(([id, meta]) => ({
        id,
        enabled: meta.enabled,
        displayName: meta.displayName,
        description: meta.description,
        reason: null,
        updatedBy: "SYSTEM_DEFAULT",
        updatedAt: new Date(),
      }));
    }
    return flags;
  } catch (error) {
    console.warn("[feature-governance] Falling back to default flags due to query error:", error);
    return Object.entries(DEFAULT_FEATURE_FLAGS).map(([id, meta]) => ({
      id,
      enabled: meta.enabled,
      displayName: meta.displayName,
      description: meta.description,
      reason: null,
      updatedBy: "SYSTEM_FALLBACK",
      updatedAt: new Date(),
    }));
  }
}

/**
 * Checks whether a specific feature flag is enabled.
 */
export async function isFeatureEnabled(featureId: string): Promise<boolean> {
  try {
    await ensureV5SchemaMigrated();
    const [flag] = await db
      .select({ enabled: platformFeatureFlags.enabled })
      .from(platformFeatureFlags)
      .where(eq(platformFeatureFlags.id, featureId))
      .limit(1);

    if (flag !== undefined) {
      return flag.enabled;
    }
  } catch (error) {
    console.warn(`[feature-governance] Error checking flag ${featureId}, using default:`, error);
  }

  return DEFAULT_FEATURE_FLAGS[featureId]?.enabled ?? true;
}

/**
 * Asserts that a specific feature is enabled; throws if disabled.
 */
export async function assertFeatureEnabled(featureId: string, featureLabel?: string): Promise<void> {
  const enabled = await isFeatureEnabled(featureId);
  if (!enabled) {
    const label = featureLabel ?? DEFAULT_FEATURE_FLAGS[featureId]?.displayName ?? featureId;
    throw new Error(`FEATURE_DISABLED: ${label} is currently disabled by Government administration.`);
  }
}

/**
 * Updates a feature flag state.
 */
export async function setFeatureFlag(
  featureId: string,
  enabled: boolean,
  reason?: string,
  updatedBy: string = "GOVERNMENT",
): Promise<PlatformFeatureFlag> {
  await ensureV5SchemaMigrated();
  const defaultMeta = DEFAULT_FEATURE_FLAGS[featureId];
  const displayName = defaultMeta?.displayName ?? featureId;
  const description = defaultMeta?.description ?? `Platform capability ${featureId}`;

  const [updated] = await db
    .insert(platformFeatureFlags)
    .values({
      id: featureId,
      enabled,
      displayName,
      description,
      reason: reason ?? null,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: platformFeatureFlags.id,
      set: {
        enabled,
        reason: reason ?? null,
        updatedBy,
        updatedAt: new Date(),
      },
    })
    .returning();

  return updated;
}
