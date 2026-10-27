## Context

本 change 的实现已经在工作树里，尚未提交（19 个修改文件 + 7 个新增文件，`bash skills/paseo-pipeline/test/run-all.sh` 实测 433 通过 / 0 失败）。动机见 proposal.md。这里只记录塑造实现形态的约束：

- pipeline 的每个脚本都是**独立可执行入口**（`reconcile.mjs` / `merge-task.mjs` / `contract-check.mjs` / `freeze-check.mjs` / `run-state.mjs` / `hotfix.sh`），没有中心进程，因此「谁定义、谁消费」必须由模块导出关系表达，不能靠调用约定。
- 这些入口此前各自维护了同一份知识的副本：错误码集、角色集、review 标签正则、证据字段清单。副本之间已经漂移（详见 proposal.md）。
- 冻结与合流是两个不同时刻，但必须回答同一个问题：「这份 tasks.md 能不能被执行」。两处用不同解析器就会产生「冻结通过、执行解析出 0 任务」。

## Goals / Non-Goals

**Goals:**

- 每一类知识只有一个定义点，其余位置通过 import 消费；定义点变更即所有消费者同步。
- 调用者只能收紧不能放宽：冻结产物（`Verify with`、验收矩阵的必需行、契约字段集）对调用方参数是下限。
- 留档与验收分开：结构闸门对 FAIL 也放行（失败调查要能完成），验收闸门只认真实采集值。
- 采不到的事实写「未采集」，不用估算填补。

**Non-Goals:**

- 不引入新的调度层、中心服务或数据库；账本仍是 git common dir 下的单个 JSON。
- 不把语义判据机械化（scope 闭环、一场景一承载、delta 对基线这类判断仍由冻结审查的 Auditor 核）。
- 不追溯清洗归档 change 的历史 Done 行；`review=main-session` 现在解析即报错，只影响仍在执行的 change。
- 不为 `list_profiles` 之外的 provider 行为做假设。

## Decisions

**1. 错误严重度按「破坏范围」分轴，不按调用方宽松程度分。**

`ERROR_SCOPE` 把错误码分 graph / task 两档；`IDENTITY_CODES` 是正交的窄轴（只服务 contract-check 抽取测试路径）。备选是让每个调用方维护自己的集合差集（现状），或者把所有错误都当致命（旧 merge-task 行为）。前者漂移是必然的——四处副本已经各说一套；后者把「无关任务漏写 scope」升级成「整批不可合流」，与「单个任务的问题只压住被点名的任务」直接矛盾。选分轴方案后，`merge-task` 的规则变成「graph 全拒 + 请求任务及其依赖的 task 级错误」，`reconcile` 变成「graph 全拒」，两者都是同一张表的派生。

**2. review 标签正则在解析器里，不在合流器里。**

Done 行只能由 `merge-task.mjs` 写入。把语法上移后，解析期就能识别「这条 Done 行不是合流器写的」，而不是等到下一次合流才发现上游账本不可信。备选是在 `merge-task` 里保留正则、解析器继续只查非空——那正是 `pipeline-gate-slimming` 19 条 `review=main-session` 得以入账的原因。

**3. 证据字段清单独立成模块，闸门只提供判据。**

`lib/evidence-contract.mjs` 导出字段集，`check-evidence.mjs` 提供 `SMOKE_VALIDATORS` 映射。若清单有字段而闸门没有判据，脚本**抛错**而不是跳过——这是「契约与校验漂移必须当场暴露」的机械化。备选是把清单留在闸门里、让模板靠人工同步：实测后果是 8 个必填字段里 4 个在文档中命中 0 次。

**4. 占位值判据按「谁读这个字段」限定作用域。**

契约字段 + 命令型字段才参与判定。理由是可证伪的：`notes: the TEST harness was restored, for example …` 是一句人话，却会被 `TEST`/`EXAMPLE` 的子串判据拒绝整份收据（实测 rc=1）。不收窄就得给每个通用词开豁免，那个方向会一路泄漏。

**5. 冻结预检复用生产解析器，不新写正则。**

`freeze-check.mjs` 直接 `import { parseTasks }`。这样「冻结时通过、执行时解析不出来」在结构上不可能。代价是 freeze-check 无法独立于解析器演进——这正是想要的耦合。

**6. 项目内 schema 是整份替换，配一次安装步骤。**

OpenSpec 的项目内 schema 不支持叠加，因此 `openspec-schema/` 是 `spec-driven` 的整份副本，只改 tasks/specs 指令并新增 `acceptance` 产物。备选是继续用 `config.yaml` 的 `rules` 追加文字——但模板示范的仍是 `- [ ] 1.1 描述`，两条指令同时出现时写的人照模板写。schema 的 `name:` 保持 `spec-driven`（安装目录名决定注册名），这一点在 schema.yaml 头部注明，升级 OpenSpec 后需重跑探测。

**7. 账本的「作废」与「回执」是互斥终态。**

`fail` 拒绝已有真实回执的意图。旧实现放行，于是 `claim → record → fail` 可以用同一幂等键重派一个仍然活着的 agent：账本写着「上次失败」，实际出了两个写手。agent 失联的正确处置是 `reconcile` 的 rework，用新 attempt 键。

**8. 度量与版本留痕都只做「读得到才算」。**

`report` 只从账本已记的时间戳与字段推导；不记的（审查结论、READY 进入时刻）写「未采集」。Skill 版本不一致只警告——拦会让升级后每次诊断都失败，不记会让复盘无法判断规则是否存在。

## Risks / Trade-offs

- **`--matrix` 让收尾对矩阵的依赖变成硬依赖**：矩阵写错（例如 Required 行一直 PENDING）会让验收永远不过。→ 冻结时 `freeze-check` 强制矩阵结构合法且不得提前 PASS；收尾仍由人判断 PASS 是否真实，脚本只做机械核对。
- **`child_agent_id` 真实性核对依赖本机 Paseo 目录**：CI 或异地复核跑不了。→ 提供 `PIPELINE_SKIP_PASEO_LOOKUP=1`，但豁免本身报错，只能当结构留档，不能当验收收据。
- **Done 行语法收紧会让存量 change 报错**：`review=main-session` 现在解析即 `BAD_DONE_LINE`。→ 有意为之：这些行从未经过合流门禁。仍在执行的 change 需要按真实合流重写 Done 行，这是修复而不是迁移成本。
- **`UNKNOWN_FIELD` 只识别 ASCII 字段名形态**：中文小标题不报错。→ 有意收窄，避免把说明性文字当字段；代价是拼错成中文的字段名仍会被静默忽略。
- **Skill 版本警告在多机协作下会频繁出现**：不同机器不同 HEAD 是常态。→ 只是警告，不影响任何动作；报告里带 dirty 标记，便于排除「本地未提交改动」这一常见成因。
- **schema 副本会随 OpenSpec 升级过时**：1.8.0 之后的指令变更不会被自动继承。→ schema.yaml 头部与 SKILL §2.0 都写明了升级后必须重跑的探测步骤（临时仓库 `new change --schema` → 检查 instructions → `validate --strict` → `archive`）。

## Migration Plan

1. 目标仓库安装 schema：`mkdir -p openspec/schemas/paseo-pipeline && cp -R skills/paseo-pipeline/openspec-schema/. openspec/schemas/paseo-pipeline/`，用 `openspec schemas` 确认 `paseo-pipeline (project)`。
2. 新 change 一律 `openspec new change <name> --schema paseo-pipeline`；已存在的 change 在 `.openspec.yaml` 里固定了 schema，需要时按模板手工改 `tasks.md`。
3. 回滚：schema 安装是新增目录，删除即可回到上游 `spec-driven`；脚本改动以本 change 的合流提交为界，`git revert` 该提交即可。账本 `run-state.json` 无需迁移（`skill` 字段缺失按「未采集」处理）。

## Open Questions

（无）
