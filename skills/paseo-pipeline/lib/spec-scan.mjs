// Shared spec scanners. `freeze-check` and the read-only namespace report must agree on what counts
// as a declaration, so the rule lives here once instead of in two copies that drift.
import fs from 'node:fs';
import path from 'node:path';

// Every spec.md under a directory tree; the declaration sources of one change.
export function walkSpecFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSpecFiles(full, out);
    else if (entry.name === 'spec.md') out.push(full);
  }
  return out;
}
// Every markdown file: baseline specs and other changes' spec trees are scanned this way so a
// declaration in an odd filename is still seen by the cross-change check.
export function walkMarkdown(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}
// Visible markdown lines: HTML comments contribute nothing and a fenced block is an example, not
// prose. Both the spec scanners and the design.md scan must agree on what counts as a declaration.
const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})/;
// Returns `{ text, rawIndex }` so a caller can recover the raw line behind a visible one: the
// scenario comparison needs the raw body, while the declaration scan needs the visible heading.
export function visibleLines(markdown) {
  const out = [];
  let fence = null;
  let comment = false;
  const raw = markdown.split(/\r?\n/);
  for (let rawIndex = 0; rawIndex < raw.length; rawIndex += 1) {
    const original = raw[rawIndex];
    let line = original;
    // A fence marker on the raw line wins over comment stripping: ```html <!-- opens a fence, and the
    // comment opener inside it belongs to the fenced example, so it must not leak past the closer.
    const rawOpens = !fence && !comment && FENCE_MARKER.test(original);
    if (!fence && !rawOpens) {
      let visible = '';
      while (line) {
        if (comment) {
          const end = line.indexOf('-->');
          if (end < 0) { line = ''; break; }
          comment = false;
          line = line.slice(end + 3);
        } else {
          const start = line.indexOf('<!--');
          if (start < 0) { visible += line; break; }
          visible += line.slice(0, start);
          line = line.slice(start + 4);
          comment = true;
        }
      }
      line = visible;
    }
    const marker = line.match(FENCE_MARKER);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = null;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    out.push({ text: line, rawIndex });
  }
  return out;
}
// Body of a `### Scenario:` heading AS COMPARED for the verbatim exemption. This is deliberately a
// different function from the declaration scan below: discovery reads visible content (fenced
// examples and comments are not declarations), while a comparison of two declarations must keep
// everything a reader would compare. Comparison is conservative CONTENT IDENTITY, not Markdown
// rendering equivalence. It reads the RAW lines, keeps fenced payloads, and only
//   1. ends the body at the next VISIBLE heading of the same or higher level — a `#` line inside a
//      fenced payload or an HTML comment is content, not the end of the scenario,
//   2. normalizes line endings (CRLF -> LF); the split below does that and nothing else,
//   3. drops leading and trailing EMPTY lines (a whitespace-only line is content, not empty),
// and normalizes nothing else: per-line trailing whitespace, interior whitespace, indentation,
// fence delimiters, fence info strings, and comment/payload content all take part in the
// comparison. A ``` vs ~~~ pair, or a nested fence whose inner info string changed, is therefore a
// collision: reuse copies the authoritative text instead of regenerating it. Do not fold this into
// `visibleLines`.
export function comparedBody(markdown, index, visible = visibleLines(markdown)) {
  const raw = markdown.split(/\r?\n/);
  // Not a heading (or no line): there is no scenario body to compare, never a crash.
  const self = (raw[index] || '').match(/^(#{1,6})\s/);
  if (!self) return '';
  const level = self[1].length;
  // Boundary from visible structure only: the same notion of "heading" every other check uses.
  let boundary = raw.length;
  for (const entry of visible) {
    if (entry.rawIndex <= index) continue;
    const heading = entry.text.match(/^(#{1,6})\s/);
    if (heading && heading[1].length <= level) { boundary = entry.rawIndex; break; }
  }
  const body = [];
  for (let next = index + 1; next < boundary; next += 1) body.push(raw[next]);
  while (body.length && body[0] === '') body.shift();
  while (body.length && body[body.length - 1] === '') body.pop();
  return body.join('\n');
}
// Every `### Scenario: SCEN-...` declared in a markdown file's visible content.
export function scanScenarios(markdown) {
  const entries = visibleLines(markdown);
  const found = [];
  let section = '';
  for (const { text, rawIndex } of entries) {
    const heading = text.match(/^##\s+(.+?)\s*$/);
    if (heading) { section = heading[1]; continue; }
    // CommonMark only treats `### ` as an ATX heading when whitespace follows the hashes, so
    // `####Scenario:` is ordinary text.
    const match = text.match(/^#{3,6}\s+Scenario\s*:\s*(SCEN-[A-Za-z0-9-]+)(.*)$/i);
    if (!match) continue;
    // The heading/title separator is the only whitespace a title comparison ignores; internal and
    // trailing whitespace stay part of the title, so two headings that differ there are not the
    // same declaration.
    const title = match[2].replace(/^[ \t]+/, '');
    found.push({ id: match[1].toUpperCase(), title, body: comparedBody(markdown, rawIndex, entries), section, line: rawIndex });
  }
  return found;
}
// `### Requirement:` headings grouped by the delta section they sit under. Fenced examples and
// comments are not declarations, same as scenarios.
const REQUIREMENT_SECTION = /^(?:ADDED|MODIFIED|REMOVED|RENAMED) Requirements$/i;
export function scanRequirements(markdown) {
  const found = [];
  let section = null;
  for (const { text, rawIndex } of visibleLines(markdown)) {
    const heading = text.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const match = REQUIREMENT_SECTION.exec(heading[1]);
      section = match ? heading[1].split(/\s+/)[0].toUpperCase() : null;
      continue;
    }
    const match = text.match(/^###\s+Requirement\s*:\s*(.+?)\s*#*\s*$/i);
    if (section && match) found.push({ section, name: match[1], line: rawIndex });
  }
  return found;
}
// The capability a spec file belongs to: its path below `specs/`, without the `spec.md` leaf.
export function capabilityOf(specsDir, file) {
  const relative = path.relative(specsDir, file).split(path.sep).join('/');
  return relative.endsWith('/spec.md') ? relative.slice(0, -'/spec.md'.length) : relative.replace(/\.md$/i, '');
}
// `realpath` when it exists, so a change reached through a symlinked worktree still matches itself.
export function realOr(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}
// Baseline specs plus every unarchived change's spec tree. `excludeDir` is the change being
// authored; `excludeName` covers a change directory that does not exist yet, where realpath cannot
// match it. Archived changes live under `changes/archive/<name>/specs`, which this walk does not
// reach, so only active changes contribute.
export function collectSpecSources({ repoRoot, excludeDir = null, excludeName = null }) {
  const current = excludeDir == null ? null : realOr(excludeDir);
  const baselineFiles = new Set(walkMarkdown(path.join(repoRoot, 'openspec', 'specs')));
  const sources = [...baselineFiles];
  const changesRoot = path.join(repoRoot, 'openspec', 'changes');
  if (fs.existsSync(changesRoot)) {
    for (const entry of fs.readdirSync(changesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (excludeName && entry.name === excludeName) continue;
      const dir = path.join(changesRoot, entry.name);
      if (current && realOr(dir) === current) continue;
      sources.push(...walkMarkdown(path.join(dir, 'specs')));
    }
  }
  return { baselineFiles, sources };
}
// A spec file that cannot be read (dangling symlink, permissions) must never be treated as empty:
// an empty file declares nothing, so the collision gate would silently pass over it. Callers turn
// `error` into a block (freeze-check) or a reported unreadable file (namespace.mjs).
export function readSpecText(file) {
  try { return { text: fs.readFileSync(file, 'utf8'), error: null }; }
  catch (error) { return { text: null, error: error.message }; }
}
// Which external file declares each scenario id, with its visible heading text and body. The
// section in that file decides nothing: the external side cannot know whether this change is
// legitimately re-declaring the id. `unreadable` lists sources whose text could not be read, so
// the caller can fail instead of scanning an implicit empty string.
export function externalScenarios({ repoRoot, baselineFiles, sources }) {
  const external = new Map();
  const unreadable = [];
  for (const file of sources) {
    const { text, error } = readSpecText(file);
    if (error) {
      unreadable.push({ file: path.relative(repoRoot, file), reason: error });
      continue;
    }
    for (const found of scanScenarios(text)) {
      if (!external.has(found.id)) external.set(found.id, []);
      external.get(found.id).push({
        file: path.relative(repoRoot, file),
        baseline: baselineFiles.has(file),
        title: found.title,
        body: found.body,
      });
    }
  }
  return { external, unreadable };
}
// Classify this change's declared scenario ids against the external declarations. One definition
// for the full structural run and the staged specs run, so both reject the same things for the
// same reason:
//   - a baseline hit is allowed only when this change re-declares the id under MODIFIED/REMOVED
//     Requirements; baseline text is not compared because MODIFIED legitimately rewrites it.
//   - another change's hit is a collision when the heading text or body diverges. An identical
//     re-declaration is legal — `openspec validate` requires an unchanged MODIFIED scenario to
//     repeat its text — so it is only an advisory about archive/merge order.
export function classifyScenCollisions({ declared, declaredSection, declaredTitle, declaredBody, external }) {
  const blocking = [];
  const advisories = [];
  for (const scen of declared.keys()) {
    const currentAllowed = /^(?:MODIFIED|REMOVED) Requirements$/i.test(declaredSection.get(scen) || '');
    const same = (hit) => hit.title === (declaredTitle.get(scen) || '') && hit.body === (declaredBody.get(scen) || '');
    const hits = external.get(scen) || [];
    const collision = hits.find((hit) => (hit.baseline ? !currentAllowed : !same(hit)));
    if (collision) blocking.push(`COLLIDING_SCEN ${scen}: already declared in ${collision.file}`);
    for (const hit of hits) {
      if (!hit.baseline && same(hit)) {
        advisories.push(`ADVISORY_SHARED_SCEN ${scen}: ${hit.file} declares the same scenario text; confirm archive/merge order with that change before CP-1`);
      }
    }
  }
  return { blocking, advisories };
}
