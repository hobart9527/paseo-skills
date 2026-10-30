// 异构审查判据（零依赖）：审查者与写手的**执行 provider** 不得相同。
//
// 为什么需要：SKILL 的核心卖点是「异构多 Agent」——写完由另一模型家族审。但门禁只核对了
// 「审查者不是写手本人」（agent id 不同），没有核对两者是不是同一个模型跑出来的。
// 实测角色分布里 gaogong 与 anchasi 都是 codex 家族：一条由 codex 写的任务被另一个
// codex agent 审，账本上「独立审查」齐全，实际是同源自证。换 profile 名或改 alias
// 都不改变 provider，所以只有比较真实 agent 记录里的 provider 才能发现。
//
// 判据边界（刻意保守）：
//   - 任一侧 provider 未采集 → `unresolved`，**不阻断**，但必须在 run-log 留一行
//     （拿不到的记录不能既当证据又当免责）。
//   - 两侧 provider 相同 → `homogeneous`，由调用方决定阻断强度。
//   - mechanical review（热修占位）不进入本判据：它没有审查者 agent。
//
// 不比较 model 名：实测同一 provider 下的 model 别名在会话间会变（同一条 pipeline
// 记录里出现过 gpt-6.1-sol 与 glm），拿它做「不同模型」的证据会假阳性；provider
// 是唯一稳定的家族标识。

/**
 * @param {{
 *   reviewer: {id?: string, provider?: string|null, model?: string|null}|null,
 *   writers: Array<{task?: string, id?: string, provider?: string|null, model?: string|null}>,
 * }} input
 * @returns {{status: 'ok'|'homogeneous'|'unresolved'|'not-applicable', detail: string}}
 */
export function assessHeterogeneity({ reviewer = null, writers = [] } = {}) {
  if (reviewer === null) {
    return { status: 'not-applicable', detail: 'no reviewer agent (mechanical review)' };
  }
  const relevant = writers.filter((entry) => entry && typeof entry.provider === 'string' && entry.provider !== '');
  if (relevant.length === 0) {
    return {
      status: 'unresolved',
      detail: `writer provider 未采集（${writers.length} 个写手记录都读不到 provider）；异构审查无法核对`,
    };
  }
  if (typeof reviewer.provider !== 'string' || reviewer.provider === '') {
    return { status: 'unresolved', detail: 'reviewer provider 未采集；异构审查无法核对' };
  }
  const same = relevant.filter((entry) => entry.provider.toLowerCase() === reviewer.provider.toLowerCase());
  if (same.length === 0) {
    return {
      status: 'ok',
      detail: `reviewer=${reviewer.provider} 与全部写手 provider 不同`,
    };
  }
  const tasks = [...new Set(same.map((entry) => entry.task).filter(Boolean))];
  return {
    status: 'homogeneous',
    detail: `reviewer provider=${reviewer.provider} 与写手相同`
      + `${tasks.length > 0 ? `（${tasks.join(', ')}）` : ''}：这是同源自证，不是独立审查`,
  };
}
