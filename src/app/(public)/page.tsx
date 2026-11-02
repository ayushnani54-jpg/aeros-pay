import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentGovernment } from "@/lib/auth";
import { AerosLogo } from "@/components/logo";
import { APP_NAME, CURRENCY_NAME } from "@/lib/constants";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { getPublicCommunityContent } from "@/lib/public-content";
import { getPlatformFeatureFlags } from "@/lib/feature-governance";

export default async function HomePage() {
  const [user, gov] = await Promise.all([getCurrentUser(), getCurrentGovernment()]);
  if (user) redirect("/dashboard");
  if (gov) redirect("/gov");

  const [communityContent, flags] = await Promise.all([
    getPublicCommunityContent(),
    getPlatformFeatureFlags(),
  ]);

  const flagsMap = Object.fromEntries(flags.map((f) => [f.id, f.enabled]));

  const supportEmail = communityContent.support_email || "aerospay.official@gmail.com";
  const instagramUrl = communityContent.instagram_url || "https://instagram.com/aerospay";
  const whatsappCommunityUrl = communityContent.whatsapp_community_url || "https://chat.whatsapp.com/invite/aerospay-community";
  const interdreamUrl = communityContent.interdream_url || "https://interdream.io/c/aerospay";
  const publicDockUrl = communityContent.public_dock_url || "https://docs.aerospay.com";

  return (
    <div className="flex flex-1 flex-col bg-background text-foreground">
      {/* 1. Header Navigation */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <AerosLogo size={32} />
            <span className="text-xl font-bold tracking-tight text-foreground">{APP_NAME}</span>
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <ThemeToggle />
            <Link
              href="/login"
              className="btn btn-secondary text-sm px-3.5 py-1.5"
            >
              Sign In
            </Link>
            <Link
              href="/register"
              className="btn btn-primary text-sm px-4 py-1.5 shadow-sm"
            >
              Join Platform
            </Link>
          </div>
        </div>
      </header>

      {/* 2. Hero Section */}
      <section className="relative overflow-hidden border-b border-border py-16 sm:py-24 bg-surface/30">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid items-center gap-12 lg:grid-cols-12">
            <div className="lg:col-span-7 space-y-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-foreground">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                V6 Platform Upgrade Live • Verified Identity Infrastructure
              </div>
              <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl lg:text-6xl text-foreground">
                A Sovereign Closed-Loop Virtual Economy.
              </h1>
              <p className="text-lg text-muted max-w-2xl leading-relaxed">
                {APP_NAME} is a purpose-built sovereign digital economic platform governed by strict
                double-entry accounting invariants. Hold, transfer, and trade <span className="font-semibold text-foreground">{CURRENCY_NAME}</span> within
                a regulated community of verified citizens and registered corporations.
              </p>
              <div className="flex flex-wrap items-center gap-4 pt-2">
                <Link href="/register" className="btn btn-primary text-base px-6 py-2.5">
                  Create Citizen Account
                </Link>
                <Link href="/login" className="btn btn-secondary text-base px-6 py-2.5">
                  Access Existing Wallet
                </Link>
                <a
                  href="#how-it-works"
                  className="text-sm font-medium text-muted hover:text-foreground transition-colors px-2"
                >
                  Explore Ecosystem ↓
                </a>
              </div>
              <p className="text-xs text-muted">
                Zero cryptocurrency • Zero fractional units • Whole integer ledger integrity
              </p>
            </div>

            {/* Economic System Visualizer Card */}
            <div className="lg:col-span-5">
              <div className="card p-6 shadow-md border-border bg-surface/80 space-y-5">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Sovereign Balance Engine
                  </span>
                  <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-mono text-emerald-600 dark:text-emerald-400">
                    INVARIANT PRESERVED
                  </span>
                </div>

                <div className="space-y-3 font-mono text-xs">
                  <div className="rounded-lg bg-background p-3 border border-border flex justify-between items-center">
                    <span className="text-muted">Citizen Wallets</span>
                    <span className="font-semibold text-foreground">Atomic P2P Transfers</span>
                  </div>
                  <div className="rounded-lg bg-background p-3 border border-border flex justify-between items-center">
                    <span className="text-muted">Corporate Treasuries</span>
                    <span className="font-semibold text-foreground">Invoicing & Partnerships</span>
                  </div>
                  <div className="rounded-lg bg-background p-3 border border-border flex justify-between items-center">
                    <span className="text-muted">Escrow Settlement</span>
                    <span className="font-semibold text-foreground">Milestones & Bounties</span>
                  </div>
                  <div className="rounded-lg bg-background p-3 border border-border flex justify-between items-center">
                    <span className="text-muted">Central Authority</span>
                    <span className="font-semibold text-foreground">Sovereign Treasury</span>
                  </div>
                </div>

                <div className="rounded bg-surface p-3 text-center border border-border/60">
                  <span className="text-xs text-muted">Formula: </span>
                  <span className="font-mono text-xs font-bold text-foreground">
                    Total Supply = Σ Users + Σ Companies + Treasury
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3. About Section */}
      <section id="about" className="py-20 border-b border-border">
        <div className="mx-auto max-w-6xl px-6">
          <div className="max-w-3xl space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Core Architecture
            </h2>
            <h3 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              Engineered as a Controlled Sovereign Digital Environment.
            </h3>
            <p className="text-base text-muted leading-relaxed">
              Unlike speculative cryptocurrencies or unsecured payment tokens, {APP_NAME} operates
              as an isolated, double-entry financial ledger where every Aeros is backed and accounted
              for in whole-number integers.
            </p>
          </div>

          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <div className="card p-5 space-y-2">
              <div className="text-xl font-bold font-mono text-foreground">100% Integer</div>
              <h4 className="font-medium text-foreground">Zero Fractional Units</h4>
              <p className="text-xs text-muted">
                Arithmetic is strictly calculated with whole numbers, completely eliminating floating-point drift and rounding errors.
              </p>
            </div>
            <div className="card p-5 space-y-2">
              <div className="text-xl font-bold font-mono text-foreground">Row Locks</div>
              <h4 className="font-medium text-foreground">Atomic Concurrency</h4>
              <p className="text-xs text-muted">
                Transfers execute inside serializable database transactions with row-level locks, preventing double-spend exploits.
              </p>
            </div>
            <div className="card p-5 space-y-2">
              <div className="text-xl font-bold font-mono text-foreground">Append-Only</div>
              <h4 className="font-medium text-foreground">Immutable History</h4>
              <p className="text-xs text-muted">
                Permanent cryptographic audit references guarantee that balance histories can never be retroactively manipulated.
              </p>
            </div>
            <div className="card p-5 space-y-2">
              <div className="text-xl font-bold font-mono text-foreground">V6 Identity</div>
              <h4 className="font-medium text-foreground">Verified Membership</h4>
              <p className="text-xs text-muted">
                Mandatory verified email infrastructure paired with Government 6-digit cryptographic activation keys.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 4. How Ecosystem Works */}
      <section id="how-it-works" className="py-20 border-b border-border bg-surface/20">
        <div className="mx-auto max-w-6xl px-6">
          <div className="text-center max-w-2xl mx-auto space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Three-Pillar Governance
            </h2>
            <h3 className="text-3xl font-bold tracking-tight text-foreground">
              How the Aeros Pay Ecosystem Operates
            </h3>
            <p className="text-sm text-muted">
              Three sovereign participant tiers coordinate to build a flourishing, accountable digital economy.
            </p>
          </div>

          <div className="mt-12 grid gap-8 md:grid-cols-3">
            <div className="card p-6 space-y-4">
              <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center font-bold text-blue-500">
                1
              </div>
              <h4 className="text-lg font-semibold text-foreground">Citizens (Users)</h4>
              <p className="text-sm text-muted">
                Individual economic actors. Citizens can hold Aeros, execute instant zero-fee transfers,
                purchase marketplace goods, apply for corporate jobs, publish media updates, and earn wages.
              </p>
            </div>

            <div className="card p-6 space-y-4">
              <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center font-bold text-emerald-500">
                2
              </div>
              <h4 className="text-lg font-semibold text-foreground">Registered Companies</h4>
              <p className="text-sm text-muted">
                Corporate entities verified by the platform. Companies issue formal itemized invoices,
                post job contracts with escrowed wages, and form 50/50 profit-sharing corporate alliances.
              </p>
            </div>

            <div className="card p-6 space-y-4">
              <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center font-bold text-amber-500">
                3
              </div>
              <h4 className="text-lg font-semibold text-foreground">Government Authority</h4>
              <p className="text-sm text-muted">
                The central regulatory administrator. Controls sovereign issuance, maintains the central Treasury,
                approves corporate licenses, moderates dispute escrows, and generates membership activation keys.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 5. Platform Features & Real Availability Status */}
      <section id="features" className="py-20 border-b border-border">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-12">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
                Platform Capabilities
              </h2>
              <h3 className="text-3xl font-bold tracking-tight text-foreground">
                Active Modules & Transparent Status
              </h3>
            </div>
            <p className="text-xs text-muted max-w-sm">
              We uphold complete transparency: feature statuses reflect live backend configuration directly from the Government Feature Registry.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureModuleCard
              title="Citizen Wallets & Transfers"
              description="Direct balance transfers between verified citizens with instant settlement, unique reference codes, and atomic locking."
              status={flagsMap.citizen_transfers ?? true ? "ACTIVE" : "PAUSED"}
            />
            <FeatureModuleCard
              title="Public Marketplace & Escrow"
              description="Listing directory for services, digital assets, and goods with buyer protection and automated escrow disbursement."
              status={flagsMap.marketplace ?? true ? "ACTIVE" : "PAUSED"}
            />
            <FeatureModuleCard
              title="Corporate Invoicing & Payroll"
              description="Business registration, corporate tax handling, itemized invoices, and multi-member treasury controls."
              status={flagsMap.companies ?? true ? "ACTIVE" : "PAUSED"}
            />
            <FeatureModuleCard
              title="Employment & Job Bounties"
              description="Corporate job listings, applicant resume workflows, and automated escrow payouts upon verified task completion."
              status={flagsMap.jobs ?? true ? "ACTIVE" : "PAUSED"}
            />
            <FeatureModuleCard
              title="Corporate Partnerships"
              description="Bilateral joint venture proposals, Government approvals, and automated 50/50 profit and tax distributions."
              status={flagsMap.partnerships ?? true ? "ACTIVE" : "PAUSED"}
            />
            <FeatureModuleCard
              title="Aeros Media Social Stream"
              description="Text-only community feed with mentions, threading, comments, tips, and 7-day hot retention lifecycle."
              status={flagsMap.aeros_media ?? true ? "ACTIVE" : "PAUSED"}
            />
            <FeatureModuleCard
              title="Aeros Exchange (INR Purchases)"
              description="Official fiat conversion desk and package acquisition system. Temporarily disabled during V6 rollout."
              status={flagsMap.aeros_exchange ? "ACTIVE" : "DISABLED"}
              notice="Exchange purchases are paused for the V6 rollout. Existing balances remain fully intact."
            />
            <FeatureModuleCard
              title="Synthetic Trading Terminal"
              description="Aeros Market Index (AMI) charts, short-selling, and leverage positions. Temporarily paused for V6 stability."
              status={flagsMap.trading_terminal ? "ACTIVE" : "DISABLED"}
              notice="Trading execution is temporarily disabled. Collateral and positions remain preserved in Neon storage."
            />
            <FeatureModuleCard
              title="In-App Support Desk"
              description="Integrated ticket submission with verified email routing and Web3Forms priority dispatch."
              status="ACTIVE"
            />
          </div>
        </div>
      </section>

      {/* 6. How to Join */}
      <section id="how-to-join" className="py-20 border-b border-border bg-surface/20">
        <div className="mx-auto max-w-6xl px-6">
          <div className="max-w-3xl space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Onboarding Process
            </h2>
            <h3 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              Three Simple Steps to Join the Economy
            </h3>
            <p className="text-sm text-muted">
              Aeros Pay enforces a two-tier access architecture to protect the integrity of economic transactions.
            </p>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            <div className="card p-6 space-y-3">
              <span className="text-xs font-mono font-bold text-muted uppercase">Stage 01</span>
              <h4 className="text-base font-semibold text-foreground">Register with Email</h4>
              <p className="text-xs text-muted leading-relaxed">
                Choose a unique citizen handle and submit your email address. An 8-digit verification code is instantly generated.
              </p>
            </div>
            <div className="card p-6 space-y-3">
              <span className="text-xs font-mono font-bold text-muted uppercase">Stage 02</span>
              <h4 className="text-base font-semibold text-foreground">Limited Member Access</h4>
              <p className="text-xs text-muted leading-relaxed">
                Confirm your 8-digit code to explore the platform in safe read-only mode, view marketplace listings, and review community posts.
              </p>
            </div>
            <div className="card p-6 space-y-3">
              <span className="text-xs font-mono font-bold text-muted uppercase">Stage 03</span>
              <h4 className="text-base font-semibold text-foreground">Government Activation</h4>
              <p className="text-xs text-muted leading-relaxed">
                Obtain a 6-digit cryptographic activation code from the Government authority to unlock full member status and transfer Aeros freely.
              </p>
            </div>
          </div>

          <div className="mt-10 text-center">
            <Link href="/register" className="btn btn-primary px-8 py-3 text-base">
              Start Citizen Registration Now
            </Link>
          </div>
        </div>
      </section>

      {/* 7. Community & Official Links */}
      <section className="py-16 border-b border-border">
        <div className="mx-auto max-w-6xl px-6">
          <div className="text-center max-w-2xl mx-auto space-y-3 mb-10">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Connect With Us
            </h2>
            <h3 className="text-2xl font-bold tracking-tight text-foreground">
              Official Community & Communication Channels
            </h3>
            <p className="text-xs text-muted">
              Stay informed on sovereign policy changes, economic updates, and community proposals.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <a
              href={instagramUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="card p-4 hover:border-foreground/40 transition-colors flex items-center justify-between"
            >
              <div>
                <div className="font-semibold text-sm text-foreground">Instagram</div>
                <div className="text-xs text-muted">@aerospay updates</div>
              </div>
              <span className="text-muted text-sm">↗</span>
            </a>

            <a
              href={whatsappCommunityUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="card p-4 hover:border-foreground/40 transition-colors flex items-center justify-between"
            >
              <div>
                <div className="font-semibold text-sm text-foreground">WhatsApp Community</div>
                <div className="text-xs text-muted">Official citizen announcements</div>
              </div>
              <span className="text-muted text-sm">↗</span>
            </a>

            <a
              href={interdreamUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="card p-4 hover:border-foreground/40 transition-colors flex items-center justify-between"
            >
              <div>
                <div className="font-semibold text-sm text-foreground">Interdream / Entodream</div>
                <div className="text-xs text-muted">Community partner hub</div>
              </div>
              <span className="text-muted text-sm">↗</span>
            </a>

            <a
              href={publicDockUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="card p-4 hover:border-foreground/40 transition-colors flex items-center justify-between"
            >
              <div>
                <div className="font-semibold text-sm text-foreground">Documentation Dock</div>
                <div className="text-xs text-muted">Platform guides & policies</div>
              </div>
              <span className="text-muted text-sm">↗</span>
            </a>
          </div>
        </div>
      </section>

      {/* 8. Frequently Asked Questions */}
      <section className="py-20 border-b border-border bg-surface/30">
        <div className="mx-auto max-w-4xl px-6">
          <div className="text-center space-y-2 mb-12">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Clear Answers
            </h2>
            <h3 className="text-3xl font-bold tracking-tight text-foreground">
              Frequently Asked Questions
            </h3>
          </div>

          <div className="space-y-4">
            <FaqItem
              question="What is Aeros Pay?"
              answer="Aeros Pay is an institutional-grade, closed-loop sovereign virtual economic platform. It provides verified citizens and registered corporations with an atomic digital ledger to transfer internal Aeros, settle marketplace orders, and manage business operations."
            />
            <FaqItem
              question="What is an Aeros, and can it be converted to cryptocurrency?"
              answer="Aeros is strictly a virtual integer utility unit native to Aeros Pay. It has zero fractional decimals, is not a cryptocurrency, is not mined on a blockchain, and cannot be traded on external speculative crypto exchanges."
            />
            <FaqItem
              question="What is the difference between Limited Member and Active Member?"
              answer="When you verify your email address, your account is granted Limited Member status. This lets you explore the platform, read community posts, and browse the marketplace in safe read-only mode. Once the Government authority grants you a 6-digit activation code, your account becomes an Active Member with full permission to transfer Aeros and transact."
            />
            <FaqItem
              question="Why are the Trading Terminal and Aeros Exchange currently disabled?"
              answer="As part of the V6 Identity & Security upgrade, the Synthetic Trading Terminal and INR Exchange desks are temporarily paused. This ensures complete database stability and integrity while citizen accounts complete identity verification. All existing balances and positions remain preserved."
            />
            <FaqItem
              question="How do I contact support or report an issue?"
              answer={`You can reach our dedicated support desk directly inside the application via the Support page or by sending an email to ${supportEmail}. Inquiries are tracked via automated ticket references.`}
            />
          </div>
        </div>
      </section>

      {/* 9. Official Footer - ZERO Government Links */}
      <footer className="py-12 bg-surface">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-6 pb-8 border-b border-border">
            <div className="flex items-center gap-3">
              <AerosLogo size={28} />
              <span className="text-lg font-bold tracking-tight text-foreground">{APP_NAME}</span>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-6 text-xs text-muted">
              <span>Official Support: <a href={`mailto:${supportEmail}`} className="text-foreground hover:underline">{supportEmail}</a></span>
              <a href={instagramUrl} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Instagram</a>
              <a href={whatsappCommunityUrl} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">WhatsApp</a>
              <a href={publicDockUrl} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">Dock</a>
            </div>
          </div>

          <div className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted">
            <p>© {new Date().getFullYear()} {APP_NAME}. All rights reserved. Sovereign closed-loop virtual economy.</p>
            <div className="flex items-center gap-4">
              <span>Privacy-Separated Data Architecture</span>
              <span>•</span>
              <span>Double-Entry Balance Invariants</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureModuleCard({
  title,
  description,
  status,
  notice,
}: {
  title: string;
  description: string;
  status: "ACTIVE" | "PAUSED" | "DISABLED";
  notice?: string;
}) {
  const isAvailable = status === "ACTIVE";

  return (
    <div className={`card p-6 flex flex-col justify-between space-y-4 ${!isAvailable ? "opacity-85 border-dashed" : ""}`}>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold text-foreground text-base">{title}</h4>
          <span
            className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${
              isAvailable
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
            }`}
          >
            {status}
          </span>
        </div>
        <p className="text-xs text-muted leading-relaxed">{description}</p>
      </div>

      {notice && (
        <div className="rounded bg-surface p-2.5 text-[11px] text-muted border border-border/80">
          <span className="font-semibold text-foreground">Notice: </span>
          {notice}
        </div>
      )}
    </div>
  );
}

function FaqItem({ question, answer }: { question: string; answer: string }) {
  return (
    <details className="card p-4 group open:bg-surface/50 transition-colors">
      <summary className="font-medium text-foreground cursor-pointer list-none flex items-center justify-between gap-4 text-sm sm:text-base">
        <span>{question}</span>
        <span className="text-muted group-open:rotate-180 transition-transform font-mono text-xs">
          ▼
        </span>
      </summary>
      <p className="mt-3 text-xs sm:text-sm text-muted leading-relaxed border-t border-border pt-3">
        {answer}
      </p>
    </details>
  );
}
