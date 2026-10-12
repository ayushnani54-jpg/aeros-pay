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
  { href: "/market", label: "Marketplace & Jobs", icon: "list" },
  { href: "/aeros-market", label: "Market Index", icon: "list" },
  { href: "/media", label: "Aeros Media", icon: "updates" },
  { href: "/people", label: "People", icon: "people" },
  { href: "/companies", label: "Companies", icon: "company" },
  { href: "/transactions", label: "Activity", icon: "list" },
];

const SECONDARY: NavItem[] = [
  { href: "/aeros-market", label: "Trading & Index", icon: "list" },
  { href: "/market", label: "Goods & Jobs", icon: "list" },
  { href: "/media", label: "Aeros Media", icon: "updates" },
  { href: "/exchange", label: "Exchange", icon: "send" },
  { href: "/refunds", label: "Refunds", icon: "updates" },
  { href: "/market/orders", label: "My Orders", icon: "list" },
  { href: "/market/contracts", label: "Contracts", icon: "updates" },
  { href: "/market/wanted", label: "Wanted", icon: "updates" },
  { href: "/market/leaderboard", label: "Leaderboard", icon: "list" },
  { href: "/notifications", label: "Notifications", icon: "updates" },
  { href: "/updates", label: "Updates", icon: "updates" },
  { href: "/contact-government", label: "Support", icon: "updates" },
  { href: "/profile", label: "Profile", icon: "profile" },
];

/**
 * Mobile bottom bar keeps five key destinations for quick thumb access,
 * while the top scrollable pill bar provides one-tap access to all V5 modules.
 */
const MOBILE: NavItem[] = [
  { href: "/dashboard", label: "Home", icon: "home" },
  { href: "/pay", label: "Pay", icon: "send" },
  { href: "/aeros-market", label: "Trade", icon: "list" },
  { href: "/media", label: "Media", icon: "updates" },
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

  const mobileQuickLinks = hasCompany
    ? [{ href: "/my-company", label: "My Company", icon: "company" as IconName }, ...SECONDARY]
    : SECONDARY;

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 py-2.5 sm:px-6 sm:py-3">
        <Link href="/dashboard" className="flex shrink-0 items-center gap-2">
          <AerosLogo size={26} />
          <span className="font-semibold tracking-tight">{APP_NAME}</span>
          <span className="rounded bg-black px-1.5 py-0.5 text-[10px] font-bold text-white">
            V5
          </span>
        </Link>

        <nav className="hidden items-center gap-1 overflow-x-auto lg:flex">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium ${
                isActive(pathname, item.href)
                  ? "bg-black text-white"
                  : "text-muted hover:bg-surface hover:text-foreground"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <Link
            href="/notifications"
            className="relative rounded-md px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface hover:text-foreground sm:text-sm"
          >
            Alerts
            {unreadCount > 0 && (
              <span className="ml-1 rounded-full bg-black px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </Link>
          <form action={logoutAction}>
            <button type="submit" className="btn btn-secondary px-2.5 py-1.5 text-xs sm:text-sm">
              Log out
            </button>
          </form>
        </div>
      </div>

      {/* Scrollable sub-navigation row on both mobile and desktop so every V5 destination is 1 tap away */}
      <div className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-3 pb-2 sm:px-6">
        {mobileQuickLinks.map((item) => (
          <Link
            key={item.href + item.label}
            href={item.href}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              isActive(pathname, item.href)
                ? "bg-black text-white"
                : "bg-surface text-muted hover:text-foreground"
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
