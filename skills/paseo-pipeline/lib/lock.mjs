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
// 锁文件内容只用于判定与诊断（pid/host/iso/持有原因）。pid 参与**陈旧判定**：持锁进程
// 已经死掉时立刻可回收，不必干等 `DEFAULT_STALE_MS`；活着的持有者即使超过时限也不算陈旧，
// 单纯按年龄判会把一次长测试中的合法锁抢走。跨主机的持有者本机无法探活，退回按年龄判定。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 持有者无法探活时，锁文件超过该年龄即视为崩溃残留（合流含长测试，默认给足 2 小时）。 */
export const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function readHolder(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 锁持有者的存活判定。
 *
 * @returns {'alive'|'dead'|'unknown'} unknown = 别的机器（本机探不到）或记录不可读。
 */
export function holderLiveness(holder) {
  if (!holder || !Number.isInteger(holder.pid) || holder.pid <= 0) return 'unknown';
  // 跨主机不能拿本机 pid 空间去探：同名 pid 很可能是无关进程。
  if (holder.host !== os.hostname()) return 'unknown';
  try {
    process.kill(holder.pid, 0);
    return 'alive';
  } catch (error) {
    // ESRCH = 没有这个进程；EPERM 等意味着进程存在但无权发信号，按存活处理。
    return error.code === 'ESRCH' ? 'dead' : 'alive';
  }
}

function describeHolder(file, now = Date.now(), holder = undefined) {
  const raw = holder === undefined ? readHolder(file) : holder;
  if (!raw) return '持有者信息不可读';
  let age = '';
  const acquired = Date.parse(raw.acquiredAt ?? '');
  const ageMs = Number.isFinite(acquired) ? now - acquired : null;
  if (ageMs !== null && ageMs >= 0) age = ` age=${Math.round(ageMs / 1000)}s`;
  return `pid=${raw.pid ?? '?'} host=${raw.host ?? '?'} since=${raw.acquiredAt ?? '?'}${age}`
    + (raw.purpose ? ` purpose=${raw.purpose}` : '');
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
 * 陈旧判定：持有者在**本机**且已死 → 立即回收（崩溃残留正是「锁死两小时」的来源）；
 * 持有者确认存活 → 永远按新鲜处理，年龄再大也不抢；探不到存活（跨主机、无 pid、
 * 记录不可读）→ 退回纯年龄判定。只按年龄判会抢走一次长测试中仍然活着的合法锁。
 *
 * @returns {{ok: true, release: () => void, file: string}
 *          | {ok: false, reason: 'held'|'error', holder: string, file: string, liveness?: string, error?: string}}
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
      const holder = readHolder(file);
      const liveness = holderLiveness(holder);
      const holderText = describeHolder(file, now, holder);
      let age = null;
      let observedMtime = null;
      try {
        observedMtime = fs.statSync(file).mtimeMs;
        age = now - observedMtime;
      } catch { age = null; }
      const tooOld = age !== null && age > staleMs;
      // 持有者已死是硬证据：立刻可回收，不必干等 DEFAULT_STALE_MS（崩溃残留正是「锁死了
      // 2 小时」的来源）。持有者确认存活则一律按新鲜处理，年龄再大也不抢——那可能是一次
      // 仍在跑的长测试。探不到存活（跨主机、无 pid、记录不可读）时才退回纯年龄判定。
      const stale = liveness === 'dead' || (liveness === 'unknown' && tooOld);
      if (!stale || attempt === 1) {
        const note = liveness === 'alive' && tooOld
          ? '（已超时，但持有进程仍存活）'
          : (stale ? '（持有者已死，但清理失败）' : '');
        return { ok: false, reason: 'held', holder: `${holderText}${note}`, file, liveness };
      }
      // 陈旧残留：删除前必须重读 mtime 比对。判定 stale 到 rm 之间有窗口——并发进程可能
      // 已释放旧锁并重建新锁（同路径、新 mtime）；不比对就 rm 会删掉别人刚持有的锁，
      // 两个进程都以为自己拿到了排他权。mtime 变了即放弃删除，按 held 返回。
      if (!removeIfMtimeUnchanged(file, observedMtime)) {
        return { ok: false, reason: 'held', holder: describeHolder(file), file, liveness };
      }
    }
  }
  return { ok: false, reason: 'held', holder: describeHolder(file), file };
}

/**
 * 手动清除残留锁（崩溃现场、pid 被复用、跨主机无法探活）。
 *
 * 这是「陈旧判定」之外唯一的人工入口：自动回收要求**超龄**，而刚崩掉的锁还没到时限，
 * 卡住的人等不起 `DEFAULT_STALE_MS`。判定只认持有者存活——持有进程还活着就拒绝，因为
 * 清掉活锁等于直接制造它要防的事故。
 *
 * @param {boolean} force 仅用于「确认持有者已死但探不到」（pid 复用、EPERM、跨主机）。
 * @returns {{removed: boolean, file: string, holder: string, reason: 'absent'|'removed'
 *          |'alive'|'unknown'|'changed'|'error', error?: string}}
 */
export function breakLock(dir, name, { force = false, now = Date.now() } = {}) {
  const file = path.join(dir, `${name}.lock`);
  let observedMtime;
  try {
    observedMtime = fs.statSync(file).mtimeMs;
  } catch {
    return { removed: false, file, holder: '', reason: 'absent' };
  }
  const holder = readHolder(file);
  const liveness = holderLiveness(holder);
  const holderText = describeHolder(file, now, holder);
  if (!force && liveness === 'alive') return { removed: false, file, holder: holderText, reason: 'alive' };
  if (!force && liveness === 'unknown') return { removed: false, file, holder: holderText, reason: 'unknown' };

  // 与自动回收同一条竞态防护：读到的 mtime 已变 = 锁在判定与删除之间换过主人。
  if (!removeIfMtimeUnchanged(file, observedMtime)) {
    return { removed: false, file, holder: describeHolder(file), reason: 'changed' };
  }
  return { removed: true, file, holder: holderText, reason: 'removed' };
}
