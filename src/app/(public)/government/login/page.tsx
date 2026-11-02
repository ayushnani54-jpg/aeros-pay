import { notFound } from "next/navigation";

/**
 * V6 Security: Public Government login route has been permanently decommissioned.
 * Administrative access is restricted to the protected access gateway.
 */
export default function LegacyGovernmentLoginPage() {
  notFound();
}
