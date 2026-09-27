import "dotenv/config";
import { fundUserFromTreasury } from "../../src/lib/payments";
import { db, pool } from "../../src/db/client";
import { users, government } from "../../src/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  const [gov] = await db.select().from(government).limit(1);
  const [user] = await db.select().from(users).where(eq(users.username, "ayush")).limit(1);
  console.log("gov:", gov?.id, gov?.balance);
  console.log("user:", user?.id, user?.balance, user?.status);

  const result = await fundUserFromTreasury({
    governmentId: gov!.id,
    receiverUserId: user!.id,
    amount: 2000,
    reason: "test funding",
  });
  console.log("RESULT:", result);
  await pool.end();
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
