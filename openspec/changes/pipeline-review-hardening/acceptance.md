# Acceptance Matrix

<!--
  本 change 交付的是门禁本身，所以「真实入口」就是那几条命令本身：解析器没有 HTTP 路由，
  它的入口是 `reconcile` / `merge-task` 这类消费方；门禁的入口是 SKILL 里写死的那条命令。
  每条 Verify 都是可重跑的命令，不接受「看过一遍」。
-->

| Scenario | Entry | Tasks | Verify | Required | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| SCEN-CON-15 | `node skills/paseo-pipeline/freeze-check.mjs <change>` 读到的任务集合 | T-01 | 写一份任务行带行内注释的 tasks.md，跑 freeze-check，确认任务数不减少、无 MISSING_SCOPE | yes | PENDING | pending |
| SCEN-CON-16 | `merge-task.mjs` 读取的 `Verify with` | T-01 | `node --test skills/paseo-pipeline/test/tasks.test.mjs`，确认 `(cd sub && make)` 原样保留 | yes | PENDING | pending |
| SCEN-CON-19 | `node skills/paseo-pipeline/contract-check.mjs <spec> --tasks <tasks> --baseline <dir>` | T-02 | 同一命令加/不加 `--baseline` 各跑一次，确认基线场景在后者被判 phantom | yes | PENDING | pending |
| SCEN-CON-20 | `contract-check.mjs --max-phantom <n>` 的退出码 | T-02 | `bash skills/paseo-pipeline/contract-check.test.sh`，确认越界失败、等于或低于预算通过 | yes | PENDING | pending |
| SCEN-CON-21 | `contract-check.mjs` 的消息通道 | T-02 | `bash skills/paseo-pipeline/contract-check.test.sh` 的 R26，确认 `typeof err.message === 'string'` 不产生 undeclared | no | PENDING | pending |
| SCEN-CON-17 | `node skills/paseo-pipeline/freeze-check.mjs openspec/changes/archive/<change>` | T-03 | 对四个已归档 change 各跑一次，确认 rc=0 且输出含「已归档」 | yes | PENDING | pending |
| SCEN-CON-18 | `node --test skills/paseo-pipeline/test/docs.test.mjs` | T-04 | 改动一份安装副本后重跑，确认失败并指名该文件；还原后通过 | yes | PENDING | pending |
| SCEN-CON-22 | `node skills/paseo-pipeline/run-state.mjs report <change>` | T-04 | 跑 report（含 `--json`），确认无第一个通过率/READY 等待字段，且末尾有一句「未采集」说明 | yes | PENDING | pending |
| SCEN-CON-23 | `node skills/paseo-pipeline/run-state.mjs begin <change> --owner <id>` | T-04 | 在 `GIT_DIR` 指向不存在路径的环境下跑 begin，确认 rc=0 且 stderr 含「Skill 版本未采集」 | no | PENDING | pending |
