## Why

<!-- Explain the motivation for this change. What problem does this solve? Why now? -->

## What Changes

<!-- Describe what will change. Be specific about new capabilities, modifications, or removals. -->

## Capabilities

### New Capabilities
<!-- Capabilities being introduced. Use kebab-case for path segments you introduce
     (e.g., user-auth or identity/user-auth) that follow the project's existing
     spec organization. Each creates specs/<capability-path>/spec.md. -->
- `<capability-path>`: <brief description of what this capability covers>

### Modified Capabilities
<!-- Existing capabilities whose REQUIREMENTS are changing (not just implementation).
     Only list here if spec-level behavior changes. Each needs a delta spec file.
     Use the exact existing path under openspec/specs/. Leave empty if no requirement
     changes. A change with no capabilities at all (pure refactor, tooling, docs)
     must set `skip_specs: true` in its .openspec.yaml - openspec validate rejects
     a zero-delta change without that marker. Do not invent a requirement just to
     satisfy validation. -->
- `<existing-capability-path>`: <what requirement is changing>

## Impact

<!-- Only material affected code, APIs, dependencies, or systems -->

## Baseline

<!-- Only facts that support a changed rule. Write each code-reading finding here
     (or beside the rule in specs/design) AS FOUND and commit: `path:line` plus one
     line of consequence. A finding that exists only in thinking does not count.
     No survey, no alignment tables. -->
- `<path:line>`: <consequence for the changed rule>

## OPEN-DECISION

<!-- Only for a material product choice the inputs do not settle. Omit if none.
     Continue on the recommended default; never decide for the human. -->
- **<decision>**: options <A | B>; consequences <of each>; recommended default <A>.
