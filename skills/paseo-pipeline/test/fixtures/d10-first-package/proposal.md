# Ticket-driven expense form (D10)

## Why

Source: `docs/specs/2026-11-03-ticket-driven-expense-form-redesign.md` (spec) and `docs/adr/0001-ticket-driven-expense-settlement-rules.md` (ADR, Accepted). The expense form must become ticket-driven while keeping every Kingdee field and the accepted settlement rules. Baseline already carries most of the settlement mechanics; this change closes the gaps verified below.

## What Changes

Rule list (R-ids reused in Baseline). `GAP` = this change builds it; `SATISFIED` = baseline already does it, no task; `DEFERRED` = needs an OPEN-DECISION.

- R1 GAP — 1:N split: one invoice backing N entries emits N invoice entries, same code/number, amount apportioned, `bizEntryBill` per entry (ADR 2.2).
- R2 GAP — Partial claim: sum of entry amounts bound to one invoice may be < face amount; > face amount is blocked inline (ADR 2.1, ADR 3 constraint).
- R3 SATISFIED — Tax back-calculation `tax = amount*rate/(1+rate)`.
- R4 SATISFIED — No-ticket entry: rate 0, tax 0, without-tax = amount, no invoice entry (ADR 2.4).
- R5 SATISFIED — One-bill lock: an invoice held by one bill cannot be used by another bill; ADR `CONSUMED` maps to baseline `LOCKED`/`SETTLED` (no enum, no migration).
- R6 GAP — Multi-loan offset: auto-allocate oldest-`bizDate` first, manual per-loan adjustment kept (ADR 2.5).
- R7 SATISFIED — Net settlement three tiers and collection amount = net (spec 3.4).
- R8 PARTIAL — Own payee pick (`mine=1`) SATISFIED; "save this account to my archive" checkbox (default off) GAP (spec 3.4).
- R9 SATISFIED — Refund bill needs no mandatory loan offset (ADR 3): baseline has no mandatory offset gate at all.
- R10 DEFERRED — Travel/contract/refund linkage slots, travel over-budget soft warning, cause auto-prefix (spec 3.2/3.3, ADR 2.3): OD-5.
- R11 GAP — Remove compliance dashboard and approval-path preview; blocking issues stay blocking and are shown inline (spec 1.2, 3.5).
- R12 DEFERRED — Header manual control-total mode (spec 3.2): OD-4.

## Capabilities

### New Capabilities
- `ticket-driven-expense`: ticket-driven expense form behaviour: 1:N/partial invoice mapping, FIFO loan allocation, payee archive save, noise removal.

### Modified Capabilities
- none (baseline `bill-filing-ui` / `invoice-lease-ledger` requirements stay as written; see OD-1).

## Impact

Web only: `packages/web/src/utils/ticket-entries-payload.ts`, `packages/web/src/utils/invoice-reconciliation.ts`, `packages/web/src/components/forms/LoanOffsetPicker.tsx`, `packages/web/src/components/forms/PayeeEntriesEditor.tsx`, new `packages/web/src/utils/payee-archive-save.ts`, `packages/web/src/components/forms/ExpenseBillForm.tsx`, and their tests. No server, schema, enum or migration change. External write: payee archive save reuses existing `POST /master-data/payees`.

## Frozen interfaces

Consumed by T-04 through `Depends on` (no skeleton; producers merge first).
- T-01 `buildTicketEntries({ invoices, entryRows, ticketTypes })` (`packages/web/src/utils/ticket-entries-payload.ts`): one row per entry row whose `invoiceKey` matches, `bizEntryBill` = that row id, `amout`/`tax` apportioned by row amount ratio, last row absorbs cents (OD-2 A). `entryRows` items gain optional `amount: number`; single bound row keeps `amout` = face total.
- T-01 `checkInvoiceSplitBalance` (`packages/web/src/utils/invoice-reconciliation.ts`): `balanced` true when line total ≤ face; when above, `balanced` false, `difference` negative and `message` names invoice number and excess.
- T-03 `PayeeEntryRow.saveToArchive?: boolean` (default false, not offered when `source` is the archive import); `saveCheckedPayees(rows): Promise<Array<{ key: string; error: string }>>` in `packages/web/src/utils/payee-archive-save.ts`, calls `createPayeeProfile` (`packages/web/src/api/payeeProfiles.ts:147`) once per checked manual row, never throws.
- T-02 `LoanOffsetPicker` keeps its props; allocation behaviour per SCEN-TDE-04.

## Baseline

Baseline SHA `547c5bd8141e6ad930ff4f4da049ab62380a461b`.

- R1 `packages/web/src/utils/ticket-entries-payload.ts:57-86`: one invoice entry per invoice, `amout` = face `totalAmount`, `bizEntryBill` = first linked row only. A split invoice leaves rows 2..N without invoice entry (ADR 2.2 orphan). Field is Kingdee spelling `amout` (`:5`), not spec's `amount`. Call site `packages/web/src/components/forms/ExpenseBillForm.tsx:2405`. Server contract test `packages/server/test/ticket-entries-bizlink.test.ts` pins first-row behaviour.
- R2 `packages/web/src/utils/invoice-reconciliation.ts:88-90`: `balanced = diffCents === 0` — exact equality; used as submit error at `packages/web/src/components/forms/ExpenseBillForm.tsx:2244-2256`. Partial claim is blocked today. Server ledger already allows lease ≤ face (`packages/server/src/db/index.ts:1593`, `INVOICE_INSUFFICIENT_LIMIT` at `:1636-1638`).
- R3 `packages/web/src/components/forms/InvoiceSplitViewer.tsx:273,305,324`: `tax = amount*rate/(1+rate)` already in cents. Rate option list not re-verified (UNVERIFIED, no task).
- R4 `packages/web/src/components/forms/ExpenseBillForm.tsx:1945-1950` (SCEN-BFU-13) and `:2075`: no-invoice row forces rate/tax 0 and emits no invoice entry.
- R5 enum `packages/server/src/services/invoice-lease-service.ts:90` `'LOCKED' | 'SETTLED' | 'RELEASED'`; storage `CHECK (status IN ('LOCKED','SETTLED','RELEASED'))` `packages/server/src/db/index.ts:189`. Submit gate `packages/server/src/services/bill-submit-service.ts:1283` `assertNoCrossBillOccupancy` with policy `SINGLE_BILL_EXCLUSIVE` (`invoice-lease-service.ts:331-334`), covered by `packages/server/test/bill-submit-invoice-wiring.test.ts:201`. Reject/withdraw releases leases (`packages/server/src/services/approval-service.ts:3070`). No `CONSUMED` exists.
- R6 `packages/web/src/components/forms/LoanOffsetPicker.tsx:492-503`: each toggle suggests `min(availableBalance, expense)` in click order, ignoring `bizDate` and earlier lines; manual input `:511`. Server `calculateOffset` is greedy in input order (`packages/server/src/services/loan-offset-service.ts:168-195`) and honours explicit `checkAmount` (`:183-191`), so FIFO belongs in the picker. `PendingLoanItem.bizDate` exists (`loan-offset-service.ts:64`).
- R7 `packages/web/src/components/forms/ExpenseBillForm.tsx:1739` `requiresPayee = netPayoutAmount > 0`; copy `:3080-3081`; payee balance gate SCEN-BFU-15 `:2257-2262`.
- R8 `packages/web/src/components/forms/PayeeAccountPicker.tsx:181` and `PayeeDirectoryModal.tsx:77` send `mine=1`; server `packages/server/src/routes/bill-routes.ts:394`. No save-to-archive checkbox anywhere in `packages/web/src`. Create endpoint `POST /master-data/payees` (`packages/server/src/routes/master-data-routes.ts:377-390`, body `payee/bankName/bankAccount/openAreaId/openAreaName`, writes Kingdee via `payeeAccounts().create`).
- R9 `rg LOAN_OFFSET_REQUIRED|mustOffset packages/server/src` → no match; `isRefund` is only passed through (`packages/server/src/services/bill-submit-service.ts:1442`).
- R10 `ExpenseBillForm.tsx` has 0 matches for `差旅|travel|预算`; no linkage slot exists.
- R11 `packages/web/src/components/forms/ExpenseBillForm.tsx:3180-3201` renders `提单前财税合规体检看板` with `PreflightComplianceChecker` and `RoutePreviewPanel`; gate: submit disabled when `!complianceReport.canSubmit` (`:3227-3236`); `routePreview` used only for copy at `:3214-3215`.
- Verify baseline (this checkout, after `npm ci --ignore-scripts` exit 0): server narrow `MOCK_MODE=true NODE_ENV=test node --test --import tsx test/ticket-entries-bizlink.test.ts test/invoice-split-reconciliation.test.ts test/invoice-lease-service.test.ts test/loan-offset-service.test.ts test/payee-directory-routes.test.ts` exit 0 (86 pass); web `node --import tsx --test test/loan-offset-picker-guard.test.tsx test/expense-form-draft.test.tsx` exit 0 (20 pass). Sink full-suite baselines: see `## Sink baseline`.

## Sink baseline

Run on baseline `547c5bd8` in this worktree after `npm ci --ignore-scripts` (exit 0):
- `npm --prefix packages/server test` → exit 0, 2018 pass, 0 fail.
- `cd packages/web && node --import tsx --test test/*.test.ts test/*.test.tsx` → exit 0, 62 pass, 0 fail (web has no `test` script; `packages/web/package.json:6-10`).
- From repo root: `node --import tsx --test packages/web/test/loan-offset-picker-guard.test.tsx` exit 0; `MOCK_MODE=true NODE_ENV=test node --test --import tsx packages/server/test/ticket-entries-bizlink.test.ts packages/server/test/invoice-split-reconciliation.test.ts` exit 0.
- New test files `packages/web/test/expense-form-ticket-driven.test.tsx`, `packages/web/test/payee-archive-save.test.tsx` do not exist at baseline; their Verify fails (missing file) until T-03/T-04 create them.
- T-04 lease change: `packages/web/src/components/forms/ExpenseBillForm.tsx:2046-2053` leases only the first bound entry with `leasedAmount: totalAmount`; T-04 must lease per bound entry (`entrySeq`, entry amount). Removal (R11) gate: `complianceReport.canSubmit` disable at `:3227` moves next to the submit button as inline error; `routePreview` copy `:3214-3215` deleted with the panel.
- Existing contract tests T-01 must rewrite: `packages/server/test/ticket-entries-bizlink.test.ts` ("duplicate invoiceKey uses first ID-bearing entry row") pins one-row-per-invoice; `invoice-split-reconciliation.test.ts` pins exact equality.

## OPEN-DECISION

- **OD-1 CONSUMED vs baseline enum**: options A keep `LOCKED`/`SETTLED` as the ADR's CONSUMED, reject/withdraw releases, ledger-level multi-bill share (`openspec/specs/invoice-lease-ledger/spec.md:20-22` 拼车) stays while submit gate stays exclusive | B add `CONSUMED` enum + migration and forbid release after submit. A: no schema change, ADR meaning holds for any live bill; B: new enum/migration (scope growth, stop point 5). Recommended default A. No task depends on B.
- **OD-2 split invoice-entry amount**: A apportion face `amout`/`tax` by row amount ratio, last row absorbs cents, sum = face (keeps baseline single-row `amout` = face) | B each entry `amout` = row claimed amount, sum = claimed. Kingdee 10-050 acceptance of either is UNVERIFIED. Recommended default A. T-01 Verify follows A; B changes T-01 only.
- **OD-3 payee archive save timing**: A after bill submit succeeds, once per checked row, failure shown as non-blocking warning, bill not rolled back | B before submit, failure blocks submit. Recommended default A. External Kingdee write; no test may hit real Kingdee.
- **OD-4 manual control-total (R12)**: spec 3.2 asks for auto/manual total toggle; user ruling 2026-11-18 (memory `expense-form-business-rulings`, UNVERIFIED as authorization) lists "金额自动/手动开关" as redundancy to delete. Options A not built | B build. Recommended default A.
- **OD-5 linkage slots (R10)**: travel/contract/refund search cards, budget soft warning, cause auto-prefix need new source integrations not in the rough DAG. Options A defer to FOLLOWUP | B new tasks (scope growth). Recommended default A.
- **OD-6 buyer tax-number mismatch**: spec 3.3 says yellow warning; baseline blocks submit (`ExpenseBillForm.tsx:387,394`). Options A keep blocking | B warn only (compliance relaxation). Recommended default A.
