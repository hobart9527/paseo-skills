# SDD convergence design — contract checks vs. semantic review (2026-11-08)

Status: approved by the human on 2026-11-08 (bounded patch; no extra design round).
Scope: `skills/paseo-pipeline` contract gate only. Non-normative for workflow; the workflow
authority remains `skills/paseo-pipeline/SKILL.md`.

## Decision

Divide the work between the machine gate and semantic review by what each can actually prove.

1. **Machines enforce references, set consistency and content identity.** The existing contract
   format stays: optional `design.md` / `Implements:`, existing task-to-acceptance bidirectional
   checks, existing SCEN ownership and graph checks. No new metadata, dependencies, ownership
   files, AST migration or scheduler change.
2. **Semantic review checks intent**: whether the entry named in `acceptance.md` is the real one,
   whether it is really wired, and whether a Verify could falsify its claimed outcome. R0 and FINAL
   keep that responsibility; the gate does not pretend to it.
3. **Collision comparison is conservative content identity, not Markdown rendering equivalence.**
   `comparedBody` keeps visible-heading discovery and raw-index body boundaries (a `#` line inside
   a fence or comment cannot end a scenario). It normalizes only CRLF/LF and leading/trailing
   *empty* body lines. Internal whitespace, indentation, per-line trailing whitespace, fence
   delimiters, info strings and comment/payload content all take part in the comparison. A
   different backtick/tilde style, or a nested fence whose inner info string changed, therefore
   **collides**: reuse copies the authoritative text instead of regenerating it. No delimiter
   normalization state machine. `collapse()` is removed; title comparison trims only the
   heading/title separator, so internal title whitespace is significant.
4. **`SINK_TEST_ONLY` is not proof of missing vertical closure, so it becomes an advisory.**
   A DAG sink is defined by graph edges (nothing consumes it), not by who wires the pieces
   together. Upstream scenario tasks may already own the real production entry, and a final
   integration verification task may legitimately be test-only. The hard block pushed authors to
   fabricate a production path to satisfy the gate. `ADVISORY_SINK_TEST_ONLY` now asks R0 to check
   that an upstream scenario task owns the entry and that the sink's test-only work is legitimate.
   No blocking fix entry remains for it. Real behavior slices keep their responsibilities:
   behavior + wiring + affected fixtures + tests, `FIXTURE_ONLY_TASK` for non-sink test-only scopes,
   scenario claims, ownership/graph constraints, and semantic R0.
5. **The optional-design scaffold stays valid.** `Implements:` enforcement is not widened beyond
   the existing dangling-reference check (`UNKNOWN_DECISION`); with no `design.md`, omit
   `Implements:`.

## Alternatives rejected

- **Continued normalization patches** for the comparator (trailing whitespace, fence style, title
  collapsing). Each one bought a little convenience by guessing at equivalence, and each new
  normalization was itself a way for two genuinely different contracts to compare equal. The
  observed defect chain (B7 → B9 → 4-backtick fence) is the cost of that path.
- **A Markdown AST or a new contract format.** Migration cost for no check the reference/set checks
  do not already cover; rendering equivalence would also require a pinned renderer and its
  version in the evidence.

## Verification shape

- Reproduce the final reviewer blocker first: a 4-backtick outer fence with an inner ```json vs
  ```yaml example must collide; byte-identical content must stay an advisory.
- Keep the regression set: fenced/commented heading boundaries, external examples not being
  declarations, malformed headings not crashing the gate, per-row ownership failures (mixed ids and
  cross-row), template/scaffold coverage without `design.md`.
- Invert the former fence-style-equivalence expectation to a collision, and make the trailing-space
  expectation consistent with content identity. These are intentional assertion changes.
- Positive fixture: an upstream behavior task owning the real production entry plus a final
  mechanical test-only integration task → zero blocking, `ADVISORY_SINK_TEST_ONLY` present.
- Negative controls: invalid ownership/graph still block; a non-sink behavior-only-test scope still
  blocks (`FIXTURE_ONLY_TASK`).

## Persistence evidence for the edit

Repository-managed source under `skills/paseo-pipeline` is not overwritten by Paseo on restart or
upgrade. Paseo's skills reconciliation (Paseo 0.15.3, `app.asar` →
`@getpaseo/server/dist/server/server/orchestration-skills/`) only manages the skills bundled inside
the app (`paseo`, `paseo-advisor`, `paseo-committee`, `paseo-handoff`, `paseo-help`, `paseo-plugin`);
`paseo-pipeline` is not in that bundle, and the installed entry is a symlink
`~/.claude/skills/paseo-pipeline -> ~/Codex/paseo-skills/skills/paseo-pipeline`. Even for managed
skills, the sync refuses to traverse a symlink (`Cannot sync through symbolic link`) and targets the
`skills/` directory inside the bundle as its source, never this checkout. `install.sh` conversely
treats the checkout as the source of truth and fails on schema drift instead of overwriting it.

## Measurements

Author-stage timing target and benchmark numbers are recorded in the delivery report, not here;
the structural repair, R0 and total elapsed are tracked separately for the later D4 benchmark.
