import type { Transaction } from "@/db/schema";
import { CURRENCY_NAME } from "@/lib/constants";

type PartyType = "USER" | "GOVERNMENT" | "COMPANY";

function partyLabel(type: PartyType, username: string): string {
  if (type === "GOVERNMENT") return "Government";
  return `@${username}`;
}

const TYPE_LABELS: Record<string, string> = {
  TRANSFER: "Transfer",
  GOVERNMENT_FUNDING: "Government funding",
  ADMIN_ADJUSTMENT_CREDIT: "Administrative credit",
  ADMIN_ADJUSTMENT_DEBIT: "Administrative debit",
  ISSUANCE_CREDIT: "Aeros issuance",
  COMPANY_FUNDING: "Company funding",
  COMPANY_SALE: "Company sale",
  COMPANY_PAYMENT: "Company payment",
  INVOICE_PAYMENT: "Invoice payment",
  GOVERNMENT_PAYMENT: "Government payment",
  GOVERNMENT_RECEIPT: "Payment to Government",
  COMPANY_ADJUSTMENT_CREDIT: "Company administrative credit",
  COMPANY_ADJUSTMENT_DEBIT: "Company administrative debit",
  COMPANY_SALE_PURCHASE: "Company purchase",
  LOAN_DISBURSEMENT: "Loan disbursement",
  LOAN_REPAYMENT: "Loan repayment",
};

export function TransactionRow({
  tx,
  viewerUsername,
  viewerId,
}: {
  tx: Transaction;
  /** Username of the wallet being viewed (user or company). */
  viewerUsername?: string;
  /** Id of the wallet being viewed — more reliable than the username. */
  viewerId?: string;
}) {
  const matchesViewer = (
    partyId: string | null,
    partyUsername: string,
    partyType: PartyType,
  ): boolean => {
    if (partyType === "GOVERNMENT") return false;
    if (viewerId && partyId) return partyId === viewerId;
    return viewerUsername ? partyUsername === viewerUsername : false;
  };

  const isOutgoing = matchesViewer(tx.senderId, tx.senderUsername, tx.senderType);
  const isIncoming = matchesViewer(tx.receiverId, tx.receiverUsername, tx.receiverType);

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
    <div className="flex items-center justify-between gap-3 py-3 text-sm">
      <div className="min-w-0">
        <p className="truncate font-medium">
          {partyLabel(tx.senderType, tx.senderUsername)}
          <span className="mx-1 text-muted">→</span>
          {partyLabel(tx.receiverType, tx.receiverUsername)}
        </p>
        <p className="text-xs text-muted">
          {TYPE_LABELS[tx.type] ?? tx.type} · {tx.txRef} ·{" "}
          {new Date(tx.createdAt).toLocaleString()}
        </p>
        {tx.reason && <p className="truncate text-xs text-muted">{tx.reason}</p>}
      </div>
      <div className="shrink-0 text-right">
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
