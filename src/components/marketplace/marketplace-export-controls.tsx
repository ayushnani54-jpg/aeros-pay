"use client";

import { useState } from "react";

interface ExportControlsProps {
  title: string;
  category: string;
  priceText: string;
  sellerName: string;
  sellerHandle: string;
  description: string;
  listedDate: string;
  isOwner?: boolean;
}

export function MarketplaceExportControls({
  title,
  category,
  priceText,
  sellerName,
  sellerHandle,
  description,
  listedDate,
  isOwner = false,
}: ExportControlsProps) {
  const [copiedText, setCopiedText] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const formattedContent = `
AEROS PAY MARKETPLACE LISTING
========================================
Title       : ${title}
Category    : ${category}
Price       : ${priceText}
Seller      : ${sellerName} (@${sellerHandle})
Listed Date : ${listedDate}
========================================

DESCRIPTION:
${description}

----------------------------------------
Exported from Aeros Pay Sovereign Virtual Economy Platform
Verified Ledger Content • Integrity Protected
`.trim();

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(formattedContent);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2500);
    } catch (e) {
      console.warn("Failed to copy text:", e);
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch (e) {
      console.warn("Failed to copy link:", e);
    }
  };

  const handleDownload = (format: "txt" | "md") => {
    let content = formattedContent;
    if (format === "md") {
      content = `# ${title}\n\n**Category:** ${category}  \n**Price:** ${priceText}  \n**Seller:** [${sellerName}](/@${sellerHandle})  \n**Listed Date:** ${listedDate}  \n\n## Description\n\n${description}\n\n---\n*Exported from Aeros Pay Sovereign Virtual Economy Platform*`;
    }

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const sanitizedTitle = title.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase().slice(0, 32);
    a.href = url;
    a.download = `aeros-offer-${sanitizedTitle}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card p-4 bg-surface/40 border-border space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
          {isOwner ? "Owner Content & Export Tools" : "Share & Content Tools"}
        </span>
        <span className="text-[10px] font-mono text-muted">AEROS EXPORT V6</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleCopyText}
          className="btn btn-secondary text-xs px-3 py-1.5"
        >
          {copiedText ? "✓ Text Copied" : "Copy Listing Text"}
        </button>

        <button
          type="button"
          onClick={handleCopyLink}
          className="btn btn-secondary text-xs px-3 py-1.5"
        >
          {copiedLink ? "✓ Link Copied" : "Copy Public Link"}
        </button>

        <button
          type="button"
          onClick={() => handleDownload("txt")}
          className="btn btn-secondary text-xs px-3 py-1.5 font-mono"
        >
          Download .txt
        </button>

        <button
          type="button"
          onClick={() => handleDownload("md")}
          className="btn btn-secondary text-xs px-3 py-1.5 font-mono"
        >
          Download .md
        </button>
      </div>
    </div>
  );
}
