import "server-only";
import { db, ensureV5SchemaMigrated } from "@/db/client";
import { governmentPublicContent, type GovernmentPublicContent } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

export const DEFAULT_PUBLIC_CONTENT: Record<string, { value: string; label: string; isPrivate: boolean }> = {
  support_email: {
    value: "support@aerospay.com",
    label: "Official Support Email",
    isPrivate: false,
  },
  instagram_url: {
    value: "https://instagram.com/aerospay",
    label: "Instagram Community",
    isPrivate: false,
  },
  whatsapp_community_url: {
    value: "https://chat.whatsapp.com/invite/aerospay-community",
    label: "WhatsApp Community",
    isPrivate: false,
  },
  whatsapp_group_url: {
    value: "https://chat.whatsapp.com/invite/aerospay-official",
    label: "WhatsApp Official Group",
    isPrivate: false,
  },
  interdream_url: {
    value: "https://interdream.io/c/aerospay",
    label: "Interdream / Entodream Platform",
    isPrivate: false,
  },
  public_dock_url: {
    value: "https://docs.aerospay.com",
    label: "Public Documentation & Dock",
    isPrivate: false,
  },
  private_dock_url: {
    value: "https://docs.aerospay.com/members",
    label: "Member Private Updates Dock",
    isPrivate: true,
  },
};

export async function getPublicCommunityContent(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(DEFAULT_PUBLIC_CONTENT)) {
    if (!item.isPrivate) {
      result[key] = item.value;
    }
  }

  try {
    await ensureV5SchemaMigrated();
    const rows = await db
      .select()
      .from(governmentPublicContent)
      .where(eq(governmentPublicContent.enabled, true))
      .orderBy(asc(governmentPublicContent.sortOrder));

    for (const row of rows) {
      if (!row.isPrivate) {
        result[row.key] = row.value;
      }
    }
  } catch (err) {
    console.warn("[public-content] Falling back to default community content:", err);
  }

  return result;
}

export async function getAllGovernmentContent(): Promise<GovernmentPublicContent[]> {
  try {
    await ensureV5SchemaMigrated();
    const rows = await db
      .select()
      .from(governmentPublicContent)
      .orderBy(asc(governmentPublicContent.sortOrder));

    if (rows.length === 0) {
      return Object.entries(DEFAULT_PUBLIC_CONTENT).map(([key, item], idx) => ({
        key,
        value: item.value,
        label: item.label,
        enabled: true,
        isPrivate: item.isPrivate,
        sortOrder: idx + 1,
        updatedBy: "SYSTEM_DEFAULT",
        updatedAt: new Date(),
      }));
    }
    return rows;
  } catch (err) {
    console.warn("[public-content] Falling back to defaults:", err);
    return Object.entries(DEFAULT_PUBLIC_CONTENT).map(([key, item], idx) => ({
      key,
      value: item.value,
      label: item.label,
      enabled: true,
      isPrivate: item.isPrivate,
      sortOrder: idx + 1,
      updatedBy: "SYSTEM_DEFAULT",
      updatedAt: new Date(),
    }));
  }
}
