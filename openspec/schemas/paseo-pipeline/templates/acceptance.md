# Acceptance Matrix

<!--
  这张表是本 change「算不算交付」的唯一定义。tasks.md 与单测都不回答这个问题：
  任务可以合流、单测可以全绿，而功能从真实入口根本走不通。

  冻结时（人类确认点 1）整表冻结：Result 一律 PENDING，Evidence 一律 pending。
  收尾时（人类确认点 2 之前）逐行回填，并由
  `node "$PIPELINE_HOME"/test/check-evidence.mjs --gate acceptance --matrix <本文件>`
  机械核对。Required=yes 的行 Result 不是 PASS、或 Evidence 未绑定验收 SHA，收尾即拒绝。

  行规则：
  - Scenario：必须是本 change spec delta 里声明过的 SCEN-* 编号（freeze-check 核对）。
  - Entry：真实入口 —— HTTP 路由、UI 路径、CLI 命令，或让能力可达的装配点。不是内部函数。
  - Tasks：承载这一行的任务 ID，逗号分隔。
  - Verify：真正跑一遍 Entry 的**单条可执行命令**。收尾由 acceptance-run 逐条真跑，freeze-check 冻结时已用同一判据拦截：
    自然语言、手工步骤、以 `!` 开头的取反写法都会被拒。预期失败（如退出码 1）写成 `sh -c '! node x.mjs'`；
    多步骤写进一个脚本再调用。只有 Required=no 的行允许写手工步骤（它只留档，不进入执行）。
  - Required：yes 阻断交付；no 只留档不阻断。
  - Result：PENDING / PASS / FAIL / BLOCKED / UNVERIFIED。冻结时只能写 PENDING。
  - Evidence：证据文件路径 + 验收 SHA，收尾时回填。

  外部必需依赖冻结时就接不通，要把 Result 标 BLOCKED 并写原因。
  mock 通过不能折算业务验收。
-->

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-CAP-01 | `<真实入口：GET /api/x、UI 路径、CLI 命令或装配点>` | T-01 | `<跑一遍该入口的命令或步骤>` | yes | PENDING | pending |
| SCEN-CAP-02 | `<异常/恢复路径的真实入口>` | T-02 | `<命令或步骤>` | yes | PENDING | pending |
