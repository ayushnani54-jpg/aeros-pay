import { notFound, redirect } from "next/navigation";
import { getCurrentGovernment } from "@/lib/auth";
import { db, ensureV5SchemaMigrated } from "@/db/client";
import { government } from "@/db/schema";
import { AerosLogo } from "@/components/logo";
import { GovLoginForm } from "@/components/forms/gov-login-form";

export default async function ProtectedGovernmentAccessPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  await ensureV5SchemaMigrated();
  const [gov] = await db
    .select({ accessPathCode: government.accessPathCode })
    .from(government)
    .limit(1);

  const expectedCode = gov?.accessPathCode || "2027";

  if (!code || code !== expectedCode) {
    notFound();
  }

  const currentGov = await getCurrentGovernment();
  if (currentGov) {
    redirect("/gov");
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <AerosLogo size={40} />
          <h1 className="mt-4 text-xl font-semibold">Government Authority Gateway</h1>
          <p className="mt-1 text-center text-sm text-muted">
            Authenticated administrative access for the central Aeros Pay sovereign authority.
          </p>
        </div>
        <div className="card p-6 shadow-sm">
          <GovLoginForm pathCode={code} />
        </div>
      </div>
    </div>
  );
}
