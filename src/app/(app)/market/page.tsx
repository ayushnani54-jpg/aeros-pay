import Link from "next/link";
import { getActingContext } from "@/lib/auth";
import { browseOffers, listOfferCategories, expireOverdueOrders } from "@/lib/marketplace";
import { getLiveAd, runPromotionCharges } from "@/lib/promotions";
import {
  listPublicJobs,
  listUserJobApplications,
  listApplicationsForEmployer,
} from "@/lib/jobs";
import { MarketSearchBar } from "@/components/forms/marketplace-forms";
import { PromotionSlot } from "@/components/promotion-slot";
import {
  JobsAndMarketplaceTabs,
  type SerializedPublicJob,
  type SerializedUserApplication,
  type SerializedEmployerApplication,
} from "@/components/v5/jobs-and-marketplace-panel";
import { CURRENCY_NAME } from "@/lib/constants";
import { formatDate } from "@/lib/datetime";

export default async function MarketPage({ searchParams }: PageProps<"/market">) {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const params = await searchParams;
  const str = (key: string): string => {
    const value = params[key];
    return typeof value === "string" ? value : "";
  };

  const q = str("q");
  const category = str("category");
  const minPrice = str("minPrice");
  const maxPrice = str("maxPrice");
  const sortParam = str("sort");
  const sort =
    sortParam === "PRICE_ASC" || sortParam === "PRICE_DESC" ? sortParam : ("NEWEST" as const);
  const page = Math.max(Number.parseInt(str("page") || "1", 10) || 1, 1);

  await Promise.all([
    runPromotionCharges().catch(() => undefined),
    expireOverdueOrders().catch(() => undefined),
  ]);

  const [result, categories, ad, publicJobsRaw, myAppsRaw] = await Promise.all([
    browseOffers({
      q,
      category,
      minPrice: minPrice === "" ? null : Number(minPrice),
      maxPrice: maxPrice === "" ? null : Number(maxPrice),
      sort,
      page,
    }),
    listOfferCategories(),
    getLiveAd(),
    listPublicJobs(60).catch(() => []),
    listUserJobApplications(ctx.user.id).catch(() => []),
  ]);

  // Fetch employer applications across all companies owned by this citizen
  const employerAppsNested = await Promise.all(
    ctx.availableCompanies.map((comp) =>
      listApplicationsForEmployer({
        employerType: "COMPANY",
        employerCompanyId: comp.id,
      }).catch(() => []),
    ),
  );
  const employerAppsFlat = employerAppsNested.flat();

  const serializedPublicJobs: SerializedPublicJob[] = publicJobsRaw.map((r) => ({
    id: r.job.id,
    jobNumber: r.job.jobNumber,
    employerType: r.job.employerType,
    employerCompanyId: r.job.employerCompanyId,
    employerName: r.employerName,
    employerHandle: r.employerHandle,
    title: r.job.title,
    category: r.job.category,
    description: r.job.description,
    requirements: r.job.requirements,
    compensationAeros: r.job.compensationAeros,
    status: r.job.status,
    hiredUserId: r.job.hiredUserId,
    createdAt: r.job.createdAt.toISOString(),
  }));

  const serializedMyApps: SerializedUserApplication[] = myAppsRaw.map((r) => ({
    id: r.application.id,
    jobId: r.job.id,
    jobNumber: r.job.jobNumber,
    jobTitle: r.job.title,
    compensationAeros: r.job.compensationAeros,
    jobStatus: r.job.status,
    coverNote: r.application.coverNote,
    status: r.application.status,
    createdAt: r.application.createdAt.toISOString(),
  }));

  const serializedEmployerApps: SerializedEmployerApplication[] = employerAppsFlat.map((r) => ({
    id: r.application.id,
    jobId: r.job.id,
    jobNumber: r.job.jobNumber,
    jobTitle: r.job.title,
    jobStatus: r.job.status,
    compensationAeros: r.job.compensationAeros,
    employerCompanyId: r.job.employerCompanyId,
    applicantUsername: r.applicantUsername,
    applicantDisplayName: r.applicantDisplayName,
    coverNote: r.application.coverNote,
    status: r.application.status,
    createdAt: r.application.createdAt.toISOString(),
  }));

  function pageHref(target: number): string {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (category) sp.set("category", category);
    if (minPrice) sp.set("minPrice", minPrice);
    if (maxPrice) sp.set("maxPrice", maxPrice);
    if (sort !== "NEWEST") sp.set("sort", sort);
    sp.set("page", String(target));
    return `/market?${sp.toString()}`;
  }

  const publicListingsNode = (
    <div className="space-y-4">
      <PromotionSlot ad={ad} />

      <MarketSearchBar
        categories={categories}
        initial={{ q, category, minPrice, maxPrice, sort }}
      />

      <p className="text-xs text-muted">
        {result.total === 0
          ? "No listings matched."
          : `${result.total.toLocaleString()} listing${result.total === 1 ? "" : "s"} · page ${result.page} of ${result.pageCount}`}
      </p>

      {result.rows.length === 0 ? (
        <div className="card p-6">
          <p className="text-sm text-muted">
            Nothing here yet.{" "}
            {ctx.availableCompanies.length > 0 ? (
              <>
                <Link href="/my-company/offers" className="underline">
                  Add a listing
                </Link>{" "}
                for your own company.
              </>
            ) : (
              "Companies list goods and services here once they are approved."
            )}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {result.rows.map(({ offer, companyName, companyUsername }) => (
            <div key={offer.id} className="card p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/market/offers/${offer.id}`}
                    className="font-semibold hover:underline"
                  >
                    {offer.title}
                  </Link>
                  <p className="text-xs text-muted sm:text-sm">
                    {companyName} (@{companyUsername})
                  </p>
                  <p className="mt-1 text-xs text-muted">{offer.category}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-lg font-semibold">
                    {offer.unitPrice.toLocaleString()}{" "}
                    <span className="text-xs font-medium text-muted">{CURRENCY_NAME}</span>
                  </p>
                  <p className="text-xs text-muted">
                    {offer.quantityAvailable === null
                      ? "Unlimited"
                      : offer.quantityAvailable === 0
                        ? "Out of stock"
                        : `${offer.quantityAvailable.toLocaleString()} left`}
                  </p>
                </div>
              </div>
              <p className="mt-3 line-clamp-3 text-sm">{offer.description}</p>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5 text-xs text-muted">
                <span>Listed {formatDate(offer.createdAt)}</span>
                <Link
                  href={`/market/offers/${offer.id}`}
                  className="font-semibold text-foreground hover:underline"
                >
                  View &amp; Order →
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {result.pageCount > 1 && (
        <div className="flex items-center justify-between gap-3">
          {result.page > 1 ? (
            <Link href={pageHref(result.page - 1)} className="btn btn-secondary text-sm">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted">
            Page {result.page} of {result.pageCount}
          </span>
          {result.page < result.pageCount ? (
            <Link href={pageHref(result.page + 1)} className="btn btn-secondary text-sm">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}

      <p className="text-xs text-muted">
        Looking to buy or sell an entire business?{" "}
        <Link href="/marketplace" className="underline">
          Companies for sale
        </Link>{" "}
        is available separately.
      </p>
    </div>
  );

  return (
    <JobsAndMarketplaceTabs
      publicListingsNode={publicListingsNode}
      publicJobs={serializedPublicJobs}
      myApplications={serializedMyApps}
      employerApplications={serializedEmployerApps}
      ownedCompanies={ctx.availableCompanies.map((c) => ({
        id: c.id,
        name: c.name,
        username: c.username,
        balance: c.balance,
      }))}
      currentUserId={ctx.user.id}
    />
  );
}
