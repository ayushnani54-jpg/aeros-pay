import Link from "next/link";
import { notFound } from "next/navigation";
import { getActingContext } from "@/lib/auth";
import {
  getMyResponse,
  getResponsesForRequest,
  getWantedRequestById,
  requesterWallet,
} from "@/lib/wanted";
import { sameWallet } from "@/lib/wallets";
import { WantedStatusBadge } from "@/components/status-badge";
import {
  CloseWantedButtons,
  RespondToWantedForm,
  WantedDecisionButtons,
  WithdrawWantedResponseButton,
} from "@/components/forms/marketplace-forms";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/datetime";

/**
 * One wanted request, its replies, and the one reply this wallet may send.
 *
 * Replies are only visible to the requester and to their own author: a request
 * is a call for offers, not a public auction, and showing everyone else's
 * quotes would turn it into one.
 */
export default async function WantedRequestPage({ params }: PageProps<"/market/wanted/[id]">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { id } = await params;
  const row = await getWantedRequestById(id);
  if (!row) notFound();

  const { request } = row;
  const isRequester = sameWallet(requesterWallet(request), ctx.wallet);
  const [responses, myResponse] = await Promise.all([
    isRequester ? getResponsesForRequest(request.id) : Promise.resolve([]),
    getMyResponse(request.id, ctx.wallet),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/market/wanted" className="text-sm text-muted hover:text-foreground">
          ← Wanted
        </Link>
      </div>

      <section className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{request.heading}</h1>
            <p className="mt-1 text-sm text-muted">
              {row.requesterLabel} (@{row.requesterHandle}) · {request.category}
            </p>
          </div>
          <WantedStatusBadge status={request.status} />
        </div>

        <p className="mt-4 whitespace-pre-wrap text-sm">{request.description}</p>

        <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted">Quantity wanted</dt>
          <dd>{request.quantity.toLocaleString()}</dd>
          <dt className="text-muted">Budget</dt>
          <dd className="font-medium">
            {request.budget.toLocaleString()} {CURRENCY_NAME}
          </dd>
          {request.deadline && (
            <>
              <dt className="text-muted">Needed by</dt>
              <dd>{formatDate(request.deadline)}</dd>
            </>
          )}
          <dt className="text-muted">Posted</dt>
          <dd>{formatDate(request.createdAt)}</dd>
          <dt className="text-muted">Lapses</dt>
          <dd>{formatDate(request.expiresAt)}</dd>
        </dl>
      </section>

      {isRequester ? (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted">
              Replies ({responses.length})
            </h2>
            {responses.length === 0 ? (
              <div className="card p-5">
                <p className="text-sm text-muted">Nobody has replied yet.</p>
              </div>
            ) : (
              <div className="card divide-y divide-border">
                {responses.map((r) => (
                  <div key={r.response.id} className="space-y-2 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">
                          {r.responderLabel}{" "}
                          <span className="text-sm font-normal text-muted">
                            (@{r.responderHandle})
                          </span>
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {formatDateTime(r.response.createdAt)}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        {r.response.offeredPrice !== null && (
                          <p className="font-medium">
                            {r.response.offeredPrice.toLocaleString()} {CURRENCY_NAME}
                          </p>
                        )}
                        <WantedStatusBadge status={r.response.status} />
                      </div>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{r.response.message}</p>
                    {r.response.status === "PENDING" && request.status === "OPEN" && (
                      <WantedDecisionButtons responseId={r.response.id} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {request.status === "OPEN" && (
            <section className="card p-5">
              <h2 className="font-medium">Close this request</h2>
              <p className="mt-1 text-sm text-muted">
                Accepting a reply does not move any Aeros. Pay the person or company directly, or
                ask them to invoice you.
              </p>
              <div className="mt-3">
                <CloseWantedButtons requestId={request.id} />
              </div>
            </section>
          )}
        </>
      ) : myResponse ? (
        <section className="card space-y-2 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="font-medium">Your reply</h2>
            <WantedStatusBadge status={myResponse.status} />
          </div>
          <p className="whitespace-pre-wrap text-sm">{myResponse.message}</p>
          {myResponse.offeredPrice !== null && (
            <p className="text-sm text-muted">
              You quoted {myResponse.offeredPrice.toLocaleString()} {CURRENCY_NAME}.
            </p>
          )}
          {myResponse.status === "PENDING" && (
            <WithdrawWantedResponseButton responseId={myResponse.id} />
          )}
          <p className="text-xs text-muted">Each party may reply once to a request.</p>
        </section>
      ) : request.status === "OPEN" ? (
        <RespondToWantedForm requestId={request.id} />
      ) : (
        <div className="card p-5">
          <p className="text-sm text-muted">
            This request is {request.status.toLowerCase()} and is no longer taking replies.
          </p>
        </div>
      )}
    </div>
  );
}
