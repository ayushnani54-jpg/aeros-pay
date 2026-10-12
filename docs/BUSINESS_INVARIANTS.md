# Aeros Pay — Business & Economic Invariants

## 1. Monetary Unit & Integer Invariant
- **Unit of Currency**: **Aeros**.
- **Representation**: Strictly whole-number integers (`integer` in PostgreSQL, `Math.round()` / integer validation in TypeScript).
- **Prohibition**: Fractional Aeros, floating-point currencies, or decimal amounts are strictly forbidden. Any calculation producing a fraction must be explicitly rounded according to system rules.
- **Basis Points**: All interest rates, tax rates, collateral ratios, and fee percentages are stored as integer Basis Points (`bp`), where $100\text{ bp} = 1.00\%$ and $10000\text{ bp} = 100\%$.

---

## 2. Total Circulating Supply Invariant
The fundamental macroeconomic equation of Aeros Pay is:
$$\text{Total Circulating Supply} = \sum \text{Citizen Balances} + \sum \text{Company Balances} + \text{Government Treasury Balance}$$

### Invariant Rules:
1. **Conservation of Money**: Peer-to-peer transfers, invoice payments, escrow locks, loan disbursements/repayments, market buy/sell/short/cover executions, and refund settlements are **strictly zero-sum**. Money is transferred between accounts or locked into reserves, never created or destroyed.
2. **Authorized Supply Expansion**: Only an approved Government monetary issuance (`ISSUANCE_CREDIT` executed by an authenticated administrator) increases total supply. Newly issued Aeros are credited directly to the Government Treasury.
3. **Treasury Reserve Solvency**: The Government Treasury balance cannot drop below zero.

---

## 3. Transaction Atomicity & Idempotency
- **PostgreSQL Transactions**: Every balance alteration, transfer tax split, escrow release, or market trade must be wrapped in `db.transaction(...)`.
- **Row-Level Locking**: Accounts being credited or debited must be locked using PostgreSQL row-level `FOR UPDATE` locks prior to reading balances and applying modifications (`src/lib/wallets.ts`).
- **Idempotency Keys**: All client actions that mutate financial state require a client-generated UUID `idempotency_key`. A duplicate submission returns the cached result without re-executing balance mutations.

---

## 4. Multi-Workflow Settlement & Double-Spend Guards

### A. Invoices (`invoices`)
- States: `DRAFT`, `PENDING`, `PAID`, `CANCELLED`, `EXPIRED`.
- Invariant: An invoice in state `PAID`, `CANCELLED`, or `EXPIRED` is in a terminal state and cannot be paid again or re-activated.

### B. Marketplace Escrow (`marketplace_orders`)
- Creation: When an order is placed, Aeros are debited from the buyer and held in escrow (`ESCROW_LOCKED`).
- Settlement:
  - Fulfillment: Buyer or timeout releases escrow (`ESCROW_RELEASED`), crediting the seller's corporate wallet minus marketplace tax.
  - Dispute/Cancellation: Escrow is refunded (`ESCROW_REFUNDED`), returning funds to the buyer.
- Invariant: Escrow funds can settle exactly once. Mutual exclusion between release and refund is guaranteed atomically.

### C. Milestone & Bounty Contracts (`marketplace_contracts`)
- Locked Escrow: Contract creator funds the bounty upon creation.
- Award: Released to contractor upon verification of milestone delivery.
- Invariant: Bounties cannot be paid out twice or refunded after payment.

### D. Corporate Loans (`loans`, `loan_instalments`)
- Approval & Disbursement: Disburses loan principal from Government Treasury to company wallet.
- Repayment: Instalments are repaid from the company balance back to Treasury.
- Invariant: Instalments are tracked by sequence number and cannot be paid multiple times. Overpaying past total debt is rejected.

### E. Virtual Refund Center (`refund_requests`)
- Lifecycle: `SUBMITTED -> UNDER_REVIEW / DELAYED -> APPROVED / REJECTED -> REFUNDED`.
- Invariant: When approved, the payout (`REFUND_CREDIT`) transfers Aeros from Government Treasury to Citizen in the same transaction that sets the status to `REFUNDED`. It cannot be executed twice.

---

## 5. Synthetic Market & Short-Selling Invariants

### A. Index Pricing Invariant
- The Aeros Market Index (AMI) is deterministic across time buckets (`5m`, `15m`, `1h`).
- Viewing or refreshing charts never shifts candle history or causes price drift.
- Order flow price movement is bounded by `maxStepChangeBp` to prevent manipulative market swings.

### B. Short Selling & Collateral Guarantees
- Collateralization: Opening a short position locks collateral equal to $\text{units} \times \text{entryPrice} \times \frac{\text{shortCollateralRatioBp}}{10000}$ (default $100\%$) from citizen balance into Treasury reserves.
- Short P&L Formula:
  $$\text{Realized P&L} = (\text{entryNotional} - \text{coverNotional})$$
- Payout Calculation:
  $$\text{Payout} = \max\left(0, \text{lockedCollateral} + \text{realizedPnL}\right)$$
- Non-Negative Balance Invariant: Even under an extreme $\ge 2\times$ price spike, the payout is clamped at 0. A short seller's balance **never** becomes negative.

---

## 6. Authorization & Role Separation
- **Server-Side Enforcement**: All administrative actions (`/gov/*`) require valid, unexpired Government session tokens (`getGovSession()`).
- **Feature Toggles**: When a feature is disabled via the Control Room (`government.transfersEnabled === false`), Server Actions immediately reject requests with user-facing error messages before opening database transactions.
