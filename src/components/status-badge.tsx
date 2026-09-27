/**
 * Status badges. All of these reuse the existing V1 badge classes
 * (`badge-active` / `badge-suspended` / `badge-banned`) so V2 adds no new
 * colours to the design system.
 */

export function StatusBadge({ status }: { status: "ACTIVE" | "SUSPENDED" | "BANNED" }) {
  const cls =
    status === "ACTIVE" ? "badge-active" : status === "SUSPENDED" ? "badge-suspended" : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function CodeStatusBadge({ status }: { status: "UNUSED" | "USED" | "REVOKED" }) {
  const cls =
    status === "UNUSED" ? "badge-active" : status === "USED" ? "badge-suspended" : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function IssuanceStatusBadge({ status }: { status: "OPEN" | "EXECUTED" }) {
  const cls = status === "OPEN" ? "badge-suspended" : "badge-active";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function CompanyStatusBadge({
  status,
}: {
  status: "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED" | "REVOKED";
}) {
  const cls =
    status === "APPROVED"
      ? "badge-active"
      : status === "PENDING" || status === "SUSPENDED"
        ? "badge-suspended"
        : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function InvoiceStatusBadge({
  status,
}: {
  status: "PENDING" | "PAID" | "CANCELLED" | "EXPIRED";
}) {
  const cls =
    status === "PAID"
      ? "badge-active"
      : status === "PENDING"
        ? "badge-suspended"
        : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function LoanStatusBadge({ status }: { status: string }) {
  const cls =
    status === "PAID" || status === "ACTIVE"
      ? "badge-active"
      : status === "PENDING" || status === "APPROVED" || status === "RESTRUCTURED"
        ? "badge-suspended"
        : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function InstalmentStatusBadge({ status }: { status: string }) {
  const cls =
    status === "PAID"
      ? "badge-active"
      : status === "PENDING" || status === "WAIVED"
        ? "badge-suspended"
        : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function SupportStatusBadge({ status }: { status: "OPEN" | "WAITING" | "RESOLVED" }) {
  const cls =
    status === "RESOLVED" ? "badge-active" : status === "OPEN" ? "badge-suspended" : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function IpStatusBadge({ status }: { status: string }) {
  const cls =
    status === "RESOLVED"
      ? "badge-active"
      : status === "OPEN"
        ? "badge-suspended"
        : "badge-banned";
  return <span className={`badge ${cls}`}>{status.replace(/_/g, " ")}</span>;
}

export function SaleStatusBadge({ status }: { status: string }) {
  const cls =
    status === "SOLD" || status === "ACCEPTED"
      ? "badge-active"
      : status === "OPEN" || status === "PENDING"
        ? "badge-suspended"
        : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}
