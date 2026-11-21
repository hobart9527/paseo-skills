# Change Author Brief

Mode: `FULL | REVISE`. Change: `<change>`. Output: `openspec/changes/<change>/`.

## Route first

1. Read `SKILL.md`, `openspec-schema/{schema.yaml,templates/}`, and any JIT-inlined `baseline-facts.md`.
2. Write the rule list first: `proposal.md` with `## What Changes` (one line per rule), `## OPEN-DECISION` for supplied choices, and `## Baseline`. Commit before reading baseline code.
3. Draft a compact DAG next: task IDs, dependencies, `maxWidth`, and one-line goal per task. Tier 3 requires `tasks >= 4` and `maxWidth >= 3` (or `maxWidth >= 2` with `weightedSpeedup >= 1.8`); never split to qualify.
4. After the rule-list commit, the baseline is fair game — consult `baseline-facts.md` first and research only missing gaps (`path:line`), committing small. Write pure-behavior `specs/` (SCEN-numbered `WHEN`/`THEN`; executable `Verify` lives in `tasks.md`) and run `freeze-check --structural --stage specs` before authoring `tasks.md`. **Never run full test suites before `specs/` is committed.**
5. Finish `tasks.md` (`Write scope:`, `Entry:`, `Verify with:`, `Scenarios:`, optional `Required:`), derive `acceptance.md` via `pipeline-run.mjs acceptance sync <change-dir>`, then run supplied structural `freeze-check` on the committed package; it is authoritative for route. On handoff, existing `acceptance.md` is historical, superseded by `tier2-verify`. Handoff `COMPLETE` needs structural exit 0 with no blocks and matching checked/reported SHA.
6. If route is `pipeline`, confirm complete package: proposal, SCEN-numbered spec deltas, tasks, acceptance, and review artifact. Add `design.md` only when schema criteria apply.

## Assignment and boundaries

- Write only in the assigned author workspace under `openspec/changes/<change>/`. Package files: proposal (with `## Baseline`), specs, tasks, acceptance, review (R0 line); `design.md` only per schema, nothing else.
- Brief supplies workspace, baseline SHA, `PIPELINE_HOME`, structural commands, constants and confirmed decisions; each command authorizes only itself.
- Conflicting instructions or denied required commands mean `BLOCKED`: report command, cwd, denial and next owner, then stop.
- Skip redundant `preflight`/`namespace` when Stage 0 `baseline-facts.md` already supplies them. Cite source claims as `path:line` or mark `UNVERIFIED`.

## Deliverables and decisions

- Return assumptions with verification methods. Separate material product choices from ordinary ones: state options/consequences for the human. Record unresolved choices as `OPEN-DECISION`; open hard decision: commit and return `BLOCKED (decision)` with options before specs/tasks.
- Keep behavior requirements observable. Avoid invented behavior, ownership or dependencies. For shared cross-layer types across concurrent tasks, prefer a Wave 0 `Kind: skeleton` typed stub checked by the compiler rather than hand-copying TypeScript interfaces into Markdown.

## Three checks before the structural check

Read baseline only for rules (`rg`, narrow windows, `path:line`) absent from `baseline-facts.md`:

1. **Reach** — each SCEN names `Entry` and a `Verify with:` in `tasks.md` hitting that real entry (fresh-worktree runnable or note dep gap).
2. **Shape** — cite real baseline field/route/enum/DB shapes (`CHECK`/migration); add a task or `OPEN-DECISION` for missing fields.
3. **Removal** — every deletion states the gate it carried and its new owner.

## DAG draft and route checks

Claim source: `tasks.md` `Scenarios:`; `acceptance sync` compiles `Tasks`, `Entry`, `Verify`, and `Required`. Reuse baseline IDs only under MODIFIED/REMOVED; resolve active conflicts honestly.

List task ID, behavior goal, dependencies, Write scope, Entry and Verify for `freeze-check`. Keep vertical slices together. Wave 0 needs shared contracts and real consumers (`Uses` a `Kind: skeleton` for shared assembly). Parallel Write scopes stay disjoint; dependencies follow consumer readiness. Workers own tests + implementation (`Review: strict` adds independent Red only when needed).

## Commit and check sequence

1. Commit each artifact as it lands with done/remaining summary.
2. Check `namespace.mjs` (if not in `baseline-facts.md`), write pure-behavior specs and run `--stage specs`. Add concise `design.md` if warranted, then `tasks.md` and `acceptance sync`.
3. Record baseline suite status in `## Baseline` from Stage 0 or one targeted baseline run once (never pre-spec).
4. Run full structural check once the package is committed; checked SHA must match `HEAD`.
5. Every commit ends with `Pipeline-Role: <role>` and `Pipeline-Author: $(echo $PASEO_AGENT_ID)`.

## Scope budget

Work in bounded timed milestones (commit rule-list by minute 2; `specs/` + `--stage specs` by minute 10; with Stage 1 `baseline-facts.md` target `COMPLETE` by minute 12 / self-stop by minute 18; without Stage 1 target `COMPLETE` by minute 20 / self-stop by minute 25). Never survey unrelated files or accumulate excess thinking chasing minor details before `specs/`. If blocked, stuck, or compacted with empty `specs/`, commit current state immediately and report `INCOMPLETE` with the snapshot commit; an unfinished draft never counts as `COMPLETE`.

## Mode REVISE

Same author and workspace. Fix confirmed blocker locations, update affected contracts/`Entry:`/`Verify with:`/`Scenarios:`, re-run `acceptance sync`, keep everything else untouched. Rerun structural check, commit, report new reviewed SHA.

## Structural-check evidence

Run the exact supplied structural-check command. A draft run is evidence only about the draft, never `COMPLETE`; checked SHA must match committed package. Report command, route, stdout, stderr, exit code, `git rev-parse HEAD`, and `git status --porcelain`. Record blockers and advisories separately; only blockers reject.

## Return envelope

Return `COMPLETE`, `BLOCKED`, or `INCOMPLETE`; mode; absolute workspace; baseline SHA; package commit SHA; changed paths; evidence; decision coverage; unresolved conflicts; assumptions; task count; `maxWidth`; route; structural command/outcome/exit; blockers; next responsible action. `COMPLETE` requires structural success on committed content. In REVISE add finding IDs, changed locations, affected SCEN/tasks/Verify, unchanged items, new commit and reviewed SHA.
