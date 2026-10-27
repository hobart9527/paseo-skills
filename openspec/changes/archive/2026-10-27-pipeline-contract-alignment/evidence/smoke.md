# pipeline-contract-alignment 验收冒烟证据

<!--
  本 change 改的是编排工具链本身，真实入口就是各脚本的命令行（见 acceptance.md 的 Entry 列），
  不是业务 API。因此这份证据记录两件事：
  1. 唤醒路径：派发 → 完成 → 通知送达主会话的实测时间线（下方结构化字段）。
  2. 14 个冻结场景各自的真实执行结果（下方 scenario_results 与逐条实测记录）。
  采集不到的一律写「未采集」，不估算。
-->

parent_agent_id: dd078ab4-a3f1-462c-adaf-8d000fc7cd0a
child_agent_id: b6aeb7ec-967f-44e7-b2e8-c38837b3136c
notification_message_id: 59165370-3b82-417c-b60c-cc706a2248cc
dispatched_at: 2026-10-26T22:43:38.381Z
notification_at: 2026-10-26T22:47:35.535Z
reviewed_sha: 78ea95b5cb28e7c14a99c9cc00c2dbec75863845
result: PASS
relay_case: confirmed
unverified:

scenario_results:
  - SCEN-CON-01: PASS
  - SCEN-CON-02: PASS
  - SCEN-CON-03: PASS
  - SCEN-CON-04: PASS
  - SCEN-CON-05: PASS
  - SCEN-CON-06: PASS
  - SCEN-CON-07: PASS
  - SCEN-CON-08: PASS
  - SCEN-CON-09: PASS
  - SCEN-CON-10: PASS
  - SCEN-CON-11: PASS
  - SCEN-CON-12: PASS
  - SCEN-CON-13: PASS
  - SCEN-CON-14: PASS

---

## 1. 唤醒路径实测

| 事件 | 采集值 | 来源 |
| --- | --- | --- |
| 第三轮审计派发（claim） | `2026-10-26T22:43:38.381Z` | 运行账本 `local:T-08:3:audit:anchasi:dispatch` 的 `createdAt` |
| 回执（record） | `2026-10-26T22:43:53.312Z` | 同一意图的 `resolvedAt`，`agentId=b6aeb7ec-…` |
| 完成通知送达 | `2026-10-26T22:47:35.535Z` | `paseo-system` 通知信封 `message-id=59165370-…`，落盘于主会话 transcript |
| 该 agent 真实创建时间 | `2026-10-26T17:50:12.602Z` | `findAgentRecord('b6aeb7ec-…')` 返回的持久记录 `createdAt` |

结论：`createdAt(17:50:12) ≤ dispatched_at(22:43:38) ≤ notification_at(22:47:35)`，时间线自洽；通知确实送达主会话，`relay_case=confirmed`。该 agent 的首轮创建早于本轮派发，因为审计员被三轮复用（同一 agent 多次 `send_agent_prompt`）。

## 2. 全量回归

`bash skills/paseo-pipeline/test/run-all.sh` @ 本证据的 `reviewed_sha`：

```
ℹ tests 455
ℹ pass 455
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 115036.796833
=== All regression test suites completed successfully ===
```

逐文件（同一 revision，各跑一次）：

| 测试文件 | pass | fail | 覆盖场景 |
| --- | --- | --- | --- |
| `test/merge-task.test.mjs` | 77 | 0 | SCEN-CON-01、SCEN-CON-14 |
| `test/tasks.test.mjs` | 44 | 0 | SCEN-CON-02、SCEN-CON-03 |
| `test/freeze-check.test.mjs` | 16 | 0 | SCEN-CON-04、SCEN-CON-05、SCEN-CON-14 |
| `test/check-evidence.test.mjs` | 27 | 0 | SCEN-CON-07、SCEN-CON-08 |
| `test/run-state.test.mjs` | 24 | 0 | SCEN-CON-09、SCEN-CON-10、SCEN-CON-11 |
| `test/docs.test.mjs` | 24 | 0 | SCEN-CON-06、SCEN-CON-12 |
| `test/hotfix.test.mjs` | 17 | 0 | SCEN-CON-13 |

## 3. 逐场景真实入口与观测结果

### SCEN-CON-01 与 SCEN-CON-14：合流依赖门禁

`node --test test/merge-task.test.mjs` → pass 77 / fail 0。SCEN-CON-14 的四条新用例覆盖：Pod 同批依赖由本次合流满足、集外依赖仍 exit 35、环在解析期即被 `CYCLE` 拒绝、单任务合流不获得豁免。

### SCEN-CON-02 与 SCEN-CON-03：任务解析器

`node --test test/tasks.test.mjs` → pass 44 / fail 0。含手写 Done 行（`review=main-session`）被判 `BAD_DONE_LINE`、未知字段与 HTML 注释不改变契约、`Verify with` 的 Markdown 包裹在交给 shell 前被剥掉且内部引号保留。

### SCEN-CON-04：冻结预检拦住每一类缺陷

`node skills/paseo-pipeline/freeze-check.mjs openspec/changes/pipeline-contract-alignment` 实跑输出：

```
[freeze-check] openspec/changes/pipeline-contract-alignment
  tasks=8 scenarios=14 acceptanceRows=14
  HINT  Pod 成员 8 个的依赖闭包完全落在成员集内，单次合流可满足
  RESULT 可冻结（0 阻断项）；语义判据（scope 闭环、delta 对基线）仍由冻结审查逐条核
```

`node --test test/freeze-check.test.mjs` → pass 16 / fail 0，逐类缺陷各有一条阻断用例。

### SCEN-CON-05：项目内 schema 的临时仓库全流程

在 `/tmp/pp-schema-probe` 新建临时 git 仓库，复制 `openspec/schemas/paseo-pipeline` 后实跑：

1. `openspec init --tools none` → 成功，`openspec schemas` 列出 `paseo-pipeline (project)`，Artifacts 含 `acceptance`。
2. `openspec new change probe --schema paseo-pipeline` → `Created change 'probe'`，Schema: paseo-pipeline。
3. `openspec instructions tasks --change probe` → 指令正文含 `- [ ] 1.1 T-01 <one-line goal>` 与 `- Write scope:`，即模板由本 schema 生成。
4. `openspec validate probe --strict` → `Change 'probe' is valid`。
5. `openspec archive probe --yes` → `Change 'probe' archived as '2026-10-27-probe'`。

本机 `openspec --version` = `1.8.0`。`node --test test/freeze-check.test.mjs` → pass 16 / fail 0（模板必须零错误通过生产解析器）。

### SCEN-CON-06 与 SCEN-CON-12：文档与契约同源

`node --test test/docs.test.mjs` → pass 24 / fail 0：模板字段集与 `lib/evidence-contract.mjs` 导出的必填集双向相等；SKILL §4 的 run-state 命令块照抄可执行（租约下 `claim`/`record`/`fail` 均带 `--owner`，且每个子命令都真实存在于脚本）。

### SCEN-CON-07：占位判据按字段归属

真实跑一次结构闸门，证据文件的 `notes:` 里塞入 `TEST`/`example`/`LOST` 三个人话词：

```
[check-evidence] Smoke evidence valid (gate=structure): /tmp/scen07-probe.md
```

即闸门不读的字段不决定收据存亡。同一批词落在契约字段里仍被拒（`test/check-evidence.test.mjs`，pass 27 / fail 0）。

### SCEN-CON-08：必需场景来自冻结矩阵

用一份只声明 `SCEN-CON-01: PASS` 的证据跑：

```
node skills/paseo-pipeline/test/check-evidence.mjs --gate acceptance \
  --sha 78ea95b5cb28e7c14a99c9cc00c2dbec75863845 \
  --matrix openspec/changes/pipeline-contract-alignment/acceptance.md /tmp/scen08-probe.md
→ exit 1
  - 验收矩阵里 Required 行未通过：SCEN-CON-01=PENDING, …, SCEN-CON-14=PENDING
  - 必需场景 SCEN-CON-02 在本证据中没有任何引用
```

矩阵的 Required 行是必需项权威来源，调用者无法用 `--require-scenario` 减少。

### SCEN-CON-09：已回执意图不得作废

对已有真实回执的 `local:T-08:3:audit:anchasi:dispatch` 实跑：

```
node skills/paseo-pipeline/run-state.mjs fail pipeline-contract-alignment \
  --key "local:T-08:3:audit:anchasi:dispatch" --reason probe --owner main-session-1793037018
→ exit 2
  意图已有真实回执（agent=b6aeb7ec-…，2026-10-26T22:43:53.312Z），不得作废：…
  该 agent 已失联请走 reconcile 的 rework 处置，用新的 attempt 键派发，不要抹掉这次派发的痕迹
```

`node --test test/run-state.test.mjs` → pass 24 / fail 0。

### SCEN-CON-10：report 只报采集值

有账本：

```
派发 3 次 / 2 个任务
同任务最大 attempt 3
审查派发 3 次；作废意图 0 条
首次审查通过 未采集：账本不记审查结论，首次通过与否须从 Done 行的 review 值反查
READY 等待时长 未采集：账本不记状态迁移时刻，无 READY 进入时间
```

无账本（`report no-such-change`）→ `（无账本）`，派发 0 次，未采得的度量同样写「未采集」而非 0。

### SCEN-CON-11：版本漂移只告警

```
[run-state] pipeline-contract-alignment 有记录 …
LEASE owner=main-session-1793037018 gen=1 有效 到期=2026-10-26T23:57:40.580Z
INTENTS 未回执 0 / 共 3
SKILL head=78ea95b
```

账本记录的 Skill 版本与当前 HEAD 相同故无漂移告警；无 `skill` 字段的旧账本打印「SKILL 未采集」（`test/run-state.test.mjs` 两条用例分别覆盖漂移告警与未采集，均 pass）。

### SCEN-CON-13：profile 解析 fail-closed

`node --test test/hotfix.test.mjs` → pass 17 / fail 0，含「无 gongbu profile 时拒绝派发且不调用 `paseo run`」与「profile 解析出空 provider 同样拒绝」两条。

## 4. 静态对账（如实记录：这条门禁未通过）

`node skills/paseo-pipeline/contract-check.mjs openspec/changes/pipeline-contract-alignment/specs --tasks openspec/changes/pipeline-contract-alignment/tasks.md --final` 实测 **exit 1**：

```
tested=1 declared=0 undeclared=1 untested=0 scens=98/14 phantom_scens=84 untested_scens=0
```

数字的含义必须分开读，不能合成一个「通过」：

| 指标 | 实测 | 含义 |
| --- | --- | --- |
| `untested_scens` | 0 | **有利**：本 change 声明的 14 个场景全部被测试静态引用 |
| `phantom_scens` | 84 | **阻断项**：测试里引用、但本 change 的 spec 未声明的场景编号 |
| 其中 `SCEN-CON-*` | 0 条 | 本 change 自己的场景没有一条被判 phantom |
| `undeclared` | 1 | 测试断言的消息字面量 `"string"` 未在 spec 声明（消息通道方言不匹配，spec 侧 `declared=0`） |

84 条按前缀分组实测（`grep -oE 'phantom\): SCEN-…' | sort | uniq -c`）：

```
28 SCEN-MRG   22 SCEN-DOC   6 SCEN-DISP   5 SCEN-EVD   5 SCEN-DMO
 4 SCEN-REL    3 SCEN-A     2 SCEN-VER    2 SCEN-REC   2 SCEN-EVT
 1 SCEN-X      1 SCEN-RS    1 SCEN-OTH
```

即绝大多数是其他 change 的历史场景编号，被本 change 的 `Verify with` 一并引入；`SCEN-DMO`/`SCEN-OTH` 一类则是测试夹具内联 spec 的示例编号（夹具自造，不是仓库的真实场景）。

### 4.1 本 change 是否让这条门禁变差：是

上述 84 是「本 change 范围内」的口径。要看 delta 必须换 repo-wide 口径（剥掉 `--tasks` 过滤，全仓 `test/*.mjs` 对比 `openspec/` 全部已声明场景），在 `git archive` 出来的两棵干净树上分别实测：

| 度量 | 基线 `0ce4389` | HEAD `78ea95b` |
| --- | --- | --- |
| 测试引用的唯一场景编号 | 96 | 124 |
| 仓库内已声明 | 66 | 66 |
| 未声明（phantom） | **58** | **72** |

`comm -13` 得净增 **14** 条，`comm -23` 得被消除 **0** 条。逐条定位，全部落在本 change 新建或改写的 3 个测试文件里（`grep -rl` 逐个核对过）：

| 新增 phantom | 所在文件 | 性质 |
| --- | --- | --- |
| `SCEN-DMO-0`、`SCEN-DMO-01`、`SCEN-DMO-02`、`SCEN-DMO-77`、`SCEN-DMO-99`、`SCEN-OTH-0` | `test/freeze-check.test.mjs`（本 change 新建） | 该文件内联夹具 spec 的示例编号 |
| `SCEN-EVD-04`、`SCEN-EVD-05`、`SCEN-REL-08`、`SCEN-REL-09`、`SCEN-REL-99` | `test/check-evidence.test.mjs`（本 change 修改） | 同上 |
| `SCEN-DOC-21`、`SCEN-DOC-22`、`SCEN-DOC-23` | `test/docs.test.mjs`（本 change 修改） | 新增用例名，沿用该文件 `SCEN-DOC-03..20` 的既存惯例 |

三个已归档 change 各自跑 `--final` 也都是 exit 1。**`--final` 在本仓库从未通过过**，本 change 没有改变这一点，也没有让它变好——反而多了 14 条。

### 4.2 采集口径修正记录

本小节初稿写过「基线 59 → HEAD 73」，那组数字来自一次无法复现的扫描（多用 BSD `grep` 不支持的 `\s`，且比现测结果多出一个来源不明的裸 `SCEN-MRG`）。已按上表重测替换。`--final` 的退出码也曾被误读为 0——那是管道末端 `tail` 的退出码，不是 `node` 的；直跑取的才是真值 1。

**结论**：这条门禁的真实状态是「失败」，且本 change 让它变差 14 条。本文件 §3 的 14 个场景通过结论来自实际执行，不依赖这条门禁。要让它通过，要么清理测试夹具/用例名里的幽灵编号（夹具示例编号需改用不占用 `SCEN-` 命名空间的形式），要么调整门禁的抽取口径——那是独立的一项工作，不在本 change 已冻结的 14 个场景范围内，不应由收尾阶段顺手扩范围。

## 5. 本次未触达的边界（如实记录，不折算为已验证）

以下能力不属于本 change 冻结的 14 个场景，只在单元夹具中被证明，未在真实仓库里触发：

- 并发合流锁（exit 37）只在 `lock` 夹具的单进程内验证，未制造真实双进程竞争。
- Pod 依赖门禁的「集外依赖未验收」路径只在 `merge-task` 夹具里验证，未在真实仓库以未达成的集外依赖跑一次完整合流。
- `merge-task` 的测试内改树 / `MERGE_HEAD` 消失等 abort 分支（exit 20/40）同样只走夹具。

这三项是既有能力的回归保护，本 change 未修改其语义；它们的真实验证需要专门的破坏性演练，不在本次验收范围内。
