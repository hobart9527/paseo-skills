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

/**
 * 抢锁尝试上限。正常路径一次 open 就够；额外两次留给「锁在观察途中被释放」（stat 得
 * ENOENT）与「回收陈旧锁后重新竞争」。回收本身另由 reclaimAttempted 限一次。
 */
const MAX_ACQUIRE_ATTEMPTS = 3;

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
 * `kill(pid, 0)` 只能证明「本机存在这个 pid」。pid 复用（旧持有者已死、pid 被无关进程
 * 拿走）与真存活在 pid 探活下**不可区分**，EPERM（进程存在但无权发信号）同理——两者
 * 都按 alive 处理。把不可区分当成 dead 会回收掉活锁，代价是两条读改写同时跑，比多留
 * 一把需要人工清的锁严重得多。
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
  // 这里的 age 是「持有者自报的持有时长」（acquiredAt），给人读；陈旧判定用的是文件
  // mtime（见 acquireLock）。两者口径不同是故意的：mtime 表示锁文件这一代的建立时刻，
  // 锁被回收重建后 mtime 会变，而残留的 acquiredAt 仍写着上一代；拿 acquiredAt 做
  // 删除守卫会漏掉「同代重建」。诊断文案用自报时间，删除判定用 mtime。
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
 * @returns {boolean} true=已删除；false=文件已不在、已被换或被换主/不可读，放弃（调用方
 *          不得把 false 当成「已删除」放行——它紧接着会 open(wx) 抢锁）。
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

  // 回收只做一次：删掉之后重新 open 仍失败，说明有人在竞争，按 held 返回而不是再删。
  let reclaimAttempted = false;
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
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
      // **必须先取 mtime，再读持有者**：两者是同一代际的旁证。反过来先 readHolder 后
      // statSync 时，中间可能被并发进程回收并重建锁——「持有者已死」（旧代际）与
      // 「mtime 未变」（新代际）会拼成一条 stale 判定，删除守卫比对新锁照样通过，
      // 刚建立的活锁被删，两个进程同时进入临界区。先 stat 则守卫锚定在更早的那一代：
      // 期间被换过，readHolder 读到的可能是新代际，而守卫仍按旧 mtime 比对，除非新代际的
      // mtime 恰好落在同一时间戳刻度（本设计的残余窗口），否则放弃删除。
      let observedMtime;
      try {
        observedMtime = fs.statSync(file).mtimeMs;
      } catch (statError) {
        // 锁在 open 与 stat 之间被释放：这一代已经没了，回到 open 重新竞争。
        if (statError.code === 'ENOENT') continue;
        // 其余（EACCES 等）读不到就无从判定，更不能盲删。
        return { ok: false, reason: 'error', holder: '', file, error: statError.message };
      }
      const holder = readHolder(file);
      const liveness = holderLiveness(holder);
      const holderText = describeHolder(file, now, holder);
      const tooOld = now - observedMtime > staleMs;
      // 持有者已死是硬证据：立刻可回收，不必干等 DEFAULT_STALE_MS（崩溃残留正是「锁死了
      // 2 小时」的来源）。持有者确认存活则一律按新鲜处理，年龄再大也不抢——那可能是一次
      // 仍在跑的长测试。探不到存活（跨主机、无 pid、记录不可读）时才退回纯年龄判定。
      const stale = liveness === 'dead' || (liveness === 'unknown' && tooOld);
      // 回收只试一次：删掉之后若仍抢不到（别人先建了），说明有人正在竞争，按 held 返回。
      if (!stale || reclaimAttempted) {
        const note = liveness === 'alive' && tooOld
          ? '（已超时，但持有进程仍存活）'
          : (stale ? '（持有者已死，但清理失败）' : '');
        return { ok: false, reason: 'held', holder: `${holderText}${note}`, file, liveness };
      }
      reclaimAttempted = true;
      // 删除前重读 mtime 比对：判定 stale 到 rm 之间可能已换了一代（同路径、新 mtime）。
      // 不比对就 rm 会删掉别人刚持有的锁。mtime 变了即放弃删除，按 held 返回。
      if (!removeIfMtimeUnchanged(file, observedMtime)) {
        return { ok: false, reason: 'held', holder: describeHolder(file), file, liveness };
      }
    }
  }
  return { ok: false, reason: 'held', holder: describeHolder(file), file };
}

/**
 * 手动清除残留锁（崩溃现场、跨主机无法探活）。pid 复用不在此列：它探得到且判 alive，
 * 只能人工移除锁文件（先比对进程启动时间与锁 mtime），不要结束被复用的进程。
 *
 * 这是「陈旧判定」之外唯一的人工入口：自动回收要求**超龄**，而刚崩掉的锁还没到时限，
 * 卡住的人等不起 `DEFAULT_STALE_MS`。判定只认持有者存活——持有进程还活着就拒绝，因为
 * 清掉活锁等于直接制造它要防的事故。
 *
 * 2026-11-01 前的实现把 force 放在存活判定之前，`--break-lock --force` 于是能清掉活锁并
 * 打印「已清除残留锁」——把制造并发写当成了成功。
 *
 * @param {boolean} force 仅用于「确认持有者已死但本机探不到」：跨主机、记录无 pid、
 *          记录不可读。pid 复用与 EPERM 探得到且判 alive，force 对其无效——那些情形要
 *          人工移除锁文件（先 ps 比对启动时间与锁 mtime）。
 * @returns {{removed: boolean, file: string, holder: string, reason: 'absent'|'removed'
 *          |'alive'|'unknown'|'changed'|'error', error?: string}}
 */
export function breakLock(dir, name, { force = false, now = Date.now() } = {}) {
  const file = path.join(dir, `${name}.lock`);
  let observedMtime;
  try {
    observedMtime = fs.statSync(file).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: false, file, holder: '', reason: 'absent' };
    // 读不到锁文件不等于没有锁：把 EACCES 之类当成 absent 会打印「无需清除」并 exit 0，
    // 使用者据此以为已处理，实际锁还在，之后的动作继续被拒。
    return { removed: false, file, holder: '', reason: 'error', error: error.message };
  }
  const holder = readHolder(file);
  const liveness = holderLiveness(holder);
  const holderText = describeHolder(file, now, holder);
  // 顺序即豁免范围：alive 先返回，force 只落在 unknown 上。
  if (liveness === 'alive') return { removed: false, file, holder: holderText, reason: 'alive' };
  if (!force && liveness === 'unknown') return { removed: false, file, holder: holderText, reason: 'unknown' };

  // 与自动回收同一条竞态防护：读到的 mtime 已变 = 锁在判定与删除之间换过主人。
  if (!removeIfMtimeUnchanged(file, observedMtime)) {
    return { removed: false, file, holder: describeHolder(file), reason: 'changed' };
  }
  return { removed: true, file, holder: holderText, reason: 'removed' };
}
