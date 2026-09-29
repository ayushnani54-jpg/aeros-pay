/**
 * Puts one official Government promotion in the single ad slot (or clears it),
 * so the browser pass can check that the slot renders and that dismissing it
 * stores nothing.
 *
 * An OFFICIAL promotion is used deliberately: it has no company and a zero
 * daily rate, so exercising the ad UI moves no Aeros at all.
 *
 *   npx tsx --require ./scripts/test/hook.cjs scripts/test/seed_ux_promotion.ts <heading>
 *   npx tsx --require ./scripts/test/hook.cjs scripts/test/seed_ux_promotion.ts --clear
 */
import "dotenv/config";
import { db, pool } from "../../src/db/client";
import { government, promotionCampaigns } from "../../src/db/schema";
import { inArray } from "drizzle-orm";
import { createOfficialPromotion, cancelPromotion, getLiveAd } from "../../src/lib/promotions";

async function main() {
  const arg = process.argv[2] ?? "UX ad slot";

  if (arg === "--clear") {
    const live = await db
      .select({ id: promotionCampaigns.id, companyId: promotionCampaigns.companyId })
      .from(promotionCampaigns)
      .where(inArray(promotionCampaigns.status, ["PENDING", "APPROVED", "ACTIVE", "PAUSED"]));
    for (const row of live) {
      await cancelPromotion({
        campaignId: row.id,
        companyId: row.companyId,
        byGovernment: true,
        actorLabel: "ux fixture",
      }).catch(() => undefined);
    }
    console.log(JSON.stringify({ cleared: live.length, liveAd: await getLiveAd() }, null, 2));
    await pool.end();
    return;
  }

  const [gov] = await db.select({ id: government.id }).from(government).limit(1);
  if (!gov) throw new Error("no government row");

  // Free the slot first, so this is repeatable.
  const live = await db
    .select({ id: promotionCampaigns.id, companyId: promotionCampaigns.companyId })
    .from(promotionCampaigns)
    .where(inArray(promotionCampaigns.status, ["ACTIVE", "PAUSED", "APPROVED", "PENDING"]));
  for (const row of live) {
    await cancelPromotion({
      campaignId: row.id,
      companyId: row.companyId,
      byGovernment: true,
      actorLabel: "ux fixture",
    }).catch(() => undefined);
  }

  const campaign = await createOfficialPromotion({
    governmentId: gov.id,
    actorLabel: "ux fixture",
    kind: "NEW_PLAYER_BONUS",
    heading: arg,
    shortDescription: "The Government funds every new account when it is created.",
    ctaLabel: "Read the update",
    destination: "/updates",
    durationDays: 7,
    activate: true,
  });

  console.log(
    JSON.stringify(
      { id: campaign.id, heading: campaign.heading, status: campaign.status, dailyRate: campaign.dailyRate },
      null,
      2,
    ),
  );
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
