import type { Transaction } from "@/db/schema";
import { CURRENCY_NAME } from "@/lib/constants";

function partyLabel(type: "USER" | "GOVERNMENT", username: string): string {
  return type === "GOVERNMENT" ? "Government" : `@${username}`;
}

const TYPE_LABELS: Record<string, string> = {
  TRANSFER: "Transfer",
  GOVERNMENT_FUNDING: "Government funding",
  ADMIN_ADJUSTMENT_CREDIT: "Administrative credit",
  ADMIN_ADJUSTMENT_DEBIT: "Administrative debit",
  ISSUANCE_CREDIT: "Aeros issuance",
};

export function TransactionRow({
  tx,
  viewerUsername,
}: {
  tx: Transaction;
  viewerUsername?: string;
}) {
  const isOutgoing = viewerUsername ? tx.senderUsername === viewerUsername && tx.senderType === "USER" : undefined;
  const isIncoming = viewerUsername
    ? tx.receiverUsername === viewerUsername && tx.receiverType === "USER"
    : undefined;

  let amountDisplay: string;
  let amountClass: string;
  if (isOutgoing) {
    amountDisplay = `-${tx.grossAmount.toLocaleString()}`;
    amountClass = "text-danger";
  } else if (isIncoming) {
    amountDisplay = `+${tx.netAmount.toLocaleString()}`;
    amountClass = "text-success";
  } else {
    amountDisplay = tx.netAmount.toLocaleString();
    amountClass = "text-foreground";
  }

  return (
    <div className="flex items-center justify-between py-3 text-sm">
      <div>
        <p className="font-medium">
          {partyLabel(tx.senderType, tx.senderUsername)}
          <span className="mx-1 text-muted">→</span>
          {partyLabel(tx.receiverType, tx.receiverUsername)}
        </p>
        <p className="text-xs text-muted">
          {TYPE_LABELS[tx.type] ?? tx.type} · {tx.txRef} ·{" "}
          {new Date(tx.createdAt).toLocaleString()}
        </p>
      </div>
      <div className="text-right">
        <p className={`font-mono font-medium ${amountClass}`}>
          {amountDisplay} {CURRENCY_NAME}
        </p>
        {tx.taxAmount > 0 && (
          <p className="text-xs text-muted">tax {tx.taxAmount.toLocaleString()}</p>
        )}
      </div>
    </div>
  );
}
