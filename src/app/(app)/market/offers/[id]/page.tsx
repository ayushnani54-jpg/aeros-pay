import Link from "next/link";
import { notFound } from "next/navigation";
import { getActingContext } from "@/lib/auth";
import { getOfferById, getOrdersForBuyer } from "@/lib/marketplace";
import { OfferStatusBadge } from "@/components/status-badge";
import { PlaceOrderForm } from "@/components/forms/marketplace-forms";
import { CURRENCY_NAME, MARKETPLACE_OPEN_ORDER_STATUSES } from "@/lib/constants";
import { formatDate } from "@/lib/datetime";

/**
 * One listing, and the order form.
 *
 * The form takes a quantity and nothing else: the price the order is written at
 * is read from this offer row inside the placing transaction, so what is shown
 * here is a display of the server's number rather than an input to it.
 */
export default async function OfferPage({ params }: PageProps<"/market/offers/[id]">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { id } = await params;
  const row = await getOfferById(id);
  if (!row) notFound();

  const { offer, companyName, companyUsername, companyOwnerUserId } = row;
  const isOwnCompany = ctx.wallet.kind === "COMPANY" && ctx.wallet.id === offer.companyId;
  const isOwner = companyOwnerUserId === ctx.user.id;

  const myOrders = await getOrdersForBuyer(ctx.wallet, 200);
  const openOrder = myOrders.find(
    (r) =>
      r.order.offerId === offer.id &&
      (MARKETPLACE_OPEN_ORDER_STATUSES as readonly string[]).includes(r.order.status),
  );

  // Why the order form may not be usable. Every one of these is re-checked on
  // the server inside the transaction; this is only the explanation.
  const disabledReason =
    offer.status === "PAUSED"
      ? "This listing is paused and is not taking orders right now."
      : offer.status === "CLOSED"
        ? "This listing has been closed."
        : isOwnCompany
          ? "This is your own company's listing."
          : offer.quantityAvailable === 0
            ? "This listing is out of stock."
            : openOrder
              ? `You already have an open order for this listing (${openOrder.order.orderNumber}).`
              : ctx.effectiveStatus !== "ACTIVE"
                ? "Your account cannot place orders right now."
                : null;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/market" className="text-sm text-muted hover:text-foreground">
          ← Market
        </Link>
      </div>

      <section className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{offer.title}</h1>
            <p className="mt-1 text-sm text-muted">
              <Link href={`/c/${companyUsername}`} className="hover:underline">
                {companyName}
              </Link>{" "}
              (@{companyUsername}) · {offer.category}
            </p>
          </div>
          <OfferStatusBadge status={offer.status} />
        </div>

        <p className="mt-4 whitespace-pre-wrap text-sm">{offer.description}</p>

        <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted">Price</dt>
          <dd className="font-medium">
            {offer.unitPrice.toLocaleString()} {CURRENCY_NAME}
          </dd>
          <dt className="text-muted">Availability</dt>
          <dd>
            {offer.quantityAvailable === null
              ? "Unlimited"
              : `${offer.quantityAvailable.toLocaleString()}`}
          </dd>
          <dt className="text-muted">Listed</dt>
          <dd>{formatDate(offer.createdAt)}</dd>
        </dl>
      </section>

      {isOwner && (
        <div className="card p-5">
          <p className="text-sm text-muted">
            You own this listing.{" "}
            <Link href="/my-company/offers" className="underline">
              Manage your listings
            </Link>
            .
          </p>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted">Order this</h2>
        <PlaceOrderForm
          offerId={offer.id}
          unitPrice={offer.unitPrice}
          available={offer.quantityAvailable}
          buyerLabel={ctx.company ? `${ctx.company.name} (${ctx.handle})` : ctx.handle}
          disabledReason={disabledReason}
        />
        {openOrder && (
          <p className="text-xs text-muted">
            <Link href={`/market/orders/${openOrder.order.id}`} className="underline">
              View order {openOrder.order.orderNumber}
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
