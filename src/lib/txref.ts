import "server-only";
import { db, pool } from "@/db/client";
import { transactions } from "@/db/schema";
import { sql } from "drizzle-orm";

/**
 * Generates the next human-readable transaction reference, e.g.
 * "TX-20260927-000184". The numeric suffix comes from a Postgres sequence
 * (tx_ref_seq) so it is assigned atomically and can never collide, even
 * under heavy concurrent write load.
 */
export async function nextTxRef(
  executor: Pick<typeof db, "execute"> = db,
): Promise<string> {
  const result = await executor.execute<{ nextval: string }>(
    sql`SELECT nextval('tx_ref_seq') AS nextval`,
  );
  const seq = result.rows[0].nextval;
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const paddedSeq = seq.padStart(6, "0");
  return `TX-${y}${m}${d}-${paddedSeq}`;
}

export type TxRow = typeof transactions.$inferSelect;

export { pool };
