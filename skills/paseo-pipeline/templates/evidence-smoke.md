# Native Smoke Evidence

<!--
  原生编排冒烟的证据模板。字段集合由 test/check-evidence.mjs 决定，不是这里定的：
  写完先跑 `node skills/paseo-pipeline/test/check-evidence.mjs <本文件>`（structure 闸门，
  只证明字段齐全），收尾再跑 `--gate acceptance --sha <集成 HEAD> --matrix <acceptance.md>`。

  两条闸门的分工是刻意的：
  - structure 只判「这份记录写得完不完整」，FAIL 也是合法留档。
  - acceptance 判「这份记录能不能当验收收据」：结论必须是 PASS、必须绑定 revision、
    必须没有未验证项、child_agent_id 必须在 Paseo 持久记录里真实存在、
    时间线不得早于该 agent 的真实创建时间。

  采集不到时写「未采集」并说明原因——不许编造。
  但「未采集」只对 structure 有效：acceptance 会拒。两者不矛盾：留档如实，验收要真值。
-->

parent_agent_id: <父 agent 的完整 UUID>
child_agent_id: <被派发 agent 的完整 UUID，必须是 Paseo 里真实存在的那个>
notification_message_id: <真实通知消息 id；采不到写 未采集 并说明>
dispatched_at: <ISO 时间戳，不得早于 child 的真实 createdAt>
notification_at: <ISO 时间戳，不得早于 dispatched_at>
reviewed_sha: <本次冒烟验证的 commit sha（7-40 位），收尾须与集成 HEAD 一致>
result: <PASS | FAIL>
relay_case: <唤醒路径的实际结果，如 confirmed / timeout / 未采集>
unverified:
  - <逐条列出这次没有验证到的能力；空着表示全验过>

scenario_results:
  - SCEN-XXX-01: <PASS | FAIL | BLOCKED | SKIPPED>

<!--
  scenario_results 段落是对账入口：`--require-scenario` 与 `--matrix` 里的 Required 行
  都要求这里有一条 `<ID>: PASS`。正文里提到场景编号不算验证，注释和 TODO 也不算。
  同一场景不得同时出现在 unverified 列表里（自相矛盾会被直接拒绝）。
-->
