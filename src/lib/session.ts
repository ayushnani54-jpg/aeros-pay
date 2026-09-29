import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import {
  COMPANY_CONTEXT_COOKIE,
  GOV_SESSION_COOKIE,
  GOV_SESSION_MAX_AGE_SECONDS,
  USER_SESSION_COOKIE,
  USER_SESSION_MAX_AGE_SECONDS,
} from "./constants";

// ---------------------------------------------------------------------------
// Session tokens are stateless signed JWTs (HS256) stored in httpOnly,
// secure, sameSite=lax cookies. No server-side session table is required —
// this keeps the schema small per the project's own design rule, while still
// giving us server-verified identity (the client never sees or can forge the
// signed payload) and clean, immediate logout (cookie deletion).
//
// Two entirely separate cookies/secrets-scopes are used for normal users and
// for the Government account, so a leaked or forged user token can never be
// mistaken for a Government session, and vice versa.
//
// V2 adds an `epoch` claim. Every user row carries a `session_epoch` counter
// which the Government increments when it resets that user's password. A
// token minted before the reset no longer matches and is rejected on the next
// request, so a password reset really does invalidate existing sessions even
// though the sessions themselves are stateless (spec §4).
// ---------------------------------------------------------------------------

function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "AUTH_SECRET environment variable must be set to a random string of at least 32 characters.",
    );
  }
  return new TextEncoder().encode(secret);
}

type UserSessionPayload = {
  role: "user";
  sub: string; // user id
  username: string;
  epoch: number;
};

type GovSessionPayload = {
  role: "government";
  sub: string; // government id
  username: string;
};

async function signSession(
  payload: UserSessionPayload | GovSessionPayload,
  maxAgeSeconds: number,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAgeSeconds)
    .sign(getSecretKey());
}

async function verifySession<T>(token: string): Promise<T | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    return payload as T;
  } catch {
    return null;
  }
}

// ---- User session ----------------------------------------------------------

export async function createUserSession(user: {
  id: string;
  username: string;
  sessionEpoch?: number;
}) {
  const token = await signSession(
    {
      role: "user",
      sub: user.id,
      username: user.username,
      epoch: user.sessionEpoch ?? 0,
    },
    USER_SESSION_MAX_AGE_SECONDS,
  );
  const store = await cookies();
  store.set(USER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // Intentionally NOT a persistent cookie: no `maxAge`/`expires` means the
    // browser treats this as a session cookie and discards it when the
    // browser itself is fully closed (not just the tab), so reopening the
    // browser requires logging in again. The JWT's own `exp` claim (set via
    // USER_SESSION_MAX_AGE_SECONDS in signSession above) remains as a
    // server-verified backstop for how long the token is honored even if a
    // client ever retains the cookie longer than intended.
  });
}

export async function getUserSession(): Promise<UserSessionPayload | null> {
  const store = await cookies();
  const token = store.get(USER_SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = await verifySession<UserSessionPayload>(token);
  if (!payload || payload.role !== "user") return null;
  return payload;
}

export async function clearUserSession() {
  const store = await cookies();
  store.delete(USER_SESSION_COOKIE);
  store.delete(COMPANY_CONTEXT_COOKIE);
}

// ---- Government session ----------------------------------------------------

export async function createGovSession(gov: { id: string; username: string }) {
  const token = await signSession(
    { role: "government", sub: gov.id, username: gov.username },
    GOV_SESSION_MAX_AGE_SECONDS,
  );
  const store = await cookies();
  store.set(GOV_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // Session cookie (no maxAge/expires) — see comment in createUserSession.
    // The JWT `exp` claim (GOV_SESSION_MAX_AGE_SECONDS) remains as a
    // server-verified backstop.
  });
}

export async function getGovSession(): Promise<GovSessionPayload | null> {
  const store = await cookies();
  const token = store.get(GOV_SESSION_COOKIE)?.value;
  if (!token) return null;
  const payload = await verifySession<GovSessionPayload>(token);
  if (!payload || payload.role !== "government") return null;
  return payload;
}

export async function clearGovSession() {
  const store = await cookies();
  store.delete(GOV_SESSION_COOKIE);
}

// ---- Company context -------------------------------------------------------
//
// This cookie is only a HINT about which wallet the user is currently acting
// as. It is never trusted on its own: every company action re-verifies, on
// the server, that the company exists, is owned by the logged-in user, and is
// currently approved (see `requireOwnedCompany`). Forging this cookie
// therefore grants nothing.

export async function setCompanyContext(companyId: string | null) {
  const store = await cookies();
  if (companyId === null) {
    store.delete(COMPANY_CONTEXT_COOKIE);
    return;
  }
  store.set(COMPANY_CONTEXT_COOKIE, companyId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // Session cookie, like the auth cookies: a wallet-context hint should
    // never outlive the browser session that chose it.
  });
}

export async function getCompanyContextId(): Promise<string | null> {
  const store = await cookies();
  return store.get(COMPANY_CONTEXT_COOKIE)?.value ?? null;
}

// ---- Offline payment authorization (V3 PWA offline payments) --------------
//
// Not a session and not a cookie: a short, signed JWT the client fetches
// while online and stores itself (in IndexedDB — see src/lib/offline-db.ts),
// then presents back at sync time. It reuses the SAME signing primitive as
// the session tokens above (`jose`, HS256, `AUTH_SECRET`) and the same
// discriminant-claim pattern that keeps a user session from ever being
// mistaken for a Government one: `purpose` here plays the role `role` plays
// for sessions, so an offline-auth token can never be replayed anywhere a
// session token is expected, or vice versa. See src/lib/offline-auth.ts for
// what goes into the payload and how it is enforced at sync time.

export type OfflineAuthTokenPayload = {
  purpose: "offline_payment_auth";
  /** user id */
  sub: string;
  /** offline_auth_tokens.id — looked up server-side at sync to track
   * consumed-so-far across every device that presents this token. */
  jti: string;
  /** Remaining allowance snapshot at issue, in whole Aeros. */
  allowance: number;
  /** Per-transaction cap snapshot at issue, in whole Aeros. */
  perTxMax: number;
};

export async function signOfflineAuthToken(
  payload: OfflineAuthTokenPayload,
  maxAgeSeconds: number,
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAgeSeconds)
    .sign(getSecretKey());
}

/**
 * Verifies signature AND expiry (`jwtVerify` itself rejects an expired
 * token), and rejects anything that is not an offline-auth token — including
 * a perfectly valid user or Government session token, which would otherwise
 * verify fine against the same secret. Returns null rather than throwing, so
 * every call site handles "invalid or expired" as one uniform case exactly
 * like `getUserSession`/`getGovSession` do.
 */
export async function verifyOfflineAuthToken(
  token: string,
): Promise<OfflineAuthTokenPayload | null> {
  const payload = await verifySession<OfflineAuthTokenPayload>(token);
  if (!payload || payload.purpose !== "offline_payment_auth") return null;
  if (typeof payload.sub !== "string" || typeof payload.jti !== "string") return null;
  if (!Number.isFinite(payload.allowance) || !Number.isFinite(payload.perTxMax)) return null;
  return payload;
}
