#!/usr/bin/env node
// Read-only check: Paseo agent profile notes vs the SKILL.md `## Roles` table.
// Checks only what is deterministic: role has a profile, notes carry the template
// fields, brief paths exist, default implementation-pair families differ, antigravity
// declares diff-check, no profile claims a read-only guarantee the harness cannot give.
// Self-declared metadata only: not backend, target-independence or sandbox proof.
//
// Notes template (one `key: value` per line):
//   family:  model family (gemini | gpt | claude | glm | kimi | ...), compared for heterogeneity
//   harness: claude | codex | antigravity
//   write:   who guarantees the write boundary; antigravity must contain `diff-check`
//   use:     one line, when to pick this profile
//   not:     one line, what it does not do
//   brief:   repo-relative path of the brief to paste into the task prompt, or `none`

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELDS = ['family', 'harness', 'write', 'use', 'not', 'brief'];
const FALSE_READONLY = /纯只读|只读无写权限/;
// Default implementation pairings only. A tester and auditor may share a family;
// actual target contributors must be reconciled at dispatch, not inferred here.
const WRITERS = ['gongbu', 'gaogong', 'jiangzuo'];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export function rolesOf(skillText) {
  const section = skillText.split(/^## Roles\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  return [...section.matchAll(/^\|[^|\n]*`([a-z]+)`[^|\n]*\|/gm)].map((m) => m[1]);
}

export function field(notes, key) {
  const m = new RegExp(`^\\s*${key}\\s*[:：]\\s*(.+?)\\s*$`, 'im').exec(notes ?? '');
  return m ? m[1] : null;
}

export function check(roles, profiles, root = null) {
  const findings = [];
  const byRole = new Map();
  for (const role of roles) {
    const p = profiles.find((x) => x?.id === `agent_profile_${role}`);
    if (!p) { findings.push(`MISSING_PROFILE ${role}`); continue; }
    byRole.set(role, p);
    for (const f of FIELDS) if (!field(p.notes, f)) findings.push(`MISSING_FIELD ${role} ${f}`);
    if (FALSE_READONLY.test(p.notes ?? '')) findings.push(`FALSE_READONLY ${role}`);
    const brief = field(p.notes, 'brief');
    if (root && brief && brief !== 'none' && !fs.existsSync(path.resolve(root, brief))) findings.push(`MISSING_BRIEF ${role} ${brief}`);
    if (p.provider === 'antigravity' && !/diff-check/i.test(field(p.notes, 'write') ?? '')) {
      findings.push(`UNENFORCED_WRITE ${role}`);
    }
  }
  const fam = (r) => field(byRole.get(r)?.notes, 'family')?.toLowerCase();
  const clash = (a, b) => fam(a) && fam(a) === fam(b) && findings.push(`FAMILY_CLASH ${a} ${b} (${fam(a)})`);
  for (const w of WRITERS) clash('anchasi', w);
  clash('ceshi', 'gongbu');
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const skillFile = arg('--skill', path.join(here, 'SKILL.md'));
  const configFile = arg('--config', path.join(os.homedir(), '.paseo', 'config.json'));
  let roles; let profiles;
  try {
    const args = process.argv.slice(2);
    const seen = new Set();
    for (let i = 0; i < args.length; i += 2) {
      if (!['--skill', '--config', '--root'].includes(args[i]) || seen.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
        throw new Error('expected unique --skill/--config flags with file paths');
      }
      seen.add(args[i]);
    }
    roles = rolesOf(fs.readFileSync(skillFile, 'utf8'));
    profiles = JSON.parse(fs.readFileSync(configFile, 'utf8'))?.daemon?.agentProfiles ?? [];
    if (!roles.length) throw new Error(`no roles parsed from ${skillFile}`);
  } catch (error) {
    console.error(`Usage: profiles-check.mjs [--skill SKILL.md] [--config ~/.paseo/config.json] [--root repo]\n${error.message}`);
    process.exit(2);
  }
  const findings = check(roles, profiles, arg('--root', path.resolve(here, '..', '..')));
  console.log(findings.length ? findings.join('\n') : `profiles ok (${roles.length} roles)`);
  process.exit(findings.length ? 1 : 0);
}
