import "server-only";

/**
 * True if the error is a Postgres unique-constraint violation (SQLSTATE
 * 23505), whether it arrives as a raw `pg` error or wrapped by Drizzle's
 * DrizzleQueryError (which nests the original error under `.cause`).
 */
export function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const direct = (e as { code?: string }).code;
  if (direct === "23505") return true;
  const cause = (e as { cause?: { code?: string } }).cause;
  return !!cause && typeof cause === "object" && cause.code === "23505";
}
