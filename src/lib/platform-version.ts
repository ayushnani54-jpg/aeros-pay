/**
 * AEROS PAY — CANONICAL PLATFORM VERSIONING & RELEASE REGISTRY
 *
 * This file is the single source of truth for user-facing platform upgrades.
 *
 * HOW IT WORKS:
 * Whenever a new platform version is deployed:
 * 1. Increment `CURRENT_PLATFORM_VERSION` (e.g. "6.1.0").
 * 2. Prepend a new release object to `PLATFORM_RELEASES` with user-facing highlights.
 * 3. Any citizen, business, or visitor visiting the application will automatically
 *    see a clean upgrade prompt detailing the improvements.
 *
 * CONFIDENTIALITY RULE:
 * Backend internals, internal hashes, secrets, and private administrative routes
 * MUST NEVER be included in these public release highlights.
 */

export const CURRENT_PLATFORM_VERSION = "6.0.0";
export const PLATFORM_VERSION_STORAGE_KEY = "aeros_last_seen_platform_version";

export interface PlatformRelease {
  version: string;
  title: string;
  releaseDate: string;
  tagline: string;
  highlights: string[];
  docUrl?: string;
}

export const PLATFORM_RELEASES: PlatformRelease[] = [
  {
    version: "6.0.0",
    title: "Aeros Pay V6.0 — Identity, Security & Pure Dark Architecture",
    releaseDate: "November 2026",
    tagline: "A foundational upgrade bringing automated email verification, pure institutional dark mode, in-app support, and enhanced sovereign identity controls.",
    highlights: [
      "Automated 8-Digit Email Verification: Safe account onboarding with secure email code delivery.",
      "Pure Dark & Grayish Theme: Sleek, high-contrast dark mode with zero neon glare and adaptive brand logo.",
      "In-App Official Support: Direct support ticketing system for bug reports, account assistance, and inquiries.",
      "Three-Tier Identity Progression: Unverified → Verified Limited → Active Member access architecture.",
      "Government Authority Gateway: Hardened administrative access with cryptographic single-use activation codes.",
      "Integer Monetary System: 100% whole-number Aeros supply preservation across all transactions.",
    ],
  },
  {
    version: "5.0.0",
    title: "Aeros Pay V5.0 — 15-Repository GitHub Historical Archival & Social Media",
    releaseDate: "October 2026",
    tagline: "Introduction of multi-repository cold storage, citizen jobs board, and text-only Aeros Media platform.",
    highlights: [
      "15-Repository cold archival system with 900 MB automatic rollover safeguards.",
      "Aeros Media text-only sovereign social microblogging feed with @mentions.",
      "Citizen Jobs Board and corporate partnership profit-sharing contracts.",
      "Hedge-style independent BUY (Long) and SELL (Short) market positions.",
    ],
  },
];

export function getLatestRelease(): PlatformRelease {
  return PLATFORM_RELEASES[0];
}

