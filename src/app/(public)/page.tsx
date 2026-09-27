import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentGovernment } from "@/lib/auth";
import { AerosLogo } from "@/components/logo";
import { APP_NAME, CURRENCY_NAME } from "@/lib/constants";

export default async function HomePage() {
  const [user, gov] = await Promise.all([getCurrentUser(), getCurrentGovernment()]);
  if (user) redirect("/dashboard");
  if (gov) redirect("/gov");

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <AerosLogo size={28} />
            <span className="text-lg font-semibold tracking-tight">{APP_NAME}</span>
          </div>
          <nav className="flex items-center gap-3 text-sm">
            <Link href="/login" className="btn btn-secondary">
              Log in
            </Link>
            <Link href="/register" className="btn btn-primary">
              Register
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-16">
        <div className="max-w-2xl">
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            A private, closed-loop economy for {CURRENCY_NAME}.
          </h1>
          <p className="mt-5 text-lg text-muted">
            {APP_NAME} lets an approved, small community hold and transfer {CURRENCY_NAME}{" "}
            digitally, with a serious transaction ledger behind it. It is not a bank, not real
            money, and not a cryptocurrency — it is a controlled virtual economy run by a
            Government administrator.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/register" className="btn btn-primary">
              Create an account
            </Link>
            <Link href="/login" className="btn btn-secondary">
              I already have an account
            </Link>
          </div>
          <p className="mt-6 text-sm text-muted">
            Registration requires a one-time code issued by the Government administrator.
          </p>
        </div>

        <div className="mt-16 grid gap-6 sm:grid-cols-3">
          <FeatureCard
            title="Server-verified balances"
            body="Every balance change happens atomically in the database — never trusted from the browser."
          />
          <FeatureCard
            title="Immutable ledger"
            body="Each payment gets a permanent transaction reference. History is never rewritten."
          />
          <FeatureCard
            title="Community-governed issuance"
            body="New Aeros beyond the treasury require a Government proposal and 100% community approval."
          />
        </div>
      </main>

      <footer className="border-t border-border py-6 text-center text-xs text-muted">
        <Link href="/government/login" className="hover:text-foreground">
          Government access
        </Link>
      </footer>
    </div>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-5">
      <h3 className="font-medium text-foreground">{title}</h3>
      <p className="mt-2 text-sm text-muted">{body}</p>
    </div>
  );
}
