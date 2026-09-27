import { redirect } from "next/navigation";
import { getCurrentGovernment } from "@/lib/auth";
import { GovNavbar } from "@/components/gov-nav";

export default async function GovLayout({ children }: LayoutProps<"/gov">) {
  const gov = await getCurrentGovernment();
  if (!gov) redirect("/government/login");

  return (
    <div className="flex min-h-screen flex-col">
      <GovNavbar />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
