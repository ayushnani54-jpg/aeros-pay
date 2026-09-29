import Link from "next/link";
import { db } from "@/db/client";
import {
  contractPayableAmount,
  expireOverdueContracts,
  getApplicationsForContract,
  getContractsForIssuer,
} from "@/lib/contracts";
import { ContractStatusBadge, InvoiceStatusBadge } from "@/components/status-badge";
import {
  GovAwardContractButton,
  GovCancelContractButton,
  GovCreateContractForm,
  GovPayContractButton,
} from "@/components/forms/gov-marketplace-forms";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate } from "@/lib/datetime";

/**
 * GOVERNMENT CONTRACTS (spec §17).
 *
 * The Treasury puts work out to tender, awards one applicant, and settles it —
 * by paying a person directly, or by paying the invoice the awarded COMPANY
 * raises, which lands in that company's wallet through the same settlement
 * guarantee as everything else.
 */
export default async function GovContractsPage() {
  await expireOverdueContracts().catch(() => undefined);

  const contracts = await getContractsForIssuer({ type: "GOVERNMENT" }, 100);

  const withDetail = await Promise.all(
    contracts.map(async (row) => ({
      row,
      applications:
        row.contract.status === "OPEN" || row.contract.status === "AWARDED"
          ? await getApplicationsForContract(row.contract.id)
          : [],
      payable:
        row.contract.status === "AWARDED"
          ? await contractPayableAmount(db, row.contract).catch(() => null)
          : null,
    })),
  );

  const open = withDetail.filter((c) => c.row.contract.status === "OPEN");
  const awarded = withDetail.filter((c) => c.row.contract.status === "AWARDED");
  const done = withDetail.filter(
    (c) => !["OPEN", "AWARDED"].includes(c.row.contract.status),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Government contracts</h1>
        <p className="mt-1 text-sm text-muted">
          Work the Treasury needs done. Anyone eligible may apply once; one applicant is awarded
          and paid from the treasury.
        </p>
      </div>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Put work out to tender</h2>
        <GovCreateContractForm />
      </section>

      <ContractSection title="Open for applications" items={open} />
      <ContractSection title="Awarded, awaiting settlement" items={awarded} />
      <ContractSection title="Closed" items={done} />
    </div>
  );
}

type Item = {
  row: Awaited<ReturnType<typeof getContractsForIssuer>>[number];
  applications: Awaited<ReturnType<typeof getApplicationsForContract>>;
  payable: number | null;
};

function ContractSection({ title, items }: { title: string; items: Item[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted">
        {title} ({items.length})
      </h2>
      {items.length === 0 ? (
        <div className="card p-5">
          <p className="text-sm text-muted">Nothing here.</p>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {items.map(({ row, applications, payable }) => (
            <div key={row.contract.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/market/contracts/${row.contract.id}`}
                    className="font-medium hover:underline"
                  >
                    {row.contract.title}
                  </Link>
                  <p className="text-sm text-muted">
                    <span className="font-mono">{row.contract.contractNumber}</span> · budget{" "}
                    {row.contract.budget.toLocaleString()} {CURRENCY_NAME}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Published {formatDate(row.contract.createdAt)}
                    {row.contract.deadline
                      ? ` · deadline ${formatDate(row.contract.deadline)}`
                      : ""}
                    {row.awardedToLabel ? ` · awarded to ${row.awardedToLabel}` : ""}
                  </p>
                  {row.invoiceNumber && (
                    <p className="mt-1 text-xs text-muted">
                      Invoice{" "}
                      <Link href={`/invoices/${row.contract.invoiceId}`} className="underline">
                        {row.invoiceNumber}
                      </Link>
                      {row.invoiceTotal !== null
                        ? ` · ${row.invoiceTotal.toLocaleString()} ${CURRENCY_NAME}`
                        : ""}
                    </p>
                  )}
                  {row.contract.paidTxRef && (
                    <p className="mt-1 font-mono text-xs text-muted">
                      Ref {row.contract.paidTxRef}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <ContractStatusBadge status={row.contract.status} />
                  {row.invoiceStatus && (
                    <InvoiceStatusBadge
                      status={row.invoiceStatus as "PENDING" | "PAID" | "CANCELLED" | "EXPIRED"}
                    />
                  )}
                </div>
              </div>

              {applications.length > 0 && (
                <div className="space-y-2 rounded-md bg-surface p-3">
                  <p className="text-xs font-medium text-muted">
                    {applications.length} application{applications.length === 1 ? "" : "s"}
                  </p>
                  {applications.map((a) => (
                    <div
                      key={a.application.id}
                      className="flex flex-wrap items-start justify-between gap-2 border-t border-border pt-2 first:border-t-0 first:pt-0"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {a.applicantLabel}{" "}
                          <span className="font-normal text-muted">(@{a.applicantHandle})</span>
                        </p>
                        <p className="text-xs text-muted">{a.application.proposal}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm">
                          {(a.application.quotedPrice ?? row.contract.budget).toLocaleString()}{" "}
                          {CURRENCY_NAME}
                        </p>
                        {row.contract.status === "OPEN" &&
                          a.application.status === "PENDING" && (
                            <GovAwardContractButton
                              contractId={row.contract.id}
                              applicationId={a.application.id}
                            />
                          )}
                        {a.application.status !== "PENDING" && (
                          <ContractStatusBadge status={a.application.status} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-start gap-2">
                {row.contract.status === "AWARDED" &&
                  row.contract.awardedToType === "USER" &&
                  payable !== null && (
                    <GovPayContractButton contractId={row.contract.id} amount={payable} />
                  )}
                {row.contract.status === "AWARDED" &&
                  row.contract.awardedToType === "COMPANY" &&
                  !row.contract.invoiceId && (
                    <p className="text-xs text-muted">
                      Waiting for {row.awardedToLabel} to raise their invoice.
                    </p>
                  )}
                {row.contract.status === "AWARDED" &&
                  row.contract.invoiceId &&
                  row.invoiceStatus === "PENDING" && (
                    <Link
                      href={`/invoices/${row.contract.invoiceId}`}
                      className="btn btn-primary text-xs"
                    >
                      Open the invoice to pay
                    </Link>
                  )}
                {["OPEN", "AWARDED"].includes(row.contract.status) &&
                  !row.contract.invoiceId && (
                    <GovCancelContractButton contractId={row.contract.id} />
                  )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
