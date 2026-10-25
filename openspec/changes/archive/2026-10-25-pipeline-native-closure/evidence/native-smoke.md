# Native MCP Callback Smoke Test Evidence

## 1. 结构化元数据（自动化验证字段）

parent_agent_id: 62ce24cf-6ad9-4248-9def-7108195c73b5
child_agent_id: dfa79d7b-99f5-46aa-bd01-3829029a8d9b
notification_message_id: msg_01JAX_LOST_NOTIFICATION
dispatched_at: 2026-10-25T05:54:33.409Z
notification_at: 2026-10-25T06:13:24.669Z
result: FAIL
relay_case: grandchild_to_lead_relay_stalled_due_to_lost_wakeup
unverified:
  - daemon restart recovery without in-memory state loss
  - spontaneous self-wakeup without external event or timer source
  - zero-compaction execution on extended multi-agent pipelines

---

## 2. 实测过程与断链证据记录

### 测试场景
- Change: `pipeline-native-closure`
- 派发通道：Paseo 原生 MCP `create_agent`（保留默认 `notifyOnFinish: true`）
- 角色拓扑：主会话 (`ed31d53d`) → Lead Agent (`62ce24cf`) → Worker Agent (`dfa79d7b` Senior T-02 attempt 5)

### 实测现象
1. **Worker 完成**：Worker `dfa79d7b` 于 `2026-10-25T06:13:24Z` 前完成 T-02 代码编写与 182/182 测试通过，转入 `idle` 终态。
2. **通知未唤醒**：父级 Lead `62ce24cf` 保持 `idle`（`activeTurn: null`），`notifyOnFinish` 未能自动触发 Lead 继续执行下游 Auditor 派发或合流。
3. **静默停摆**：流水线进入无唤醒源的无限挂起状态，长达 15+ 分钟无任何自主进展，必须依赖主会话人工介入探查状态并手工接管。
4. **同类复发**：此前在 T-02 Senior a3 (`52479f24`)、T-04 Tester a2 (`e73389e6`) 均出现子 Agent 完成但 Lead 未唤醒的相同停摆反例。

### 结论与系统局限
- **评定结果**：`FAIL`。
- **事实结论**：仅改用原生 MCP `create_agent` 并启用 `notifyOnFinish`，**并不能保证父子 Agent 之间 100% 可靠唤醒接力**。在 Paseo daemon/host 缺少持久定时器或看门狗支撑时，纯事件驱动存在事件丢失、合并或未激活 turn 的物理局限。
- **规程约束**：必须如实记录该缺陷，禁止声称“已彻底解决断链”；依赖 `reconcile.mjs` 惰性对账作为唯一可信恢复手段。
