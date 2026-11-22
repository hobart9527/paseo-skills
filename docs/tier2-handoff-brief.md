# Tier 2 Handoff Brief

Filled by `/tier2-handoff` before `/paseo-handoff` dispatches. Use only when the work can be done whole by an independent session, needs parallel runs, or follows a heavy `/brainstorming`/compacted discussion on large files (after Stage 0/1 `prepare-author --schema paseo-tier2 --hydrate` + `chanpin` persists `baseline-facts.md`, `brief.mjs tier2 [--task T-01]` JIT-inlines it and `handoff-progress.md` per clean slice). Isolation alone on a light session does not need a handoff. Risky operations (deploy, production write, running a migration, push) stay with the session that holds the context. Rule source: `~/.claude/CLAUDE.md`.

## Assignment
- **Workspace:** `<absolute path>`
- **Branch:** `<branch>`
- **Base SHA:** `<full commit SHA>`
- **Delegate:** `<gongbu | gaogong>`; 开发（工部）`gongbu` by default, 攻坚（高工）`gaogong` for cross-module, concurrency, state-machine or reworked slices. Read-only 调研（中书）goes to `chanpin`, not here.
- **Testing:** `<owner | independent Red requested>`; default owner writes tests and implementation. For requested independent Red, supply exact test paths, real available entry/interface, Verify and `skills/paseo-pipeline/templates/tester.md`; receive Red SHA, actual command, exit code and assertion failure before the selected Delegate continues on the same branch. Missing imports/dependencies are not Red. Risk alone adds no tester.
- **Requirements:** `<R1..Rn in user's words> + files/scope`
- **Authorization:** `<quote user's words and scope for any stop point this work covers (merge, push, deploy, migration); "none" if it covers none>`. Commits on this non-default branch are pre-authorized and need no quote.
- **Pending decisions:** `<open choices, each with a default>`; dispatcher resolves any without a default before dispatch. A choice touching a risky operation, or changing auth or money semantics, needs the user's words, not a dispatcher default.
- **Slices:** serial list, no DAG. One line each: `S<n>: <R ids> | <files> | <old tests to change → new assertion> | <done evidence>`. A behavior-test slice when separate Red is requested/applicable uses two commits: tests first (test files only, red on the base), implementation second; otherwise one commit.
- **Size estimate:** `<files, lines, minutes>`; tell the user this estimate at dispatch.
- **Risk:** `<class + path:line>` naming one or more of: `auth/authorization/security`; `concurrency/idempotency`; `persistence/schema`; `money/billing/tax/settlement`; `external-write/irreversible side-effect`; or modifying/weakening existing test assertions. Otherwise write `Risk: none` (still subject to automated `risk-scan.mjs` verification at delivery).
- **Contract:** `openspec/changes/<name>/` using `schema: paseo-tier2` (`.openspec.yaml`, `specs/<capability>/spec.md`, serial `tasks.md` — no `proposal.md` or `acceptance.md`), authored per [`tier2-contract.md`](tier2-contract.md) in the skills checkout (not the target repo's `docs/`) before the first source edit; `openspec validate <name> --strict` exits 0. Mechanical change with no new observable behaviour: `Contract: none — <reason>`.

## Pre-dispatch check
- The brief has `Delegate:`, `Testing:`, `Authorization:`, `Pending decisions`, `Slices`, `Risk:` and `Contract:`; missing any one, do not dispatch.
- Read every test the brief requires to pass. An assertion that locks in a defect being fixed is listed in its slice as "change to …", never left under "must pass".
- Questions while running: hard-risk questions (risky operation, auth or money semantics) go to the user verbatim; the dispatcher never answers them. Other questions: the delegate applies the default, records it in the report, and keeps going.

## Delivery
- No recursive handoff. Return blockers or incomplete work to dispatcher. Choose smallest option within scope. Report `COMPLETE | BLOCKED | INCOMPLETE`, base/tip SHA, changed files, full-suite command and pass/fail counts, known gaps and simulation limits. Evidence per R is the command actually run: `R<n>: <command> → exit <code>, <passed>/<total>`. A command not run is written `UNVERIFIED: <reason>`, never as a result.
- **Evidence recheck, every Tier 2 delivery (both delegated and main-session-in-worktree):** run `node "$PIPELINE_HOME"/pipeline-run.mjs tier2-verify <base> [--change-dir openspec/changes/<name>] [--verify "<cmd>"]` at the tip SHA. It reruns each `**Verify:**` / slice evidence command with `set -o pipefail`, verifies clean worktree isolation, AND runs `risk-scan.mjs`. A mismatch, or a narrow command labelled as the full suite, sends a delegated delivery back once as `INCOMPLETE (evidence mismatch)`; a second mismatch goes to the user. For a behavior-test slice with separate Red, also rerun the Red command at the test commit.
- **Review only for risky code or weakened test oracles:** an independent reviewer (`brief.mjs tier2-review` / `docs/tier2-reviewer-brief.md`) is mandatory whenever `Risk:` names a class OR `tier2-verify` / `risk-scan.mjs` reports `REVIEW_REQUIRED` (any of the 5 risk classes or modified/deleted existing test assertions), even if the brief originally said `Risk: none` or `Contract: none`. Always dispatch an external heterogeneous reviewer via Paseo (`list_profiles` → `审查（按察司）` / `anchasi`) — never the built-in `Agent` tool. Record the verdict at tip SHA via `pipeline-run.mjs record-review --mode tier2`. With `Risk: none` AND `tier2-verify` `PASS`, that output is the acceptance evidence; human owns merge approval. If the reviewer returns `BLOCKED` or `NOT_MET`, never waive it silently: fix once only if single-point/low-risk and context is fresh (<2 compactions); after >=2 compactions or cross-module rework, stop and present the verbatim `BLOCKED` matrix to the human before acting.
- If fix needs cross-module change, persistence/schema change, new mechanism (lock, queue, worker, service), or >30% diff growth, stop: `BLOCKED (scope expansion)` for human decision.
- Commit each slice on the assigned branch before reporting (pre-authorized); review binds to tip SHA. Never merge, push, amend or rewrite history without the stop-point quote in `Authorization:`. Inside this worktree, use relative paths: never `cd <shared-checkout>`, `git -C <other-checkout>`, or multi-directory `git` shells. Commit trailers: `Pipeline-Role: <Delegate id>`, `Pipeline-Author: <agent id>`, and `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Progress and recovery
- Track progress in `$(git rev-parse --git-dir)/handoff-progress.md`; record done/next, files touched and conclusions. After compaction, read it first.
- One full context window with no write: stop and return `BLOCKED` with unresolved item.
- Reconcile Paseo agent status with Git; elapsed time is never completion. Progress is counted in finished slices, not minutes.
- Diff past the size estimate by >30%: stop and return `BLOCKED (scope expansion)`.
