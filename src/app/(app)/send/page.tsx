import { getGovernmentSingleton } from "@/lib/queries";
import { SendAerosForm } from "@/components/forms/send-aeros-form";
import { formatTaxRateBp } from "@/lib/tax";

export default async function SendPage() {
  const gov = await getGovernmentSingleton();
  const taxRatePercent = gov ? gov.taxRateBp / 100 : 0;

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Send Aeros</h1>
        <p className="mt-1 text-sm text-muted">
          Current tax rate: {gov ? formatTaxRateBp(gov.taxRateBp) : "—"} (a payment of exactly 1
          Aeros is always tax-free)
        </p>
      </div>
      <SendAerosForm taxRatePercent={taxRatePercent} />
    </div>
  );
}
