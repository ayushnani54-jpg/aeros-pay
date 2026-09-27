import "server-only";
import { randomInt } from "crypto";
import { db } from "@/db/client";
import { registrationCodes } from "@/db/schema";
import { REGISTRATION_CODE_LENGTH } from "./constants";
import { isUniqueViolation } from "./db-errors";

/**
 * Generates a cryptographically random 4-digit registration code and
 * inserts it as UNUSED. Retries on the rare collision with an existing
 * code (global uniqueness, enforced at the database level).
 */
export async function generateRegistrationCode(maxAttempts = 25): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = String(randomInt(0, 10 ** REGISTRATION_CODE_LENGTH)).padStart(
      REGISTRATION_CODE_LENGTH,
      "0",
    );
    try {
      await db.insert(registrationCodes).values({ code });
      return code;
    } catch (e) {
      if (isUniqueViolation(e)) continue;
      throw e;
    }
  }
  throw new Error("Could not generate a unique registration code. Try again.");
}
