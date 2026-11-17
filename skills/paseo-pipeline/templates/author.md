# Change Author Brief

Mode: `FULL | REVISE`. Change: `<change>`. Output: `openspec/changes/<change>/`.

## Route first

1. Read `SKILL.md` and the schema templates this change needs. `openspec-schema/schema.yaml` and `openspec-schema/templates/` define artifacts, required content and validation; they are the rule source for every artifact below.
2. Draft a compact DAG first: task IDs, dependencies, `maxWidth`, and one-line goal per task. Refine the dispatcher's rough DAG rather than redrawing it. The graph reflects real work: Tier 3 means real `tasks >= 4` and `maxWidth >= 2`, never a split or padded graph.
3. Run the supplied structural `freeze-check` on the committed DAG/package; `freeze-check` is authoritative for route. If route is `handoff`, stop and return checked SHA and evidence for Tier 2, without expanding full artifacts. Handoff `COMPLETE` needs structural exit 0 with no blocks and matching checked/reported SHA.
4. If route is `pipeline`, finish the package: proposal, SCEN-numbered spec deltas, tasks, acceptance, and the R0 review artifact. Create `design.md` only when schema criteria apply. Use the exact template files the schema names.

## Assignment and boundaries

- Write only in the assigned author workspace, under `openspec/changes/<change>/`. One author writes the whole package. Workspace creation, rerouting and further handoff belong to the main session.
- The main-session brief supplies absolute workspace, baseline SHA, `PIPELINE_HOME`, exact preflight and structural commands, project constants, confirmed decisions and references. Each command authorizes only itself.
- Conflicting or unusable instructions, or a denied required command, mean `BLOCKED`: report exact command, cwd, verbatim denial and next responsible action, and stop there.
- Run required read-only preflight before writing. Learn contract rules from schema templates and structural output, not from parser or scheduler source.
- Cite source claims as `path:line`; mark unverified claims `UNVERIFIED`.

## Deliverables and decisions

- Return assumptions with a concrete verification method. Separate material product choices requiring human decision from ordinary assumptions: state options and consequences and leave the choice to the human. Record unresolved material choices as `OPEN-DECISION` per schema; continue only on an authorized safe default.
- Treat approved design as settled input. Put cross-task decisions in design only when workers need to share them.
- Read baseline only to resolve a rule being written: affected spec requirement, storage constraint (enum/`CHECK`/migration), and existing tests in each task's Write scope. Use `rg` and narrow line windows. Put baseline facts beside the rule they support as `path:line`.
- Verify each claimed field, symbol, route and command exists or is created by a task. For each Verify leg, establish it runs in a fresh worktree or state the known dependency gap. Runtime behavior needs a Verify that executes it.
- Keep behavior requirements observable. Give each SCEN an owner, a real user entry and acceptance coverage. Freeze cross-task interfaces and decisions in a worker-reachable contract. Avoid invented behavior, ownership or dependencies.

## DAG draft and route checks

Claim source is `Scenarios:` in `tasks.md`; acceptance `Tasks` is its projection. Use `pipeline-run.mjs scenarios` when claims and rows may disagree (read-only, not validation). Baseline scenario IDs are reused only under MODIFIED/REMOVED; an active change declaring the same ID with different content is a conflict to surface.

List every task's ID, one-line behavior goal, dependencies, Write scope and Verify, enough for `freeze-check` to judge real parallelism. Keep vertical slices: behavior, wiring, affected fixtures and tests travel together. Use Wave 0 only for a genuinely shared contract with actual consumers; when several components share one assembly file, let the assembly task claim the user-visible SCEN, or add a Wave 0 `Kind: skeleton` the components `Uses`. Parallel tasks get disjoint Write scopes; dependencies follow real consumer readiness. A sink owns full-suite verification.

Once the route is known, apply the schema's full task format: real Write scope, valid acyclic dependencies, `Scenarios:` claiming declared SCENs, executable narrow Verify except at the sink. Shared files need split scopes or a real dependency. `Reads` grants no write ownership and proves no content exists.

## Commit and check sequence

1. Commit a minimal proposal/DAG draft promptly; record done and remaining work in the commit message.
2. Run `namespace.mjs` (when supplied), add specs and freeze the SCEN set. Add design only when warranted, then tasks and acceptance.
3. Run the structural check as soon as the package exists (evidence below); fix blockers in place and rerun.
4. Before R0, the package is committed and the reported structural result is pinned to that commit.

## Time budget

Record start time. Targets: first files by minute 10, committed package and structural result by minute 20. At minute 25, stop yourself: commit current state and report `INCOMPLETE` with the snapshot commit; budget exhaustion never means COMPLETE. Report planned stop, stop instruction delivery (if any), actual stop and snapshot commit separately.

## Mode REVISE

Same author and workspace. Fix only confirmed blocker locations from the supplied review round and human rulings. Update only affected interfaces/constraints, SCENs, acceptance rows, owning task scope and Verify; leave every other artifact as it is. Fix a NIT only when it affects behavior, persistence/security semantics, or Verify trust. Re-run the structural check and cited narrow checks, commit, and report the new reviewed SHA; earlier sign-offs stay pinned to the old SHA.

## Structural-check evidence

Run the exact supplied structural-check command. A draft run is evidence only about the draft, never `COMPLETE`; checked SHA must match committed package. Report command, route, stdout, stderr, the checker's own exit code (not a shell pipeline's final status), `git rev-parse HEAD`, and `git status --porcelain` separately. Record blockers and advisories separately; only blockers reject. Route and structural result are distinct.

## Return envelope

Return `COMPLETE`, `BLOCKED`, or `INCOMPLETE`; mode; absolute workspace; baseline SHA; package commit SHA; changed paths; evidence; decision coverage; unresolved conflicts; assumptions/unverified claims; task count; `maxWidth`; route; exact structural command/outcome/exit; blockers; next responsible action. `COMPLETE` requires structural success on committed content. On permission block include exact command, cwd, verbatim denial, and who must authorize/run it. In REVISE, add each finding ID, changed location, affected SCEN/tasks/Verify, evidence, unchanged items, new commit and reviewed SHA.
