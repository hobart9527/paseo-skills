## MODIFIED Requirements

### Requirement: Run ledger refuses to erase receipts and reports only collected facts
The run ledger SHALL refuse to void an intent that already carries a real agent receipt, since voiding means "this dispatch did not happen" while a receipt proves it did and names an agent; recovering from a lost agent SHALL use a new attempt key instead.

The ledger SHALL provide a report command whose every number is derived from facts already recorded in the ledger. Metrics that the ledger does not record — audit conclusions, state transition times — SHALL be reported as not collected rather than estimated. The report SHALL distinguish an absent ledger from a ledger with zero activity.

A dispatch count SHALL count only intents that carry a real agent receipt, and every dispatch count in the report SHALL use that same definition. An intent that was never dispatched — one that is still open, or one explicitly voided because its creation failed — SHALL NOT be counted as a dispatch, regardless of its phase or role. Voided intents SHALL be reported by their own count and SHALL NOT be folded into any dispatch count, so that the number of audits actually performed stays distinguishable from the number of audit intents that were attempted.

The ledger SHALL record the orchestrating skill's git identity when a lease is acquired. A later mismatch between the recorded identity and the current one SHALL warn and SHALL NOT block reading or acting on the ledger; a ledger without the field SHALL be reported as not collected.

#### Scenario: SCEN-CON-09 a receipted intent cannot be voided
- **WHEN** `fail` is issued for an intent that was already recorded with an agent id
- **THEN** the command exits non-zero, the intent keeps its receipt, and a claim on a new attempt key succeeds.

#### Scenario: SCEN-CON-10 report separates measured from uncollected
- **WHEN** the report runs on a ledger holding two dispatches and on a missing ledger
- **THEN** the first reports counts derived from recorded intents while stating that first-pass review outcome and ready wait are not collected, and the second reports the ledger as absent instead of zero-valued metrics.

#### Scenario: SCEN-CON-11 skill version drift warns without blocking
- **WHEN** a ledger records a skill HEAD different from the current one, or records none at all
- **THEN** status prints a drift warning in the first case and a not-collected line in the second, and both remain readable.

#### Scenario: SCEN-CON-27 a voided audit intent is not counted as an audit dispatch
- **WHEN** an audit intent is claimed and then explicitly voided because its agent creation failed, alongside one writer dispatch that carries a real receipt
- **THEN** the report counts one dispatch and zero audit dispatches, reports the voided intent under the voided count, and the writer dispatch is still counted as dispatched.
