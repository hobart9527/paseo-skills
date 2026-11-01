// 单写者锁的竞态防护与陈旧判定测试（lib/lock.mjs）。
//
// 为什么钉死这条：判定 stale 到 rm 之间存在窗口，并发进程可能已释放旧锁并在同路径
// 重建新锁。不比 mtime 就 rm，会删掉别人刚持有的锁，两个进程都以为自己独占——
// 合流的读-改-写序列失去互斥，正是这把锁要防的事故本身。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, breakLock, holderLiveness, removeIfMtimeUnchanged } from '../lib/lock.mjs';

const runStateScript = fileURLToPath(new URL('../run-state.mjs', import.meta.url));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 一个「确定已死」的本机 pid：spawn 一个立即退出的子进程，拿它已经消失的 pid。
 *
 * 子进程已被 reap，正常情况下 `kill(pid, 0)` 立刻 ESRCH。极小概率下该 pid 会被别的进程
 * 复用，那时测试读到的是「存活」——重取几次，取不到死 pid 就直接跳过断言前提。
 */
function deadPid(t) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pid = spawnSync(process.execPath, ['-e', '']).pid;
    if (holderLiveness({ pid, host: os.hostname() }) === 'dead') return pid;
  }
  t.diagnostic('取不到可靠已死的本机 pid（pid 被复用），本次断言前提不成立');
  return null;
}

function requireDeadPid(t) {
  const pid = deadPid(t);
  assert.notEqual(pid, null, '测试前提：需要本机一个已死进程的 pid');
  return pid;
}

function aged(file, ms = 3 * 60 * 60 * 1000) {
  const old = new Date(Date.now() - ms);
  fs.utimesSync(file, old, old);
}

test('removeIfMtimeUnchanged removes only when the mtime still matches', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'x.lock');

  fs.writeFileSync(file, '{}');
  const mtime = fs.statSync(file).mtimeMs;
  assert.equal(removeIfMtimeUnchanged(file, mtime), true, 'mtime 一致必须删除');
  assert.ok(!fs.existsSync(file));

  // mtime 变了（锁已被换）：必须保留，按 held 处理。
  fs.writeFileSync(file, '{}');
  const before = fs.statSync(file).mtimeMs;
  fs.writeFileSync(file, '{"pid":99999}'); // 重写改变 mtime
  const after = fs.statSync(file).mtimeMs;
  assert.notEqual(after, before, '测试前提：重写必须改变 mtime');
  assert.equal(removeIfMtimeUnchanged(file, before), false, 'mtime 不一致不得删除');
  assert.ok(fs.existsSync(file), '被换的锁必须保留');

  // 文件不存在：无从比对，不得当成「已删除」放行（调用方会紧接着 open(wx) 抢锁）。
  assert.equal(removeIfMtimeUnchanged(path.join(dir, 'gone.lock'), 123), false);
});

test('acquireLock reclaims a stale lock whose mtime is unchanged', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'merge.lock');
  fs.writeFileSync(file, '{"pid":1}');
  aged(file);

  const first = acquireLock(dir, 'merge', { staleMs: 1000 });
  assert.equal(first.ok, true, '陈旧锁必须被回收');
  first.release();

  // 新鲜锁不得被当成 stale 回收。
  const holder = acquireLock(dir, 'merge', { staleMs: 1000 });
  assert.equal(holder.ok, true);
  const second = acquireLock(dir, 'merge', { staleMs: 1000 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'held');
  holder.release();
});

// --- 陈旧判定并入 pid（SCEN-LED-04） ---
//
// 只按年龄判会抢走一次长测试中仍然活着的合法锁；只按存活判会在跨主机时永远不回收。
// 两条判据必须同时成立才回收。

test('SCEN-LED-04 a live local holder is fresh no matter how old the lock is', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'merge.lock');
  // 自己这个进程就是持有者：必然存活，且锁文件被推到远超阈值。
  fs.writeFileSync(file, JSON.stringify({
    pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(),
  }));
  aged(file);

  assert.equal(holderLiveness({ pid: process.pid, host: os.hostname() }), 'alive');
  const refused = acquireLock(dir, 'merge', { staleMs: 1000 });
  assert.equal(refused.ok, false, '持有进程仍存活时，超龄的锁不得被回收');
  assert.equal(refused.reason, 'held');
  assert.match(refused.holder, new RegExp(`pid=${process.pid}`), '拒绝必须点名持有者');
  assert.match(refused.holder, /持有进程仍存活/, '必须说明为什么超龄仍未回收');
  assert.ok(fs.existsSync(file), '被拒绝时不得动别人的锁');
});

test('SCEN-LED-04 a dead local holder is reclaimed immediately, without waiting for the age threshold', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'merge.lock');
  // 新鲜锁 + 已死的本机 pid：年龄不够，但持有者可以证明已死。
  // 用很长的 staleMs，确认回收靠的是 pid 而不是「等够时间」。
  const pid = requireDeadPid(t);
  fs.writeFileSync(file, JSON.stringify({
    pid, host: os.hostname(), acquiredAt: new Date().toISOString(),
  }));

  assert.equal(holderLiveness({ pid, host: os.hostname() }), 'dead');
  const taken = acquireLock(dir, 'merge', { staleMs: 24 * 60 * 60 * 1000 });
  assert.equal(taken.ok, true, '持有进程已死时立即回收，不该干等 DEFAULT_STALE_MS');
  taken.release();
});

test('a holder on another host cannot be probed, so age stays the only evidence', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'merge.lock');
  const foreign = { pid: 99999, host: 'other-host', acquiredAt: new Date().toISOString() };
  assert.equal(holderLiveness(foreign), 'unknown', '跨主机不得拿本机 pid 空间探活');

  // 新鲜：不回收。
  fs.writeFileSync(file, JSON.stringify(foreign));
  assert.equal(acquireLock(dir, 'merge', { staleMs: 60 * 60 * 1000 }).ok, false);

  // 超龄：本机探不到存活，按年龄回收（保留旧的兜底行为）。
  aged(file);
  const taken = acquireLock(dir, 'merge', { staleMs: 60 * 60 * 1000 });
  assert.equal(taken.ok, true, '跨主机的超龄锁仍必须可回收，否则会永久死锁');
  taken.release();
});

test('an unreadable or pid-less lock file falls back to age, never to an unconditional reclaim', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'merge.lock');
  assert.equal(holderLiveness(null), 'unknown');
  assert.equal(holderLiveness({ host: os.hostname() }), 'unknown', '缺 pid 无法探活');

  fs.writeFileSync(file, 'not json');
  const fresh = acquireLock(dir, 'merge', { staleMs: 60 * 60 * 1000 });
  assert.equal(fresh.ok, false, '读不出持有者的新鲜锁不得被回收');
  assert.equal(fresh.reason, 'held');

  aged(file);
  const stale = acquireLock(dir, 'merge', { staleMs: 60 * 60 * 1000 });
  assert.equal(stale.ok, true, '读不出持有者的超龄锁仍可回收');
  stale.release();
});

// --- 代际竞态：观察与删除必须取自同一代际 ---
//
// 旧实现先 readHolder 再 statSync：两次读取之间锁可能被并发进程回收并重建。
// 于是「持有者已死」（旧代际）与「mtime 未变」（新代际）拼在一起，删除守卫通过，
// 刚建立的活锁被删——两个进程同时进入临界区。这里把重建注入到观察窗口内，
// 使交错确定发生，而不是靠时序碰运气。

test('acquireLock must not delete a lock rebuilt between its own two observations', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'merge.lock');
  fs.writeFileSync(file, JSON.stringify({
    pid: requireDeadPid(t), host: os.hostname(), acquiredAt: new Date().toISOString(),
  }));

  // 重建出来的锁是本进程持有的活锁：它一旦被删，两个进程就同时持锁。
  const livePayload = JSON.stringify({
    pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(),
  });
  const originalRead = fs.readFileSync;
  let rebuilt = false;
  fs.readFileSync = function patchedRead(target, ...rest) {
    const result = originalRead.call(this, target, ...rest);
    if (!rebuilt && String(target) === file) {
      rebuilt = true;
      // 并发进程在「读持有者」与「读 mtime」之间回收旧锁并重建新锁。
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, livePayload);
    }
    return result;
  };
  t.after(() => { fs.readFileSync = originalRead; });

  const result = acquireLock(dir, 'merge', { staleMs: 24 * 60 * 60 * 1000 });
  assert.equal(rebuilt, true, '测试前提：重建必须发生在 acquireLock 的观察窗口内');
  assert.equal(result.ok, false, '观察窗口内被重建的锁不得被判定为陈旧残留');
  assert.ok(fs.existsSync(file), '刚重建的活锁不得被删除');
  assert.equal(fs.readFileSync(file, 'utf8'), livePayload, '保留下来的必须是新代际的锁');
});

// --- 手动释放入口（SCEN-LED-04：文档化的人工清锁） ---

test('SCEN-LED-04 breakLock removes the lock when the holder is dead, regardless of age', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'run-state.lock');
  fs.writeFileSync(file, JSON.stringify({
    pid: requireDeadPid(t), host: os.hostname(), acquiredAt: new Date().toISOString(),
  }));

  const result = breakLock(dir, 'run-state');
  assert.equal(result.reason, 'removed');
  assert.equal(result.removed, true);
  assert.ok(!fs.existsSync(file), '持有者已死时必须清除');
});

test('SCEN-LED-04 breakLock refuses to clear a lock whose holder is alive', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'run-state.lock');
  fs.writeFileSync(file, JSON.stringify({
    pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(),
  }));

  const result = breakLock(dir, 'run-state');
  assert.equal(result.reason, 'alive');
  assert.equal(result.removed, false);
  assert.ok(fs.existsSync(file), '清活锁会制造它要防的并发改写');
});

test('breakLock ignores --force when the holder is provably alive', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'run-state.lock');
  fs.writeFileSync(file, JSON.stringify({
    pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(),
  }));

  // `--force` 的豁免范围只有「探不到」：能确认存活的持有者一律拒绝。
  // 放行 force 等于给「清活锁」留一条默认路径，正是这把锁要防的事故。
  const result = breakLock(dir, 'run-state', { force: true });
  assert.equal(result.reason, 'alive', '--force 不得把可确认存活的持有者当成探不到');
  assert.equal(result.removed, false);
  assert.ok(fs.existsSync(file), '活锁无论如何都不得被清除');
});

test('breakLock does not guess when the holder cannot be probed, unless forced', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'run-state.lock');
  fs.writeFileSync(file, JSON.stringify({
    pid: 99999, host: 'other-host', acquiredAt: new Date().toISOString(),
  }));

  const refused = breakLock(dir, 'run-state');
  assert.equal(refused.reason, 'unknown', '探不到存活时不得默认放行');
  assert.ok(fs.existsSync(file));

  const forced = breakLock(dir, 'run-state', { force: true });
  assert.equal(forced.reason, 'removed');
  assert.ok(!fs.existsSync(file), '--force 是人确认之后的显式豁免');
});

test('breakLock reports an unreadable lock as an error, not as absent', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'run-state.lock');
  fs.writeFileSync(file, JSON.stringify({
    pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(),
  }));

  // stat 报 EACCES 时锁仍然在：按 absent 返回会让 CLI 打印「无需清除」并 exit 0，
  // 使用者以为已处理，之后的写入继续被拒。
  const originalStat = fs.statSync;
  fs.statSync = function patchedStat(target, ...rest) {
    if (String(target) === file) {
      const error = new Error(`EACCES: permission denied, stat '${file}'`);
      error.code = 'EACCES';
      throw error;
    }
    return originalStat.call(this, target, ...rest);
  };
  t.after(() => { fs.statSync = originalStat; });

  const result = breakLock(dir, 'run-state');
  assert.equal(result.reason, 'error', '读不到锁文件必须报 error');
  assert.match(result.error, /EACCES/);
  assert.ok(fs.existsSync(file), '读不到就不得删');
});

test('breakLock reports an absent lock instead of failing', (t) => {
  const dir = tempDir(t);
  const result = breakLock(dir, 'run-state');
  assert.equal(result.reason, 'absent');
  assert.equal(result.removed, false);
});

// --- CLI 入口：手册化的恢复路径必须真的可用 ---

function cliFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-break-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const change = 'lock-cli';
  const env = { ...process.env, PIPELINE_RUN_STATE_DIR: path.join(root, 'state') };
  const dir = path.join(root, 'state', change);
  fs.mkdirSync(dir, { recursive: true });
  const run = (...args) => spawnSync(process.execPath, [runStateScript, args[0], change, ...args.slice(1)], {
    env, encoding: 'utf8', timeout: 20_000,
  });
  return { dir, lockFile: path.join(dir, 'run-state.lock'), run };
}

test('SCEN-LED-04 the CLI names break-lock in the refusal, and --force unwedges an unprobeable lock', (t) => {
  const subject = cliFixture(t);
  // 跨主机的锁在本机探不到 pid（进程可能早就没了，也可能还在跑），年龄又是新鲜的：
  // 自动回收不动它，只能由人确认后显式清除。这正是不崩溃、却锁死当场的那种残留。
  fs.writeFileSync(subject.lockFile, JSON.stringify({
    pid: 99999, host: 'other-host', acquiredAt: new Date().toISOString(),
  }));

  const blocked = subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu');
  assert.equal(blocked.status, 2, '残留锁必须拒绝动作');
  assert.match(blocked.stderr, /pid=99999/, '拒绝文案必须点名持有者 pid');
  assert.match(blocked.stderr, /host=other-host/, '拒绝文案必须点名持有者主机');
  assert.match(blocked.stderr, /age=\d+s/, '拒绝文案必须给出持有时长');
  assert.match(blocked.stderr, /break-lock/, '拒绝文案必须给出文档化的恢复入口，并指明子命令');
  assert.match(blocked.stderr, /run-state\.mjs --break-lock lock-cli/, '必须给出可照抄的命令');

  // 不猜测：探不到存活时默认拒绝，并指出 --force 是人工豁免。
  const refused = subject.run('--break-lock');
  assert.equal(refused.status, 2, '探不到存活时不得默认清除');
  assert.match(refused.stderr, /--force/, '拒绝时须指出人工豁免的写法');
  assert.ok(fs.existsSync(subject.lockFile));

  const broken = subject.run('--break-lock', '--force');
  assert.equal(broken.status, 0, broken.stderr);
  assert.equal(fs.existsSync(subject.lockFile), false, 'break-lock --force 必须真的删掉锁');

  const retried = subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu');
  assert.equal(retried.status, 0, `清锁后同一动作必须能继续：${retried.stderr}`);
});

test('SCEN-LED-04 a dead-holder lock is reclaimed without any manual step', (t) => {
  const subject = cliFixture(t);
  fs.writeFileSync(subject.lockFile, JSON.stringify({
    pid: requireDeadPid(t), host: os.hostname(), acquiredAt: new Date().toISOString(),
  }));

  const result = subject.run('claim', '--task', 'T-01', '--attempt', '1', '--phase', 'impl', '--role', 'gongbu');
  assert.equal(result.status, 0, `持有者已死时应当自动回收：${result.stderr}`);
  assert.equal(fs.existsSync(subject.lockFile), false, '动作完成后不得留下锁');
});

test('SCEN-LED-04 the CLI break-lock exits non-zero for a live holder and leaves the lock alone', (t) => {
  const subject = cliFixture(t);
  fs.writeFileSync(subject.lockFile, JSON.stringify({
    pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(),
  }));

  const result = subject.run('--break-lock');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /存活/);
  assert.ok(fs.existsSync(subject.lockFile), '活锁不得被 CLI 悄悄清掉');
});

test('SCEN-LED-04 the CLI refuses --break-lock --force for a live holder instead of reporting a cleanup', (t) => {
  const subject = cliFixture(t);
  fs.writeFileSync(subject.lockFile, JSON.stringify({
    pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(),
  }));

  // 旧行为：--force 连活锁一起清，还打印「已清除残留锁」——CLI 把制造并发写当成了成功。
  const result = subject.run('--break-lock', '--force');
  assert.equal(result.status, 2, '--force 不得清掉可确认存活的锁');
  assert.doesNotMatch(result.stdout, /已清除/, '拒绝时不得报告已清除');
  assert.match(result.stderr, /存活/, '拒绝文案必须说明持有者仍存活');
  assert.match(result.stderr, /--force/, '拒绝文案必须说明强制豁免不适用于可确认存活的持有者');
  assert.ok(fs.existsSync(subject.lockFile), '活锁必须原样保留');
});

// --- 文档契约：人工恢复路径必须与代码的豁免面一致 ---
//
// 代码只做 `kill(pid, 0)`：pid 复用与 EPERM 都判 alive，`--force` 无效。文档若把这两种
// 情形指向 `--force`，人会照着跑、被拒、再猜，最后删账本——那正是「锁恢复」要避免的。
// 这里读源文本钉住口径；docs.test.mjs 属 T-11，改动只落在本文件。

const skillText = fs.readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf8');
const runStateText = fs.readFileSync(runStateScript, 'utf8');

test('SKILL documents the manual lock-file removal for pid reuse / EPERM, and does not route either to --force', () => {
  // pid 复用与 EPERM 必须与「--force 无效」同段声明。
  assert.match(skillText, /pid 复用[\s\S]{0,200}EPERM[\s\S]{0,300}--force`?\s*无效/,
    'SKILL 必须写明 pid 复用/EPERM 探得到且判 alive，--force 无效');
  // 四步人工恢复：status 核对 → ps 比对 → rm 锁文件 → 原样重试。
  assert.match(skillText, /人工移除锁文件/, 'SKILL 必须给出人工移除锁文件的入口');
  assert.match(skillText, /status <change>`? 核对没有在跑的派发/, '第 1 步必须核对 status');
  assert.match(skillText, /ps -p <pid> -o pid,lstart,command/, '第 2 步必须给出 ps 比对命令');
  assert.match(skillText, /启动时间\*\*晚于锁文件 mtime/, '第 2 步必须写明判定前提');
  assert.match(skillText, /rm <git-common-dir>\/paseo-pipeline\/<change>\/run-state\.lock/, '第 3 步必须给出可照抄的 rm');
  assert.match(skillText, /绕过存活守卫/, '人工移除必须显式声明绕过存活守卫');
  assert.match(skillText, /原样重试被拒的动作/, '第 4 步必须原样重试');
  assert.match(skillText, /不要结束/, '必须写明不要结束被复用的无关进程');
  // 反过来：SKILL 里凡是提到「pid 复用」或「EPERM」的段落，都不得把它们列进 --force 的豁免面。
  for (const match of skillText.matchAll(/pid 复用|EPERM/g)) {
    const window = skillText.slice(Math.max(0, match.index - 200), match.index + 300);
    assert.doesNotMatch(window, /--force`?\s*是?人工豁免[^。]*pid 被无关进程复用/,
      'SKILL 不得再把 pid 复用列进 --force 的豁免情形');
  }
});

test('the ELOCKED refusal does not point pid reuse at --force', () => {
  // ELOCKED 文案是每次被锁挡住时的第一手出路；把 pid 复用写成「加 --force」会直接误导。
  const elocked = runStateText.slice(runStateText.indexOf('运行账本被占用'), runStateText.indexOf('运行账本被占用') + 600);
  assert.ok(elocked.length > 0, '测试前提：ELOCKED 文案必须存在');
  assert.doesNotMatch(elocked, /pid 被?复用[\s\S]{0,40}--force/, 'ELOCKED 文案不得把 pid 复用指向 --force');
  assert.match(elocked, /记录无 pid|不可读/, 'ELOCKED 文案的 --force 豁免面必须写成探不到的三种');
});
