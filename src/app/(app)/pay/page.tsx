import { getActingContext } from "@/lib/auth";
import { db } from "@/db/client";
import { resolveEffectiveTaxRateBp } from "@/lib/taxmatrix";
import { userWallet } from "@/lib/wallets";
import { PayForm } from "@/components/forms/pay-form";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatTaxRateBp } from "@/lib/tax";
import { effectiveUserStatus } from "@/lib/status";

export default async function PayPage({ searchParams }: PageProps<"/pay">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const params = await searchParams;
  const prefill = typeof params.to === "string" ? params.to : undefined;

  // The headline rate comes from the ONE resolver (src/lib/taxmatrix.ts) for the
  // wallet the viewer is actually acting as, so it already reflects any matrix
  // cell the Government has configured. It is a hint only: the authoritative
  // figure for a specific payment is quoted by the server on the confirm step.
  const hintRateBp = await resolveEffectiveTaxRateBp(db, {
    payer: ctx.wallet,
    recipient: userWallet(ctx.user.id),
    context: "DIRECT_TRANSFER",
  });

  const status = effectiveUserStatus(ctx.user);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Pay</h1>
        <p className="mt-1 text-sm text-muted">
          {ctx.company
            ? `Paying as ${ctx.company.name} — tax on a payment to a person is ${formatTaxRateBp(hintRateBp)}`
            : `Current tax rate: ${formatTaxRateBp(hintRateBp)} (a payment of exactly 1 ${CURRENCY_NAME} is always tax-free)`}
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
          prefillRecipient={prefill}
        />
      )}
    </div>
  );
}
