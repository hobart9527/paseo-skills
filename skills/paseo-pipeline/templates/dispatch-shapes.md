# 派发参数形状

<!--
  字段全部取自 2026-10-31 沙盒演练里被工具校验接受/拒绝的真实调用，不是推测。
  值（provider/model/modeId/thinking）一律来自活态 `list_profiles`，这里的示例值只示范形状。
-->

## 1. 建 workspace

```text
create_workspace
  isolation: "worktree"            # 必填。缺了直接校验失败
  path:      "<主仓库绝对路径>"
  background: false
```

- 首选 `templates/lead.md`「任务 workspace」的形状：`mode: "branch-off"` + `baseBranch` + `branchName` + `worktreeSlug`，一步到位拿到合规分支名。
- 沙盒演练只用了最小形状（`isolation` + `path`，不带 `branch`），得到的是自动生成的分支名（如 `evil-crab`）。`branch` 属于 `mode: "checkout-branch"`，在 branch-off 下传它会被拒。最小形状的分支名**不符合** SKILL §3，必须当场改名：

  ```bash
  git -C <worktree路径> branch -m integration/<name>          # 集成
  git -C <worktree路径> branch -m task/<name>/<task>          # 任务（重派追加 -a<attempt>）
  ```

  这是改名，不是 `git branch -D`，不违反 §3 的禁令。
- 无论哪种形状，建完都 `git branch --show-current` 核对：分支被占用时 Paseo 会自动加 `-1` 后缀，合流门禁认精确名。
- 任务/Pod worktree 的基点是 `integration/<name>`：建完确认 `git log -1` 是集成 HEAD，不是主干。

## 2. 派 agent

```text
create_agent
  title:         "[Pipeline] gongbu T-01 slugify"      # ≤60 字符，见 SKILL §1
  provider:      "claude/flash"                         # 必须是 <provider>/<model>，取 list_profiles 的 provider + model
  workspaceId:   "<create_workspace 返回的 id>"
  settings:      { modeId, thinkingOptionId, features } # 逐字复制 list_profiles，缺省字段整个省略
  labels:        { pipeline.change, pipeline.task, pipeline.attempt, pipeline.phase, pipeline.role }
  initialPrompt: "<templates/*.md 组装的 brief>"
  notifyOnFinish: true
```

- 不接受 `cwd`：目录由 `workspaceId` 决定。
- `provider` 只写 `claude` 会被拒；必须带 `/<model>`。
- `modeId` 必须是该 provider 支持的值：claude 为 plan/default/acceptEdits/auto/bypassPermissions，codex 为 auto/auto-review/full-access。`node "$PIPELINE_HOME"/pipeline-doctor.mjs` 会提前核。

## 3. 顺序（不可颠倒）

```text
run-state.mjs claim  → create_workspace（如需）→ git branch -m → create_agent
  → run-state.mjs record --agent <id> --workspace <id> → paseo wait <id> --timeout 540 --json
  → 读终态与产出 → update_agent 写 pipeline.disposition → merge-task.mjs
```

- `paseo wait` **无论 agent 成败都 exit 0**：必须解析 JSON 的 `status`，不能看退出码。
- `--timeout` 超时只代表还没结束，不代表失败；回到 `reconcile` 取真实态再决定。
- create_agent 失败（校验错误、没拿到 id）：`run-state.mjs fail` 作废意图后才允许重派。
