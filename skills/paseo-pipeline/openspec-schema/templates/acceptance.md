# Acceptance Matrix

<!--
  这张表是本 change「算不算交付」的唯一定义。tasks.md 与单测都不回答这个问题：
  任务可以合流、单测可以全绿，而功能从真实入口根本走不通。

  冻结时（人类确认点 1）整表冻结：Result 一律 PENDING，Evidence 一律 pending。
  Git 内冻结矩阵始终是验收要求的唯一权威，不回填以免改变验收 SHA。
  收尾时（人类确认点 2 之前）在仓外独立执行记录中逐行回填 Result 和 Evidence，
  记录原始矩阵、完整 source SHA、命令和输出；Required=yes 的行没有 PASS 和证据时 CP-2 即拒绝。

  行规则：
  - Scenario：必须是本 change spec delta 里声明过的 SCEN-* 编号（freeze-check 核对）。
    每个声明过的场景至少一行；多行可以共用 Entry 和 Verify，也可以复用已有测试，
    不要求为每个场景新写测试。
  - Entry：真实入口 —— HTTP 路由、UI 路径、CLI 命令，或让能力可达的装配点。不是内部函数。
    写的是本 change 某个任务会写的文件时，行所有者必须写它或依赖写它的任务（freeze-check 报
    ENTRY_OWNER_UNCLAIMED）；多个组件共用一个装配文件时，让装配任务认领用户可见场景，或加
    Wave 0 `Kind: skeleton` 预接线并让组件 `Uses` 它（见 author brief 的 shared-assembly 模式）。
  - Tasks：承载这一行的任务 ID，逗号分隔。**认领来源是 tasks.md 的 `Scenarios:`，这一格是它的投影，不是第二份认领。**
    留空则从 tasks.md 的 Scenarios 认领自动推导（推荐默认）；填了就只能列在 tasks.md 的 Scenarios 里
    认领了该场景的任务，且同一场景所有行的并集必须覆盖全部认领者，单行不必列全；填值只用于把所有者分摊到多行。
    一行里出现未认领该场景的任务就是错，即使并集看起来仍然完整。Entry、Verify、Required 仍是作者的判断：
    Required 按真实交付语义决定，不能为省事把全部行设为 no —— 那只是隐藏交付证据，并没有通过门禁。
  - 场景身份要分清三件事：**新编号**是 baseline 和所有其他未归档 change 都没声明过的编号；复用
    **baseline 编号**必须写在 `## MODIFIED Requirements` / `## REMOVED Requirements` 下，那是同一个场景的
    身份复用，应引用并更新原需求，而不是另造一个平行场景；与 **active change 内容冲突**指另一个 change
    用同一个编号声明了不同的标题或正文（逐字相同的共享声明是合法的，只影响归档/合并顺序）。冲突要暴露并协调，
    不能改名或改写正文把它伪装成独立行为。`../../pipeline-run.mjs scenarios <change-dir>` 可以只读列出这些关系与缺口。
  - Verify：真正跑一遍 Entry 的**单条可执行命令**。收尾由主会话逐条真跑并留证；命令必须是单条可执行语句：
    自然语言、手工步骤、以 `!` 开头的取反写法都会被拒。预期失败（如退出码 1）写成 `sh -c '! node x.mjs'`；
    多步骤写进一个脚本再调用。只有 Required=no 的行允许写手工步骤（它只留档，不进入执行）。
    判定看命令自身的退出码；经过 `| tail` 等管道时 `$?` 是管道末端的状态，不能当作检查结果。
  - Required：按真实交付语义决定。yes 阻断交付；no 只留档不阻断。不要为省事把全部行设为 no。
  - Result：PENDING / PASS / FAIL / BLOCKED / UNVERIFIED。冻结时只能写 PENDING。
  - Evidence：执行记录中的命令输出及完整 source SHA。

  runner 对失败（包括缺少依赖）记录 FAIL，不自动判断 BLOCKED。操作者可在独立说明中
  标记 BLOCKED 并记录原因，不可改写冻结矩阵或执行记录；FAIL 和 BLOCKED 均阻断 CP-2。
  mock 通过不能折算业务验收。
-->

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-CAP-01 | `<真实入口：GET /api/x、UI 路径、CLI 命令或装配点>` | T-01 | `<跑一遍该入口的命令或步骤>` | yes | PENDING | pending |
| SCEN-CAP-02 | `<异常/恢复路径的真实入口>` | T-02 | `<命令或步骤>` | yes | PENDING | pending |
