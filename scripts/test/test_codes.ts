import "dotenv/config";
import { generateRegistrationCode } from "../../src/lib/codes";
import { pool } from "../../src/db/client";

async function main() {
  const codes = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const c = await generateRegistrationCode();
    console.log("generated:", c);
    if (codes.has(c)) throw new Error("DUPLICATE CODE GENERATED: " + c);
    codes.add(c);
    if (!/^[0-9]{4}$/.test(c)) throw new Error("BAD FORMAT: " + c);
  }
  console.log("OK: all codes unique and well-formed");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
