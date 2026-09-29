import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { getOffersForCompany } from "@/lib/marketplace";
import {
  getCampaignsForCompany,
  getPromotionPolicy,
  runPromotionCharges,
} from "@/lib/promotions";
import { PromotionStatusBadge } from "@/components/status-badge";
import {
  ActivatePromotionButton,
  CancelPromotionButton,
  PausePromotionButton,
  RequestPromotionForm,
} from "@/components/forms/marketplace-forms";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate, formatDateTime } from "@/lib/datetime";

/**
 * PROMOTIONS — the company's side (spec §24).
 *
 * One ad slot exists across the whole app, so a campaign can be APPROVED and
 * still have to wait for the slot. Activation asks; the database answers, and a
 * refusal arrives here as an ordinary message rather than a crash.
 *
 * The daily charge runs lazily on page loads, including this one. It is claimed
 * by a single conditional UPDATE keyed on the IST calendar day, so opening this
 * page ten times today still bills once.
 */
export default async function CompanyPromotionsPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const company = ctx.company ?? ctx.availableCompanies[0] ?? null;
  if (!company) {
    return (
      <div className="card p-6">
        <p className="text-sm text-muted">
          You need an approved company to run a promotion.{" "}
          <Link href="/my-company" className="underline">
            Apply for one
          </Link>
          .
        </p>
      </div>
    );
  }

  await runPromotionCharges().catch(() => undefined);

  const [campaigns, offers, policy] = await Promise.all([
    getCampaignsForCompany(company.id),
    getOffersForCompany(company.id, 200),
    getPromotionPolicy(),
  ]);

  const activeOffers = offers
    .filter((o) => o.status === "ACTIVE")
    .map((o) => ({ id: o.id, title: o.title }));
  const live = campaigns.find((c) =>
    ["PENDING", "APPROVED", "ACTIVE", "PAUSED"].includes(c.status),
  );
  const isActingAsThisCompany = ctx.company?.id === company.id;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/my-company" className="text-sm text-muted hover:text-foreground">
          ← {company.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Promotions</h1>
        <p className="mt-1 text-sm text-muted">
          Advertise one of your listings in the single Aeros Pay ad slot.
          {policy.enabled
            ? ` The Government's rate is ${policy.dailyRate.toLocaleString()} ${CURRENCY_NAME} per day.`
            : " The Government has paused promotions for now."}
        </p>
      </div>

      {campaigns.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted">Your campaigns</h2>
          <div className="card divide-y divide-border">
            {campaigns.map((c) => (
              <div key={c.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{c.heading}</p>
                    <p className="text-sm text-muted">{c.shortDescription}</p>
                    <p className="mt-1 text-xs text-muted">
                      {c.dailyRate.toLocaleString()} {CURRENCY_NAME}/day ·{" "}
                      {c.requestedDurationDays} day run · charged so far{" "}
                      {c.totalCharged.toLocaleString()} {CURRENCY_NAME}
                    </p>
                    {c.lastChargedOn && (
                      <p className="mt-1 text-xs text-muted">
                        Last charged for {c.lastChargedOn} (IST)
                      </p>
                    )}
                    {c.activatedAt && c.expiresAt && (
                      <p className="mt-1 text-xs text-muted">
                        Running {formatDate(c.activatedAt)} → {formatDate(c.expiresAt)}
                      </p>
                    )}
                    {c.status === "PAUSED" && c.pausedAt && (
                      <p className="mt-1 text-xs text-muted">
                        Paused {formatDateTime(c.pausedAt)}. Resume it once the company wallet can
                        cover the daily charge.
                      </p>
                    )}
                    {c.rejectionReason && (
                      <p className="mt-1 text-xs text-danger">Rejected: {c.rejectionReason}</p>
                    )}
                  </div>
                  <PromotionStatusBadge status={c.status} />
                </div>

                {isActingAsThisCompany && (
                  <div className="flex flex-wrap items-start gap-2">
                    {(c.status === "APPROVED" || c.status === "PAUSED") && (
                      <ActivatePromotionButton campaignId={c.id} />
                    )}
                    {c.status === "ACTIVE" && <PausePromotionButton campaignId={c.id} />}
                    {["PENDING", "APPROVED", "ACTIVE", "PAUSED"].includes(c.status) && (
                      <CancelPromotionButton campaignId={c.id} />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {!isActingAsThisCompany ? (
        <div className="card p-5">
          <p className="text-sm text-muted">
            Switch to {company.name} from your dashboard to manage its promotions.
          </p>
        </div>
      ) : live ? (
        <div className="card p-5">
          <p className="text-sm text-muted">
            {company.name} already has a {live.status.toLowerCase()} campaign. Finish or cancel it
            before requesting another.
          </p>
        </div>
      ) : !policy.enabled ? (
        <div className="card p-5">
          <p className="text-sm text-muted">
            Promotions are switched off by the Government at the moment.
          </p>
        </div>
      ) : (
        <RequestPromotionForm offers={activeOffers} dailyRate={policy.dailyRate} />
      )}

      <p className="text-xs text-muted">
        Nothing about who sees or dismisses an ad is recorded — there are no impression, click or
        dismissal counts anywhere in Aeros Pay.
      </p>
    </div>
  );
}
