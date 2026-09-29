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

// ---------------------------------------------------------------------------
// V3 — marketplace, wanted, contracts, promotions
//
// Same three badge classes as everything above. V3 adds no new colours to the
// design system either: "good/settled" is green, "in progress/waiting" is
// amber, "gone/refused" is red.
// ---------------------------------------------------------------------------

export function OfferStatusBadge({ status }: { status: "ACTIVE" | "PAUSED" | "CLOSED" }) {
  const cls =
    status === "ACTIVE" ? "badge-active" : status === "PAUSED" ? "badge-suspended" : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function OrderStatusBadge({ status }: { status: string }) {
  const cls =
    status === "PAID" || status === "COMPLETED"
      ? "badge-active"
      : status === "CANCELLED" || status === "EXPIRED"
        ? "badge-banned"
        : "badge-suspended";
  return <span className={`badge ${cls}`}>{status.replace(/_/g, " ")}</span>;
}

export function WantedStatusBadge({ status }: { status: string }) {
  const cls =
    status === "FULFILLED" || status === "ACCEPTED"
      ? "badge-active"
      : status === "OPEN" || status === "PENDING"
        ? "badge-suspended"
        : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function ContractStatusBadge({ status }: { status: string }) {
  const cls =
    status === "COMPLETED" || status === "ACCEPTED"
      ? "badge-active"
      : status === "OPEN" || status === "AWARDED" || status === "PENDING"
        ? "badge-suspended"
        : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function PromotionStatusBadge({ status }: { status: string }) {
  const cls =
    status === "ACTIVE" || status === "COMPLETED" || status === "APPROVED"
      ? "badge-active"
      : status === "PENDING" || status === "PAUSED"
        ? "badge-suspended"
        : "badge-banned";
  return <span className={`badge ${cls}`}>{status}</span>;
}

// ---------------------------------------------------------------------------
// V3 — Government identity labels (Phase G, spec §§19,20)
//
// These are LABELS, not permissions. They say who the Government has chosen to
// mark; they say nothing about what that account can do, and no authorization
// check anywhere reads the columns behind them (see src/lib/badges.ts).
//
// No new colours: the verified label reuses `badge-active` and the member label
// reuses the existing `bg-surface` / `text-muted` tokens, so V3 adds nothing to
// the palette here either.
// ---------------------------------------------------------------------------

export function GovernmentUserBadge() {
  return (
    <span className="badge badge-active" title="Official Government User" data-testid="badge-gov">
      GOV
    </span>
  );
}

export function GovernmentMemberBadge() {
  return (
    <span
      className="badge bg-surface text-muted"
      title="Government Member"
      data-testid="badge-member"
    >
      Member
    </span>
  );
}

/** Both labels, in a fixed order, rendering nothing when there are none. */
export function UserBadges({
  official,
  member,
}: {
  official: boolean;
  member: boolean;
}) {
  if (!official && !member) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {official && <GovernmentUserBadge />}
      {member && <GovernmentMemberBadge />}
    </span>
  );
}
