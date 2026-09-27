import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import {
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
}) {
  const token = await signSession(
    { role: "user", sub: user.id, username: user.username },
    USER_SESSION_MAX_AGE_SECONDS,
  );
  const store = await cookies();
  store.set(USER_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: USER_SESSION_MAX_AGE_SECONDS,
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
    maxAge: GOV_SESSION_MAX_AGE_SECONDS,
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
