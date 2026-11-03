# Tasks

## 0. 接口骨架（Wave 0）

- [ ] 0.1 T-00 冻结接口桩：useFormDraft 签名与 LoanOffsetPicker invalidReason 类型
  - Depends on: none
  - Kind: skeleton
  - Write scope: packages/web/src/components/forms/common/useFormDraft.ts, packages/web/src/components/forms/LoanOffsetPicker.tsx
  - Interface: packages/web/src/components/forms/common/useFormDraft.ts#useFormDraft, packages/web/src/components/forms/LoanOffsetPicker.tsx#invalidReason
  - Est: S
  - Review: mechanical
  - Reads: packages/web/tsconfig.test.json
  - Verify with: npx tsc --noEmit -p packages/web/tsconfig.test.json

## 1. 草稿服务端（Phase 1）

- [ ] 1.1 T-01 form_drafts 表、仓储方法与 /api/v1/drafts REST 接口
  - Depends on: none
  - Est: M
  - Risk-surface: [persistence, public-api, concurrency]
  - Review: strict
  - Write scope: packages/server/src/db/index.ts, packages/server/src/routes/draft-routes.ts, packages/server/src/routes/api.ts, packages/server/test/form-drafts.test.ts
  - Verify with: MOCK_MODE=true NODE_ENV=test node --test --import tsx packages/server/test/form-drafts.test.ts
  - Scenarios: SCEN-FDL-01, SCEN-FDL-02, SCEN-FDL-03, SCEN-FDL-04, SCEN-FDL-05, SCEN-FDL-09
  - Note: 表结构与接口契约按 design.md D1（原设计 §5.4.1/§5.4.2）。`form_drafts` 入 `BASE_DDL` 并挂 `resetAll`（`db/index.ts:1199`）；`owner_id` 强制取 `session.dingtalkUserId`、忽略 body 声明；非本人统一 404；revision 口径冻结：创建请求携带 `revision: 0`，落库后初始 `revision` 为 1，更新校验请求值与库存一致并自增，客户端按返回值递增，冲突 409；**非 ACTIVE 冻结**：`PUT` 打到 `status !== 'ACTIVE'` 的记录返回 409 `DRAFT_NOT_ACTIVE` 且零改写（D1），测试必须断言内容与状态均未变；8 MiB 上限 413；单用户 ACTIVE 上限 50 份 409；DELETE 软删 DISCARDED；列表只回元数据、按 updated_at DESC。`api.ts` 按既有 `router.use` 模式挂载（`api.ts:777-1207`）。

- [ ] 1.2 T-02 提单与存金蝶成功后的草稿状态跃迁与单号回填
  - Depends on: T-01
  - Est: S
  - Risk-surface: [public-api, persistence]
  - Review: strict
  - Write scope: packages/server/src/routes/bill-routes.ts, packages/server/src/services/approval-service.ts, packages/server/test/form-drafts-submit-marking.test.ts
  - Verify with: MOCK_MODE=true NODE_ENV=test node --test --import tsx packages/server/test/form-drafts-submit-marking.test.ts
  - Scenarios: SCEN-FDL-06, SCEN-BFU-31
  - Note: `draftId` 一律从 query 参数 `?draftId=` 读取（design.md D1），不从 body 取。`POST /bills/submit`（`bill-routes.ts:903`）在 `submitGovernedBill` 返回 `status < 400 && body.code === 'OK'` 后按 `draftId + owner_id` 原子标记 `SUBMITTED` 并回填 `bill_no`；`POST /bills/draft`（`bill-routes.ts:865` → `approval-service.ts:4543`）存金蝶成功标记 `SAVED_TO_EAS`。测试必须断言转发给 `saveBillDraft` 的 EAS 模型不含 `draftId` 字段（防污染金蝶模型）。标记失败只记日志、不影响提交结果（原设计 §5.4.7）。逻辑依赖 T-01：测试需驱动真实 SQLite 仓储方法，见 design.md D4。不改 `loan-topology-routes.test.ts` / `travel-loan-submit.test.ts`，保持既有绿。

## 2. 草稿客户端与表单接入（Phase 2）

- [ ] 2.1 T-03 useFormDraft 通用草稿 Hook、本地多草稿索引与旧版迁移
  - Depends on: T-00
  - Interface: packages/web/src/components/forms/common/useFormDraft.ts#useFormDraft
  - Est: L
  - Risk-surface: [persistence, concurrency, error-handling]
  - Review: strict
  - Write scope: packages/web/src/components/forms/common/useFormDraft.ts, packages/web/test/use-form-draft.test.tsx
  - Verify with: TSX_TSCONFIG_PATH=packages/web/tsconfig.test.json node --test --import=tsx packages/web/test/use-form-draft.test.tsx
  - Scenarios: SCEN-FDL-07, SCEN-FDL-08, SCEN-BFU-28, SCEN-BFU-29
  - Note: 接口与行为按 design.md D1/D2（原设计 §5.4.3~§5.4.8）：本地镜像 800ms 防抖、服务端节流单在途、首次保存 `history.replaceState` 写 draftId、`pagehide` keepalive 补发；`enabled` 由调用表单传入，语义为「非 EDIT 回显模式才启用」（D8；契约不写标识符）；409 停自动保存 + 冲突横幅（载入最新/覆盖，覆盖先 GET 最新 revision）；收到提交/存金蝶成功信号后清空内部 `draftId` 并从 URL 移除该参数，下次保存生成新 id（D2，与 D1 的 `DRAFT_NOT_ACTIVE` 双保险）；发票快照剔除 Blob `previewUrl`、本地镜像剔除 `archiveBase64`、超 8 MiB 从后往前裁 Base64 并置 `archiveDropped: true`；旧版单槽位 key 一次性迁移、只写本地索引，解析失败不删旧 key，并导出纯函数 `scanLegacyDrafts()` 供 T-08 扫 4 个旧 key（其展示与移除归 T-08 草稿箱，见 design.md D2/D4）。服务端交互只依 D1 冻结契约，不依赖 T-01 实现。Red 形态用动态 import + `assert.ok` 兜底（design.md D5），禁止静态 import 尚不存在的模块。jsdom 断言覆盖：800ms 本地防抖、服务端节流单在途、409 冲突横幅、发票 Blob `previewUrl` 剔除与 `archiveBase64` 剔除、8 MiB 从后往前裁剪、旧单槽位迁移。

- [ ] 2.2 T-04 ExpenseBillForm 接入 useFormDraft、发票序列化与失效行提交阻断
  - Depends on: T-05
  - Uses: T-03, T-12
  - Est: L
  - Risk-surface: [persistence, public-api]
  - Review: strict
  - Write scope: packages/web/src/components/forms/ExpenseBillForm.tsx, packages/web/test/expense-form-draft.test.tsx, scripts/specs/expense-form-v10.mjs, scripts/specs/invoice-autofill.mjs, scripts/specs/invoice-table.mjs, scripts/specs/payee-local-directory-removed.mjs
  - Reads: scripts/specs/payee-company-scope.mjs
  - Verify with: TSX_TSCONFIG_PATH=packages/web/tsconfig.test.json node --test --import=tsx packages/web/test/expense-form-draft.test.tsx && node scripts/specs/expense-form-v10.mjs && node scripts/specs/invoice-autofill.mjs && node scripts/specs/invoice-table.mjs && node scripts/specs/payee-company-scope.mjs && node scripts/specs/payee-local-directory-removed.mjs
  - Scenarios: SCEN-BFU-26, SCEN-BFU-27, SCEN-BFU-28, SCEN-BFU-30, SCEN-BFU-31, SCEN-BFU-05, SCEN-BFU-07, SCEN-BFU-08
  - Note: 替换点：`:902` 旧恢复、`:1208` `useDebouncedLocalDraft`、`:2576` `clearLocalDraft`；快照覆盖 `org, cause, billNumber, happenDate, payees, entryRows, invoices, loanOffsets` 与 `submissionId`（恢复复用，`:2286` 派生单号 `SUB-<submissionId>` 不变）；`enabled = editEntry.mode !== 'EDIT'`（D8：`editing` 是「用户已改动」脏标志（`:1053`，`:1214` 心跳同源），**禁止**当作 EDIT 判定）；提交/存金蝶以 query 参数 `?draftId=` 携带草稿标识（design.md D1，EAS 模型 body 不加字段），成功后清本地镜像、索引与 URL 中的 `draftId`（D2）；空表单不触发保存；存在 `invalidReason` 注解行时禁用提交并给阻断提示（D3，类型契约来自 T-12）。依赖 T-03 已证明的 hook 行为。jsdom 测试真实渲染 `ExpenseBillForm`，断言：录入触发草稿保存、EDIT 模式不触发、**录入后 `editing === true`（脏标志）时仍然自动保存**、含发票快照的序列化、恢复 `draftId` 后复用 `submissionId`、提交 URL 带 `?draftId=`、成功后清理本地镜像与 URL 参数、存在 `invalidReason` 行时提交按钮禁用（SCEN-BFU-30 门禁）、提交后下一张单生成新 `draftId`。另加基线回归断言：SCEN-BFU-05 发票自动成单与 30s 心跳保持（心跳仅在 `editing && busy === null` 时启动，测试须先弄脏表单再推进假定时器）、SCEN-BFU-07 的收款账户门槛半边（`netPayout > 0` 时收款银行必填、`≤ 0` 时非必填，`:1862-1869`；差额展示半边归 T-12 的 Picker 断言）、SCEN-BFU-08 EDIT 回显还原（回收 T-13 的基线 UI 场景，R0 B5）。scope 内 5 个 `scripts/specs/*.mjs` 为只读回归夹具：执行-only，红即本任务失败，只准改实现、不准改脚本；任务审查必须确认 `git diff <base>..<tip> -- scripts/specs/` 为空（D6）。Depends T-05：`payee-company-scope.mjs` 同读 T-05 的三个表单源码，串行避免 scope 冲突（design.md D4）。

- [ ] 2.3 T-05 三个非报销表单接入 useFormDraft（借款 / 差旅借款 / 差旅报销）
  - Depends on: none
  - Uses: T-03
  - Est: L
  - Risk-surface: [persistence]
  - Review: strict
  - Write scope: packages/web/src/components/forms/LoanBillForm.tsx, packages/web/src/components/forms/TravelLoanBillForm.tsx, packages/web/src/components/forms/TravelExpenseBillForm.tsx, packages/web/test/non-expense-form-draft.test.tsx
  - Reads: scripts/specs/payee-company-scope.mjs
  - Verify with: TSX_TSCONFIG_PATH=packages/web/tsconfig.test.json node --test --import=tsx packages/web/test/non-expense-form-draft.test.tsx && node scripts/specs/payee-company-scope.mjs
  - Scenarios: SCEN-BFU-26, SCEN-BFU-27, SCEN-BFU-31, SCEN-BFU-04, SCEN-BFU-08
  - Note: 三个表单同构接入，共用一个测试文件（与 T-04 的 `expense-form-draft.test.tsx` 文件级隔离）。`LoanBillForm` 替换点：`:29-44` import、`:144` 旧恢复、`:240` `useDebouncedLocalDraft`、`:407` `clearLocalDraft`；快照覆盖 `org, borrower, employeeNo, cause, amount, expectDate, expenseType, payee` 与 `submissionId`；`enabled = !editEntry.editing`（`:142` 读 `readLoanEditEntry`，`:144` 据此跳过旧草稿恢复，D8）。`TravelLoanBillForm` 替换点：`:8-14` import、`:25` `DRAFT_KEY`、`:52` 旧恢复、`:71` `useDebouncedLocalDraft`、`:182` `clearLocalDraft`；快照覆盖 `org, cause, days, amount, payee, travelApplication` 与 `submissionId`；无 EDIT 入口（`rg 'editEntry|operateState'` 零命中），`enabled = true`，**不得写 EDIT 断言**（D8）。`TravelExpenseBillForm` 替换点：`:7-17` import、`:99` 旧恢复、`:139` `useDebouncedLocalDraft`、`:390` `clearLocalDraft`；快照覆盖 `org, cause, trips, entries, dailyAllowance, overAmountDesc, explanation, travelApplication, invoices, baseModel` 与 `submissionId`；`enabled = edit.mode !== 'EDIT'`（`:98` `readEditEntry`，D8）。三表单均：提交/存金蝶以 query 参数 `?draftId=` 携带草稿标识（D1）并成功后清理本地镜像、索引与 URL 参数（D2）；空表单不触发保存；不动 Phase 0 已修的预占与空冲销行逻辑。jsdom 测试逐个表单真实渲染，断言快照字段清单、EDIT 不自动保存（Loan / TravelExpense 两个可写，TravelLoan 不写）、draftId query 透传、成功后清理、空表单不触发保存。另加基线回归断言：SCEN-BFU-04 借款表单暂存草稿与分别调用 `/bills/submit` / `/bills/draft`、SCEN-BFU-08 的 `LoanBillForm` EDIT 回显还原（回收 T-13 的基线 UI 场景，R0 B5）。`payee-company-scope.mjs` 直读本任务三表单源码（D6），执行-only：红即本任务失败，只准改实现、不准改脚本。

## 3. 工作台首屏、草稿箱与深链改道（Phase 2/3）

- [ ] 3.1 T-08 SubmitHubView 四入口首屏、子视图路由、DraftBoxView 与 MyRequestsView 冲抵入口
  - Depends on: T-11
  - Uses: T-03
  - Est: M
  - Risk-surface: [public-api]
  - Review: deferred
  - Write scope: packages/web/src/components/SubmitHubView.tsx, packages/web/src/components/DraftBoxView.tsx, packages/web/src/components/Navigation.tsx, packages/web/src/components/MyRequestsView.tsx, packages/web/test/submit-hub-views.test.tsx, packages/web/test/my-requests-offset-entry.test.tsx
  - Verify with: TSX_TSCONFIG_PATH=packages/web/tsconfig.test.json node --test --import=tsx packages/web/test/submit-hub-views.test.tsx && TSX_TSCONFIG_PATH=packages/web/tsconfig.test.json node --test --import=tsx packages/web/test/my-requests-offset-entry.test.tsx
  - Scenarios: SCEN-SHN-01, SCEN-SHN-04, SCEN-SHN-05, SCEN-SHN-06, SCEN-SHN-09, SCEN-FDL-07, SCEN-BFU-29, SCEN-LOL-06
  - Note: 首屏固定四卡（日常借款/日常费用报销/冲抵借款/草稿箱），不再遍历 `FILING_ENTRIES` 平铺（SCEN-SHN-01 按修订后基线全量通过：四卡 + 点击进入 + 「重选单据」返回首屏）；差旅两项保留注册表与 `entry=TRAVEL_LOAN|TRAVEL_EXPENSE` 深链渲染及「重选单据」返回；`SubmitHubView` 自读 URL `entry` 做子路由分发并同步 URL，`App.tsx:331` 渲染 `<SubmitHubView />` 不传 props（D7）；草稿箱卡片展示 ACTIVE 数徽标、0 时「暂无文案」保持可点；`Navigation.tsx` 新增 `FILING_FORM_LABELS` 供草稿箱展示，`FilingView` 定义保留不删。`DraftBoxView` 列表冻结为双源合并：`GET /api/v1/drafts?status=ACTIVE`（D1 契约）∪ 本地索引 `approval_hub_draft_index:v1` 未同步条目（标「本机草稿，尚未同步」），损坏旧版条目标「旧版本草稿（无法自动恢复）」并可手工移除（SCEN-BFU-29 展示侧、SCEN-FDL-07 列表合并）；旧版 key 的扫描 MUST 调用 T-03 导出的纯函数 `scanLegacyDrafts()`（D2），不得在视图内重复实现解析逻辑；支持继续填写（带 draftId 跳转）与二次确认软删。`MyRequestsView` 待冲借款页签（`MyRequestsView.tsx:79-84`）中可用额度大于 0 的行展示「转为报销单」，点击跳 `?view=SUBMIT_HUB&entry=OFFSET&loanBillId=<内码>`；审批中行不展示该按钮（原设计 §11.1 第 3 条）；`DRAFT` 行既有展示不动。统一本任务四个视图的文案/空态/错误态措辞（不改行为）。依赖 T-03：草稿箱旧版条目展示复用 `scanLegacyDrafts()`；依赖 T-11：`entry=OFFSET` 需 import 已存在的 `OffsetLoanSelectView`（design.md D4）。jsdom 测试覆盖：首屏四卡渲染、子路由分发、DraftBoxView 双源合并列表/本机未同步标注/旧版本草稿标注与移除/继续填写带 draftId 跳转/二次确认删除；MyRequestsView 真实渲染断言按钮展示/隐藏与跳转参数。

- [ ] 3.2 T-09 App.tsx 填报深链改道 SUBMIT_HUB 与 filingTab 移除
  - Depends on: none
  - Est: M
  - Risk-surface: [public-api]
  - Review: deferred
  - Write scope: packages/web/src/App.tsx, packages/web/src/lib/filingDeepLink.ts, packages/web/test/filing-deep-link.test.ts, scripts/specs/app-filing-deeplink.mjs
  - Verify with: TSX_TSCONFIG_PATH=packages/web/tsconfig.test.json node --test --import=tsx packages/web/test/filing-deep-link.test.ts && node scripts/specs/app-filing-deeplink.mjs
  - Scenarios: SCEN-SHN-07, SCEN-SHN-08
  - Note: 深链解析与 URL 规范化抽成纯函数 `filingDeepLink.ts`（不依赖 DOM / `import.meta.env`，SHN-07 由 node 行为测试断言）；`isFilingEntryKey(viewParam)`（`App.tsx:88-98`）改道 `setActiveView('SUBMIT_HUB')` 并把 key 规范化为 `?view=SUBMIT_HUB&entry=<KEY>`；移除 `filingTab` 状态（`:71`）、URL 同步耦合（`:103`）与 INBOX 内 `FilingView` 条件分支（`:396-402`）；`App.tsx:19` 的 `FilingView` import 随之清理；URL 同步（`:100-114`）不改写 view 以外参数；`activeView !== 'SUBMIT_HUB'` 时 MUST 清理 `entry` / `draftId` / `loanBillId` 三个填报参数，避免离开工作台后旧草稿标识停留在地址栏、被下次进入误认（D1/D2 的 draftId 生命周期）；`App.tsx:331` 渲染 `<SubmitHubView />` 不传 props（D7）。`scripts/specs/app-filing-deeplink.mjs` 只保留 SHN-08 的结构性断言（`filingTab` / `FilingView` 分支不存在、`setFilingTab` 零命中），**并追加正向断言：`App.tsx` 确实 import 并调用 `filingDeepLink` 模块**——只断「删干净」会让空实现通过；SHN-07 行为证明在 `filing-deep-link.test.ts`（Red 形态用动态 import + `assert.ok`，D5）。禁止为 App 级渲染测试修改 `App.tsx:210` 的 `import.meta.env` 写法。

## 4. 冲抵选择页与失效行阻断（Phase 3）

- [ ] 4.1 T-11 OffsetLoanSelectView 独立冲抵借款选择页
  - Depends on: none
  - Est: M
  - Risk-surface: [public-api, error-handling]
  - Review: deferred
  - Write scope: packages/web/src/components/OffsetLoanSelectView.tsx, packages/web/test/offset-loan-select-view.test.tsx
  - Verify with: TSX_TSCONFIG_PATH=packages/web/tsconfig.test.json node --test --import=tsx packages/web/test/offset-loan-select-view.test.tsx
  - Scenarios: SCEN-LOL-01, SCEN-LOL-02, SCEN-LOL-03, SCEN-LOL-04, SCEN-LOL-05
  - Note: 复用 `useApprovalStore.fetchPendingLoans` / `pendingLoans`；列含单号、事由、日期、借款金额、未冲余额、可用额度、币种、复选框、拟冲金额输入；`dataSourceAvailable: false` 如实展示原因不冒充空列表；过滤 `travel_loan`；非 `BB01` 与 25/30 或状态未知行可见但置灰注明原因、全选跳过；拟冲金额默认带可用额度、超额红字并钳制；底部实时汇总已选笔数/冲抵合计/可用合计；「下一步」生成 draftId 并按 D1 契约 `PUT /api/v1/drafts/:id` 写含 `loanOffsets` 初始草稿，成功跳 `?view=SUBMIT_HUB&entry=EXPENSE&draftId=<id>`，失败留页报错；支持 `loanBillId` 参数预勾选（路径 1）；不预占、不调 calculate-offset（原设计 §11.1 第 5/6 条）。jsdom 断言覆盖：跨币种行、审批中/状态未知行置灰、全选跳过不可用行、超额钳制、汇总、下一步 PUT 草稿成功跳转、失败留页报错、`loanBillId` 预勾选。Red 形态用动态 import + `assert.ok`（design.md D5）。

- [ ] 4.2 T-12 LoanOffsetPicker 失效预填行可见阻断与刷新台账
  - Depends on: T-00
  - Interface: packages/web/src/components/forms/LoanOffsetPicker.tsx#invalidReason
  - Est: L
  - Risk-surface: [error-handling, public-api]
  - Review: strict
  - Write scope: packages/web/src/components/forms/LoanOffsetPicker.tsx, packages/web/test/loan-offset-picker-guard.test.tsx
  - Verify with: TSX_TSCONFIG_PATH=packages/web/tsconfig.test.json node --test --import=tsx packages/web/test/loan-offset-picker-guard.test.tsx
  - Scenarios: SCEN-BFU-30, SCEN-LOL-07, SCEN-BFU-06, SCEN-BFU-07
  - Note: 台账到齐后不再静默剔除不在台账/无余额/跨币种行（现状 `LoanOffsetPicker.tsx:335-360`），转为只读「已失效」行并按 D3 注解 `invalidReason` 标明原因；保留差旅过滤（`:283-286`）；「刷新台账」重新拉取本人待冲借款（客户端 re-fetch）；服务端 write-through 回写为既有行为、本任务不改服务端，由 T-13 全量服务端套件兜底；可用额度取服务端已扣预占值；不再要求 `loanEntryId`（Phase 0 已降为可选）。jsdom 断言覆盖：失效行可见且只读、`invalidReason` 三种原因、「刷新台账」触发重新拉取。另加基线回归断言：SCEN-BFU-06 在途借款检索与多选冲抵联动、SCEN-BFU-07 的差额结算展示半边（`computeLoanOffsetSettlement` 三档与 `presentSettlement` 文案，`:112-200`；表单层的收款账户门槛归 T-04，见 `ExpenseBillForm.tsx:1862-1869`）（回收 T-13 的基线 UI 场景，R0 B5）。

## 5. 收尾（Phase 4，唯一 sink）

- [ ] 5.1 T-13 eas-submit-api 文档补注与全量回归
  - Depends on: T-01, T-02, T-04, T-05, T-08, T-09, T-11, T-03, T-12, T-00
  - Est: M
  - Risk-surface: [none]
  - Review: mechanical
  - Write scope: docs/eas-submit-api.md
  - Verify with: npm --prefix packages/server test && npm --prefix packages/web run build && npx tsc --noEmit -p packages/web/tsconfig.test.json && TSX_TSCONFIG_PATH=packages/web/tsconfig.test.json node --test --import=tsx packages/web/test/*.test.tsx packages/web/test/*.test.ts && for f in scripts/specs/*.mjs; do node "$f" || exit 1; done
  - Scenarios: SCEN-REG-01, SCEN-no-fake-ledger, SCEN-pending-loan-port, SCEN-pending-loan-demo-mock-only
  - Note: 唯一 sink。五条腿：全量服务端测试、生产构建、测试 tsconfig 编译检查（基线 `3a4ebc4` 实测 exit 0）、全部 jsdom 与 node 测试（`.test.tsx` + `.test.ts`，`filing-deep-link.test.ts` 属 `.ts` 腿，必须纳入）、逐一执行 `scripts/specs/*.mjs` 任一失败即非零退出（SCEN-REG-01；同时回归守护既有台账端口契约 SCEN-no-fake-ledger / SCEN-pending-loan-port / SCEN-pending-loan-demo-mock-only）。基线 UI 场景 SCEN-BFU-04/05/06/07/08 不得在 sink 兜底——本变更会改写这些场景所描述的表单行为，必须由改动它们的任务各自持有回归断言（T-04 持 BFU-05/08-Expense，T-05 持 BFU-04/08-Loan，T-12 持 BFU-06/07，R0 B5）。既有脚本清单实测 8 个：`cutover-two-plane`、`expense-form-v10`、`expense-row-markers`、`invoice-autofill`、`invoice-table`、`payee-company-scope`、`payee-local-directory-removed`、`payee-readonly-view`，基线 `3a4ebc4` 全绿；脚本为只读夹具，本任务执行-only、无写权限（scope 已移除 `scripts/specs`），变红即前序改动任务失败、回溯修实现（design.md D6）。`docs/eas-submit-api.md` 补注 `loanBillId` 必须为 EAS 单据内码、`loanBillNo` 为单号（原设计 §6）。
