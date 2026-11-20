#!/usr/bin/env node
// Benchmark forwarder: delegates to the production brief renderer under skills/paseo-pipeline/.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const prod = fileURLToPath(new URL('../../../skills/paseo-pipeline/brief.mjs', import.meta.url));
const res = spawnSync(process.execPath, [prod, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status ?? 1);
