// 单写者锁（零依赖，跨进程）。
//
// 为什么需要：`merge-task.mjs` 的校验—合流—提交是一条读-改-写序列，两个进程同时跑时
// 后者的 `git merge --abort` 会撤掉前者正在进行的合流，双方都以为自己在提交同一份集成历史。
// `run-state.mjs` 的读-改-写同样没有互斥，并发 claim 可以双双成功，幂等键形同虚设。
//
// 实现选择 `open(..., 'wx')`（O_CREAT|O_EXCL）而不是 flock：
//   - 零依赖、跨平台一致；
//   - 锁文件落在 git common dir 下，同一仓库的所有 worktree 看到同一个锁；
//   - 崩溃残留可由 mtime 与 pid 判定陈旧，而 flock 在进程死亡时自动释放、留不下诊断线索。
//
// 锁文件内容只用于诊断（pid/host/iso/持有原因），不参与互斥判定。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 锁文件超过该年龄即视为崩溃残留（合流含长测试，默认给足 2 小时）。 */
export const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function describeHolder(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return `pid=${raw.pid ?? '?'} host=${raw.host ?? '?'} since=${raw.acquiredAt ?? '?'}`
      + (raw.purpose ? ` purpose=${raw.purpose}` : '');
  } catch {
    return '持有者信息不可读';
  }
}

/**
 * 尝试获取排他锁。
 *
 * @returns {{ok: true, release: () => void, file: string}
 *          | {ok: false, reason: 'held'|'error', holder: string, file: string, error?: string}}
 */
export function acquireLock(dir, name, {
  staleMs = DEFAULT_STALE_MS, purpose = null, now = Date.now(),
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.lock`);
  const payload = `${JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date(now).toISOString(),
    purpose,
  }, null, 2)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      let released = false;
      return {
        ok: true,
        file,
        release() {
          if (released) return;
          released = true;
          try { fs.rmSync(file, { force: true }); } catch { /* 锁已不在即为释放 */ }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        return { ok: false, reason: 'error', holder: '', file, error: error.message };
      }
      const holder = describeHolder(file);
      let age = null;
      try { age = now - fs.statSync(file).mtimeMs; } catch { age = null; }
      const stale = age !== null && age > staleMs;
      if (!stale || attempt === 1) {
        return { ok: false, reason: 'held', holder: `${holder}${stale ? '（已超时，但清理失败）' : ''}`, file };
      }
      // 陈旧残留：只在能确认不会被并发争抢时删除（删后立即重试一次 open）。
      try { fs.rmSync(file, { force: true }); } catch { /* 交由下一轮 open 报告 */ }
    }
  }
  return { ok: false, reason: 'held', holder: describeHolder(file), file };
}
