// Verify command safety & provability prover shared by freeze-check (Tier 3) and tier2-verify (Tier 2).
// Accepts only shell commands whose exit status is deterministically linked to real verification work
// (F-1..F-7): prevents `true`, `echo ok || true`, `node -e "0"`, `bash -c`, `eval`, or `| cat` spoofing.
import { FIXTURE_DIR, isTestPath } from './paths.mjs';
import { FULL_SUITE_LEG, legPaths, verifyLegs } from './tasks.mjs';

export const verifyTestPath = (p) => isTestPath(p) && !FIXTURE_DIR.test(p);

export const testScript = (command) => /^(?:(?:bash|sh)\s+)?(?:\.\/)?(?:[\w.-]+\/)*test(?:[._-][\w.-]+)?\.(?:sh|bash)(?:\s|$)/i.test(command)
  && !FIXTURE_DIR.test(command.replace(/^(?:bash|sh)\s+/, '').split(/\s/)[0]);

// Option arguments (`--config test/fixtures/jest.config.js`) configure the run; they are not what it runs.
export function fixtureOnlyLeg(leg) {
  const tokens = leg.command.split(/\s+/);
  const targets = tokens.flatMap((token, i) => {
    const prev = tokens[i - 1] ?? '';
    if (/^-/.test(prev) && !/=/.test(prev) && prev !== '--' && prev !== '--test') return [];
    return legPaths(token);
  });
  return targets.length > 0 && targets.every((p) => FIXTURE_DIR.test(p));
}

export function legProves(leg) {
  return (FULL_SUITE_LEG.test(leg.command) && !fixtureOnlyLeg(leg))
    || testScript(leg.command)
    || leg.paths.some(verifyTestPath);
}

export function acceptanceLegProves(leg) {
  if (leg.broad || legProves(leg)) return true;
  const command = leg.command.replace(/^\s*(?:[A-Za-z_]\w*=\S*\s+)+/, '');
  return /^(?:npm|pnpm|yarn|bun)\s+(?:--?[a-z-]+(?:=\S+)?\s+)*[A-Za-z]/.test(command)
    || /^(?:npx\s+)?(?:tsc|eslint|biome|swc|babel)\b/.test(command)
    || /^(?:make|cargo|go|dotnet|mvn|gradle)\s+(?:build|check|test|lint|vet)\b/.test(command);
}

export function maskQuotes(text) {
  return text.replace(/'[^']*'|"[^"]*"/g, (segment) => `${segment[0]}${'x'.repeat(Math.max(0, segment.length - 2))}${segment[0]}`);
}

export function maskShell(text) {
  let out = '';
  let quote = null;
  for (const ch of text) {
    if (quote === "'") { if (ch === "'") { quote = null; out += ch; } else out += ch === '\n' ? ch : 'x'; }
    else if (quote === '"') {
      if (ch === '`' || ch === '\\') out += ch;
      else if (ch === '$' || (out.endsWith('$') && (ch === '(' || ch === '{'))) out += ch;
      else if (ch === '"') { quote = null; out += ch; }
      else out += ch === '\n' ? ch : 'x';
    } else if (ch === "'" || ch === '"') { quote = ch; out += ch; }
    else out += ch;
  }
  return out;
}

const SIMPLE_PARAM = /\$\{?[A-Za-z_]\w*\}?/g;
const CONTROL_WORD = /(?:^|[\s;&|])(?:for|while|until|select|if|then|elif|else|fi|case|esac|do|done|function|coproc|time)\b/;
const EXIT_NONZERO = /\|\|\s*exit(?:\s+(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-5]))?\s*$/;
const ITERATION_VAR = /^\$\{?([A-Za-z_]\w*)\}?$/;
const INLINE_CODE = /^(?:node|bun|deno|python[0-9.]*|ruby|perl|php)\b.*(?:^|\s)(?:-e|--eval|--print|-p)(?:\s|=|$)/;
const ANY_ARGS = new Set(['tsc', 'eslint', 'swc', 'babel', 'jest', 'mocha', 'phpunit', 'rspec', 'php', 'pytest']);
const RUNS_TESTS = {
  node: /^(?:-\S+\s+)*--test(?:\s|$)/,
  npm: /^(?:(?:-\S+)\s+)*(?:test|t|run(?:-script)?(?:\s+(?:test|build|lint|check|typecheck))?)(?:\s|$)/,
  pnpm: /^(?:(?:-\S+)\s+)*(?:test|t|run(?:\s+(?:test|build|lint|check|typecheck))?)(?:\s|$)/,
  yarn: /^(?:(?:-\S+)\s+)*(?:test|run(?:\s+(?:test|build|lint|check|typecheck))?)(?:\s|$)/,
  bun: /^(?:(?:-\S+)\s+)*(?:test|run(?:\s+(?:test|build|lint|check|typecheck))?)(?:\s|$)/,
  deno: /^(?:(?:-\S+)\s+)*test(?:\s|$)/,
  go: /^(?:(?:-\S+)\s+)*test(?:\s|$)/,
  cargo: /^(?:(?:-\S+)\s+)*(?:test|nextest)(?:\s|$)/,
  make: /^(?:(?:-\S+|\S+=\S*)\s+)*(?:test|check|lint)(?:\s|$)/,
  pytest: /^(?:(?:-\S+)\s+)*\S/,
  python: /^(?:(?:-\S+)\s+)*-m\s+pytest(?:\s|$)/,
  python3: /^(?:(?:-\S+)\s+)*-m\s+pytest(?:\s|$)/,
  uv: /^(?:(?:-\S+)\s+)*(?:run\s+)?pytest(?:\s|$)/,
  poetry: /^(?:(?:-\S+)\s+)*(?:run\s+)?pytest(?:\s|$)/,
  dotnet: /^(?:(?:-\S+)\s+)*test(?:\s|$)/,
  mvn: /^(?:(?:-\S+)\s+)*(?:test|verify)(?:\s|$)/,
  gradle: /^(?:(?:-\S+)\s+)*(?:test|check)(?:\s|$)/,
  tsc: /^(?:-\S+\s+)*\S/,
  eslint: /^(?:-\S+\s+)*\S/,
  biome: /^(?:(?:-\S+)\s+)*(?:check|ci)(?:\s|$)/,
  swc: /^(?:-\S+\s+)*\S/,
  babel: /^(?:-\S+\s+)*\S/,
  jest: /^(?:-\S+\s+)*\S/,
  vitest: /^(?:(?:-\S+)\s+)*(?:run)?(?:\s|$)/,
  mocha: /^(?:-\S+\s+)*\S/,
  playwright: /^(?:(?:-\S+)\s+)*test(?:\s|$)/,
  cypress: /^(?:(?:-\S+)\s+)*run(?:\s|$)/,
  phpunit: /^(?:-\S+\s+)*\S/,
  rspec: /^(?:-\S+\s+)*\S/,
  ruby: /^(?:-\S+\s+)*-e(?:\s|$)/,
  php: /^(?:-\S+\s+)*\S/,
  swift: /^(?:(?:-\S+)\s+)*test(?:\s|$)/,
  xcodebuild: /^(?:(?:-\S+)\s+)*test(?:\s|$)/,
  npx: /^(?:(?:-\S+)\s+)*(?:tsc|eslint|biome|swc|babel|jest|vitest|mocha|playwright|cypress|tsx|ts-node)(?:\s|$)/,
  bunx: /^(?:(?:-\S+)\s+)*(?:tsc|eslint|biome|swc|babel|jest|vitest|mocha|playwright|cypress|tsx|ts-node)(?:\s|$)/,
};

export function isManualVerify(text) {
  return /^\s*`?\s*(?:!|manual|手工|自然语言)/i.test(String(text || ''));
}

export function unprovableVerifyReason(text, loopList = null, rootCommand = text) {
  if (/\n/.test(text.trim())) return 'a newline starts another command, so the row\'s status is not the first command\'s status; put the checks in one `&&` chain or in a `test*` script';
  const masked = maskQuotes(text);
  const shell = maskShell(text).replace(SIMPLE_PARAM, (m) => 'x'.repeat(m.length));
  if (/(?:^|[\s=])(?:[\w.-]*\/)*(?:bash|sh|dash|zsh|ksh|fish)(?:-[\d.]*)?\s+-[a-z]*c\s/.test(masked)) {
    return 'a `bash -c`/`sh -c` body runs in a new shell, so the gate cannot prove its exit status';
  }
  if (/(?:^|[\s;&|(){}])(?:eval|source|command\s+eval|builtin\s+eval)(?:\s|$)|(?:^|[\s;|&])\.\s+\S/.test(masked)) {
    return '`eval`/`source` re-interpret their argument as shell code, so a quoted body is not an argument; run the check in its own `test*` script';
  }
  if (/[`\\]|\$\(/.test(shell)) {
    return 'a command substitution or an escaped character means a leg of this row is not the command the shell actually runs; run the check in a `test*` script';
  }
  const loopSpans = [...masked.matchAll(/for\s+[A-Za-z_]\w*\s+in\s+[^;]+;\s*do[\s\S]*?\bdone\b/gi)];
  const inLoop = (index) => loopSpans.some((m) => index >= m.index && index < m.index + m[0].length);
  const cuts = [];
  for (let i = masked.indexOf('&&'); i !== -1; i = masked.indexOf('&&', i + 2)) if (!inLoop(i)) cuts.push(i);
  if (cuts.length) {
    const segments = [];
    let last = 0;
    for (const cut of cuts) { segments.push([text.slice(last, cut), masked.slice(last, cut)]); last = cut + 2; }
    segments.push([text.slice(last), masked.slice(last)]);
    for (const [rawSegment] of segments) {
      const segmentReason = unprovableVerifyReason(rawSegment.trim(), loopList, rootCommand);
      if (segmentReason) return segmentReason;
    }
    return null;
  }
  const LOOP = /^for\s+([A-Za-z_]\w*)\s+in\s+([^;]+);\s*do\s+([\s\S]+?);?\s*done$/i;
  const loop = LOOP.exec(text);
  if (loop) {
    const list = loop[2].trim();
    if (/[$`'"();&|<>\\]/.test(maskShell(list))) {
      return 'a loop list with a substitution, quote or redirection is expanded by the shell and can leave the loop with zero iterations and status 0';
    }
    const bodyReason = unprovableVerifyReason(loop[3], list.split(/\s+/), rootCommand);
    if (bodyReason) return bodyReason;
    return EXIT_NONZERO.test(maskQuotes(loop[3]).trim())
      ? null
      : 'a `for` loop without a trailing `|| exit <1-255>` continues after a failed iteration and can finish with status 0';
  }
  let headMasked = masked.trim();
  let head = text.trim();
  let headShell = shell.trim();
  if (/\|\|/.test(headMasked)) {
    const tail = EXIT_NONZERO.exec(headMasked);
    if (!tail || /\|\|/.test(headMasked.slice(0, tail.index))) return '`||` hides which leg is the check unless it is a single trailing `|| exit <1-255>`';
    const cutAt = headMasked.length - tail[0].length;
    headMasked = headMasked.slice(0, cutAt);
    headShell = headShell.slice(0, cutAt);
    head = head.slice(0, cutAt);
  }
  if (/[;|&!`\\]|[(){}]|\$\(/.test(headShell) || CONTROL_WORD.test(headMasked)) {
    return 'only one command or commands joined by `&&` can have a provable exit status; `;`, `|`, `!`, a loop, a condition, a subshell or a nested shell can exit 0 after a leg failed';
  }
  const legSource = head.replace(/'[^']*'|"[^"]*"/g, (segment) => segment.replace(/\|/g, ' '));
  const legs = verifyLegs(legSource);
  const entryOf = (leg) => leg.command.replace(/^\s*(?:[A-Za-z_]\w*=\S*\s+)+/, '').trim()
    .replace(/^(?:[\w.-]*\/)+([\w.-]+)/, '$1');
  const wordsOf = (leg) => entryOf(leg).split(/\s+/).filter((word) => word && !/^[A-Za-z_]\w*=/.test(word));
  const testInvocation = (leg) => {
    const words = wordsOf(leg);
    const program = words[0] ?? '';
    if (INLINE_CODE.test(leg.command)) return false;
    if (loopList && /^\$/.test((words[words.length - 1] ?? '').replace(/^['"]|['"]$/g, ''))) return true;
    if (Object.prototype.hasOwnProperty.call(RUNS_TESTS, program)) {
      if (ANY_ARGS.has(program)) return words.length > 1;
      if ((program === 'node' || program === 'bun' || program === 'deno')
        && words.length === 2 && verifyTestPath(words[1].replace(/^['"]|['"]$/g, ''))) return true;
      const args = [];
      for (let i = 1; i < words.length; i += 1) {
        if (/^(?:--prefix|-C|--dir|--cwd|--project|-p|-c|--config|--reporter|--filter)$/.test(words[i])) { i += 1; continue; }
        args.push(words[i]);
      }
      return RUNS_TESTS[program].test(args.join(' '));
    }
    return testScript(leg.command);
  };
  const entryOk = (leg) => {
    if (testInvocation(leg)) return true;
    const words = wordsOf(leg);
    const headWord = words[0] ?? '';
    if (!/^(?:[\w.-]*\/)*(?:bash|sh)$/.test(headWord)) return false;
    const target = words[1] ?? '';
    if (!target || target.startsWith('-') || words.length !== 2) return false;
    const p = target.replace(/^['"]|['"]$/g, '');
    return testScript(`bash ${p}`) || verifyTestPath(p);
  };
  const iterated = (leg) => {
    if (!loopList) return false;
    const target = leg.command.split(/\s+/).reverse().find((token) => !token.startsWith('-')) ?? '';
    return !!ITERATION_VAR.exec(target.replace(/['"]/g, ''));
  };
  const provesLeg = (leg) => acceptanceLegProves(leg)
    || testInvocation(leg)
    || (iterated(leg) && loopList.some((item) => {
      const p = item.replace(/^['"]|['"]$/g, '');
      return verifyTestPath(p) || testScript(`bash ${p}`) || legPaths(p).some((x) => verifyTestPath(x));
    }));
  if (!(legs.length > 0 && legs.every((leg) => entryOk(leg) && provesLeg(leg)))) {
    return `${JSON.stringify(rootCommand)} proves nothing — run a real entry point or test command whose exit status can fail`;
  }
  return null;
}

export function proveVerifyCommand(raw) {
  const command = String(raw || '').replace(/^`+|`+$/g, '').trim();
  if (!command) return { ok: false, command: '', reason: 'Verify command is empty' };
  if (isManualVerify(command)) {
    return { ok: false, command, reason: 'manual/placeholder Verify command cannot be proven; supply an executable test or check command' };
  }
  const reason = unprovableVerifyReason(command);
  if (reason) return { ok: false, command, reason };
  return { ok: true, command, reason: null };
}
