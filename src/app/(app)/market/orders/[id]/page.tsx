import Link from "next/link";
import { notFound } from "next/navigation";
import { getActingContext, getOwnedCompanies } from "@/lib/auth";
import {
  expireOrderIfOverdue,
  getOrderById,
  orderBuyerWallet,
  orderViewerRole,
} from "@/lib/marketplace";
import { OrderStatusBadge, InvoiceStatusBadge } from "@/components/status-badge";
import {
  AcceptOrderButton,
  CancelOrderButton,
  CompleteOrderButton,
  IssueOrderInvoiceForm,
  RequestInvoiceButton,
} from "@/components/forms/marketplace-forms";
import { CURRENCY_NAME, RATING_COMMENT_RETENTION_DAYS } from "@/lib/constants";
import { formatDateTime } from "@/lib/datetime";
import { getRatingForOrder, orderIsRateableBy } from "@/lib/ratings";
import { RateOrderForm } from "@/components/forms/rating-form";
import { RatingStars } from "@/components/rating-stars";

/**
 * ONE ORDER, and whichever actions the viewer is actually entitled to.
 *
 * The buttons shown here are a convenience, not the rule: every action
 * re-derives the viewer's role and re-checks the order's state inside its own
 * transaction, so a hidden button is not what stops the wrong person acting.
 *
 * The money figures all come from the linked INVOICE, which is the canonical
 * record of what is payable — this page never recomputes a total.
 */
export default async function OrderPage({ params }: PageProps<"/market/orders/[id]">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { id } = await params;
  await expireOrderIfOverdue(id).catch(() => undefined);

  const row = await getOrderById(id);
  if (!row) notFound();

  const owned = await getOwnedCompanies(ctx.user.id);
  const role = orderViewerRole(row.order, {
    userId: ctx.user.id,
    wallet: ctx.wallet,
    ownedCompanyIds: owned.map((c) => c.id),
  });
  if (!role.canView) notFound();

  const { order } = row;
  const buyerWallet = orderBuyerWallet(order);
  const buyerIsThisWallet =
    buyerWallet.kind === ctx.wallet.kind && buyerWallet.id === ctx.wallet.id;

  // Rating: shown to the buyer of a COMPLETED order that has not been rated.
  // `orderIsRateableBy` is only about what to RENDER — rateOrderAction re-derives
  // the buyer, the status and the once-only rule server-side under a row lock.
  const existingRating = await getRatingForOrder(order.id);
  const canRate = existingRating === null && orderIsRateableBy(order, ctx.wallet);

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={role.isSeller ? "/my-company/orders" : "/market/orders"}
          className="text-sm text-muted hover:text-foreground"
        >
          ← {role.isSeller ? "Company orders" : "My orders"}
        </Link>
      </div>

      <section className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{row.offerTitle}</h1>
            <p className="mt-1 font-mono text-sm text-muted">{order.orderNumber}</p>
          </div>
          <OrderStatusBadge status={order.status} />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted">Seller</dt>
          <dd>
            <Link href={`/c/${row.sellerUsername}`} className="hover:underline">
              {row.sellerName}
            </Link>{" "}
            (@{row.sellerUsername})
          </dd>
          <dt className="text-muted">Buyer</dt>
          <dd>
            {row.buyerLabel} (@{row.buyerHandle})
          </dd>
          <dt className="text-muted">Quantity</dt>
          <dd>{order.quantity.toLocaleString()}</dd>
          <dt className="text-muted">Price at order time</dt>
          <dd>
            {order.unitPrice.toLocaleString()} {CURRENCY_NAME} each
          </dd>
          <dt className="text-muted">Subtotal</dt>
          <dd className="font-medium">
            {order.subtotal.toLocaleString()} {CURRENCY_NAME}
          </dd>
          <dt className="text-muted">Ordered</dt>
          <dd>{formatDateTime(order.createdAt)}</dd>
          {order.acceptedAt && (
            <>
              <dt className="text-muted">Accepted</dt>
              <dd>{formatDateTime(order.acceptedAt)}</dd>
            </>
          )}
          {order.paidAt && (
            <>
              <dt className="text-muted">Paid</dt>
              <dd>{formatDateTime(order.paidAt)}</dd>
            </>
          )}
          {order.completedAt && (
            <>
              <dt className="text-muted">Completed</dt>
              <dd>{formatDateTime(order.completedAt)}</dd>
            </>
          )}
          {order.cancelledAt && (
            <>
              <dt className="text-muted">Cancelled</dt>
              <dd>
                {formatDateTime(order.cancelledAt)}
                {order.cancelReason ? ` — ${order.cancelReason}` : ""}
              </dd>
            </>
          )}
          {!["PAID", "COMPLETED", "CANCELLED", "EXPIRED"].includes(order.status) && (
            <>
              <dt className="text-muted">Lapses</dt>
              <dd>{formatDateTime(order.expiresAt)}</dd>
            </>
          )}
        </dl>
      </section>

      {order.invoiceId && row.invoiceNumber && (
        <section className="card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-medium">Invoice {row.invoiceNumber}</h2>
              <p className="mt-1 text-sm text-muted">
                {row.invoiceTotal !== null
                  ? `${row.invoiceTotal.toLocaleString()} ${CURRENCY_NAME} payable by the buyer.`
                  : "See the invoice for the payable total."}
              </p>
              {row.paidTxRef && (
                <p className="mt-1 font-mono text-xs text-muted">Ref {row.paidTxRef}</p>
              )}
            </div>
            {row.invoiceStatus && (
              <InvoiceStatusBadge
                status={row.invoiceStatus as "PENDING" | "PAID" | "CANCELLED" | "EXPIRED"}
              />
            )}
          </div>
          <Link
            href={`/invoices/${order.invoiceId}`}
            className="btn btn-primary mt-3 inline-block text-sm"
          >
            {buyerIsThisWallet && row.invoiceStatus === "PENDING"
              ? "Open the invoice to pay"
              : "View the invoice"}
          </Link>
        </section>
      )}

      <section className="card space-y-3 p-5">
        <h2 className="font-medium">What happens next</h2>
        <p className="text-sm text-muted">
          {order.status === "PENDING"
            ? "The seller has to accept this order before an invoice can be raised."
            : order.status === "ACCEPTED"
              ? "The seller accepted. An invoice comes next."
              : order.status === "WAITING_FOR_INVOICE"
                ? "The buyer is waiting for the seller's invoice."
                : order.status === "PAYMENT_DUE"
                  ? "The invoice is waiting to be paid. The money settles to the seller's company wallet."
                  : order.status === "PAID"
                    ? "Paid. Either side can mark it completed once the goods or service have changed hands."
                    : order.status === "COMPLETED"
                      ? "Completed. A refund would be a new transaction linked to the payment, never an edit."
                      : order.status === "CANCELLED"
                        ? "Cancelled. Any reserved stock went back to the listing."
                        : "This order lapsed without being settled."}
        </p>

        <div className="flex flex-wrap items-start gap-2">
          {role.isSeller && order.status === "PENDING" && <AcceptOrderButton orderId={order.id} />}
          {role.isSeller &&
            (order.status === "ACCEPTED" || order.status === "WAITING_FOR_INVOICE") && (
              <IssueOrderInvoiceForm orderId={order.id} total={order.subtotal} />
            )}
          {buyerIsThisWallet && order.status === "ACCEPTED" && (
            <RequestInvoiceButton orderId={order.id} />
          )}
          {order.status === "PAID" && (role.isSeller || buyerIsThisWallet) && (
            <CompleteOrderButton orderId={order.id} />
          )}
          {(role.isSeller || buyerIsThisWallet) &&
            ["PENDING", "ACCEPTED", "WAITING_FOR_INVOICE", "PAYMENT_DUE"].includes(
              order.status,
            ) && <CancelOrderButton orderId={order.id} />}
        </div>

        {role.isSellerOwner && !role.isSeller && (
          <p className="text-xs text-muted">
            Switch to {row.sellerName} from your dashboard to act on this order as the seller.
          </p>
        )}
      </section>

      {canRate && (
        <RateOrderForm
          orderId={order.id}
          sellerName={row.sellerName}
          commentRetentionDays={RATING_COMMENT_RETENTION_DAYS}
        />
      )}

      {existingRating && (
        <section className="card p-5" data-testid="existing-rating">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">
              {buyerIsThisWallet ? "Your rating" : "The buyer's rating"}
            </h2>
            <RatingStars stars={existingRating.stars} size={16} />
          </div>
          {existingRating.comment ? (
            <p className="mt-2 whitespace-pre-line text-sm">{existingRating.comment}</p>
          ) : existingRating.commentClearedAt ? (
            <p className="mt-2 text-sm italic text-muted">Comment removed — the star stays.</p>
          ) : null}
          <p className="mt-2 text-xs text-muted">
            Left {formatDateTime(existingRating.createdAt)}. A rating cannot be changed or
            repeated — one per order.
          </p>
        </section>
      )}

      {order.status === "PAID" && buyerIsThisWallet && (
        <p className="text-sm text-muted">
          You can rate this order once it is marked completed.
        </p>
      )}
    </div>
  );
}
