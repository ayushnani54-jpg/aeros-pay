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
  { href: "/gov/users", label: "Users" },
  { href: "/gov/companies", label: "Companies" },
  { href: "/gov/transactions", label: "Transactions" },
  { href: "/gov/treasury", label: "Treasury" },
  { href: "/gov/tax", label: "Taxes" },
  { href: "/gov/loans", label: "Loans" },
  { href: "/gov/sales", label: "Sales" },
  { href: "/gov/issuance", label: "Issuance" },
  { href: "/gov/payments", label: "Payments" },
  { href: "/gov/support", label: "Support" },
  { href: "/gov/ip", label: "IP" },
  { href: "/gov/updates", label: "Updates" },
  { href: "/gov/audit", label: "Audit Log" },
  { href: "/gov/codes", label: "Codes" },
  { href: "/gov/control-room", label: "Control Room" },
  { href: "/gov/retention", label: "Retention" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/gov") return pathname === "/gov";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function GovNavbar({ alerts = 0 }: { alerts?: number }) {
  const pathname = usePathname();

  return (
    <header className="border-b border-border">
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
