"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AerosLogo } from "./logo";
import { logoutAction } from "@/actions/auth";
import { APP_NAME } from "@/lib/constants";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Home" },
  { href: "/send", label: "Send" },
  { href: "/transactions", label: "Transactions" },
  { href: "/updates", label: "Updates" },
  { href: "/profile", label: "Profile" },
];

export function UserNavbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
        <Link href="/dashboard" className="flex items-center gap-2">
          <AerosLogo size={26} />
          <span className="font-semibold tracking-tight">{APP_NAME}</span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  active ? "bg-black text-white" : "text-muted hover:bg-surface hover:text-foreground"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <form action={logoutAction}>
          <button type="submit" className="btn btn-secondary text-sm">
            Log out
          </button>
        </form>
      </div>
    </header>
  );
}

export function UserBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background sm:hidden">
      <div className="grid grid-cols-5">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium ${
                active ? "text-foreground" : "text-muted"
              }`}
            >
              <NavIcon label={item.label} active={active} />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function NavIcon({ label, active }: { label: string; active: boolean }) {
  const stroke = active ? "#111111" : "#9a9a9a";
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none" as const };
  switch (label) {
    case "Home":
      return (
        <svg {...common}>
          <path d="M4 11.5 12 4l8 7.5" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M6 10v9h12v-9" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Send":
      return (
        <svg {...common}>
          <path d="M4 12h15M13 6l6 6-6 6" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Transactions":
      return (
        <svg {...common}>
          <path d="M5 7h14M5 12h14M5 17h9" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "Updates":
      return (
        <svg {...common}>
          <path d="M6 4h9l4 4v12H6z" stroke={stroke} strokeWidth="2" strokeLinejoin="round" />
          <path d="M9 12h6M9 16h6" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.2" stroke={stroke} strokeWidth="2" />
          <path d="M5 20c1.5-4 4.5-6 7-6s5.5 2 7 6" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
  }
}
