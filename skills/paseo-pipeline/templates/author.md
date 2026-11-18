# Change Author Brief

Mode: `FULL | REVISE`. Change: `<change>`. Output: `openspec/changes/<change>/`.

## Route first

1. Read `SKILL.md` and the schema templates this change needs: `openspec-schema/schema.yaml` and `openspec-schema/templates/` define artifacts, required content and validation, and are the rule source for every artifact below.
2. Write the rule list now: `proposal.md` with `## What Changes` (one line per rule this change makes), `## OPEN-DECISION` for the choices the brief supplies, and an empty `## Baseline`. Commit it within 2 minutes and read no baseline code before that commit.
3. Draft a compact DAG next: task IDs, dependencies, `maxWidth`, and one-line goal per task. Refine the dispatcher's rough DAG rather than redrawing it: the graph reflects real work, so Tier 3 means `tasks >= 4` and `maxWidth >= 2`, never a split or padded graph.
4. After the rule-list commit, the baseline is fair game: research only what a listed rule needs, and commit each finding small.
5. Run the supplied structural `freeze-check` on the committed package; it is authoritative for route. If route is `handoff`, stop and return checked SHA and evidence for Tier 2, without expanding full artifacts. Handoff `COMPLETE` needs structural exit 0 with no blocks and matching checked/reported SHA.
6. If route is `pipeline`, finish the package: proposal, SCEN-numbered spec deltas, tasks, acceptance, and the R0 review artifact. Create `design.md` only when schema criteria apply, using the exact template files the schema names.

## Assignment and boundaries

- Write only in the assigned author workspace, under `openspec/changes/<change>/`. One author writes the whole package; workspace creation, rerouting and handoff belong to the main session.
- The main-session brief supplies absolute workspace, baseline SHA, `PIPELINE_HOME`, exact preflight and structural commands, project constants and confirmed decisions; each command authorizes only itself.
- Conflicting instructions or a denied required command mean `BLOCKED`: report exact command, cwd, verbatim denial and next responsible action, and stop there.
- Run required read-only preflight before writing. Learn contract rules from schema templates and structural output, not from source code.
- Cite source claims as `path:line`; mark unverified claims `UNVERIFIED`.

## Deliverables and decisions

- Return assumptions with a concrete verification method. Separate material product choices from ordinary assumptions: state options and consequences and leave the choice to the human. Record unresolved material choices as `OPEN-DECISION`; continue only on an authorized safe default.
- Treat approved design as settled input. Put cross-task decisions in design only when workers need to share them.
- Keep behavior requirements observable. Freeze cross-task interfaces and decisions in a worker-reachable contract. Avoid invented behavior, ownership or dependencies.

## Three checks before the structural check

Read baseline only to resolve a rule you listed. Use `rg` and narrow line windows; put each fact beside its rule as `path:line`.

1. **Reach** — every SCEN names its entry, the file that owns it, and a Verify that exercises that entry through a real path. A Verify on an isolated helper passes while the user path stays dead. Each Verify leg runs in a fresh worktree, or states its dependency gap.
2. **Shape** — every field, route, enum and payload the spec claims is cited from the baseline with its real shape and storage constraint (enum/`CHECK`/migration). A field the baseline does not carry is a new task or an `OPEN-DECISION`, never a value the test invents.
3. **Removal** — every deletion lists the gate the deleted code carries today (submit blocking, validation, lease, ledger) and where that gate goes.

## DAG draft and route checks

Claim source is `Scenarios:` in `tasks.md`; acceptance `Tasks` is its projection. Use `pipeline-run.mjs scenarios` when the two may disagree (read-only, not validation). Baseline IDs are reused only under MODIFIED/REMOVED; an active change re-declaring one with different content is a conflict.

List every task's ID, one-line behavior goal, dependencies, Write scope and Verify, enough for `freeze-check` to judge real parallelism. Keep vertical slices: behavior, wiring, affected fixtures and tests travel together. Use Wave 0 only for a genuinely shared contract with actual consumers; when components share one assembly file, let the assembly task claim the user-visible SCEN, or add a Wave 0 `Kind: skeleton` the components `Uses`. Parallel tasks get disjoint Write scopes; dependencies follow consumer readiness.

Apply the schema's full task format once the route is known; the structural check enforces the shape, so spend your attention on ownership, scope and Verify.

## Commit and check sequence

1. Commit each artifact as it lands; record done and remaining work in the commit message.
2. Run `namespace.mjs` (when supplied), add specs and freeze the SCEN set. Add design only when warranted, then tasks and acceptance.
3. Run the sink's Verify on the baseline commit once and record each command's exit code in `## Baseline`. A script already red on the baseline stays out of the sink's Verify, or a task owns the fix.
4. Run the structural check as soon as the package exists (evidence below); fix blockers in place and rerun.
5. Before R0, the package is committed and the reported structural result is pinned to that commit.
6. Every commit ends with `Pipeline-Role: <role>` and `Pipeline-Author: $(echo $PASEO_AGENT_ID)` — your own agent id, never the dispatcher's.

## Time budget

Record start time. Targets: rule-list commit by minute 2, complete package and structural result by minute 20. At minute 25, stop yourself: commit current state and report `INCOMPLETE` with the snapshot commit; budget exhaustion never means COMPLETE. Report planned stop, stop instruction delivery (if any), actual stop and snapshot commit separately.

## Mode REVISE

Same author and workspace. Fix only confirmed blocker locations from the review round and human rulings. Update only affected interfaces/constraints, SCENs, acceptance rows, owning task scope and Verify; leave every other artifact as it is. Fix a NIT only when it affects behavior, persistence/security semantics, or Verify trust. Re-run the structural check and cited narrow checks, commit, and report the new reviewed SHA.

## Structural-check evidence

Run the exact supplied structural-check command. A draft run is evidence only about the draft, never `COMPLETE`; checked SHA must match committed package. Report command, route, stdout, stderr, the checker's own exit code (not a shell pipeline's), `git rev-parse HEAD`, and `git status --porcelain` separately. Record blockers and advisories separately; only blockers reject. Route and structural result are distinct.

## Return envelope

Return `COMPLETE`, `BLOCKED`, or `INCOMPLETE`; mode; absolute workspace; baseline SHA; package commit SHA; changed paths; evidence; decision coverage; unresolved conflicts; assumptions/unverified claims; task count; `maxWidth`; route; exact structural command/outcome/exit; blockers; next responsible action. `COMPLETE` requires structural success on committed content. On permission block include exact command, cwd, verbatim denial, and who must authorize/run it. In REVISE, add each finding ID, changed location, affected SCEN/tasks/Verify, evidence, unchanged items, new commit and reviewed SHA.
