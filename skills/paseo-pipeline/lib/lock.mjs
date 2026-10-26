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
 * 仅当锁文件 mtime 与初次观测一致时才删除（陈旧锁清理的换锁防护）。
 *
 * @returns {boolean} true=已删除（或文件本就不在，删除目标已达成）；false=锁已被换/不可读，放弃。
 */
export function removeIfMtimeUnchanged(file, expectedMtimeMs) {
  let current;
  try {
    current = fs.statSync(file).mtimeMs;
  } catch {
    return false; // 读不到就无从比对，不得盲删
  }
  if (current !== expectedMtimeMs) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
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
      let observedMtime = null;
      try {
        observedMtime = fs.statSync(file).mtimeMs;
        age = now - observedMtime;
      } catch { age = null; }
      const stale = age !== null && age > staleMs;
      if (!stale || attempt === 1) {
        return { ok: false, reason: 'held', holder: `${holder}${stale ? '（已超时，但清理失败）' : ''}`, file };
      }
      // 陈旧残留：删除前必须重读 mtime 比对。判定 stale 到 rm 之间有窗口——并发进程可能
      // 已释放旧锁并重建新锁（同路径、新 mtime）；不比对就 rm 会删掉别人刚持有的锁，
      // 两个进程都以为自己拿到了排他权。mtime 变了即放弃删除，按 held 返回。
      if (!removeIfMtimeUnchanged(file, observedMtime)) {
        return { ok: false, reason: 'held', holder: describeHolder(file), file };
      }
    }
  }
  return { ok: false, reason: 'held', holder: describeHolder(file), file };
}
