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
  - Tasks：承载这一行的任务 ID，逗号分隔。留空则从 tasks.md 的 Scenarios 认领自动推导（推荐默认）；
    填了就只能列在 tasks.md 的 Scenarios 里认领了该场景的任务。同一场景多行可以分摊，
    但所有行的并集必须覆盖全部认领者，单行不必列全；填值只用于把所有者分摊到多行。
    无论留空还是填写，Entry 是文件路径时，行所有者必须写这个文件，或经由 Depends on/Uses
    到达写它的任务（freeze-check 报 ENTRY_OWNER_UNCLAIMED）。
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
