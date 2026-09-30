import Link from "next/link";
import { getActingContext, getOwnedCompanies } from "@/lib/auth";
import { getMyCompanyAllowance } from "@/lib/companies";
import { CreateCompanyForm } from "@/components/forms/company-forms";

/**
 * Apply for another company. Allowed while the person owns fewer companies
 * than the Government's per-person limit (Government -> Taxes -> Companies per
 * person). The server re-checks the limit when the form is submitted.
 */
export default async function NewCompanyPage() {
  const ctx = await getActingContext();
  if (!ctx) return null;

  const allowance = await getMyCompanyAllowance(ctx.user.id);
  const owned = await getOwnedCompanies(ctx.user.id);
  // Submitting the form refreshes this page, so an application that was just
  // sent shows up here as "awaiting review" (which is also the confirmation).
  const pending = owned.filter((c) => c.status === "PENDING");

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create another company</h1>
        <p className="mt-1 text-sm text-muted">
          Each company has its own wallet and username, separate from your personal account. The
          Government reviews every application and funds approved companies from the treasury.
        </p>
        <p className="mt-1 text-xs text-muted">
          You own {allowance.owned} of the {allowance.max} compan{allowance.max === 1 ? "y" : "ies"}{" "}
          the Government allows per person.
        </p>
      </div>
      {pending.length > 0 ? (
        <div className="card p-5">
          {pending.map((c) => (
            <p key={c.id} className="text-sm">
              <span className="font-medium">{c.name}</span>{" "}
              <span className="text-muted">@{c.username}</span>
            </p>
          ))}
          <p className="mt-2 text-sm text-muted">
            Your application is with the Government. You will be notified when it is reviewed, and
            can apply for another company after that if the limit allows it.
          </p>
          <Link href="/my-company" className="btn btn-secondary mt-3 inline-block text-sm">
            Back to my company
          </Link>
        </div>
      ) : allowance.canCreate ? (
        <CreateCompanyForm />
      ) : (
        <div className="card p-5">
          <p className="text-sm text-muted">
            You have reached the limit, so you cannot create another company right now.
          </p>
          <Link href="/my-company" className="btn btn-secondary mt-3 inline-block text-sm">
            Back to my company
          </Link>
        </div>
      )}
    </div>
  );
}
