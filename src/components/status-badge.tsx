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
