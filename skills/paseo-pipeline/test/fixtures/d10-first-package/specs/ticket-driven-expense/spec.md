## Purpose

Ticket-driven expense form: one invoice can back several expense entries or a partial claim, multiple loans are offset oldest first, the applicant can save a payee to their own archive, and the form drops its compliance dashboard and approval-path preview while keeping every blocking gate.

## ADDED Requirements

### Requirement: Split invoice maps to one invoice entry per expense entry
When one uploaded invoice is bound to N expense entries, the submitted `tickeEntries` SHALL contain N rows with the same `ticketCode`/`ticketNumber`, `bizEntryBill` pointing to each bound entry id, and `amout`/`tax` apportioned from the invoice face values by entry amount ratio, the last row absorbing cent remainders so the N rows sum exactly to face `amout`/`tax` (OD-2 default A). Field name stays Kingdee `amout`. An invoice bound to one entry SHALL keep today's single row.

#### Scenario: SCEN-TDE-01 one invoice split across two entries
- **WHEN** a 1000.00 invoice (tax 60.00) is bound to entry A (600.00, id `ea`) and entry B (400.00, id `eb`) and the bill is submitted
- **THEN** the submit payload has two `tickeEntries` rows with that code/number, `bizEntryBill` `ea` and `eb`, `amout` 600.00/400.00 and `tax` 36.00/24.00

### Requirement: Partial claim within invoice face amount
The form SHALL accept a bill whose entries bound to one invoice sum to less than or equal to the invoice face amount, and SHALL lease each bound entry separately with its own `entrySeq` and `leasedAmount` = entry amount. A sum above face amount MUST block submit with an inline error naming the invoice, and no submit or lease request SHALL be sent. The one-bill lock (other bills cannot use the invoice, remainder forfeited) stays as baseline `SINGLE_BILL_EXCLUSIVE` with `LOCKED`/`SETTLED` (OD-1 default A).

#### Scenario: SCEN-TDE-02 partial claim submits
- **WHEN** a 1000.00 invoice is bound to one entry of 500.00 and the bill is submitted
- **THEN** no split-balance error is shown and the lease request for that invoice carries `leasedAmount` 500.00 with the entry's `entrySeq`

#### Scenario: SCEN-TDE-03 over-claim blocked inline
- **WHEN** a 1000.00 invoice is bound to entries of 700.00 and 400.00 and submit is clicked
- **THEN** an inline error names the invoice number and the 100.00 excess, and no `/bills/submit` or lease request is sent

#### Scenario: SCEN-TDE-07 invoice held by another bill stays rejected
- **WHEN** `POST /bills/submit` carries an invoice that another bill holds `LOCKED`
- **THEN** the response is 409 `INVOICE_DUPLICATE_OR_EXCEEDED`, Kingdee is not called, and this bill's own lease is released

### Requirement: Multi-loan offset allocates oldest first
When several loans are selected, the loan picker SHALL allocate the bill total across selected loans ordered by `bizDate` ascending, each loan taking `min(availableBalance, remaining)`, recomputing on every selection change; a loan whose amount the user typed SHALL keep the typed amount and the rest are reallocated around it.

#### Scenario: SCEN-TDE-04 FIFO allocation with manual override
- **WHEN** bill total is 1500.00 and the user selects loan N (bizDate 2026-10-01, available 1000.00) then loan O (bizDate 2026-08-01, available 1000.00)
- **THEN** loan O shows 1000.00 and loan N 500.00; after the user types 300.00 on loan O, loan N shows 1000.00

### Requirement: Save payee to own archive
Each manually entered payee row SHALL show a checkbox "保存此账户到我的收款档案", unchecked by default and hidden for rows imported from the archive. After the bill submit succeeds, each checked row SHALL be saved once through existing `POST /master-data/payees` (`createPayeeProfile`) with the row's payee name, bank account, bank name and open area; a save failure SHALL show a non-blocking warning and SHALL NOT change the submitted bill (OD-3 default A). Picking from own archive keeps baseline `mine=1`.

#### Scenario: SCEN-TDE-05 checked payee saved after successful submit
- **WHEN** a manual payee row has the checkbox checked and `/bills/submit` succeeds
- **THEN** exactly one `POST /master-data/payees` is sent with that row's fields; an unchecked row sends none; if the save returns an error a warning is shown and the success state remains

### Requirement: Form without dashboard noise, gates inline
The expense form SHALL NOT render the `提单前财税合规体检看板` section's `PreflightComplianceChecker` or `RoutePreviewPanel`. Every blocking condition the compliance report carried (`complianceReport.canSubmit === false`) SHALL still prevent submit and SHALL be shown as an inline error next to the submit button.

#### Scenario: SCEN-TDE-06 dashboard gone, blocking stays
- **WHEN** the expense form renders with an invoice whose buyer tax number mismatches the company
- **THEN** no element labelled `提单前财税合规体检看板` or route-preview panel is present, the submit button is disabled, and an inline error describes the mismatch
