/**
 * Global Platform Maintenance Mode Toggle
 *
 * When `MAINTENANCE_MODE` is `true`:
 * - All public traffic (home, login, register) and direct navigation to citizen app areas
 *   are presented with the institutional maintenance screen.
 * - Public logins and new account registrations are safely paused.
 * - All existing databases, citizen balances, and historical archives remain 100% intact.
 *
 * To toggle maintenance mode:
 * - In code: Change MAINTENANCE_MODE to false below.
 * - Or via environment variable: Set NEXT_PUBLIC_MAINTENANCE_MODE="false" in Vercel.
 */
export const MAINTENANCE_MODE: boolean =
  process.env.NEXT_PUBLIC_MAINTENANCE_MODE === "false" ? false : true;

export const MAINTENANCE_DETAILS = {
  appName: "Aeros Pay",
  title: "Aeros Pay is Temporarily Unavailable",
  badge: "SYSTEM MAINTENANCE • SOVEREIGN NETWORK",
  headline: "Scheduled Development & Infrastructure Upgrade in Progress",
  message:
    "Aeros Pay is currently undergoing scheduled development, infrastructure upgrades, and system enhancements. Access to citizen accounts, logins, and new account registrations is temporarily paused while updates are applied.",
  status: "Scheduled Development in Progress",
  supportEmail: "aerospay.official@gmail.com",
  assurances: [
    {
      title: "Citizen Accounts & Balances Safe",
      description:
        "All existing integer Aeros balances, corporate accounts, and transactions remain 100% secure and intact in the database.",
    },
    {
      title: "Permanent Archives Protected",
      description:
        "15-repository GitHub historical archival records, index trees, and audit trails remain cryptographically verified.",
    },
    {
      title: "Seamless Service Resumption",
      description:
        "Citizen access, login services, and registration will automatically resume once the scheduled update rollout is completed.",
    },
  ],
} as const;

