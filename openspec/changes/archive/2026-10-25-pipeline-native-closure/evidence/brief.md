# Brief evidence (gate1 prep)
- 输入：proposal.md（含完整验收，未派 PM）。
- 现状读取：skills/paseo-pipeline 下 SKILL.md/LESSONS.md/dispatch/reconcile/merge-task(.sh)/hotfix/contract-check(.test.sh)；源检出脏改 diff（dispatch pi 跳过 --mode；hotfix 可选 mode/thinking + pi 跳过 --mode）已读，意图由 T-04 在本分支重做，不覆盖源检出。
- 现状缺陷（路径:行）：merge-task.mjs 默认 test-cmd `true` 与默认 review `pass(mechanical)`、catch 内 `git reset --hard`、记账第二提交、`\b${tid}\b` 正则；reconcile.mjs paseo 不可用时静默 running=[]、无环/未知依赖校验、分支领先即 MERGE；SKILL.md "<100ms"、"0 次压缩"、CLI 派发默认。
- 角色选择：Critic=agent_profile_yushi（notes：异构对抗审评、只读、静音）；Auditor=agent_profile_anchasi；实现=gongbu/gaogong(strict 先 ceshi)。
