# Tasks

## 1. Slices

- [ ] 1.1 T-01 角色表与识别代码同步：`next-actions.mjs` 认可 `shangshu`/`chanpin`，并用测试双向断言两张角色表一致
  - Depends on: none
  - Write scope: skills/paseo-pipeline/next-actions.mjs, skills/paseo-pipeline/test/next-actions.test.mjs
  - Est: S
  - Review: standard
  - Verify with: node --test skills/paseo-pipeline/test/next-actions.test.mjs
  - Scenarios: SCEN-ROLE-01, SCEN-ROLE-02

- [ ] 1.2 T-02 审查者读取作者 `## Baseline`，不再自跑一遍 sink Verify
  - Depends on: none
  - Write scope: skills/paseo-pipeline/templates/reviewer.md, skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs
  - Est: S
  - Review: standard
  - Verify with: node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs
  - Scenarios: SCEN-RBASE-01

- [ ] 1.3 T-03 hook 校验 `create_agent` 运行时参数与 profile 一致，并在省略或置空 `modeId` 时从 profile 填入
  - Depends on: none
  - Write scope: skills/paseo-pipeline/hooks/tool-guard-hook.mjs, skills/paseo-pipeline/test/tool-guard-hook.test.mjs
  - Est: M
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: node --test skills/paseo-pipeline/test/tool-guard-hook.test.mjs
  - Scenarios: SCEN-DISP-04, SCEN-DISP-05, SCEN-DISP-06
