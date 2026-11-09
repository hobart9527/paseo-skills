#!/usr/bin/env node
// Read-only namespace snapshot for a contract author: which SCEN prefixes are already in use
// across the baseline and the other unarchived changes, and which requirement headings those
// changes touch. One call instead of a hand-run `rg` sweep. Never writes, never mutates git.
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './lib/git.mjs';
import { walkSpecFiles, scanScenarios, scanRequirements, capabilityOf, collectSpecSources, readSpecText } from './lib/spec-scan.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const positional = args.filter((arg) => !arg.startsWith('--'));
const changeArg = positional[0];
if (!changeArg || positional.length > 1 || args.some((arg) => arg.startsWith('--') && arg !== '--json')) {
  console.error('Usage: namespace.mjs <change-dir> [--json]');
  process.exit(2);
}
const changeDir = path.resolve(changeArg);
const changeName = path.basename(changeDir);
// The change directory may not exist yet (specs-first authoring); git runs from its nearest
// existing ancestor instead of failing on a missing cwd.
const gitCwd = (() => {
  let dir = changeDir;
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fs.existsSync(dir) ? dir : process.cwd();
})();
const toplevel = runGit(gitCwd, ['rev-parse', '--show-toplevel']);
if (toplevel.status !== 0) {
  console.error(`namespace: ${changeArg} is not inside a git repository`);
  process.exit(2);
}
const repoRoot = toplevel.stdout.trim();
// The change being authored is excluded by directory when it exists and by name when it does not
// (a specs-first author runs this before creating the change directory).
const excludeDir = fs.existsSync(changeDir) ? changeDir : null;
const excludeName = fs.existsSync(changeDir) ? null : changeName;
const { sources, unreadable: scanUnreadable } = collectSpecSources({ repoRoot, excludeDir, excludeName });

const ID = /^SCEN-(.*)-(\d+)$/;
const prefixes = new Map();
const unparsed = [];
// A spec file (or a directory that cannot be listed) is never silently skipped: the free-range
// numbers and the requirement overlap list would be wrong while the report looked complete. It is
// listed and makes the exit status nonzero, while the rest of the report still prints so the author
// can act on it.
const unreadable = [...scanUnreadable];
for (const file of sources) {
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  const changeMatch = /^openspec\/changes\/([^/]+)\//.exec(relative);
  const source = changeMatch ? { kind: 'change', name: changeMatch[1] } : { kind: 'baseline', name: 'baseline' };
  const { text, error } = readSpecText(file);
  if (error) {
    unreadable.push({ file: relative, reason: error });
    continue;
  }
  for (const found of scanScenarios(text)) {
    const match = ID.exec(found.id);
    if (!match || !match[1]) {
      unparsed.push({ id: found.id, file: relative });
      continue;
    }
    const prefix = match[1];
    const number = Number.parseInt(match[2], 10);
    if (!prefixes.has(prefix)) prefixes.set(prefix, { prefix, max: 0, occurrences: 0, sources: new Map(), scens: new Set() });
    const entry = prefixes.get(prefix);
    entry.max = Math.max(entry.max, number);
    entry.occurrences += 1;
    entry.scens.add(found.id);
    const key = `${source.kind}:${source.name}`;
    if (!entry.sources.has(key)) entry.sources.set(key, { kind: source.kind, name: source.name, ids: new Set() });
    entry.sources.get(key).ids.add(found.id);
  }
}
const scenarios = [...prefixes.values()]
  .map((entry) => ({
    prefix: entry.prefix,
    max: entry.max,
    next: entry.max + 1,
    occurrences: entry.occurrences,
    sources: [...entry.sources.values()]
      .map((source) => ({ kind: source.kind, name: source.name, ids: [...source.ids].sort() }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'baseline' ? -1 : 1)),
    ids: [...entry.scens].sort(),
  }))
  .sort((a, b) => a.prefix.localeCompare(b.prefix));

// Requirement headings another active change deltas, grouped by capability and change. The author
// reads this to see which baseline requirements are already in flight somewhere else.
const ACTIVE_SECTIONS = new Set(['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED']);
const requirements = [];
for (const file of sources) {
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  const changeMatch = /^openspec\/changes\/([^/]+)\//.exec(relative);
  if (!changeMatch) continue;
  const change = changeMatch[1];
  const capability = capabilityOf(path.join(repoRoot, 'openspec', 'changes', change, 'specs'), file);
  // Already reported above as unreadable; one entry per file is enough.
  const { text, error } = readSpecText(file);
  if (error) continue;
  for (const found of scanRequirements(text)) {
    if (!ACTIVE_SECTIONS.has(found.section)) continue;
    requirements.push({ change, capability, section: found.section, name: found.name, file: relative });
  }
}
const byCapability = new Map();
for (const entry of requirements) {
  if (!byCapability.has(entry.capability)) byCapability.set(entry.capability, []);
  byCapability.get(entry.capability).push(entry);
}
const capabilities = [...byCapability.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([capability, entries]) => {
  const changes = new Map();
  for (const entry of entries.sort((a, b) => a.change.localeCompare(b.change) || a.section.localeCompare(b.section) || a.name.localeCompare(b.name))) {
    if (!changes.has(entry.change)) changes.set(entry.change, { change: entry.change, sections: { ADDED: [], MODIFIED: [], REMOVED: [], RENAMED: [] } });
    changes.get(entry.change).sections[entry.section].push(entry.name);
  }
  return { capability, changes: [...changes.values()] };
});

if (json) {
  console.log(JSON.stringify({
    change: changeName,
    changeDir,
    scenarios,
    unparsed,
    unreadable,
    capabilities,
  }, null, 2));
} else {
  const lines = [`[namespace] ${changeName}`, `repo=${repoRoot}`, `sources=${sources.length} spec files (baseline + other unarchived changes)`, ''];
  lines.push(`SCEN prefixes in use (${scenarios.length}):`);
  for (const entry of scenarios) {
    const used = entry.sources.map((source) => `${source.name}(${source.ids.length})`).join(', ');
    lines.push(`  SCEN-${entry.prefix}  max=${entry.max} next=${entry.next} ids=${entry.occurrences}  ${used}`);
  }
  if (unreadable.length) {
    lines.push('', `Unreadable spec files or directories (${unreadable.length}, NOT scanned; free-range numbers may be incomplete):`);
    for (const entry of [...unreadable].sort((a, b) => a.file.localeCompare(b.file))) lines.push(`  ${entry.file}: ${entry.reason}`);
  }
  if (unparsed.length) {
    const byFile = new Map();
    for (const entry of unparsed) {
      if (!byFile.has(entry.file)) byFile.set(entry.file, []);
      byFile.get(entry.file).push(entry.id);
    }
    lines.push('', `Unparsed scenario ids (${unparsed.length}, not SCEN-<PREFIX>-<number>; listed only, never counted as a free-range source):`);
    for (const [file, ids] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`  ${file}: ${ids.join(', ')}`);
  }
  lines.push('', `Requirement headings other changes add/modify/remove (${requirements.length}):`);
  for (const entry of capabilities) {
    const parts = entry.changes.map((change) => {
      const sections = Object.entries(change.sections)
        .filter(([, names]) => names.length)
        .map(([section, names]) => `${section}: ${names.join('; ')}`)
        .join(' | ');
      return `${change.change} [${sections}]`;
    });
    lines.push(`  ${entry.capability}: ${parts.join(' | ')}`);
  }
  console.log(lines.join('\n'));
}
// Nonzero when any source could not be read: the report is incomplete, so a clean exit would lie.
if (unreadable.length) process.exitCode = 1;
