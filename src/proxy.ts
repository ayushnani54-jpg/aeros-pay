import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { GOV_SESSION_COOKIE, USER_SESSION_COOKIE } from "@/lib/constants";

// Fast, edge-level redirect based on cookie *presence* only. This is a
// convenience for a snappier redirect and is NOT the security boundary —
// every protected layout and server action independently re-verifies the
// signed session server-side (see src/lib/auth.ts). A forged or expired
// cookie is still rejected there even if it passes this check.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isGovArea = pathname.startsWith("/gov");
  const isUserArea =
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/send") ||
    pathname.startsWith("/transactions") ||
    pathname.startsWith("/profile") ||
    pathname.startsWith("/updates");

  if (isGovArea) {
    const hasGovSession = request.cookies.has(GOV_SESSION_COOKIE);
    if (!hasGovSession) {
      return NextResponse.redirect(new URL("/government/login", request.url));
    }
  }

  if (isUserArea) {
    const hasUserSession = request.cookies.has(USER_SESSION_COOKIE);
    if (!hasUserSession) {
      return NextResponse.redirect(new URL("/login", request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/send/:path*",
    "/transactions/:path*",
    "/profile/:path*",
    "/updates/:path*",
    "/gov/:path*",
  ],
};
