import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { GOV_SESSION_COOKIE, USER_SESSION_COOKIE } from "@/lib/constants";

/**
 * Fast, edge-level redirect based on cookie *presence* only.
 *
 * This is a convenience for a snappier redirect and is NOT the security
 * boundary. Every protected layout and every server action independently
 * re-verifies the signed session server-side (see src/lib/auth.ts), including
 * the session epoch, the user's effective status and company ownership. A
 * forged or stale cookie still gets rejected there even though it passes this
 * check — which matters because Server Actions are directly callable HTTP
 * endpoints that this matcher would not cover on its own.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isGovArea = pathname.startsWith("/gov");

  const USER_AREAS = [
    "/dashboard",
    "/pay",
    "/send",
    "/people",
    "/companies",
    "/marketplace",
    "/market",
    "/transactions",
    "/notifications",
    "/updates",
    "/profile",
    "/my-company",
    "/invoices",
    "/contact-government",
    "/government-profile",
    "/u/",
    "/c/",
  ];
  const isUserArea = USER_AREAS.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );

  if (isGovArea) {
    if (!request.cookies.has(GOV_SESSION_COOKIE)) {
      return NextResponse.redirect(new URL("/government/login", request.url));
    }
  }

  if (isUserArea) {
    if (!request.cookies.has(USER_SESSION_COOKIE)) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/pay/:path*",
    "/send/:path*",
    "/people/:path*",
    "/companies/:path*",
    "/marketplace/:path*",
    "/market/:path*",
    "/transactions/:path*",
    "/notifications/:path*",
    "/updates/:path*",
    "/profile/:path*",
    "/my-company/:path*",
    "/invoices/:path*",
    "/contact-government/:path*",
    "/government-profile/:path*",
    "/u/:path*",
    "/c/:path*",
    "/gov/:path*",
  ],
};
