"use client";

import { useActionState, useState } from "react";
import { generateCodeAction, revokeCodeAction } from "@/actions/government";

export function GenerateCodeButton() {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; code?: string; error?: string } | null>(null);

  return (
    <div>
      <button
        className="btn btn-primary"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          const res = await generateCodeAction();
          setPending(false);
          if (res.ok) {
            setResult({ ok: true, code: res.data.code });
          } else {
            setResult({ ok: false, error: res.error });
          }
        }}
      >
        {pending ? "Generating…" : "Generate new code"}
      </button>
      {result?.ok && (
        <p className="mt-2 text-sm">
          New code: <span className="font-mono text-base font-semibold">{result.code}</span>
        </p>
      )}
      {result && !result.ok && <p className="mt-2 text-sm text-danger">{result.error}</p>}
    </div>
  );
}

export function RevokeCodeButton({ codeId }: { codeId: string }) {
  const [state, formAction, pending] = useActionState(revokeCodeAction, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="codeId" value={codeId} />
      <button type="submit" className="btn btn-secondary text-xs" disabled={pending}>
        {pending ? "Revoking…" : "Revoke"}
      </button>
      {state && !state.ok && <p className="mt-1 text-xs text-danger">{state.error}</p>}
    </form>
  );
}
