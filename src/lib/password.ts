import bcrypt from "bcryptjs";

// Cost factor 12 is a reasonable balance of security and latency for a
// small closed-loop app in 2026 on serverless hardware.
const SALT_ROUNDS = 12;

export async function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifySecret(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
