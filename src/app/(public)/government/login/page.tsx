import { redirect } from "next/navigation";
import { getCurrentGovernment } from "@/lib/auth";
import { AerosLogo } from "@/components/logo";
import { GovLoginForm } from "@/components/forms/gov-login-form";

export default async function GovernmentLoginPage() {
  const gov = await getCurrentGovernment();
  if (gov) redirect("/gov");

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <AerosLogo size={40} />
          <h1 className="mt-4 text-xl font-semibold">Government Panel</h1>
          <p className="mt-1 text-center text-sm text-muted">
            Restricted access. Normal user accounts cannot sign in here.
          </p>
        </div>
        <div className="card p-6">
          <GovLoginForm />
        </div>
      </div>
    </div>
  );
}
