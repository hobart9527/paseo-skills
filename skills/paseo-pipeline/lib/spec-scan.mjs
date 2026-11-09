// Spec scanning for `freeze-check` and the read-only namespace report.
//
// Two layers, and no fs anywhere else:
//   - the pure scanners below take strings and trees only; their logic is the base
//     freeze-check.mjs logic, moved here verbatim so both callers cannot drift;
//   - `loadSpecTree` is the ONE place that reads spec files or lists spec directories. It never
//     throws: a missing input is merely absent (base's `existsSync` guard), and an input that
//     exists but cannot be read or listed becomes a `problems` entry. Callers only decide what a
//     problem means (freeze-check: block; namespace: report and exit nonzero). No caller catches
//     fs errors on spec reading.
import fs from 'node:fs';
import path from 'node:path';

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
// comments are not declarations, same as scenarios. Used by the staged specs check to find the
// requirements two active changes both touch.
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
// The capability a spec file belongs to: its path below `specs/`, without the `spec.md` leaf.
export function capabilityOf(specsDir, file) {
  const relative = path.relative(specsDir, file).split(path.sep).join('/');
  return relative.endsWith('/spec.md') ? relative.slice(0, -'/spec.md'.length) : relative.replace(/\.md$/i, '');
}

// ---- the single I/O entry ----
// The spec inputs as one tree, read once:
//   { kind: 'absent' }                          the path is not there (ENOENT/ENOTDIR)
//   { kind: 'unreadable', path, reason }        it is there but cannot be listed or read
//   { kind: 'dir', path, children: [...] }
//   { kind: 'file', path, text }
// `flattenFiles` and `treeProblems` are pure: they only walk the tree they are given, so the
// callers' policy over that tree needs no fs at all.
export function flattenFiles(node, match, out = []) {
  if (node.kind === 'dir') {
    for (const child of node.children) flattenFiles(child, match, out);
  } else if (node.kind === 'file' && match(node.path.slice(node.path.lastIndexOf('/') + 1))) {
    out.push(node);
  }
  return out;
}
export function treeProblems(node, out = []) {
  if (node.kind === 'unreadable') out.push(node);
  else if (node.kind === 'dir') { for (const child of node.children) treeProblems(child, out); }
  return out;
}

// `realpath` when it exists, so a change reached through a symlinked worktree still matches itself.
// This is identity resolution only and never classifies a spec input: an unreadable change reached
// through a link still differs from the authored change by path, which only adds a redundant
// duplicate of a source this run already reads, never removes one.
const realOr = (value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } };

// THE classifier, and the only place an I/O error becomes "absent". Absent means exactly ENOENT or
// ENOTDIR — the filesystem says the path is not there. Every other code (EACCES, EPERM, ELOOP, EIO,
// ...) means an entry is there that this process cannot examine, which is an unreadable problem,
// never a silent skip. When the failure itself reported ENOENT/ENOTDIR, lstat decides: lstat does
// not follow the final link, so a dangling symlink reads as PRESENT and is reported as unreadable;
// only a path whose own lstat also says "not there" is absent.
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
function classifyFailure(file, error) {
  if (!ABSENT_CODES.has(error.code)) return { kind: 'unreadable', path: file, reason: error.message, directory: false };
  try { fs.lstatSync(file); }
  catch (probeError) {
    return ABSENT_CODES.has(probeError.code)
      ? { kind: 'absent' }
      : { kind: 'unreadable', path: file, reason: probeError.message, directory: false };
  }
  return { kind: 'unreadable', path: file, reason: error.message, directory: false };
}

// List one directory, shallowly. Used for `openspec/changes`, which base listed with Dirents and
// never descended into itself; a failure to list it is classified by `classifyFailure`.
function listDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const state = classifyFailure(dir, error);
    return state.kind === 'unreadable' ? { ...state, directory: true } : state;
  }
  return { kind: 'dir', path: dir, entries };
}
// Read a `specs/` subtree. Only real directories are descended into (base's walk skipped a
// symlinked directory), and only files whose name satisfies `matchLeaf` are read at all. Listing
// goes through `listDir`, so every readdir failure is classified in exactly one place.
function readTree(dir, matchLeaf) {
  const listed = listDir(dir);
  if (listed.kind !== 'dir') return listed;
  const children = [];
  for (const entry of listed.entries) {
    if (!entry.isDirectory() && !matchLeaf(entry.name)) continue;
    children.push(entry.isDirectory() ? readTree(path.join(dir, entry.name), matchLeaf) : readLeaf(path.join(dir, entry.name)));
  }
  return { kind: 'dir', path: dir, children };
}
// One file's text, or its state when it cannot be read. Never returns empty text for an unreadable
// file; never records a genuinely missing file as a problem.
function readLeaf(file) {
  try {
    return { kind: 'file', path: file, text: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return classifyFailure(file, error);
  }
}

// The one place spec I/O happens. Returns a snapshot, never throws:
//   { current: [{file, text}], baseline: [{file, text}], others: [{change, file, text}],
//     problems: [{path, kind: 'unreadable', reason}] }
// Scope is base's, exactly:
//   - `current`: this change's own `specs/` tree, `spec.md` leaves (base's `walk`);
//   - `baseline`: `openspec/specs` as every `.md` (base's `walkMarkdown`);
//   - `others`: the immediate child directories of `openspec/changes` (Dirents; symlinked change
//     dirs are not followed), each read only at `<child>/specs`, every `.md`. Nothing under
//     `archive/`, under `<change>/` outside `specs/`, or directly in `openspec/changes` is opened.
// A path is absent only per `classifyFailure` (ENOENT/ENOTDIR): it contributes no source and no
// problem, which is what base's `existsSync` guard did. Anything present but unreadable contributes
// a problem and is skipped whole, never scanned as if it were empty.
// The change being authored is excluded by realpath, or by `excludeName` when its directory does
// not exist yet. A problem `path` is relative to `repoRoot` (else `changeDir`), trailing slash for
// a directory.
export function loadSpecTree({ repoRoot = null, changeDir, excludeName = null }) {
  const base = repoRoot ?? changeDir;
  const display = (node) => `${path.relative(base, node.path).split(path.sep).join('/')}${node.directory ? '/' : ''}`;
  const problemsOf = (node) => treeProblems(node).map((problem) => ({ path: display(problem), kind: 'unreadable', reason: problem.reason }));
  const sourcesOf = (tree, match, annotate = (source) => source) => flattenFiles(tree, match, [])
    .map((node) => annotate({ file: node.path, text: node.text }));
  const isMarkdown = (name) => name.endsWith('.md');

  const currentTree = readTree(path.join(changeDir, 'specs'), (name) => name === 'spec.md');
  const snapshot = {
    current: sourcesOf(currentTree, (name) => name === 'spec.md'),
    baseline: [],
    others: [],
    problems: problemsOf(currentTree),
  };
  if (!repoRoot) return snapshot;

  const baselineTree = readTree(path.join(repoRoot, 'openspec', 'specs'), isMarkdown);
  snapshot.baseline = sourcesOf(baselineTree, isMarkdown);
  snapshot.problems.push(...problemsOf(baselineTree));

  const changes = listDir(path.join(repoRoot, 'openspec', 'changes'));
  if (changes.kind === 'unreadable') snapshot.problems.push({ path: display(changes), kind: 'unreadable', reason: changes.reason });
  if (changes.kind !== 'dir') return snapshot;
  const currentReal = realOr(changeDir);
  for (const entry of changes.entries) {
    // Base used Dirent.isDirectory(), which is false for a symlink: a symlinked change dir is not
    // followed and contributes nothing.
    if (!entry.isDirectory()) continue;
    const dir = path.join(changes.path, entry.name);
    if (realOr(dir) === currentReal) continue;
    if (excludeName && entry.name === excludeName) continue;
    const specsTree = readTree(path.join(dir, 'specs'), isMarkdown);
    snapshot.others.push(...sourcesOf(specsTree, isMarkdown, (source) => ({ change: entry.name, ...source })));
    snapshot.problems.push(...problemsOf(specsTree));
  }
  return snapshot;
}
