# Writer brief：<change> / <task>（attempt <n>）

你是本任务的写手（`Pipeline-Role: gongbu`，复杂任务改 `gaogong`）。工作目录见末尾。
**只改 `Write scope` 内的文件**，越界提交会被合流门禁 exit 30 拒绝。

## 目标与不变式

- 任务：<一句话说明要实现什么>
- 场景：读 `openspec/changes/<change>/specs/<spec>.md` 里的 `SCEN-*`，**自己读文件**，不要等人转述。
- 不变式：<不许破坏的既有契约；没有就写「无」>
- **深模块原则（Deep Modules）**：接口尽量小且稳定，复杂性在实现内部消化，杜绝浅层包装（Shallow Modules）；拒绝 Speculative Generality（臆想泛化，未在 spec 要求的参数/抽象一律不加）。
- **TDD 节奏**：测试先行或紧随，红-绿-重构循环。断言针对公开接口行为与不变式，不对准私有实现细节。

## 返工严律（attempt ≥ 2，红灯反馈环优先）

若本任务是因 Auditor 提出 Blocker 打回（attempt ≥ 2）：
1. **严禁直接盲改业务代码**：不建反馈环的猜改 90% 会引入连带破坏。
2. **第一步必须构造确定性红灯测试（Tight Red-Capable Loop）**：
   - 在测试文件中针对信封给出的 `repro` 编写复现断言；
   - 运行该单测，确认**必须明确失败（RED）**，且失败原因精准对应 Blocker 描述；
3. **第二步定点修改业务实现**，转为通过（GREEN）；
4. **第三步执行全量验证**，确保既有场景无任何回归。

## 边界

- base SHA：`<base-sha>`（分支拉出点，勿 rebase、勿 merge 主干）
- Write scope（精确列表，多一个文件都不行）：
  - `<path/a.mjs>`
  - `<test/a.test.mjs>`
- Verify 命令（提交前必须自己跑通，失败不得提交）：
  ```
  <verify-command>
  ```

## 提交

- 提交信息末尾必须带两个 trailer：
  ```
  Pipeline-Role: gongbu
  Pipeline-Author: <你的 agent id>
  ```

### ⚠️ trailer 必须在**最后一段**；提交后必须自验

`merge-task.mjs` 用 `git log --format=%(trailers)` 解析，而 git **只认最后一个非空段落**。
2026-10-26 六组探针实测（B/C/D/E 组）：
- **块后空行 + 再跟任何一行**（正文、`Co-Authored-By:`、`Signed-off-by:` 皆可）→
  前面的 `Pipeline-*` trailer 全部作废，合流直接 `exit 31`（author provenance）；
- **块内空行** → 只有最后一段被解析，前面的 trailer 同样丢失；
- **信息尾部空行无害**——不用删结尾换行。

**正确**（trailer 与前面正文只隔一个空行，trailer 块内不留空行，块后没有任何行）：
```
feat(x): 一句话

正文说明。

Pipeline-Role: gongbu
Pipeline-Author: <你的 agent id>
```

**错误**（空行把 `Co-Authored-By` 分开，前面 trailer 块被截断作废）：
```
Pipeline-Role: gongbu
Pipeline-Author: <你的 agent id>

Co-Authored-By: Claude Code <noreply@anthropic.com>
```

如果工具自动追加了 `Co-Authored-By`，把它放在 **trailer 块内部、不留空行**，或干脆不放。

**提交后必做自验**（解析结果与写入意图不一致时，不靠肉眼相信提交信息）：
```
git log -1 --format='%(trailers:key=Pipeline-Author,valueonly)'
```
输出必须非空且等于你的 agent id；为空说明 trailer 块作废，立即 `git commit --amend` 修正后再验。

- 提交后 `git status --porcelain` 必须为空。
- **不要**自己合流、不要勾 `tasks.md`、不要写 `Done:` 行——那些由 `merge-task.mjs` 独占。

## 信封（≤20 行，回复末尾给出）

```
kind: phase-complete | blocked
task: <task>
attempt: <n>
phase: impl | test
result: <一句话>
reviewed_sha: <你的提交 sha>
conflicting_tests: <与既有测试冲突的断言；无则 none>
blockers: <无则 none>
next_action: merge | blocked
```

- 撞上「新 spec 与既有测试不可调和」时，**最多试 3 次**，然后立刻抛
  `kind: blocked` + `reason: BLOCKED_ON_CONFLICT`，严禁用 hack 骗测试、严禁死胡同空转。
- 数据只写采集值：命令输出、耗时、退出码都要指回真实输出，采集不到写「未采集」。
