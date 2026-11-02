#!/usr/bin/env node
// Stop hook：本轮结束时核对主 checkout 的实际改动。补 PreToolUse 看不到的 Bash 写入
// （sed -i、重定向、heredoc、patch、git apply 等）。事后补救：block 后模型必须先向用户汇报。
// stop_hook_active 为真时放行，避免 block 后再次 Stop 造成死循环。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assessStop, logHookError } from '../lib/tier-gate.mjs';

async function main() {
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch { return; }
  if (payload?.stop_hook_active) return;
  const verdict = assessStop({ cwd: payload?.cwd ?? process.cwd(), sessionId: payload?.session_id });
  if (verdict.verdict === 'block') {
    fs.writeSync(1, `${JSON.stringify({ decision: 'block', reason: verdict.reason })}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try { await main(); } catch (err) { logHookError('tier-stop-hook', err); }
}
