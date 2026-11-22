# 5 维任务评估评分卡模板（5D Task Evaluation Scorecard）

> **用途：** 在冻结规则与门禁的前提下，对真实交付任务做「成本、Oracle 质量、时间结构、路由准确度、审查校准度」五维体检。
> **纪律：** 只记录实测事实；采集不到的字段一律填 `NOT_COLLECTED`（说明原因），严禁估算或补全。

---

## 一、5 个评分维度与健康阈值

| 维度 | 核心指标 | 采集来源 | 🟢 健康 | 🟡 需关注 | 🔴 需收敛 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **D1 有效成本与摩擦税** | `frictionTax`（hook rewrite/ask/deny + 流程性 verify FAIL 占可控事件/tool calls 比重）、`dirty_worktree` 次数、Token/源码行、Compaction 次数 | `harness-metrics.jsonl` + Claude transcript + `git diff` | `compactions = 0`、`dirty_worktree = 0`、`file_limit ask ≤ 1` | `compactions = 1` 或 `dirty_worktree = 1–2` 或 `sanitize_paseo ≥ 3` | `compactions ≥ 2`、`dirty_worktree ≥ 3` 或人工打断 ≥ 4 |
| **D2 Oracle 真实检出率** | `Required=yes` Verify 覆盖率、`unprovable` 拦截、`testMutations`、`mutationsCaught`（可选变异注入演练 `K/M`） | `tier2-verify` / `acceptance` + `risk-scan` + 变异抽检 | Verify 100% 可证明、无未授权断言削弱；变异检出率 `≥ 80%` | 存在 `testMutations` 需人工复核，或变异检出 `50%–79%` | 存在 `unprovable` 漏放、自然语言 Verify 或变异检出 `< 50%` |
| **D3 真实时间阶段拆解** | 总墙钟跨度、各阶段占比（Recon / 契约 / 实现 / 门禁重试 / 审查等待）、Git 提交跨度 | Git commit 时间戳 + Paseo agent `createdAt` / transcript 首尾时间戳 | 重试与审查等待占比 `< 20%`；无长时间空等 | 契约+审查占比 `> 50%` 或单阶段明显卡顿 | 门禁/返工重试耗时超过正向开发耗时 |
| **D4 Tier 路由校准度** | 初始判定 Tier (`tierInitial`) vs 最终所需 Tier (`tierRequired` / `tierFinal`)；中途溢出 / 降级次数 | `scanRepo` (`sourceFiles`, `scopes`) + `freeze-check` + 人工记录 | 一次定档命中（`tierInitial == tierFinal`） | Tier 3 结构降级 `handoff`（正常止损） | Tier 1 起手写到一半被 `file_limit`/`scope_cross` 强转 Tier 2 |
| **D5 审查校准度与合流稳定性** | 审查轮次（R0 / Tier 2 / FINAL）、Blocker / DEVIATION / CONTRACT_GAP 数、合流后 N 天返修次数（`postMergeFixes`） | `review.md` + `harness-metrics.jsonl` + 合流后人工回溯 | 轮次 `≤ 2`、`CONTRACT_GAP = 0`、合流后同域返修 `0` | 出现 1 次 `CONTRACT_GAP` 或 1 次轻微返修 | 轮次超预算（>2）、或审查全 PASS 但合流后出现漏检返修 |

> **时间字段口径（沿用 `LESSONS.md §6`）：**
> - 有精确 transcript 首尾时间戳时使用 transcript 跨度；
> - 仅有 Paseo agent 元数据时，`createdAt` 到 `lastActivityAt` 只代表活跃时间上界，**禁止把 `updatedAt` 当完成时间**（archive 会覆盖 `updatedAt`）。

---

## 二、一键采集命令

### 1. 单任务评估（Git + OpenSpec + 遥测 + Paseo/Claude Transcript）

```bash
# Tier 2 / Tier 1 分支或提交区间评估
node benchmarks/pipeline/scorecard-5d.mjs \
  --repo /path/to/repo \
  --base main \
  --head feature/my-task \
  --since 2026-11-21T08:00:00+08:00 \
  --until 2026-11-21T12:00:00+08:00 \
  --tier-initial 1 \
  --tier-final 2 \
  --human-interventions 2 \
  --post-merge-fixes 0 \
  --markdown

# Tier 3（带 OpenSpec change）评估并导出 JSON 供横向汇总
node benchmarks/pipeline/scorecard-5d.mjs \
  --repo /path/to/repo \
  --base main \
  --head integration/my-change \
  --change my-change \
  --tier-initial 3 \
  --tier-final 3 \
  --json --out /tmp/scorecard-my-change.json
```

### 2. 多任务横向汇总对比

```bash
node benchmarks/pipeline/scorecard-5d.mjs --compare \
  /tmp/scorecard-task1.json \
  /tmp/scorecard-task2.json \
  /tmp/scorecard-task3.json \
  --markdown
```

---

## 三、单任务人工复盘填写模板（可复制使用）

```markdown
## 任务评估卡：<任务名 / Change ID>

- **仓库与基线：** `<repo>` (`<base>..<head>`)
- **任务类型：** Tier 1 / Tier 2 / Tier 3（是否有 UI / 风险类：`auth|money|concurrency|persistence|external-write`）
- **脚本报告：** `<attached json/md path>`

### D1. 有效成本与摩擦税
- **有效代码产出：** 业务源文件 `X` 个 / 测试文件 `Y` 个 / 业务源码 `+A / -D` 行
- **Agent 消耗（覆盖 `k/n` agents）：** Turns `___` | Tool Calls `___` | Compactions `___` | Total Tokens `___`（未覆盖原因：`___`）
- **摩擦事件：** `sanitize_paseo=__` | `file_limit ask=__` | `dirty_worktree=__` | `worktree_cd_primary=__` | 人工干预 `__` 次
- **小评（1-5 分）：** `__ / 5` — 摩擦主要卡在哪里？

### D2. Oracle 真实检出率
- **自动化基线：** `risk-scan` 命中 `[...]` | `testMutations=__` | `unprovable=__`
- **变异注入抽检（可选）：** 注入 `__` 处缺陷，Verify/Review 检出 `__` 处（未测填 `NOT_COLLECTED`）
- **小评（1-5 分）：** `__ / 5` — Verify 是否真走真实入口？有无假绿风险？

### D3. 真实时间阶段拆解
- **总墙钟时间：** `__ min`（Recon `__m` | Authoring `__m` | Exec `__m` | Gate 重试 `__m` | Review/等待 `__m`）
- **小评（1-5 分）：** `__ / 5` — 非编码等待/重试占比是否过高？

### D4. Tier 路由校准度
- **路由轨迹：** 初始 `Tier __` → 最终 `Tier __`（是否发生中途溢出或降级：`是/否`）
- **小评（1-5 分）：** `__ / 5` — 若定档偏差，是 Recon 漏扫还是阈值不合理？

### D5. 审查校准度与合流稳定性
- **审查记录：** R0 `__` 轮 / Tier 2 `__` 轮 / FINAL `__` 轮；Blocker `__` / DEVIATION `__` / CONTRACT_GAP `__`
- **合流后稳定性（7 天窗口）：** 同域返修 / 漏检 Bug `__` 次
- **小评（1-5 分）：** `__ / 5` — 审查意见是否真抓住了契约/风险缺陷？

### 综合结论（保持 / 剪枝 / 收敛项）
- **本次暴露的流程问题：**
- **是否建议动规则（默认不动，攒够样本再动）：**
```

---

## 四、多任务横向汇总模板（攒够 3~5 个真实任务后填）

| 任务 / Change | Tier (初→终) | 源码文件 / 行数 | Compactions | 摩擦事件总计 (`dirty` / `file_limit` / `sanitize`) | 墙钟耗时 | 审查轮次 / 返修数 | 瓶颈归因 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| 任务 1 | | | | | | | |
| 任务 2 | | | | | | | |
| 任务 3 | | | | | | | |
| **合计 / 均值** | | | | | | | |
