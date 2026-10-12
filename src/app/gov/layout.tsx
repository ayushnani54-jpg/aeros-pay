import { redirect } from "next/navigation";
import { getCurrentGovernment } from "@/lib/auth";
import { GovNavbar } from "@/components/gov-nav";
import { getPendingCompanyCount } from "@/lib/queries";
import { getUnreadSupportCountForGovernment } from "@/lib/support";
import { getOpenComplaintCount } from "@/lib/ip";
import { getLoanCounts } from "@/lib/loans";
import { GlobalActionFeedbackProvider } from "@/components/v5/action-feedback";
import { getV5RepositoriesStorageStatus } from "@/lib/archive";

export default async function GovLayout({ children }: LayoutProps<"/gov">) {
  const gov = await getCurrentGovernment();
  if (!gov) redirect("/government/login");

  // Counted in parallel so the extra context costs one round trip, not four.
  const [pendingCompanies, unreadSupport, openComplaints, loanCounts, storageStatus] =
    await Promise.all([
      getPendingCompanyCount().catch(() => 0),
      getUnreadSupportCountForGovernment().catch(() => 0),
      getOpenComplaintCount().catch(() => 0),
      getLoanCounts().catch(() => ({ pending: 0, overdueInstalments: 0 })),
      getV5RepositoriesStorageStatus().catch(() => null),
    ]);

  const storageAlertsCount =
    (storageStatus?.warningCount ?? 0) + (storageStatus?.criticalCount ?? 0);

  const alerts =
    pendingCompanies +
    unreadSupport +
    openComplaints +
    loanCounts.pending +
    loanCounts.overdueInstalments +
    storageAlertsCount;

  const storageAlertNotice =
    storageStatus && storageStatus.hasStorageAlerts
      ? `GitHub Archive Storage Alert: ${storageStatus.criticalCount} Critical (>=900 MB) and ${storageStatus.warningCount} Warning (>=800 MB) repositories detected across the 15-repository registry. Visit Archive Center to inspect continuation rollover.`
      : null;

  return (
    <div className="flex min-h-screen flex-col">
      <GovNavbar alerts={alerts} />
      <GlobalActionFeedbackProvider storageAlertNotice={storageAlertNotice}>
        <main className="mx-auto w-full max-w-6xl flex-1 px-3 py-5 sm:px-6 sm:py-6">
          {children}
        </main>
      </GlobalActionFeedbackProvider>
    </div>
  );
}

