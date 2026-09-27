import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// A single pooled connection, reused across server actions / route handlers.
// On serverless platforms (Vercel), the pool is scoped per lambda instance;
// keep max connections modest since Postgres connection limits are finite.
declare global {
  var __aerosPgPool: Pool | undefined;
}

const pool =
  global.__aerosPgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: process.env.NODE_ENV === "production" ? 5 : 10,
  });

if (process.env.NODE_ENV !== "production") {
  global.__aerosPgPool = pool;
}

export const db = drizzle(pool, { schema });
export { pool };
