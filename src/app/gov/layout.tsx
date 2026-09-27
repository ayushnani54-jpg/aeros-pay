import { redirect } from "next/navigation";
import { getCurrentGovernment } from "@/lib/auth";
import { GovNavbar } from "@/components/gov-nav";
import { getPendingCompanyCount } from "@/lib/queries";
import { getUnreadSupportCountForGovernment } from "@/lib/support";
import { getOpenComplaintCount } from "@/lib/ip";
import { getLoanCounts } from "@/lib/loans";

export default async function GovLayout({ children }: LayoutProps<"/gov">) {
  const gov = await getCurrentGovernment();
  if (!gov) redirect("/government/login");

  // Counted in parallel so the extra context costs one round trip, not four.
  const [pendingCompanies, unreadSupport, openComplaints, loanCounts] = await Promise.all([
    getPendingCompanyCount().catch(() => 0),
    getUnreadSupportCountForGovernment().catch(() => 0),
    getOpenComplaintCount().catch(() => 0),
    getLoanCounts().catch(() => ({ pending: 0, overdueInstalments: 0 })),
  ]);

  const alerts =
    pendingCompanies +
    unreadSupport +
    openComplaints +
    loanCounts.pending +
    loanCounts.overdueInstalments;

  return (
    <div className="flex min-h-screen flex-col">
      <GovNavbar alerts={alerts} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
