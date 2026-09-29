import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { getActingContext } from "@/lib/auth";
import {
  contractPayableAmount,
  getApplicationsForContract,
  getContractById,
  getMyApplication,
} from "@/lib/contracts";
import { ContractStatusBadge, InvoiceStatusBadge } from "@/components/status-badge";
import {
  ApplyForContractForm,
  AwardContractButton,
  CancelContractButton,
  IssueContractInvoiceForm,
  PayContractToUserButton,
  WithdrawContractApplicationButton,
} from "@/components/forms/marketplace-forms";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/datetime";

/**
 * One contract: its terms, its applications (visible to the issuer and to each
 * applicant for their own), and the award → invoice → payment → completion
 * steps for whoever is entitled to take them.
 *
 * The payable amount shown for an awarded contract is `contractPayableAmount`,
 * the same server function the payment itself uses, so the figure on the button
 * is the figure that will move.
 */
export default async function ContractPage({ params }: PageProps<"/market/contracts/[id]">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const { id } = await params;
  const row = await getContractById(id);
  if (!row) notFound();

  const { contract } = row;

  const isIssuingCompany =
    contract.issuerType === "COMPANY" &&
    ctx.wallet.kind === "COMPANY" &&
    ctx.wallet.id === contract.issuerCompanyId;

  const isAwardedToMe =
    (contract.awardedToType === "USER" &&
      ctx.wallet.kind === "USER" &&
      ctx.wallet.id === contract.awardedToUserId) ||
    (contract.awardedToType === "COMPANY" &&
      ctx.wallet.kind === "COMPANY" &&
      ctx.wallet.id === contract.awardedToCompanyId);

  const [applications, myApplication] = await Promise.all([
    isIssuingCompany ? getApplicationsForContract(contract.id) : Promise.resolve([]),
    getMyApplication(contract.id, ctx.wallet),
  ]);

  const payable =
    contract.status === "AWARDED" || contract.status === "COMPLETED"
      ? await contractPayableAmount(db, contract).catch(() => null)
      : null;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/market/contracts" className="text-sm text-muted hover:text-foreground">
          ← Contracts
        </Link>
      </div>

      <section className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{contract.title}</h1>
            <p className="mt-1 text-sm text-muted">
              {row.issuerLabel} · <span className="font-mono">{contract.contractNumber}</span>
            </p>
          </div>
          <ContractStatusBadge status={contract.status} />
        </div>

        <div className="mt-4 space-y-3 text-sm">
          <div>
            <p className="text-muted">Requirement</p>
            <p className="mt-1 whitespace-pre-wrap">{contract.requirement}</p>
          </div>
          <div>
            <p className="text-muted">Description</p>
            <p className="mt-1 whitespace-pre-wrap">{contract.description}</p>
          </div>
          {contract.conditions && (
            <div>
              <p className="text-muted">Conditions</p>
              <p className="mt-1 whitespace-pre-wrap">{contract.conditions}</p>
            </div>
          )}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-muted">Budget</dt>
          <dd className="font-medium">
            {contract.budget.toLocaleString()} {CURRENCY_NAME}
          </dd>
          {contract.deadline && (
            <>
              <dt className="text-muted">Deadline</dt>
              <dd>{formatDate(contract.deadline)}</dd>
            </>
          )}
          <dt className="text-muted">Published</dt>
          <dd>{formatDate(contract.createdAt)}</dd>
          {contract.status === "OPEN" && (
            <>
              <dt className="text-muted">Applications close</dt>
              <dd>{formatDate(contract.expiresAt)}</dd>
            </>
          )}
          {row.awardedToLabel && (
            <>
              <dt className="text-muted">Awarded to</dt>
              <dd>{row.awardedToLabel}</dd>
            </>
          )}
          {payable !== null && (
            <>
              <dt className="text-muted">Agreed price</dt>
              <dd className="font-medium">
                {payable.toLocaleString()} {CURRENCY_NAME}
              </dd>
            </>
          )}
          {contract.paidTxRef && (
            <>
              <dt className="text-muted">Payment reference</dt>
              <dd className="font-mono text-xs">{contract.paidTxRef}</dd>
            </>
          )}
        </dl>
      </section>

      {contract.invoiceId && row.invoiceNumber && (
        <section className="card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-medium">Invoice {row.invoiceNumber}</h2>
              {row.invoiceTotal !== null && (
                <p className="mt-1 text-sm text-muted">
                  {row.invoiceTotal.toLocaleString()} {CURRENCY_NAME} payable.
                </p>
              )}
            </div>
            {row.invoiceStatus && (
              <InvoiceStatusBadge
                status={row.invoiceStatus as "PENDING" | "PAID" | "CANCELLED" | "EXPIRED"}
              />
            )}
          </div>
          <Link
            href={`/invoices/${contract.invoiceId}`}
            className="btn btn-primary mt-3 inline-block text-sm"
          >
            View the invoice
          </Link>
        </section>
      )}

      {/* The awarded party's next step. */}
      {isAwardedToMe && contract.status === "AWARDED" && !contract.invoiceId && (
        <section className="card space-y-3 p-5">
          <h2 className="font-medium">You were awarded this contract</h2>
          {ctx.wallet.kind === "COMPANY" ? (
            <>
              <p className="text-sm text-muted">
                Raise the invoice on {row.issuerLabel}. Paying it completes the contract and the
                Aeros land in your company wallet.
              </p>
              <IssueContractInvoiceForm contractId={contract.id} />
            </>
          ) : (
            <p className="text-sm text-muted">
              {row.issuerLabel} pays you directly — people do not issue invoices. You will be
              notified when the payment lands.
            </p>
          )}
        </section>
      )}

      {/* The issuing company's next step. */}
      {isIssuingCompany && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted">
            Applications ({applications.length})
          </h2>
          {applications.length === 0 ? (
            <div className="card p-5">
              <p className="text-sm text-muted">Nobody has applied yet.</p>
            </div>
          ) : (
            <div className="card divide-y divide-border">
              {applications.map((a) => (
                <div key={a.application.id} className="space-y-2 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {a.applicantLabel}{" "}
                        <span className="text-sm font-normal text-muted">
                          (@{a.applicantHandle})
                        </span>
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {formatDateTime(a.application.createdAt)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-medium">
                        {(a.application.quotedPrice ?? contract.budget).toLocaleString()}{" "}
                        {CURRENCY_NAME}
                        {a.application.quotedPrice === null && (
                          <span className="ml-1 text-xs font-normal text-muted">(budget)</span>
                        )}
                      </p>
                      <ContractStatusBadge status={a.application.status} />
                    </div>
                  </div>
                  <p className="whitespace-pre-wrap text-sm">{a.application.proposal}</p>
                  {contract.status === "OPEN" && a.application.status === "PENDING" && (
                    <AwardContractButton
                      contractId={contract.id}
                      applicationId={a.application.id}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {contract.status === "AWARDED" &&
            contract.awardedToType === "USER" &&
            payable !== null && (
              <div className="card space-y-3 p-5">
                <h2 className="font-medium">Pay the awarded person</h2>
                <p className="text-sm text-muted">
                  This pays {row.awardedToLabel} from your company wallet and completes the
                  contract. The amount comes from their accepted application.
                </p>
                <PayContractToUserButton contractId={contract.id} amount={payable} />
              </div>
            )}

          {(contract.status === "OPEN" || contract.status === "AWARDED") &&
            !contract.invoiceId && (
              <div className="card p-5">
                <h2 className="font-medium">Withdraw this contract</h2>
                <p className="mt-1 text-sm text-muted">
                  Cancelling leaves the contract on record; it is never deleted.
                </p>
                <div className="mt-3">
                  <CancelContractButton contractId={contract.id} />
                </div>
              </div>
            )}
        </section>
      )}

      {/* An applicant's own view. */}
      {!isIssuingCompany && myApplication && (
        <section className="card space-y-2 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="font-medium">Your application</h2>
            <ContractStatusBadge status={myApplication.status} />
          </div>
          <p className="whitespace-pre-wrap text-sm">{myApplication.proposal}</p>
          <p className="text-sm text-muted">
            You quoted{" "}
            {(myApplication.quotedPrice ?? contract.budget).toLocaleString()} {CURRENCY_NAME}
            {myApplication.quotedPrice === null ? " (the contract's budget)" : ""}.
          </p>
          {myApplication.status === "PENDING" && contract.status === "OPEN" && (
            <WithdrawContractApplicationButton applicationId={myApplication.id} />
          )}
          <p className="text-xs text-muted">Each party may apply once to a contract.</p>
        </section>
      )}

      {!isIssuingCompany && !myApplication && contract.status === "OPEN" && (
        <ApplyForContractForm contractId={contract.id} />
      )}

      {contract.issuerType === "GOVERNMENT" && (
        <p className="text-xs text-muted">
          This contract was issued by the Government. Awarding and Treasury payment happen from
          the Government panel.
        </p>
      )}
    </div>
  );
}
