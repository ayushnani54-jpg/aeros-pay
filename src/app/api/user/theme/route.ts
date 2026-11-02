import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ ok: true, guest: true });
    }

    const body = await req.json().catch(() => null);
    const theme = body?.theme;
    if (theme === "light" || theme === "dark" || theme === "system") {
      await db
        .update(users)
        .set({ themePreference: theme })
        .where(eq(users.id, user.id));
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
