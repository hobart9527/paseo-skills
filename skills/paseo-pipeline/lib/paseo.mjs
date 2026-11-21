// Single Paseo CLI & profile config adapter shared by pipeline scripts and hooks.
// Preserves historical query helpers and exact error contracts for cleanup, freeze-check,
// merge-task, next-actions, profiles-check, and tool-guard-hook.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function paseoHome() {
  return process.env.PASEO_HOME || path.join(os.homedir(), '.paseo');
}

export function loadProfiles({ configPath = null, home = null, strict = false } = {}) {
  const file = configPath || path.join(home || paseoHome(), 'config.json');
  try {
    const profiles = JSON.parse(fs.readFileSync(file, 'utf8'))?.daemon?.agentProfiles;
    return Array.isArray(profiles) ? profiles : [];
  } catch (err) {
    if (strict) throw err;
    return [];
  }
}

export function profilePair(profile) {
  return profile?.provider && profile?.model ? `${profile.provider}/${profile.model}` : null;
}

export function listAgents() {
  const result = spawnSync('paseo', ['ls', '--all', '--json'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) return { error: 'cannot resolve agent provider/model from `paseo ls --all --json`' };
  try {
    const agents = JSON.parse(result.stdout);
    if (!Array.isArray(agents)) throw new Error('expected agent array');
    return { agents };
  } catch {
    return { error: 'invalid JSON from `paseo ls --all --json`' };
  }
}

export function inspectAgent(agentId, { timeout = 10_000 } = {}) {
  const result = spawnSync('paseo', ['inspect', agentId, '--json'], { encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const providerOf = (agent) => {
  const value = agent?.provider ?? agent?.Provider;
  return typeof value === 'string' && value.includes('/') ? value.toLowerCase() : null;
};

export const modelOf = (agent) => providerOf(agent)
  ?? (() => {
    const provider = agent?.provider ?? agent?.Provider;
    const model = agent?.model ?? agent?.Model;
    return provider && model ? `${provider}/${model}`.toLowerCase() : null;
  })();

export const nameOf = (agent) => {
  const value = agent?.name ?? agent?.Name;
  return typeof value === 'string' ? value : '';
};

export function findAgents(agentId, agents) {
  const wanted = String(agentId || '').toLowerCase();
  if (!wanted) return [];
  return agents.filter((agent) => [agent.id, agent.shortId].some((value) => typeof value === 'string' && value.toLowerCase().startsWith(wanted)));
}

export function listPaseoAgents({ label = null, timeout = 10_000 } = {}) {
  const args = ['ls', '--global', '--background'];
  if (label) args.push('--label', label);
  args.push('--json');
  const res = spawnSync('paseo', args, { encoding: 'utf8', timeout });
  if (res.error || res.status !== 0) return { error: `cannot read Paseo state (\`paseo ${args.join(' ')}\`)` };
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch { return { error: 'invalid JSON from `paseo ls --json`' }; }
  if (!Array.isArray(parsed)) return { error: 'invalid Paseo agent list' };
  return { agents: parsed };
}

export const inspectPaseoAgent = inspectAgent;

export function listPaseoWorkspaces({ timeout = 10_000 } = {}) {
  const result = spawnSync('paseo', ['workspace', 'ls', '--background', '--json'], { encoding: 'utf8', timeout });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || (result.stderr || '').trim();
    return { error: `cannot read Paseo workspaces (\`paseo workspace ls --background --json\`${detail ? `: ${detail}` : ''})` };
  }
  let listed;
  try { listed = JSON.parse(result.stdout); } catch { return { error: 'invalid JSON from `paseo workspace ls --background --json`' }; }
  if (!Array.isArray(listed)) return { error: 'invalid Paseo workspace list' };
  return { workspaces: listed };
}
