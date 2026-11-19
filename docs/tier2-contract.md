# Tier 2 Contract

Native OpenSpec, two files, written before the first source edit. Read by `/tier2-handoff` and by the main session working alone in its worktree.

Write it only when the change adds or alters behaviour a user or caller can observe. Mechanical work (rename, move, refactor under existing tests, config, docs) writes `Contract: none — <reason>` in the brief instead; the slices' done evidence is then the oracle.

```
openspec/changes/<name>/
  specs/<capability>/spec.md
  tasks.md
```

`proposal.md` is not written: the user's words are the `Requirements:` field of the handoff brief. Add it, with `## Capabilities`, only when the change spans more than one capability.

## spec.md
- `## Purpose` for a new capability (50+ chars); `## ADDED | MODIFIED | REMOVED Requirements` for the delta.
- Each `### Requirement:` states SHALL behaviour a user or caller can observe.
- Each requirement has at least one `#### Scenario:` with WHEN/THEN, then one line `**Verify:** <single command that runs the real entry>`.
- Facts the rule rests on: `path:line` beside the rule.

## tasks.md
- Native checkboxes, one per `Slices` entry: `- [ ] 1.1 <goal> | Verify: <command>`.
- The write scope is the slice's files; no IDs, no dependencies.

## Check
`openspec validate <name> --strict` must exit 0. It proves structure only; the `**Verify:**` line is proved by the Evidence recheck in `tier2-handoff-brief.md`.

Work grows past one session or four parallel tasks: keep the same files and route to `/paseo-pipeline`, which adds scenario ids and task fields on top.
