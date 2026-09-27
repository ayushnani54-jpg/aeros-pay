import "dotenv/config";
import { generateRegistrationCode } from "../../src/lib/codes";
import { pool } from "../../src/db/client";
async function main() {
  const c = await generateRegistrationCode();
  console.log(c);
  await pool.end();
}
main();
