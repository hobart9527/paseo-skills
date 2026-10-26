// 单写者锁的竞态防护测试（lib/lock.mjs）。
//
// 为什么钉死这条：判定 stale 到 rm 之间存在窗口，并发进程可能已释放旧锁并在同路径
// 重建新锁。不比 mtime 就 rm，会删掉别人刚持有的锁，两个进程都以为自己独占——
// 合流的读-改-写序列失去互斥，正是这把锁要防的事故本身。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, removeIfMtimeUnchanged } from '../lib/lock.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
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
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(file, old, old);

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
