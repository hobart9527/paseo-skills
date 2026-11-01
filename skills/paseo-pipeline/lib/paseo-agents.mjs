// Shared Paseo agent lookup for merge-task (model heterogeneity) and freeze-check (R0 signer).
// Pure query helpers: callers decide whether an unresolvable agent blocks or fails.

import { spawnSync } from 'node:child_process';

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

// `paseo ls --all` may omit some archived agents (it already returns more than 100 entries),
// so an agent that is missing from the list is not proof it never existed.
export function inspectAgent(agentId) {
  const result = spawnSync('paseo', ['inspect', agentId, '--json'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

export const providerOf = (agent) => {
  const value = agent?.provider ?? agent?.Provider;
  return typeof value === 'string' && value.includes('/') ? value.toLowerCase() : null;
};

// `paseo ls` packs "provider/model" into `provider`; `paseo inspect --json` splits them
// and uses capitalised keys (`Provider`, `Model`).
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

// Agent ids arrive as full UUIDs (Pipeline-Author trailers, `$PASEO_AGENT_ID`) or as
// Paseo's 7-char shortId. Match both shapes; more than one hit means ambiguity, so
// callers fail closed instead of guessing.
export function findAgents(agentId, agents) {
  const wanted = String(agentId || '').toLowerCase();
  if (!wanted) return [];
  return agents.filter((agent) => [agent.id, agent.shortId].some((value) => typeof value === 'string' && value.toLowerCase().startsWith(wanted)));
}
