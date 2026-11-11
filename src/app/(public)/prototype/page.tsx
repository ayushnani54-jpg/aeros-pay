"use client";

import React, { useState } from "react";
import Link from "next/link";
import { AerosLogo } from "@/components/logo";
import { APP_NAME, CURRENCY_NAME } from "@/lib/constants";

interface BondHolding {
  id: string;
  principal: number;
  tenorDays: number;
  apyBp: number;
  yieldAeros: number;
  daysRemaining: number;
  status: "LOCKED" | "MATURED";
}

interface HedgePosition {
  id: string;
  side: "BUY" | "SELL";
  direction: "LONG" | "SHORT";
  qty: number;
  leverage: number;
  entryPrice: number;
  marginLocked: number;
  takeProfitPrice: number;
  stopLossPrice: number;
}

export default function PrototypePage() {
  const [activeTab, setActiveTab] = useState<
    "civic" | "labor" | "payroll" | "credit" | "bonds" | "equity" | "multisig" | "trading" | "archive"
  >("civic");

  // Global Economy Simulation State
  const [simEconomy, setSimEconomy] = useState({
    userBalances: 15420000,
    companyBalances: 12180000,
    treasuryBalance: 22400000,
    totalSupply: 50000000,
    amiPrice: 124,
  });

  const accountedSupply = simEconomy.userBalances + simEconomy.companyBalances + simEconomy.treasuryBalance;
  const supplyDiscrepancy = accountedSupply - simEconomy.totalSupply;

  // =========================================================================
  // 1. CIVIC DEMOCRACY & UBI STATE
  // =========================================================================
  const [ubiSurplusPool, setUbiSurplusPool] = useState<number>(500000);
  const [refVotes, setRefVotes] = useState({ yes: 6420, no: 3580, userVoted: false });

  const ubiPerCitizen = Math.floor(ubiSurplusPool / 10000);
  const ubiRemainder = ubiSurplusPool - ubiPerCitizen * 10000;

  const handleExecuteUBI = () => {
    if (ubiSurplusPool <= 0) return;
    setSimEconomy((prev) => ({
      ...prev,
      treasuryBalance: prev.treasuryBalance - ubiSurplusPool,
      userBalances: prev.userBalances + ubiSurplusPool,
    }));
    alert(`Universal Basic Dividend disbursed! 10,000 citizens received ${ubiPerCitizen} Aeros each. Zero fractional drift.`);
  };

  const handleVoteReferendum = (type: "YES" | "NO") => {
    if (refVotes.userVoted) return;
    setRefVotes((prev) => ({
      ...prev,
      yes: type === "YES" ? prev.yes + 1 : prev.yes,
      no: type === "NO" ? prev.no + 1 : prev.no,
      userVoted: true,
    }));
  };

  // =========================================================================
  // 2. LABOR & JURY TRIBUNAL STATE
  // =========================================================================
  const [jobEscrowLocked, setJobEscrowLocked] = useState<number>(6000);
  const [milestoneStatus, setMilestoneStatus] = useState<"DISPUTED" | "SETTLED_WORKER" | "SETTLED_EMPLOYER">("DISPUTED");
  const [jurorVotes, setJurorVotes] = useState<{ j1: string | null; j2: string | null; j3: string | null }>({
    j1: null,
    j2: null,
    j3: null,
  });

  const handleJurorVerdict = (verdict: "WORKER" | "EMPLOYER") => {
    if (milestoneStatus !== "DISPUTED") return;
    setJurorVotes({
      j1: verdict,
      j2: verdict,
      j3: verdict === "WORKER" ? "EMPLOYER" : "WORKER",
    });

    if (verdict === "WORKER") {
      setSimEconomy((prev) => ({
        ...prev,
        userBalances: prev.userBalances + jobEscrowLocked,
      }));
      setMilestoneStatus("SETTLED_WORKER");
    } else {
      setSimEconomy((prev) => ({
        ...prev,
        companyBalances: prev.companyBalances + jobEscrowLocked,
      }));
      setMilestoneStatus("SETTLED_EMPLOYER");
    }
    setJobEscrowLocked(0);
  };

  // =========================================================================
  // 3. CORPORATE PAYROLL STATE
  // =========================================================================
  const [payrollGross, setPayrollGross] = useState<number>(100000);
  const [payrollExecuted, setPayrollExecuted] = useState<boolean>(false);
  const payrollTax = Math.floor(payrollGross * 0.05);
  const payrollNet = payrollGross - payrollTax;

  const handleExecutePayroll = () => {
    if (payrollGross <= 0 || payrollExecuted) return;
    setSimEconomy((prev) => ({
      ...prev,
      companyBalances: prev.companyBalances - payrollGross,
      treasuryBalance: prev.treasuryBalance + payrollTax,
      userBalances: prev.userBalances + payrollNet,
    }));
    setPayrollExecuted(true);
  };

  // =========================================================================
  // 4. CREDIT SCORE (ACS) STATE
  // =========================================================================
  const [acsSliders, setAcsSliders] = useState({ s1: 98, s2: 92, s3: 95, s4: 90 });
  const acsScore = Math.round(
    300 + (acsSliders.s1 * 0.35 + acsSliders.s2 * 0.3 + acsSliders.s3 * 0.2 + acsSliders.s4 * 0.15) * 5.5,
  );
  const acsBorrowingLimit = Math.round(acsScore * 65);

  // =========================================================================
  // 5. SOVEREIGN BONDS STATE
  // =========================================================================
  const [bondPrincipal, setBondPrincipal] = useState<number>(10000);
  const [bondTenor, setBondTenor] = useState<{ days: number; apyBp: number }>({ days: 30, apyBp: 550 });
  const [bondHoldings, setBondHoldings] = useState<BondHolding[]>([
    {
      id: "BND-401",
      principal: 25000,
      tenorDays: 30,
      apyBp: 550,
      yieldAeros: 113,
      daysRemaining: 1,
      status: "LOCKED",
    },
    {
      id: "BND-402",
      principal: 50000,
      tenorDays: 90,
      apyBp: 800,
      yieldAeros: 986,
      daysRemaining: 42,
      status: "LOCKED",
    },
  ]);

  const calculatedYield = Math.floor((bondPrincipal * bondTenor.apyBp * bondTenor.days) / (10000 * 365));

  const handleSubscribeBond = () => {
    if (bondPrincipal <= 0) return;
    const newBond: BondHolding = {
      id: `BND-${Math.floor(100 + Math.random() * 900)}`,
      principal: bondPrincipal,
      tenorDays: bondTenor.days,
      apyBp: bondTenor.apyBp,
      yieldAeros: calculatedYield,
      daysRemaining: bondTenor.days,
      status: "LOCKED",
    };

    setSimEconomy((prev) => ({
      ...prev,
      userBalances: prev.userBalances - bondPrincipal,
      treasuryBalance: prev.treasuryBalance + bondPrincipal,
    }));
    setBondHoldings([newBond, ...bondHoldings]);
  };

  const handleRedeemBond = (id: string) => {
    const bond = bondHoldings.find((b) => b.id === id);
    if (!bond) return;
    const payout = bond.principal + bond.yieldAeros;
    setSimEconomy((prev) => ({
      ...prev,
      treasuryBalance: prev.treasuryBalance - payout,
      userBalances: prev.userBalances + payout,
    }));
    setBondHoldings(bondHoldings.filter((b) => b.id !== id));
  };

  // =========================================================================
  // 6. EQUITY & DIVIDENDS STATE
  // =========================================================================
  const [divGrossPool, setDivGrossPool] = useState<number>(40000);
  const [withholdingTaxPct] = useState<number>(5);
  const [dividendDistributed, setDividendDistributed] = useState<boolean>(false);

  const govTaxDeducted = Math.floor(divGrossPool * (withholdingTaxPct / 100));
  const netShareholderPool = divGrossPool - govTaxDeducted;
  const perShareDividend = (netShareholderPool / 10000).toFixed(2);

  const shareholders = [
    { handle: "@founder_raj", role: "Founder & CEO", shares: 5000, pct: 50 },
    { handle: "@ayush_trader", role: "Angel Investor", shares: 2500, pct: 25 },
    { handle: "@vikram_citizen", role: "Citizen Shareholder", shares: 1500, pct: 15 },
    { handle: "@priya_dev", role: "Lead Engineer", shares: 1000, pct: 10 },
  ];

  const handleExecuteDividend = () => {
    setSimEconomy((prev) => ({
      ...prev,
      companyBalances: prev.companyBalances - divGrossPool,
      treasuryBalance: prev.treasuryBalance + govTaxDeducted,
      userBalances: prev.userBalances + netShareholderPool,
    }));
    setDividendDistributed(true);
  };

  // =========================================================================
  // 7. MULTI-SIG STATE
  // =========================================================================
  const [multisigSignatures, setMultisigSignatures] = useState({
    ceo: true,
    cfo: false,
    auditor: false,
  });
  const [proposalExecuted, setProposalExecuted] = useState<boolean>(false);
  const proposalAmount = 30000;
  const approvalsCount = (multisigSignatures.ceo ? 1 : 0) + (multisigSignatures.cfo ? 1 : 0) + (multisigSignatures.auditor ? 1 : 0);

  const handleSignCFO = () => {
    setMultisigSignatures((prev) => ({ ...prev, cfo: true }));
  };

  const handleExecuteMultisig = () => {
    if (approvalsCount < 2 || proposalExecuted) return;
    setSimEconomy((prev) => ({
      ...prev,
      companyBalances: prev.companyBalances - proposalAmount,
      userBalances: prev.userBalances + proposalAmount,
    }));
    setProposalExecuted(true);
  };

  // =========================================================================
  // 8. HEDGE TRADING STATE
  // =========================================================================
  const [tradeDirection, setTradeDirection] = useState<"BUY" | "SELL">("BUY");
  const [tradeQuantity, setTradeQuantity] = useState<number>(50);
  const [tradeLeverage, setTradeLeverage] = useState<number>(4);
  const [takeProfitPrice, setTakeProfitPrice] = useState<number>(145);
  const [stopLossPrice, setStopLossPrice] = useState<number>(115);
  const [openPositions, setOpenPositions] = useState<HedgePosition[]>([
    {
      id: "POS-101",
      side: "BUY",
      direction: "LONG",
      qty: 100,
      leverage: 4,
      entryPrice: 120,
      marginLocked: 3000,
      takeProfitPrice: 140,
      stopLossPrice: 110,
    },
  ]);

  const requiredMargin = Math.ceil((tradeQuantity * simEconomy.amiPrice) / tradeLeverage);

  const handleOpenPosition = () => {
    if (requiredMargin <= 0) return;
    const newPos: HedgePosition = {
      id: `POS-${Math.floor(100 + Math.random() * 900)}`,
      side: tradeDirection,
      direction: tradeDirection === "BUY" ? "LONG" : "SHORT",
      qty: tradeQuantity,
      leverage: tradeLeverage,
      entryPrice: simEconomy.amiPrice,
      marginLocked: requiredMargin,
      takeProfitPrice,
      stopLossPrice,
    };

    setSimEconomy((prev) => ({
      ...prev,
      userBalances: prev.userBalances - requiredMargin,
      treasuryBalance: prev.treasuryBalance + requiredMargin,
    }));
    setOpenPositions([newPos, ...openPositions]);
  };

  const handleClosePosition = (id: string, pnl: number) => {
    const pos = openPositions.find((p) => p.id === id);
    if (!pos) return;
    const payout = Math.max(0, pos.marginLocked + pnl);

    setSimEconomy((prev) => ({
      ...prev,
      treasuryBalance: prev.treasuryBalance - payout,
      userBalances: prev.userBalances + payout,
    }));
    setOpenPositions(openPositions.filter((p) => p.id !== id));
  };

  // =========================================================================
  // 9. ARCHIVE & MERKLE SOLVENCY STATE
  // =========================================================================
  const [merkleHash, setMerkleHash] = useState<string>("7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069");
  const [archiveRepos, setArchiveRepos] = useState([
    { name: "aeros-archive-market-index", label: "Market Index", sizeMb: 240, status: "NORMAL" },
    { name: "aeros-archive-trading-ledger", label: "Trading Ledger", sizeMb: 760, status: "NORMAL" },
    { name: "aeros-archive-payments", label: "Payments", sizeMb: 310, status: "NORMAL" },
    { name: "aeros-archive-exchange", label: "Exchange", sizeMb: 85, status: "NORMAL" },
    { name: "aeros-archive-refunds", label: "Refunds", sizeMb: 42, status: "NORMAL" },
    { name: "aeros-archive-marketplace-listings", label: "Listings", sizeMb: 110, status: "NORMAL" },
    { name: "aeros-archive-marketplace-orders", label: "Orders", sizeMb: 195, status: "NORMAL" },
    { name: "aeros-archive-jobs", label: "Citizen Jobs", sizeMb: 64, status: "NORMAL" },
    { name: "aeros-archive-contracts", label: "Contracts", sizeMb: 150, status: "NORMAL" },
    { name: "aeros-archive-company-partnerships", label: "Partnerships", sizeMb: 92, status: "NORMAL" },
    { name: "aeros-archive-company-finances", label: "Company Finances", sizeMb: 215, status: "NORMAL" },
    { name: "aeros-archive-loans", label: "Gov Loans", sizeMb: 78, status: "NORMAL" },
    { name: "aeros-archive-media", label: "Aeros Media", sizeMb: 820, status: "WARNING" },
    { name: "aeros-archive-government", label: "Gov Decisions", sizeMb: 45, status: "NORMAL" },
    { name: "aeros-archive-audit", label: "Audit Ledger", sizeMb: 490, status: "NORMAL" },
  ]);

  const handleSimulateSurge = (name: string) => {
    setArchiveRepos((prev) =>
      prev.map((r) => {
        if (r.name === name) {
          const newSize = r.sizeMb + 180;
          return {
            ...r,
            sizeMb: newSize,
            status: newSize >= 900 ? "ROLLOVER" : newSize >= 800 ? "WARNING" : "NORMAL",
          };
        }
        return r;
      }),
    );
  };

  const handleGenerateMerkleProof = () => {
    const sampleHashes = [
      "9a12e34f89b01c23d45e67f89a01b23c4d5e67f89a01b23c4d5e67f89a01b23c",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "f8421c905b63aa1109dc0821b34e5697a82910fedcba9876543210abcdef0123",
    ];
    setMerkleHash(sampleHashes[Math.floor(Math.random() * sampleHashes.length)]);
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#ffffff] text-[#111111] antialiased">
      {/* Institutional Top Header */}
      <header className="border-b border-border bg-[#ffffff] sticky top-0 z-50">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3.5">
            <AerosLogo size={32} />
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-foreground">{APP_NAME} Prototype</h1>
                <span className="rounded bg-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted border border-border">
                  V6 Architecture Lab
                </span>
                <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-900 border border-amber-300">
                  Full Sovereign Economy
                </span>
              </div>
              <p className="text-xs text-muted">Citizens • Registered Companies • Sovereign Treasury • 15 GitHub Archives</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-xs font-medium text-muted hover:text-foreground">
              ← Return Home
            </Link>
            <div className="h-4 w-px bg-border"></div>
            <div className="text-right font-mono text-xs">
              <span className="text-muted">AMI Index: </span>
              <span className="font-bold text-foreground">{simEconomy.amiPrice} {CURRENCY_NAME}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Global Invariant Live State Bar */}
      <section className="border-b border-border bg-surface px-6 py-3">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-600 animate-pulse"></span>
            <span className="font-semibold text-foreground">SUPPLY INVARIANT (I-01):</span>
            <span className="text-muted">
              Users ({simEconomy.userBalances.toLocaleString("en-IN")}) + Companies ({simEconomy.companyBalances.toLocaleString("en-IN")}) + Treasury ({simEconomy.treasuryBalance.toLocaleString("en-IN")})
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-bold text-emerald-700">
              = {accountedSupply.toLocaleString("en-IN")} {CURRENCY_NAME}
            </span>
            <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${supplyDiscrepancy === 0 ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>
              {supplyDiscrepancy === 0 ? "0 DISCREPANCY (PASS)" : `DRIFT: ${supplyDiscrepancy}`}
            </span>
          </div>
        </div>
      </section>

      {/* Module Navigation Tabs */}
      <nav className="border-b border-border bg-[#ffffff]">
        <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-6 py-2">
          {[
            { id: "civic", label: "1. Civic Democracy & UBI" },
            { id: "labor", label: "2. Labor & Jury Tribunal" },
            { id: "payroll", label: "3. Corporate Payroll & B2B" },
            { id: "credit", label: "4. Credit Score & Succession" },
            { id: "bonds", label: "5. Sovereign Bonds" },
            { id: "equity", label: "6. Corporate Equity" },
            { id: "multisig", label: "7. 2-of-3 Multi-Sig" },
            { id: "trading", label: "8. Synthetic Trading" },
            { id: "archive", label: "9. 15-Repo Archive" },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as Parameters<typeof setActiveTab>[0])}
              className={`whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-semibold transition ${
                activeTab === tab.id ? "bg-foreground text-background" : "text-muted hover:text-foreground hover:bg-surface"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Main Workspace */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">

        {/* ========================================================================= */}
        {/* 1. CIVIC DEMOCRACY & UBI */}
        {/* ========================================================================= */}
        {activeTab === "civic" && (
          <div className="space-y-6">
            <div className="card p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-900 border border-amber-300">
                  CIVIC PILLAR
                </span>
                <h2 className="text-xl font-bold tracking-tight text-foreground mt-1">Direct Democracy, Referendums & Sovereign Welfare (UBI)</h2>
                <p className="text-xs text-muted mt-1 max-w-3xl">
                  1-Citizen-1-Vote democratic referendums govern sovereign economic policy. During tax surplus periods, the Treasury returns capital equally as an integer-exact Universal Citizen Dividend without fractional leakage.
                </p>
              </div>
              <div className="font-mono text-right">
                <div className="text-[10px] text-muted uppercase">Verified Citizen Voters</div>
                <div className="text-lg font-bold text-emerald-700">10,000 Citizens</div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* UBI Simulator */}
              <div className="card p-5 space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Universal Basic Dividend (UBI) Payout Engine</h3>

                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Treasury Surplus Allocation ({CURRENCY_NAME})</label>
                  <input
                    type="number"
                    value={ubiSurplusPool}
                    onChange={(e) => setUbiSurplusPool(Number(e.target.value))}
                    step={10000}
                    className="input w-full font-mono text-xs"
                  />
                </div>

                <div className="rounded-lg bg-surface p-3 font-mono text-xs space-y-1.5 border border-border">
                  <div className="flex justify-between text-muted">
                    <span>Active Verified Citizens:</span>
                    <span className="text-foreground">10,000</span>
                  </div>
                  <div className="flex justify-between text-muted">
                    <span>Dividend Per Citizen:</span>
                    <span className="font-bold text-emerald-700">+{ubiPerCitizen} {CURRENCY_NAME}</span>
                  </div>
                  <div className="flex justify-between text-muted">
                    <span>Fractional Remainder:</span>
                    <span className="text-foreground">{ubiRemainder} {CURRENCY_NAME} (Held in Treasury)</span>
                  </div>
                </div>

                <button onClick={handleExecuteUBI} className="btn btn-primary w-full py-2.5 text-xs uppercase tracking-wider">
                  Disburse Sovereign Dividend Run
                </button>
              </div>

              {/* National Referendum Voting */}
              <div className="card p-5 space-y-4">
                <div className="flex justify-between items-center border-b border-border pb-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Active Sovereign Referendum</h3>
                  <span className="rounded bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-800">REF-2026-04</span>
                </div>

                <p className="text-sm font-semibold text-foreground">
                  &ldquo;Reduce P2P Transfer Tax from 1.0% to 0.75% for Transactions under 500 {CURRENCY_NAME}&rdquo;
                </p>
                <p className="text-xs text-muted">
                  Aimed at stimulating citizen micro-commerce and social feed tipping.
                </p>

                <div className="space-y-1.5 font-mono text-xs">
                  <div className="flex justify-between text-muted">
                    <span>YES: <strong className="text-emerald-700">{refVotes.yes.toLocaleString()}</strong></span>
                    <span>NO: <strong className="text-red-700">{refVotes.no.toLocaleString()}</strong></span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-border overflow-hidden flex">
                    <div style={{ width: `${(refVotes.yes / (refVotes.yes + refVotes.no)) * 100}%` }} className="bg-emerald-600 h-full"></div>
                    <div style={{ width: `${(refVotes.no / (refVotes.yes + refVotes.no)) * 100}%` }} className="bg-red-600 h-full"></div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <button
                    onClick={() => handleVoteReferendum("YES")}
                    disabled={refVotes.userVoted}
                    className="btn btn-secondary py-2 text-xs text-emerald-700 font-bold"
                  >
                    Vote YES
                  </button>
                  <button
                    onClick={() => handleVoteReferendum("NO")}
                    disabled={refVotes.userVoted}
                    className="btn btn-secondary py-2 text-xs text-red-700 font-bold"
                  >
                    Vote NO
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 2. LABOR & JURY TRIBUNAL */}
        {/* ========================================================================= */}
        {activeTab === "labor" && (
          <div className="space-y-6">
            <div className="card p-6">
              <span className="rounded bg-purple-100 px-2 py-0.5 text-[10px] font-bold text-purple-900 border border-purple-300">
                WORKFORCE PILLAR
              </span>
              <h2 className="text-xl font-bold tracking-tight text-foreground mt-1">Milestone Job Contracts & Citizen Dispute Tribunal</h2>
              <p className="text-xs text-muted mt-1 max-w-3xl">
                Milestone-locked wage escrows protect both parties. If work quality is contested, 3 randomly selected Citizens act as jurors, staking collateral to deliver an un-bribeable secret ballot settlement.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="card p-5 space-y-3 md:col-span-1">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Contract JOB-8842</h3>
                <div className="text-xs font-mono space-y-1.5">
                  <div className="flex justify-between"><span className="text-muted">Employer:</span> <span>@skyline_robotics</span></div>
                  <div className="flex justify-between"><span className="text-muted">Contractor:</span> <span>@arjun_engineer</span></div>
                  <div className="flex justify-between"><span className="text-muted">Contract Total:</span> <span className="font-bold">12,000 {CURRENCY_NAME}</span></div>
                  <div className="flex justify-between"><span className="text-muted">Disputed Escrow:</span> <span className="font-bold text-amber-700">{jobEscrowLocked.toLocaleString()} {CURRENCY_NAME}</span></div>
                </div>

                <div className="rounded-lg bg-surface p-2.5 text-xs font-mono space-y-1 border border-border">
                  <div className="flex justify-between"><span>M1: Spec</span> <span className="text-emerald-700 font-bold">PAID (3,000)</span></div>
                  <div className="flex justify-between"><span>M2: Implementation</span> <span className="text-amber-700 font-bold">{milestoneStatus}</span></div>
                  <div className="flex justify-between"><span>M3: Deployment</span> <span className="text-muted">PENDING (3,000)</span></div>
                </div>
              </div>

              <div className="card p-5 space-y-4 md:col-span-2">
                <div className="flex justify-between items-center border-b border-border pb-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Citizen Arbitration Panel (Case #ARB-702)</h3>
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                    {milestoneStatus === "DISPUTED" ? "DELIBERATION ACTIVE" : "CASE SETTLED"}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-3 font-mono text-xs">
                  <div className="rounded-lg bg-surface p-3 border border-border space-y-1">
                    <div className="font-bold text-foreground">Juror #1</div>
                    <div className="text-[10px] text-muted">Stake: 50 {CURRENCY_NAME}</div>
                    <div className="text-emerald-700 font-bold pt-1">{jurorVotes.j1 || "Awaiting Ballot"}</div>
                  </div>
                  <div className="rounded-lg bg-surface p-3 border border-border space-y-1">
                    <div className="font-bold text-foreground">Juror #2</div>
                    <div className="text-[10px] text-muted">Stake: 50 {CURRENCY_NAME}</div>
                    <div className="text-emerald-700 font-bold pt-1">{jurorVotes.j2 || "Awaiting Ballot"}</div>
                  </div>
                  <div className="rounded-lg bg-surface p-3 border border-border space-y-1">
                    <div className="font-bold text-foreground">Juror #3</div>
                    <div className="text-[10px] text-muted">Stake: 50 {CURRENCY_NAME}</div>
                    <div className="text-red-700 font-bold pt-1">{jurorVotes.j3 || "Awaiting Ballot"}</div>
                  </div>
                </div>

                {milestoneStatus === "DISPUTED" && (
                  <div className="flex gap-3 pt-2">
                    <button onClick={() => handleJurorVerdict("WORKER")} className="btn btn-primary flex-1 py-2 text-xs">
                      Vote: Release to Worker
                    </button>
                    <button onClick={() => handleJurorVerdict("EMPLOYER")} className="btn btn-secondary flex-1 py-2 text-xs text-red-700">
                      Vote: Refund Employer
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 3. CORPORATE PAYROLL */}
        {/* ========================================================================= */}
        {activeTab === "payroll" && (
          <div className="space-y-6">
            <div className="card p-6">
              <span className="rounded bg-cyan-100 px-2 py-0.5 text-[10px] font-bold text-cyan-900 border border-cyan-300">
                CORPORATE PILLAR
              </span>
              <h2 className="text-xl font-bold tracking-tight text-foreground mt-1">Automated Corporate Payroll Batches & Statutory Tax Withholding</h2>
              <p className="text-xs text-muted mt-1 max-w-3xl">
                Companies execute atomic monthly payroll rosters. 5% statutory income tax routes directly to the Government Treasury, while net balances credit instantaneously to employee accounts.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="card p-5 space-y-4 md:col-span-1">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Payroll Execution</h3>

                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Gross Payroll ({CURRENCY_NAME})</label>
                  <input
                    type="number"
                    value={payrollGross}
                    onChange={(e) => setPayrollGross(Number(e.target.value))}
                    step={5000}
                    className="input w-full font-mono text-xs"
                  />
                </div>

                <div className="rounded-lg bg-surface p-3 font-mono text-xs space-y-1.5 border border-border">
                  <div className="flex justify-between text-muted">
                    <span>Treasury Withholding (5%):</span>
                    <span className="text-amber-700 font-bold">+{payrollTax.toLocaleString()} {CURRENCY_NAME}</span>
                  </div>
                  <div className="flex justify-between text-muted">
                    <span>Net Employee Salaries:</span>
                    <span className="text-emerald-700 font-bold">{payrollNet.toLocaleString()} {CURRENCY_NAME}</span>
                  </div>
                  <div className="flex justify-between text-muted border-t border-border pt-1">
                    <span>Company Balance Debit:</span>
                    <span className="font-bold text-foreground">-{payrollGross.toLocaleString()} {CURRENCY_NAME}</span>
                  </div>
                </div>

                <button
                  onClick={handleExecutePayroll}
                  disabled={payrollExecuted}
                  className="btn btn-primary w-full py-2.5 text-xs uppercase tracking-wider"
                >
                  {payrollExecuted ? "Payroll Batch Settled" : "Execute Atomic Payroll"}
                </button>
              </div>

              <div className="card p-5 space-y-4 md:col-span-2">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Apex Dynamics Corp Roster (4 Employees)</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono text-left">
                    <thead>
                      <tr className="border-b border-border pb-2 text-muted">
                        <th className="py-2">EMPLOYEE</th>
                        <th className="py-2">ROLE</th>
                        <th className="py-2">GROSS</th>
                        <th className="py-2">TAX (5%)</th>
                        <th className="py-2">NET</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      <tr>
                        <td className="py-2.5 font-bold">@rohit_lead</td>
                        <td className="text-muted">Architect</td>
                        <td>40,000</td>
                        <td className="text-amber-700">2,000</td>
                        <td className="text-emerald-700 font-bold">38,000</td>
                      </tr>
                      <tr>
                        <td className="py-2.5 font-bold">@maya_ui</td>
                        <td className="text-muted">Designer</td>
                        <td>25,000</td>
                        <td className="text-amber-700">1,250</td>
                        <td className="text-emerald-700 font-bold">23,750</td>
                      </tr>
                      <tr>
                        <td className="py-2.5 font-bold">@karan_sec</td>
                        <td className="text-muted">Security</td>
                        <td>20,000</td>
                        <td className="text-amber-700">1,000</td>
                        <td className="text-emerald-700 font-bold">19,000</td>
                      </tr>
                      <tr>
                        <td className="py-2.5 font-bold">@ananya_ops</td>
                        <td className="text-muted">DevOps</td>
                        <td>15,000</td>
                        <td className="text-amber-700">750</td>
                        <td className="text-emerald-700 font-bold">14,250</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 4. CREDIT SCORE & SUCCESSION */}
        {/* ========================================================================= */}
        {activeTab === "credit" && (
          <div className="space-y-6">
            <div className="card p-6">
              <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-900 border border-emerald-300">
                BANKING & INCLUSION
              </span>
              <h2 className="text-xl font-bold tracking-tight text-foreground mt-1">On-Chain Aeros Credit Score (ACS: 300–850) & Succession Protocol</h2>
              <p className="text-xs text-muted mt-1 max-w-3xl">
                Transparent creditworthiness calculated from verifiable loan repayment history, milestone success ratings, and civic tenure. Succession timelocks protect assets against permanent inactivity.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* ACS Calculator */}
              <div className="card p-5 space-y-4">
                <div className="flex justify-between items-center border-b border-border pb-2">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Aeros Credit Score Simulator</h3>
                  <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">TIER 1 (PRIME)</span>
                </div>

                <div className="text-center py-2">
                  <div className="text-4xl font-extrabold font-mono text-foreground">{acsScore}</div>
                  <div className="text-xs text-muted mt-1">Max Borrowing Capacity: <strong className="text-emerald-700">{acsBorrowingLimit.toLocaleString()} {CURRENCY_NAME}</strong></div>
                </div>

                <div className="space-y-3 text-xs">
                  <div>
                    <div className="flex justify-between text-muted mb-1"><span>Loan Repayments (35%)</span> <span>{acsSliders.s1}%</span></div>
                    <input type="range" min={50} max={100} value={acsSliders.s1} onChange={(e) => setAcsSliders({ ...acsSliders, s1: Number(e.target.value) })} className="w-full" />
                  </div>
                  <div>
                    <div className="flex justify-between text-muted mb-1"><span>Balance Stability (30%)</span> <span>{acsSliders.s2}%</span></div>
                    <input type="range" min={50} max={100} value={acsSliders.s2} onChange={(e) => setAcsSliders({ ...acsSliders, s2: Number(e.target.value) })} className="w-full" />
                  </div>
                  <div>
                    <div className="flex justify-between text-muted mb-1"><span>Milestone Ratings (20%)</span> <span>{acsSliders.s3}%</span></div>
                    <input type="range" min={50} max={100} value={acsSliders.s3} onChange={(e) => setAcsSliders({ ...acsSliders, s3: Number(e.target.value) })} className="w-full" />
                  </div>
                  <div>
                    <div className="flex justify-between text-muted mb-1"><span>Civic Participation (15%)</span> <span>{acsSliders.s4}%</span></div>
                    <input type="range" min={50} max={100} value={acsSliders.s4} onChange={(e) => setAcsSliders({ ...acsSliders, s4: Number(e.target.value) })} className="w-full" />
                  </div>
                </div>
              </div>

              {/* Succession Switch */}
              <div className="card p-5 space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Inheritance Dead-Man&apos;s Switch</h3>
                <p className="text-xs text-muted">
                  Auto-transfers wallet assets to designated heirs if zero account activity occurs across the chosen tenure.
                </p>

                <div className="space-y-2 text-xs">
                  <label className="block text-muted">Beneficiary Wallet Address</label>
                  <input type="text" value="@aarav_son (0x7F2a...B490)" className="input w-full font-mono text-xs" readOnly />
                </div>

                <div className="rounded-lg bg-surface p-3 font-mono text-xs space-y-1.5 border border-border">
                  <div className="flex justify-between text-muted"><span>Inactivity Window:</span> <span className="text-foreground">180 Days</span></div>
                  <div className="flex justify-between text-muted"><span>Estate Duty Tax:</span> <span className="text-foreground">2.0% to Treasury</span></div>
                  <div className="flex justify-between text-muted"><span>Liveness Status:</span> <span className="text-emerald-700 font-bold">ACTIVE (Heartbeat OK)</span></div>
                </div>

                <button onClick={() => alert("Liveness heartbeat logged. Timer reset to 180 days.")} className="btn btn-secondary w-full py-2 text-xs">
                  Transmit Cryptographic Liveness Heartbeat
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 5. SOVEREIGN BONDS */}
        {/* ========================================================================= */}
        {activeTab === "bonds" && (
          <div className="space-y-6">
            <div className="card p-6">
              <h2 className="text-xl font-bold tracking-tight text-foreground">Sovereign Treasury Bonds & Term Yields</h2>
              <p className="text-xs text-muted mt-1 max-w-3xl">
                Absorbs excess circulating Aeros during market growth by letting Citizens and Companies lock capital for 7, 30, or 90 days at an annualized coupon rate backed by the Government Treasury.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="card p-5 space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Issue Bond Subscription</h3>

                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Principal Amount ({CURRENCY_NAME})</label>
                  <input
                    type="number"
                    value={bondPrincipal}
                    onChange={(e) => setBondPrincipal(Number(e.target.value))}
                    min={100}
                    step={100}
                    className="input w-full font-mono text-xs"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Tenor Duration</label>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    {[
                      { days: 7, apyBp: 350, label: "7 Days", apy: "3.5%" },
                      { days: 30, apyBp: 550, label: "30 Days", apy: "5.5%" },
                      { days: 90, apyBp: 800, label: "90 Days", apy: "8.0%" },
                    ].map((t) => (
                      <button
                        key={t.days}
                        onClick={() => setBondTenor({ days: t.days, apyBp: t.apyBp })}
                        className={`rounded-lg p-2 text-center transition ${
                          bondTenor.days === t.days ? "bg-foreground text-background font-bold" : "bg-surface text-muted hover:text-foreground"
                        }`}
                      >
                        {t.label}
                        <br />
                        <span className="text-[10px] opacity-75">{t.apy} APY</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg bg-surface p-3 font-mono text-xs space-y-1.5 border border-border">
                  <div className="flex justify-between text-muted">
                    <span>Coupon Rate:</span>
                    <span className="text-foreground">{(bondTenor.apyBp / 100).toFixed(1)}% ({bondTenor.apyBp} bp)</span>
                  </div>
                  <div className="flex justify-between text-muted">
                    <span>Calculated Yield:</span>
                    <span className="font-bold text-emerald-700">+{calculatedYield} {CURRENCY_NAME}</span>
                  </div>
                  <div className="flex justify-between text-muted border-t border-border pt-1">
                    <span>Maturity Total:</span>
                    <span className="font-bold text-foreground">{(bondPrincipal + calculatedYield).toLocaleString("en-IN")} {CURRENCY_NAME}</span>
                  </div>
                </div>

                <button onClick={handleSubscribeBond} className="btn btn-primary w-full py-2.5 text-xs uppercase tracking-wider">
                  Lock Capital in Sovereign Bond
                </button>
              </div>

              <div className="card p-5 lg:col-span-2 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Active Sovereign Bond Holdings</h3>
                  <span className="text-xs font-mono text-muted">{bondHoldings.length} Active Holdings</span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono text-left">
                    <thead>
                      <tr className="border-b border-border pb-2 text-muted">
                        <th className="py-2">BOND ID</th>
                        <th className="py-2">PRINCIPAL</th>
                        <th className="py-2">TENOR</th>
                        <th className="py-2">COUPON</th>
                        <th className="py-2">YIELD</th>
                        <th className="py-2 text-right">ACTION</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {bondHoldings.map((b) => (
                        <tr key={b.id}>
                          <td className="py-3 font-semibold text-foreground">{b.id}</td>
                          <td className="py-3 font-bold text-foreground">{b.principal.toLocaleString("en-IN")} {CURRENCY_NAME}</td>
                          <td className="py-3 text-muted">{b.tenorDays}d</td>
                          <td className="py-3 text-muted">{(b.apyBp / 100).toFixed(1)}%</td>
                          <td className="py-3 font-bold text-emerald-700">+{b.yieldAeros} {CURRENCY_NAME}</td>
                          <td className="py-3 text-right">
                            <button onClick={() => handleRedeemBond(b.id)} className="btn btn-secondary px-2 py-1 text-[11px]">
                              Redeem
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 6. CORPORATE EQUITY & DIVIDENDS */}
        {/* ========================================================================= */}
        {activeTab === "equity" && (
          <div className="space-y-6">
            <div className="card p-6">
              <h2 className="text-xl font-bold tracking-tight text-foreground">Corporate Share Capital & Automated Dividend Distribution</h2>
              <p className="text-xs text-muted mt-1 max-w-3xl">
                Companies issue share capital to Citizen investors and execute quarterly dividend runs. Statutory withholding tax automatically routes to the Treasury, with net proceeds distributed to shareholder wallets.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="card p-5 space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Declare Quarterly Dividend Pool</h3>

                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Gross Company Distribution ({CURRENCY_NAME})</label>
                  <input
                    type="number"
                    value={divGrossPool}
                    onChange={(e) => setDivGrossPool(Number(e.target.value))}
                    min={1000}
                    step={1000}
                    className="input w-full font-mono text-xs"
                  />
                </div>

                <div className="rounded-lg bg-surface p-3 font-mono text-xs space-y-1.5 border border-border">
                  <div className="flex justify-between text-muted">
                    <span>Gov Withholding Tax (5%):</span>
                    <span className="font-bold text-amber-700">+{govTaxDeducted.toLocaleString("en-IN")} {CURRENCY_NAME}</span>
                  </div>
                  <div className="flex justify-between text-muted">
                    <span>Net Shareholder Pool:</span>
                    <span className="font-bold text-emerald-700">{netShareholderPool.toLocaleString("en-IN")} {CURRENCY_NAME}</span>
                  </div>
                  <div className="flex justify-between text-muted border-t border-border pt-1">
                    <span>Dividend Per Share:</span>
                    <span className="font-bold text-foreground">{perShareDividend} {CURRENCY_NAME}</span>
                  </div>
                </div>

                <button
                  onClick={handleExecuteDividend}
                  disabled={dividendDistributed}
                  className="btn btn-primary w-full py-2.5 text-xs uppercase tracking-wider"
                >
                  {dividendDistributed ? "Dividend Run Executed" : "Execute Atomic Dividend Run"}
                </button>
              </div>

              <div className="card p-5 lg:col-span-2 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Corporate Cap Table (10,000 Authorized Shares)</h3>
                  <span className="text-xs font-mono text-muted">{dividendDistributed ? "Paid Just Now" : "Awaiting Distribution"}</span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono text-left">
                    <thead>
                      <tr className="border-b border-border pb-2 text-muted">
                        <th className="py-2">SHAREHOLDER</th>
                        <th className="py-2">ROLE</th>
                        <th className="py-2">SHARES</th>
                        <th className="py-2">OWNERSHIP</th>
                        <th className="py-2 text-right">NET PAYOUT</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {shareholders.map((s) => (
                        <tr key={s.handle}>
                          <td className="py-3 font-semibold text-foreground">{s.handle}</td>
                          <td className="py-3 text-muted">{s.role}</td>
                          <td className="py-3 font-bold text-foreground">{s.shares.toLocaleString()}</td>
                          <td className="py-3 text-muted">{s.pct.toFixed(2)}%</td>
                          <td className="py-3 text-right font-bold text-emerald-700">
                            {Math.floor((netShareholderPool * s.shares) / 10000).toLocaleString("en-IN")} {CURRENCY_NAME}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 7. 2-OF-3 MULTI-SIG */}
        {/* ========================================================================= */}
        {activeTab === "multisig" && (
          <div className="space-y-6">
            <div className="card p-6">
              <h2 className="text-xl font-bold tracking-tight text-foreground">Multi-Signature Corporate Treasury (2-of-3 Quorum)</h2>
              <p className="text-xs text-muted mt-1 max-w-3xl">
                Major corporate expenditures (&gt; 5,000 Aeros) require cryptographic quorum approval from at least 2 authorized company officers before funds release from corporate escrow.
              </p>
            </div>

            <div className="card p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between border-b border-border pb-4 gap-2">
                <div>
                  <span className="text-xs font-mono text-muted">PROPOSAL ID: #MS-9021</span>
                  <h3 className="text-base font-bold text-foreground">Purchase of Cloud GPU Cluster (30,000 {CURRENCY_NAME})</h3>
                </div>
                <span className={`rounded px-2.5 py-1 text-xs font-bold ${proposalExecuted ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                  {proposalExecuted ? "EXECUTED (2/2 QUORUM)" : `PENDING QUORUM (${approvalsCount}/2 Approvals)`}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 font-mono text-xs">
                <div className="rounded-lg bg-surface p-4 border border-border space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-foreground">Key 1: CEO</span>
                    <span className="text-emerald-700 font-bold">APPROVED</span>
                  </div>
                  <p className="text-muted">@founder_raj (0x4B...99a)</p>
                  <div className="text-[10px] text-muted">Signed at 10:14:02 UTC</div>
                </div>

                <div className="rounded-lg bg-surface p-4 border border-border space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-foreground">Key 2: CFO</span>
                    <span className={multisigSignatures.cfo ? "text-emerald-700 font-bold" : "text-amber-700 font-bold"}>
                      {multisigSignatures.cfo ? "APPROVED" : "PENDING"}
                    </span>
                  </div>
                  <p className="text-muted">@finance_lead (0x8A...21c)</p>
                  {!multisigSignatures.cfo && (
                    <button onClick={handleSignCFO} className="btn btn-secondary w-full py-1.5 text-xs text-emerald-700">
                      Sign Proposal (CFO)
                    </button>
                  )}
                </div>

                <div className="rounded-lg bg-surface p-4 border border-border space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-foreground">Key 3: Auditor</span>
                    <span className="text-muted">QUORUM MET</span>
                  </div>
                  <p className="text-muted">@external_audit (0x1F...47e)</p>
                  <div className="text-[10px] text-muted">Approval threshold satisfied</div>
                </div>
              </div>

              {approvalsCount >= 2 && !proposalExecuted && (
                <button onClick={handleExecuteMultisig} className="btn btn-primary w-full py-2.5 text-xs uppercase tracking-wider">
                  Execute Quorum Payout
                </button>
              )}
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 8. SYNTHETIC TRADING */}
        {/* ========================================================================= */}
        {activeTab === "trading" && (
          <div className="space-y-6">
            <div className="card p-6">
              <h2 className="text-xl font-bold tracking-tight text-foreground">Hedge Trading with Take-Profit & Stop-Loss Engine</h2>
              <p className="text-xs text-muted mt-1 max-w-3xl">
                Opposing positions never auto-net. Automated limit triggers execute upon AMI price tick breaches, releasing margin locked in Treasury reserves.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
              <div className="card p-5 space-y-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Open Hedge Position</h3>

                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Direction</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setTradeDirection("BUY")}
                      className={`btn py-2 text-xs font-bold ${tradeDirection === "BUY" ? "bg-emerald-100 text-emerald-800 border-emerald-300" : "btn-secondary text-muted"}`}
                    >
                      LONG (Buy)
                    </button>
                    <button
                      onClick={() => setTradeDirection("SELL")}
                      className={`btn py-2 text-xs font-bold ${tradeDirection === "SELL" ? "bg-red-100 text-red-800 border-red-300" : "btn-secondary text-muted"}`}
                    >
                      SHORT (Sell)
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Quantity (Units)</label>
                  <input
                    type="number"
                    value={tradeQuantity}
                    onChange={(e) => setTradeQuantity(Number(e.target.value))}
                    min={1}
                    className="input w-full font-mono text-xs"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-foreground mb-1">Leverage Tier</label>
                  <select
                    value={tradeLeverage}
                    onChange={(e) => setTradeLeverage(Number(e.target.value))}
                    className="input w-full font-mono text-xs"
                  >
                    <option value={2}>2x Leverage</option>
                    <option value={4}>4x Leverage</option>
                    <option value={8}>8x Leverage</option>
                    <option value={10}>10x Leverage</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-muted mb-1">Take-Profit Price</label>
                    <input
                      type="number"
                      value={takeProfitPrice}
                      onChange={(e) => setTakeProfitPrice(Number(e.target.value))}
                      className="input w-full font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-muted mb-1">Stop-Loss Price</label>
                    <input
                      type="number"
                      value={stopLossPrice}
                      onChange={(e) => setStopLossPrice(Number(e.target.value))}
                      className="input w-full font-mono text-xs"
                    />
                  </div>
                </div>

                <div className="rounded-lg bg-surface p-3 font-mono text-xs space-y-1 border border-border">
                  <div className="flex justify-between text-muted">
                    <span>Required Margin:</span>
                    <span className="font-bold text-foreground">{requiredMargin.toLocaleString()} {CURRENCY_NAME}</span>
                  </div>
                  <div className="flex justify-between text-muted">
                    <span>Current Benchmark:</span>
                    <span className="text-foreground">{simEconomy.amiPrice} {CURRENCY_NAME}</span>
                  </div>
                </div>

                <button onClick={handleOpenPosition} className="btn btn-primary w-full py-2.5 text-xs uppercase tracking-wider">
                  Open Position & Lock Margin
                </button>
              </div>

              <div className="card p-5 lg:col-span-2 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Open Positions</h3>
                  <span className="text-xs font-mono text-muted">{openPositions.length} Active</span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono text-left">
                    <thead>
                      <tr className="border-b border-border pb-2 text-muted">
                        <th className="py-2">ID</th>
                        <th className="py-2">SIDE</th>
                        <th className="py-2">QTY</th>
                        <th className="py-2">LEV</th>
                        <th className="py-2">ENTRY</th>
                        <th className="py-2">MARGIN</th>
                        <th className="py-2 text-right">ACTION</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {openPositions.map((pos) => (
                        <tr key={pos.id}>
                          <td className="py-3 font-bold text-foreground">{pos.id}</td>
                          <td className="py-3 font-bold text-emerald-700">{pos.direction}</td>
                          <td className="py-3">{pos.qty} units</td>
                          <td className="py-3 text-muted">{pos.leverage}x</td>
                          <td className="py-3">{pos.entryPrice}</td>
                          <td className="py-3 font-bold">{pos.marginLocked} {CURRENCY_NAME}</td>
                          <td className="py-3 text-right">
                            <button onClick={() => handleClosePosition(pos.id, 200)} className="btn btn-secondary px-2 py-1 text-[11px]">
                              Close (+200)
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* 9. 15-REPO GITHUB ARCHIVE & ZK */}
        {/* ========================================================================= */}
        {activeTab === "archive" && (
          <div className="space-y-6">
            <div className="card p-6">
              <h2 className="text-xl font-bold tracking-tight text-foreground">15-Repository GitHub Historical Archival Architecture</h2>
              <p className="text-xs text-muted mt-1 max-w-3xl">
                Historical records older than 24 hours (7 days for social media) migrate to dedicated GitHub repositories with an automated 900 MB rollover cap and remote read-back SHA-256 verification.
              </p>
            </div>

            <div className="card p-5 space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Archive Storage Capacities</h3>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {archiveRepos.map((r) => {
                  const pct = Math.min(100, Math.round((r.sizeMb / 900) * 100));
                  return (
                    <div key={r.name} className="rounded-lg bg-surface p-3 font-mono text-xs border border-border space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-foreground truncate max-w-[150px]">{r.label}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                            r.status === "ROLLOVER"
                              ? "bg-red-100 text-red-800"
                              : r.status === "WARNING"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-emerald-100 text-emerald-800"
                          }`}
                        >
                          {r.status}
                        </span>
                      </div>
                      <div className="flex justify-between text-[10px] text-muted">
                        <span>{r.sizeMb} MB</span>
                        <span>900 MB Cap</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-border overflow-hidden">
                        <div
                          className={`h-full ${
                            r.sizeMb >= 900 ? "bg-red-600" : r.sizeMb >= 800 ? "bg-amber-600" : "bg-emerald-600"
                          }`}
                          style={{ width: `${pct}%` }}
                        ></div>
                      </div>
                      <button
                        onClick={() => handleSimulateSurge(r.name)}
                        className="w-full text-center text-[10px] text-muted hover:text-foreground pt-1 border-t border-border"
                      >
                        + Surge 180MB
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted">Cryptographic Merkle Solvency Root</h3>
                <button onClick={handleGenerateMerkleProof} className="btn btn-secondary px-3 py-1 text-xs">
                  Re-Hash Proof
                </button>
              </div>

              <div className="rounded-lg bg-surface p-4 font-mono text-xs space-y-2 border border-border">
                <div className="flex justify-between text-muted">
                  <span>ACCOUNT LEAF COUNT:</span>
                  <span className="text-foreground">10,051 Wallets (Verified Citizens + Companies + Treasury)</span>
                </div>
                <div className="flex justify-between text-muted">
                  <span>PROVEN TOTAL SUPPLY:</span>
                  <span className="font-bold text-emerald-700">{simEconomy.totalSupply.toLocaleString("en-IN")} {CURRENCY_NAME}</span>
                </div>
                <div className="flex justify-between text-muted">
                  <span>ROOT SHA-256 HASH:</span>
                  <span className="font-semibold text-foreground break-all">{merkleHash}</span>
                </div>
              </div>
            </div>
          </div>
        )}

      </main>

      {/* Institutional Footer */}
      <footer className="border-t border-border py-6 text-center text-xs text-muted">
        Aeros Pay Sovereign Civilization • V6 Future Laboratory Prototype
      </footer>
    </div>
  );
}
