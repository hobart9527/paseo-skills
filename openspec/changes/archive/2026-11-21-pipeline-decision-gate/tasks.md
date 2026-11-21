# Tasks

## 1. Slices

- [ ] 1.1 T-01 staged 检查与完整运行共用硬决策判定；被引用的开放硬决策阻断且 route 为 null
  - Depends on: none
  - Write scope: skills/paseo-pipeline/freeze-check.mjs
  - Reads: skills/paseo-pipeline/test/freeze-check.test.mjs
  - Est: M
  - Risk-surface: [error-handling]
  - Review: standard
  - Verify with: node --test skills/paseo-pipeline/test/freeze-check.test.mjs
  - Scenarios: SCEN-DEC-01, SCEN-DEC-02, SCEN-DEC-03

- [ ] 1.2 T-02 每个 scenario 必须有 Verify 行；staged 检查报 MISSING_SCEN_VERIFY
  - Depends on: T-01
  - Write scope: skills/paseo-pipeline/lib/spec-scan.mjs, skills/paseo-pipeline/freeze-check.mjs
  - Reads: skills/paseo-pipeline/test/freeze-check.test.mjs
  - Est: S
  - Review: standard
  - Verify with: node --test skills/paseo-pipeline/test/freeze-check.test.mjs
  - Scenarios: SCEN-DEC-05

- [ ] 1.3 T-03 作者 brief、spec 模板、schema 与 proposal 模板统一硬决策与 Verify 规则；汇点跑全量套件
  - Depends on: T-02
  - Write scope: skills/paseo-pipeline/templates/author.md, skills/paseo-pipeline/openspec-schema/templates/spec.md, skills/paseo-pipeline/openspec-schema/schema.yaml, skills/paseo-pipeline/openspec-schema/templates/proposal.md
  - Reads: skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs
  - Est: S
  - Review: standard
  - Verify with: node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs && node --test
  - Scenarios: SCEN-DEC-04, SCEN-DEC-05, SCEN-DEC-07

- [ ] 1.4 T-04 交接 brief 要求行为测试两提交并在测试提交处复跑 Red；SKILL 要求绝对一次性心跳
  - Depends on: none
  - Write scope: docs/tier2-handoff-brief.md, skills/paseo-pipeline/SKILL.md
  - Reads: skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs
  - Est: S
  - Review: mechanical
  - Verify with: node --test skills/paseo-pipeline/test/pipeline-friction-docs.test.mjs
  - Scenarios: SCEN-DEC-06
