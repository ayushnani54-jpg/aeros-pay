# Aeros Pay — Security Model & Guidelines

## 1. Threat Model & Security Posture

Aeros Pay functions as a sovereign virtual economic system. Threats include:
1. **Double-Spend & Race Conditions**: Exploiting concurrent network requests to duplicate balances or settle invoices/escrow twice.
2. **Unauthorized Monetary Expansion**: Attempting to invoke issuance or treasury adjustment actions without Government credentials.
3. **Negative Balance Exploitation**: Manipulating market price swings (e.g. short selling spikes) to drive user balances negative.
4. **Credential & Secret Leakage**: Exposing database URLs, GitHub tokens, password hashes, or session secrets to source control or public archives.
5. **Replay Attacks**: Re-submitting historical requests or reusing invalidated sessions.

---

## 2. Authentication & Session Architecture

### A. Stateless HMAC-SHA256 Sessions
- Session tokens are stored in tamper-proof cookies signed with HMAC-SHA256 (`SESSION_SECRET` / `GOV_SESSION_SECRET`).
- Cookie flags: `httpOnly: true`, `sameSite: "lax"`, `secure: true` (in production).
- Citizen cookie: `aeros_session` (max age: 7 days).
- Government cookie: `aeros_gov_session` (max age: 8 hours).

### B. Session Epochs & Immediate Revocation
- Passwords are hashed using bcrypt (`bcryptjs` with salt rounds = 10).
- The `users` table contains `session_epoch integer`.
- When an administrator resets a user's password or an account is suspended/banned, `session_epoch` is incremented.
- Existing session tokens retain the old epoch; requests are immediately rejected by `getCurrentUser()` without database lookups on subsequent requests.

### C. Government Role Segregation
- Government administrators authenticate via a segregated login portal (`/government/login`) using separate credentials (`username`, `password`, `securityCode`).
- Session validation checks `government.isSuperAdmin` and status flags.

---

## 3. Financial Concurrency & Race-Condition Defense

1. **Row-Level Locks (`FOR UPDATE`)**:
   All balance mutations lock affected user/company/government wallet rows inside an explicit PostgreSQL transaction before checking solvency:
   ```typescript
   const [wallet] = await tx
     .select()
     .from(users)
     .where(eq(users.id, userId))
     .for("update");
   if (wallet.balance < amount) throw new Error("Insufficient funds");
   ```
2. **Client Idempotency Keys**:
   All mutation forms submit a UUID `idempotency_key`. The `idempotency_keys` table tracks status (`PENDING`, `COMPLETED`, `FAILED`) and caches response payloads. Concurrent or duplicate requests with the same key are safely deduplicated.
3. **Negative Balance Clamping**:
   - Short selling cover operations (`COVER`) clamp payouts at $\max(0, \text{lockedCollateral} + \text{realizedPnL})$. Even on a $\ge 2\times$ price spike, balances can never become negative.

---

## 4. Archival Sanitization & Secret Isolation

- **Sanitization Pipeline**: All records destined for GitHub archives pass through `sanitizeRecordForArchive`:
  ```typescript
  // Strips: passwordHash, password_hash, securityCodeHash, security_code_hash, session tokens
  ```
- **Read-Back SHA-256 Checksum**: Remote payloads are read back from GitHub and verified byte-for-byte before Neon records are cleared.
- **Server-Only Protection**: All database access, crypto helpers, and archival clients include `import "server-only";` to guarantee zero client bundle leakage.
