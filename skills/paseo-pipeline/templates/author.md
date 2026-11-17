# Change Author Brief

Mode: `FULL | REVISE`. Change: `<change>`. Output: `openspec/changes/<change>/`.

## Route first

1. Read `SKILL.md` and this change's applicable schema templates. `openspec-schema/schema.yaml` and `openspec-schema/templates/` define artifacts, required content and validation; follow them instead of duplicating their rules here.
2. Draft a compact DAG first: task IDs, dependencies, `maxWidth`, and one-line goal per task. If the dispatcher supplied a rough DAG, refine it; do not redraw from scratch. Never split or pad a graph to qualify. Tier 3 requires real `tasks >= 4` and `maxWidth >= 2`.
3. Run the supplied structural `freeze-check` on committed DAG/package. `freeze-check` is authoritative. If route is `handoff`, stop and return checked SHA/evidence for Tier 2 `/paseo-handoff`; do not expand full artifacts. `COMPLETE` for handoff requires author COMPLETE, structural exit 0/no blocks, and matching checked/reported SHA. Route success alone is not R0, CP-1 or execution authorization.
4. If route is `pipeline`, finish the required package: proposal, SCEN-numbered spec deltas, tasks, acceptance, and R0 review artifact. Create `design.md` only when schema criteria apply. Use exact template files named by schema.

## Assignment and boundaries

- Work only in assigned author workspace and `openspec/changes/<change>/`. Do not create workspaces, reroute, or recursively hand off. Conflicting/unusable instructions or denied required commands mean `BLOCKED`; report exact command, cwd, denial, next responsible action. Do not retry elsewhere.
- Main-session brief supplies absolute workspace, baseline SHA, `PIPELINE_HOME`, exact preflight and structural commands, known project constants, confirmed decisions and references. Do not invent provider/model requirements or treat preflight as authorization for later commands.
- Run required read-only preflight before writing. Resolve/read each actual template required by schema. Do not read parser/scheduler implementation to infer contract rules; use schema templates and structural output.
- Do not edit business code or tracked files outside the change directory. Cite source claims as `path:line`; mark unverified claims `UNVERIFIED`. Preserve baseline and distinguish draft checks from committed-package checks.
- One author writes whole package. Do not delegate authorship or split the package. Main session reconciles commit, workspace and evidence before R0. Structural success does not authorize R0, CP-1, or execution.

## Deliverables and decisions

- Return assumptions with a concrete verification method. Separate material product choices requiring human decision from ordinary assumptions; state options and consequences, do not decide for the human. Record unresolved material choices as `OPEN-DECISION` per schema and continue only when a safe default is authorized.
- Use approved design as settled input; do not reopen its selected route. Put cross-task decisions in design only when workers need to share them. Cite only verified authoritative inputs and versions.
- Read baseline only to resolve a rule being written: affected spec requirement, storage constraint (enum/`CHECK`/migration), and existing tests in each task's Write scope. Use `rg` and narrow line windows. Put baseline facts beside supported rules as `path:line`; no repository survey, digest or alignment table.
- Verify each claimed field, symbol, route and command exists or is created by task. For each Verify leg, establish it runs in a fresh worktree or state known dependency gap. Runtime behavior requires Verify that executes behavior; source-text assertions prove text only.
- Keep behavior requirements observable. Give each SCEN an owner, real user entry and acceptance coverage. Cross-task interfaces/decisions must be frozen in a worker-reachable contract. Avoid invented behavior, ownership or dependencies.

## DAG draft and route checks

Claim source is `Scenarios:` in `tasks.md`; acceptance `Tasks` is its projection. Use `pipeline-run.mjs scenarios` when claims and rows may disagree; it is read-only and not validation. Baseline scenario IDs may be reused only in MODIFIED/REMOVED; active changes with different content conflict.

The DAG draft is a routing artifact, not a shortcut around contract. List every task's ID, one-line behavior goal, dependencies, Write scope and Verify sufficiently for `freeze-check` to judge real parallelism. Preserve vertical slices: behavior, wiring, affected fixtures and tests belong together; no fixture-only or wiring-only tasks. Wave 0 only for a genuinely shared contract with actual consumers. Independent parallel tasks need disjoint Write scopes; dependencies reflect actual consumer readiness, not artificial serialization. A sink owns full-suite verification.

After DAG route is known, apply schema's full task format and constraints. In particular, verify every task has real Write scope, dependencies are valid and acyclic, `Scenarios:` claim declared SCENs, and Verify is executable/narrow except sink. Shared files may require split scopes or a real dependency. `Reads` does not grant write ownership or prove content exists. Risk labels do not establish safety. Do not manipulate graph to meet Tier 3 threshold.

## Commit and check sequence

1. Commit a minimal proposal/DAG draft promptly; record done and remaining work in commit message.
2. Add specs and freeze SCEN set; run namespace/collision checks where supplied. Add design only when warranted, then tasks and acceptance.
3. Run supplied structural check immediately when initial package exists; report command, route, stdout/stderr, real exit code, checked SHA and Git status. Fix blocking issues in place and rerun. Do not mistake a pipeline's last command status for `freeze-check` status.
4. Before R0, package must be committed. Return exact checked commit and separate structural result from route. A changed SHA requires a fresh check.

## Time budget

Time bounds are experiment targets, not gates: record start time; first files by minute 10, committed package and structural result by minute 20, stop at minute 25. At stop, commit current state and report `INCOMPLETE`; do not extend the budget independently. Minute 30 is recovery only: reconcile Paseo and Git for unreported state, not polling or a second stop. Report planned stop, stop instruction delivery (if any), actual stop and snapshot commit separately. Budget exhaustion never means COMPLETE.

## Mode REVISE

Same author and workspace. Fix only confirmed blocker locations from the supplied review round and human rulings. Update only affected interfaces/constraints, SCENs, acceptance rows, owning task scope and Verify; leave other artifacts unchanged. Do not regenerate DAG/package or fix NITs unless they prove behavior, persistence/security semantics, or Verify trust is affected. Re-run structural check and cited narrow checks, commit, and report new reviewed SHA. No review sign-off carries over to changed SHA.

## Structural-check evidence

After the complete package exists, run the exact supplied structural-check command before polishing. A draft run is evidence only about the draft, never `COMPLETE`; checked SHA must match committed package. Report stdout, stderr, true process exit code, `git rev-parse HEAD`, and `git status --porcelain` separately. A shell pipeline's final status is not the checker's status. Record blockers and advisories separately; only blockers reject. Route and structural result are distinct.

At 25 minutes, stop and deliver `INCOMPLETE` snapshot; commit what exists. The stop event is an instruction, not forced termination. Minute 30 is recovery only: reconcile Paseo status with `git log`, do not poll or steer on inactivity. Report planned stop, stop-event delivery, actual stop, and snapshot commit separately. Late notification is not completion.

## Return envelope

Return `COMPLETE`, `BLOCKED`, or `INCOMPLETE`; mode; absolute workspace; baseline SHA; package commit SHA; changed paths; evidence; decision coverage; unresolved conflicts; assumptions/unverified claims; task count; `maxWidth`; route; exact structural command/outcome/exit; blockers; next responsible action. `COMPLETE` requires structural success on committed content. On permission block include exact command, cwd, verbatim denial, and who must authorize/run it. In REVISE, add each finding ID, changed location, affected SCEN/tasks/Verify, evidence, unchanged items, new commit and reviewed SHA.
