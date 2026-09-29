import { getPromotionPolicy, listCampaigns, runPromotionCharges } from "@/lib/promotions";
import { PromotionStatusBadge } from "@/components/status-badge";
import {
  GovOfficialPromotionForm,
  GovPromotionActions,
  GovPromotionPolicyForm,
} from "@/components/forms/gov-marketplace-forms";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/datetime";

/**
 * PROMOTIONS — the Government panel (spec §24).
 *
 * Three jobs: set the policy (master switch and daily rate), review company
 * requests, and run the Government's own official promotions, which carry no
 * company and no charge.
 *
 * Approving a campaign FREEZES the current daily rate onto it, so changing the
 * rate here never re-prices a campaign that is already approved or running.
 */
export default async function GovPromotionsPage() {
  await runPromotionCharges().catch(() => undefined);

  const [policy, campaigns] = await Promise.all([getPromotionPolicy(), listCampaigns("ALL", 100)]);

  const pending = campaigns.filter((c) => c.campaign.status === "PENDING");
  const live = campaigns.filter((c) =>
    ["APPROVED", "ACTIVE", "PAUSED"].includes(c.campaign.status),
  );
  const past = campaigns.filter((c) =>
    ["REJECTED", "CANCELLED", "COMPLETED"].includes(c.campaign.status),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Promotions</h1>
        <p className="mt-1 text-sm text-muted">
          One promotion runs across Aeros Pay at a time. A company campaign is charged its frozen
          daily rate once per IST calendar day; a Government promotion is free.
        </p>
      </div>

      <section className="card p-5">
        <h2 className="mb-3 font-medium">Promotion policy</h2>
        <GovPromotionPolicyForm enabled={policy.enabled} dailyRate={policy.dailyRate} />
        {policy.updatedAt && (
          <p className="mt-2 text-xs text-muted">
            Last changed {formatDateTime(policy.updatedAt)}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted">
          Awaiting review ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">Nothing waiting.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {pending.map((row) => (
              <CampaignRowView key={row.campaign.id} row={row} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted">Approved and running ({live.length})</h2>
        {live.length === 0 ? (
          <div className="card p-5">
            <p className="text-sm text-muted">Nothing approved or running.</p>
          </div>
        ) : (
          <div className="card divide-y divide-border">
            {live.map((row) => (
              <CampaignRowView key={row.campaign.id} row={row} />
            ))}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h2 className="mb-1 font-medium">Official Government promotion</h2>
        <p className="mb-3 text-sm text-muted">
          New Player Bonus, Government Demand or Limited Opportunity. No company is billed and no
          Aeros move — the Treasury does not charge itself.
        </p>
        <GovOfficialPromotionForm />
      </section>

      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted">Finished ({past.length})</h2>
          <div className="card divide-y divide-border">
            {past.map((row) => (
              <CampaignRowView key={row.campaign.id} row={row} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function CampaignRowView({
  row,
}: {
  row: Awaited<ReturnType<typeof listCampaigns>>[number];
}) {
  const c = row.campaign;
  return (
    <div className="space-y-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{c.heading}</p>
          <p className="text-sm text-muted">{c.shortDescription}</p>
          <p className="mt-1 text-xs text-muted">
            {row.companyName ? `${row.companyName} (@${row.companyUsername})` : "Government"}
            {row.offerTitle ? ` · ${row.offerTitle}` : ""} · {c.requestedDurationDays} days ·{" "}
            {c.dailyRate.toLocaleString()} {CURRENCY_NAME}/day
          </p>
          <p className="mt-1 font-mono text-xs text-muted">{c.destination}</p>
          <p className="mt-1 text-xs text-muted">
            Requested {formatDate(c.createdAt)}
            {c.reviewedAt ? ` · reviewed ${formatDate(c.reviewedAt)} by ${c.reviewedBy}` : ""}
            {c.totalCharged > 0
              ? ` · charged ${c.totalCharged.toLocaleString()} ${CURRENCY_NAME} so far`
              : ""}
            {c.lastChargedOn ? ` · last charged ${c.lastChargedOn} IST` : ""}
          </p>
          {c.rejectionReason && (
            <p className="mt-1 text-xs text-danger">Reason: {c.rejectionReason}</p>
          )}
        </div>
        <PromotionStatusBadge status={c.status} />
      </div>
      <GovPromotionActions
        campaignId={c.id}
        status={c.status}
        isOfficial={c.companyId === null}
      />
    </div>
  );
}
