import { getActingContext } from "@/lib/auth";
import { getGovernmentSingleton } from "@/lib/queries";
import { resolveCompanyTaxRateBp } from "@/lib/companies";
import { PayForm } from "@/components/forms/pay-form";
import { CURRENCY_NAME } from "@/lib/constants";
import { effectiveUserStatus } from "@/lib/status";

export default async function PayPage({ searchParams }: PageProps<"/pay">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const params = await searchParams;
  const prefill = typeof params.to === "string" ? params.to : undefined;

  const gov = await getGovernmentSingleton();
  const personalTaxPercent = (gov?.taxRateBp ?? 500) / 100;
  const companyTaxPercent = ctx.company
    ? (await resolveCompanyTaxRateBp(ctx.company)) / 100
    : (gov?.companyTaxRateBp ?? 500) / 100;

  const status = effectiveUserStatus(ctx.user);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pay</h1>
        <p className="mt-1 text-sm text-muted">
          {ctx.company
            ? `Company tax rate: ${companyTaxPercent.toFixed(2)}%`
            : `Current tax rate: ${personalTaxPercent.toFixed(2)}% (a payment of exactly 1 ${CURRENCY_NAME} is always tax-free)`}
        </p>
      </div>

      {status === "SUSPENDED" ? (
        <div className="card p-6">
          <p className="font-medium">Payments are paused</p>
          <p className="mt-1 text-sm text-muted">
            Your account is suspended, so you cannot send Aeros right now. You can still receive
            payments and view your history.
          </p>
        </div>
      ) : (
        <PayForm
          walletLabel={ctx.displayLabel}
          walletHandle={ctx.handle}
          balance={ctx.balance}
          personalTaxPercent={personalTaxPercent}
          companyTaxPercent={companyTaxPercent}
          isCompanyContext={ctx.company !== null}
          prefillRecipient={prefill}
        />
      )}
    </div>
  );
}
