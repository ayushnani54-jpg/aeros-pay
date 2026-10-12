"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AerosLogo } from "./logo";
import { govLogoutAction } from "@/actions/auth";

/**
 * Government navigation (spec §63). Same scrolling tab-row pattern as V1 —
 * only the destinations grew.
 */
const NAV_ITEMS = [
  { href: "/gov", label: "Dashboard" },
  { href: "/gov/archive", label: "Archive Center (15 Repos)" },
  { href: "/gov/market", label: "Market Index & Leverage" },
  { href: "/gov/companies", label: "Companies & Partnerships" },
  { href: "/gov/control-room", label: "Control Room & Media" },
  { href: "/media", label: "Aeros Media" },
  { href: "/gov/exchange", label: "Exchange" },
  { href: "/gov/refunds", label: "Refunds" },
  { href: "/gov/users", label: "Users" },
  { href: "/gov/transactions", label: "Transactions" },
  { href: "/gov/treasury", label: "Treasury" },
  { href: "/gov/tax", label: "Taxes" },
  { href: "/gov/loans", label: "Loans" },
  { href: "/gov/sales", label: "Sales" },
  { href: "/gov/contracts", label: "Contracts" },
  { href: "/gov/promotions", label: "Promotions" },
  { href: "/gov/issuance", label: "Issuance" },
  { href: "/gov/payments", label: "Payments" },
  { href: "/gov/support", label: "Support" },
  { href: "/gov/ip", label: "IP" },
  { href: "/gov/updates", label: "Updates" },
  { href: "/gov/audit", label: "Audit Log" },
  { href: "/gov/codes", label: "Codes" },
  { href: "/gov/retention", label: "Retention" },
  { href: "/gov/health", label: "Health" },
  { href: "/gov/exports", label: "Exports" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/gov") return pathname === "/gov";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function GovNavbar({ alerts = 0 }: { alerts?: number }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <AerosLogo size={24} />
          <span className="font-semibold tracking-tight">Government Panel</span>
          {alerts > 0 && (
            <span className="badge badge-suspended ml-1">{alerts} needs attention</span>
          )}
        </div>
        <form action={govLogoutAction}>
          <button type="submit" className="btn btn-secondary text-sm">
            Log out
          </button>
        </form>
      </div>
      <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${
              isActive(pathname, item.href)
                ? "bg-black text-white"
                : "text-muted hover:bg-surface hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
