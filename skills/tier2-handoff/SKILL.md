---
name: tier2-handoff
description: Fill the Tier 2 delegation brief (Authorization, Pending decisions, Slices, size estimate) and run the pre-dispatch check, then dispatch through /paseo-handoff. Use whenever Tier 2 work is delegated to another agent.
user-invocable: true
---

# Tier 2 Handoff

`/paseo-handoff` is bundled with Paseo and synced by the app, so it is not edited. This skill wraps it: the brief is filled and checked here first, then pasted into the `/paseo-handoff` prompt.

1. Read `docs/tier2-handoff-brief.md` from this skills checkout (`~/Codex/paseo-skills/docs/tier2-handoff-brief.md`). It is the only template; do not restate it.
2. Fill every Assignment field. `Slices` is serial, one line per slice, no DAG. A Tier 3 `freeze-check` that routed `handoff` supplies its tasks as `Slices` unchanged.
3. Run the brief's `Pre-dispatch check`. Do not dispatch while any item fails:
   - `Authorization:`, `Pending decisions`, `Slices`, `Risk:` or `Contract:` is missing, or `openspec validate <name> --strict` does not exit 0.
   - A must-pass test asserts a defect being fixed. Move it into its slice as "change to …".
   - A pending decision touches a risky operation, or auth or money semantics, and has no user answer. Ask the user once, giving the exact reply sentence, and end the turn.
4. Tell the user the size estimate (files, lines, minutes) and the slice count.
5. Invoke `/paseo-handoff`. Put the filled brief in its `## Constraints` and `## Acceptance criteria` sections, and the `Slices` in `## Task`.
6. Track progress by finished slices and Git tips, not elapsed time. Hard-risk questions the delegate raises go to the user verbatim; never answer them.
7. On delivery, run the brief's Evidence recheck yourself: rerun every reported evidence command at the tip SHA and match exit codes and counts. Dispatch a reviewer only when `Risk:` names a class.
