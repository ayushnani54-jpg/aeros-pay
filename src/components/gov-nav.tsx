"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AerosLogo } from "./logo";
import { govLogoutAction } from "@/actions/auth";

const NAV_ITEMS = [
  { href: "/gov", label: "Dashboard" },
  { href: "/gov/users", label: "Users" },
  { href: "/gov/codes", label: "Codes" },
  { href: "/gov/transactions", label: "Transactions" },
  { href: "/gov/tax", label: "Tax" },
  { href: "/gov/treasury", label: "Treasury" },
  { href: "/gov/issuance", label: "Issuance" },
  { href: "/gov/updates", label: "Updates" },
  { href: "/gov/audit", label: "Audit Log" },
];

export function GovNavbar() {
  const pathname = usePathname();

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <AerosLogo size={24} />
          <span className="font-semibold tracking-tight">Government Panel</span>
        </div>
        <form action={govLogoutAction}>
          <button type="submit" className="btn btn-secondary text-sm">
            Log out
          </button>
        </form>
      </div>
      <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${
                active ? "bg-black text-white" : "text-muted hover:bg-surface hover:text-foreground"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
