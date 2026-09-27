/**
 * One-time initialization script for the Government account.
 *
 * Usage:
 *   GOV_USERNAME=... GOV_PASSWORD=... GOV_SECURITY_CODE=... npx tsx scripts/seed-government.ts
 *
 * Reads credentials from environment variables only — nothing is hardcoded
 * or committed to the repository. Safe to re-run: if a Government row
 * already exists, it does nothing and exits.
 */
import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import bcrypt from "bcryptjs";
import * as schema from "../src/db/schema";
import { INITIAL_GOVERNMENT_TREASURY, DEFAULT_TAX_RATE_BP } from "../src/lib/constants";

async function main() {
  const username = process.env.GOV_USERNAME;
  const password = process.env.GOV_PASSWORD;
  const securityCode = process.env.GOV_SECURITY_CODE;

  if (!username || !password || !securityCode) {
    console.error(
      "GOV_USERNAME, GOV_PASSWORD, and GOV_SECURITY_CODE environment variables are all required.",
    );
    process.exit(1);
  }

  if (securityCode.length < 5 || !/^[A-Z0-9]+$/.test(securityCode)) {
    console.error(
      "GOV_SECURITY_CODE must be at least 5 characters, uppercase letters and numbers only (e.g. G7K2P).",
    );
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("GOV_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  const existing = await db.select().from(schema.government).limit(1);
  if (existing.length > 0) {
    console.log(
      `A Government account already exists (username: "${existing[0].username}"). No changes made.`,
    );
    await pool.end();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const securityCodeHash = await bcrypt.hash(securityCode, 12);

  const [gov] = await db
    .insert(schema.government)
    .values({
      username,
      passwordHash,
      securityCodeHash,
      balance: INITIAL_GOVERNMENT_TREASURY,
      totalSupply: INITIAL_GOVERNMENT_TREASURY,
      taxRateBp: DEFAULT_TAX_RATE_BP,
      taxUpdatedAt: new Date(),
    })
    .returning();

  await db.insert(schema.auditLogs).values({
    action: "GOVERNMENT_INITIALIZED",
    actorType: "GOVERNMENT",
    actorId: gov.id,
    actorLabel: gov.username,
    metadata: { initialTreasury: INITIAL_GOVERNMENT_TREASURY, taxRateBp: DEFAULT_TAX_RATE_BP },
  });

  await db.insert(schema.updates).values({
    title: "Aeros Pay launched",
    content: `Welcome to Aeros Pay. The Government treasury begins with ${INITIAL_GOVERNMENT_TREASURY} Aeros.`,
    authorLabel: "Government",
  });

  console.log(`Government account "${username}" created successfully.`);
  console.log(`Initial treasury: ${INITIAL_GOVERNMENT_TREASURY} Aeros`);
  console.log(`Default tax rate: ${(DEFAULT_TAX_RATE_BP / 100).toFixed(2)}%`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
