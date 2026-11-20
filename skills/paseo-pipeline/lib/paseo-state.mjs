// Shared Paseo CLI query adapter for next-actions.
// Caches per-change label lookups and isolates agent inspect calls.
import { spawnSync } from 'node:child_process';

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

export function inspectPaseoAgent(agentId, { timeout = 10_000 } = {}) {
  const res = spawnSync('paseo', ['inspect', agentId, '--json'], { encoding: 'utf8', timeout });
  if (res.error || res.status !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
