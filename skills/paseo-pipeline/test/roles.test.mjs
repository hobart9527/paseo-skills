import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveRejections, retryPolicy, MAX_REJECTIONS, MAX_ESCALATED_RETRIES,
} from '../lib/roles.mjs';

// --- 打回预算的两路判据（2026-10-31） ---
//
// 事故依据：`eas-reverse-coverage-100` 的 T-03 实现走到 attempt 6、仲裁 3 次、升级高工 2 次，
// 按 disposition 计数却只有 2 次——a2 的 disposition 是 null，a3/a6 被贴成 handed-off。
// 预算是编排者手工贴标签算出来的，漏贴或贴错就整轮不计。

test('deriveRejections counts nothing when there is neither a rejection nor a second attempt', () => {
  assert.equal(deriveRejections(), 0);
  assert.equal(deriveRejections({ dispositionRejections: 0, writerAttempts: [] }), 0);
  assert.equal(deriveRejections({ writerAttempts: [1] }), 0, '单轮实现不算打回');
});

test('SCEN-REC-16 an attempt sequence alone proves rejections even when every disposition is handed-off', () => {
  // 标签全贴成 handed-off、disposition 计数为 0，但 attempt 2/3 的存在证明前两轮没被接受。
  assert.equal(deriveRejections({ dispositionRejections: 0, writerAttempts: [1, 2, 3] }), 2);
  assert.equal(retryPolicy(2).escalate, true, '第 3 轮必须进升级档，不能被标签抹掉');
});

test('SCEN-REC-16 attempt numbers that skip a grade count as one rework, not as the number itself', () => {
  // SCEN-REC-09 的 attempt 9/10 是真实形态：拿最大值减一会把编号当成打回次数，
  // 让一条只返工过一次的任务直接判成预算耗尽。
  assert.equal(deriveRejections({ writerAttempts: [9, 10] }), 1);
  assert.equal(retryPolicy(1).allowed, true);
  assert.equal(retryPolicy(1).escalate, false);
});

test('SCEN-REC-16 repeated attempts of the same number are one attempt, not several reworks', () => {
  // 同一 attempt 内的 impl→audit 交接会产出多条带同号 attempt 的 agent 记录。
  assert.equal(deriveRejections({ writerAttempts: [1, 1, 1, 2] }), 1);
});

test('SCEN-REC-16 the two sources are combined with max, never summed', () => {
  // 两个数描述的是同一批打回：相加会把一次打回算两次，让正常返工直接跳到升级档。
  assert.equal(deriveRejections({ dispositionRejections: 2, writerAttempts: [1, 2, 3] }), 2);
  assert.equal(deriveRejections({ dispositionRejections: 1, writerAttempts: [1, 2, 3] }), 2);
});

test('deriveRejections ignores malformed attempts instead of coercing them', () => {
  assert.equal(deriveRejections({ writerAttempts: [null, undefined, '2', 0, -3, NaN, 1.5] }), 0);
  assert.equal(deriveRejections({ writerAttempts: [1, '2', 3] }), 1, '字符串 attempt 不参与计数');
});

test('the budget ladder is unchanged: 2 rejections escalate, 3 exhaust', () => {
  assert.equal(MAX_REJECTIONS, 2);
  assert.equal(MAX_ESCALATED_RETRIES, 1);
  assert.deepEqual(
    [0, 1, 2, 3].map((n) => {
      const policy = retryPolicy(n);
      return policy.allowed ? (policy.escalate ? 'escalate' : 'retry') : 'blocked';
    }),
    ['retry', 'retry', 'escalate', 'blocked'],
  );
});
