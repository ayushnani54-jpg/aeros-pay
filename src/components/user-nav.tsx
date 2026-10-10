"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AerosLogo } from "./logo";
import { logoutAction } from "@/actions/auth";
import { APP_NAME } from "@/lib/constants";

/**
 * Navigation. Same visual language as V1 — a sticky top bar on desktop and a
 * fixed five-item tab bar on mobile. "My Company" only appears for users who
 * actually own an approved company (spec §62), so the experience for everyone
 * else is unchanged from V1.
 */

type NavItem = { href: string; label: string; icon: IconName };
type IconName = "home" | "send" | "people" | "list" | "updates" | "profile" | "company";

const PRIMARY: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: "home" },
  { href: "/pay", label: "Pay", icon: "send" },
  // V3: the goods-and-services Market. Deliberately NOT "/marketplace", which
  // has meant "companies that are for sale" since V2 and still does.
  { href: "/market", label: "Market", icon: "list" },
  { href: "/people", label: "People", icon: "people" },
  { href: "/companies", label: "Companies", icon: "company" },
  { href: "/transactions", label: "Activity", icon: "list" },
];

const SECONDARY: NavItem[] = [
  { href: "/exchange", label: "Exchange", icon: "send" },
  { href: "/aeros-market", label: "Aeros Market", icon: "list" },
  { href: "/refunds", label: "Refunds", icon: "updates" },
  { href: "/market/orders", label: "My Orders", icon: "list" },
  { href: "/market/leaderboard", label: "Leaderboard", icon: "list" },
  { href: "/market/wanted", label: "Wanted", icon: "updates" },
  { href: "/market/contracts", label: "Contracts", icon: "updates" },
  { href: "/notifications", label: "Notifications", icon: "updates" },
  { href: "/updates", label: "Updates", icon: "updates" },
  { href: "/contact-government", label: "Contact Government", icon: "updates" },
  { href: "/profile", label: "Profile", icon: "profile" },
];

/**
 * Mobile bottom bar keeps exactly five destinations, as in V1.
 *
 * V3 deliberately does NOT add a sixth: the bar is a five-column grid and a
 * sixth item would change the layout everyone already knows. The Market is
 * reached on a phone from the dashboard's quick actions instead.
 */
const MOBILE: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: "home" },
  { href: "/pay", label: "Pay", icon: "send" },
  { href: "/companies", label: "Companies", icon: "company" },
  { href: "/notifications", label: "Alerts", icon: "updates" },
  { href: "/profile", label: "Profile", icon: "profile" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function UserNavbar({
  hasCompany = false,
  unreadCount = 0,
}: {
  hasCompany?: boolean;
  unreadCount?: number;
}) {
  const pathname = usePathname();

  const items = hasCompany
    ? [...PRIMARY, { href: "/my-company", label: "My Company", icon: "company" as IconName }]
    : PRIMARY;

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/dashboard" className="flex shrink-0 items-center gap-2">
          <AerosLogo size={26} />
          <span className="font-semibold tracking-tight">{APP_NAME}</span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-3 py-2 text-sm font-medium ${
                isActive(pathname, item.href)
                  ? "bg-black text-white"
                  : "text-muted hover:bg-surface hover:text-foreground"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/notifications"
            className="relative hidden rounded-md px-2 py-2 text-sm font-medium text-muted hover:bg-surface hover:text-foreground sm:block"
          >
            Alerts
            {unreadCount > 0 && (
              <span className="ml-1 rounded-full bg-black px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Link>
          <form action={logoutAction}>
            <button type="submit" className="btn btn-secondary text-sm">
              Log out
            </button>
          </form>
        </div>
      </div>

      {/* Secondary row on desktop keeps the top bar uncluttered. */}
      <div className="mx-auto hidden max-w-5xl gap-1 px-4 pb-2 sm:flex sm:px-6">
        {SECONDARY.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium ${
              isActive(pathname, item.href)
                ? "bg-surface text-foreground"
                : "text-muted hover:bg-surface hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </header>
  );
}

export function UserBottomNav({
  hasCompany = false,
  unreadCount = 0,
}: {
  hasCompany?: boolean;
  unreadCount?: number;
}) {
  const pathname = usePathname();

  const items = hasCompany
    ? MOBILE.map((item) =>
        item.href === "/companies"
          ? { href: "/my-company", label: "Company", icon: "company" as IconName }
          : item,
      )
    : MOBILE;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-background sm:hidden">
      <div className="grid grid-cols-5">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`relative flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium ${
                active ? "text-foreground" : "text-muted"
              }`}
            >
              <NavIcon name={item.icon} active={active} />
              {item.label}
              {item.href === "/notifications" && unreadCount > 0 && (
                <span className="absolute right-1/4 top-1 h-1.5 w-1.5 rounded-full bg-[#b3261e]" />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function NavIcon({ name, active }: { name: IconName; active: boolean }) {
  const stroke = active ? "#111111" : "#9a9a9a";
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none" as const };

  switch (name) {
    case "home":
      return (
        <svg {...common}>
          <path d="M4 11.5 12 4l8 7.5" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M6 10v9h12v-9" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="M4 12h15M13 6l6 6-6 6" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "people":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" stroke={stroke} strokeWidth="2" />
          <path d="M3 19c1.2-3.2 3.6-5 6-5s4.8 1.8 6 5" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
          <path d="M16 6.5a3 3 0 0 1 0 5.5" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "company":
      return (
        <svg {...common}>
          <path d="M4 20V8l6-3 6 3v12" stroke={stroke} strokeWidth="2" strokeLinejoin="round" />
          <path d="M16 20V11l4 2v7" stroke={stroke} strokeWidth="2" strokeLinejoin="round" />
          <path d="M8 12h4M8 16h4" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "list":
      return (
        <svg {...common}>
          <path d="M5 7h14M5 12h14M5 17h9" stroke={stroke} strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "updates":
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
