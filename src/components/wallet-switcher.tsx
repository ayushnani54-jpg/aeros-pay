"use client";

import { useActionState } from "react";
import { switchContextAction } from "@/actions/user";
import type { Company } from "@/db/schema";

/**
 * Switches between the personal wallet and any approved company the user
 * owns. Rendered only when the user actually has a company, so the normal
 * single-wallet experience is unchanged (spec §62).
 */
export function WalletSwitcher({
  companies,
  activeCompanyId,
  personalLabel,
}: {
  companies: Company[];
  activeCompanyId: string | null;
  personalLabel: string;
}) {
  const [state, formAction, pending] = useActionState(switchContextAction, null);

  if (companies.length === 0) return null;

  return (
    <div className="card p-4">
      <p className="text-sm text-muted">Acting as</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <ContextButton
          formAction={formAction}
          value="personal"
          label={personalLabel}
          sublabel="Personal"
          active={activeCompanyId === null}
          pending={pending}
        />
        {companies.map((company) => (
          <ContextButton
            key={company.id}
            formAction={formAction}
            value={company.id}
            label={company.name}
            sublabel={`@${company.username}`}
            active={activeCompanyId === company.id}
            pending={pending}
          />
        ))}
      </div>
      {state && !state.ok && <p className="mt-2 text-sm text-danger">{state.error}</p>}
    </div>
  );
}

function ContextButton({
  formAction,
  value,
  label,
  sublabel,
  active,
  pending,
}: {
  formAction: (formData: FormData) => void;
  value: string;
  label: string;
  sublabel: string;
  active: boolean;
  pending: boolean;
}) {
  return (
    <form action={formAction}>
      <input type="hidden" name="context" value={value} />
      <button
        type="submit"
        disabled={pending || active}
        className={`rounded-md border px-3 py-2 text-left text-sm ${
          active
            ? "border-[#111111] bg-black text-white"
            : "border-border bg-background hover:bg-surface"
        } disabled:cursor-default`}
      >
        <span className="block font-medium">{label}</span>
        <span className={`block text-xs ${active ? "text-white/70" : "text-muted"}`}>
          {sublabel}
        </span>
      </button>
    </form>
  );
}
