#!/usr/bin/env bash
# 一次性、幂等的环境安装：让 Paseo daemon 启动的 agent 也能读到 PIPELINE_HOME，并装好两个 hook。
#
# 为什么需要它（2026-10-31 实测）：Paseo 派发的 agent 不继承交互终端的变量——`~/.zshrc` 只对
# 交互 shell 生效，daemon 起的 agent 里 `PIPELINE_HOME` 是 unset，SKILL.md 里所有
# `"$PIPELINE_HOME"/<脚本>` 命令全部失败。把绝对路径写进提交到 GitHub 的 SKILL.md 换机器就失效，
# 所以改成本脚本一次配好：路径由脚本自身位置推导，不写死、不接受手填。
#
# 只改两个文件，且都可重入：
#   - ~/.zshenv：只维护一个带标记的块（块外内容原样保留），块内导出 PIPELINE_HOME。
#     zshenv 对非交互 shell 也生效，这正是 daemon 起的 agent 需要的。
#   - ~/.claude/settings.json：只增不删地合并两个 hook，不碰 env 等其他键。该文件含凭据，
#     脚本从不打印它的内容（JSON 解析错误信息可能带原文片段，所以也只报事实）。
#
# 用法: bash install.sh [--dry-run | --check]
#   --dry-run  不写任何文件，只打印将发生的变化（zshenv 块与将新增的 hook），不跑自检
#   --check    不写，只判断是否已是目标状态：已满足 exit 0，否则 exit 1，不跑自检
# 退出码: 0 成功 · 2 用法错误 · 3 settings.json 无法解析 · 1 其余失败
set -euo pipefail

# 先记下调用者 shell 里原有的值（可能为空、可能指向老路径），结尾提示用；下面立刻要覆盖它。
ORIGINAL_PIPELINE_HOME="${PIPELINE_HOME:-}"

# 软链要解析到真实目录：BASH_SOURCE 可能是别人 `ln -s` 出来的入口。
# 先顺着符号链接把文件本身解开，再对目录做 `pwd -P`（解掉目录层级里的软链）。
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  SOURCE_DIR="$(cd "$(dirname "$SOURCE")" && pwd -P)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in
    /*) ;;
    *) SOURCE="$SOURCE_DIR/$SOURCE" ;;
  esac
done
PIPELINE_HOME="$(cd "$(dirname "$SOURCE")" && pwd -P)"

usage() {
  cat <<'EOF'
用法: bash install.sh [--dry-run | --check]

  默认直接写入（内容无变化时不写、不备份）。
  --dry-run  不写任何文件，只打印将发生的变化
  --check    只判断是否已是目标状态：已满足 exit 0，否则 exit 1
退出码: 0 成功 · 2 用法错误 · 3 settings.json 无法解析 · 1 其余失败
EOF
}

MODE=apply
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      if [ "$MODE" != apply ]; then echo "[install] --dry-run 与 --check 只能二选一" >&2; exit 2; fi
      MODE=dry-run ;;
    --check)
      if [ "$MODE" != apply ]; then echo "[install] --dry-run 与 --check 只能二选一" >&2; exit 2; fi
      MODE=check ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[install] 未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ -z "${HOME:-}" ]; then
  echo "[install] HOME 未设置，无法定位 ~/.zshenv 与 ~/.claude/settings.json" >&2
  exit 1
fi
ZSHENV="${HOME}/.zshenv"
SETTINGS="${HOME}/.claude/settings.json"

if [ "$MODE" = apply ]; then
  echo "[install] PIPELINE_HOME=$PIPELINE_HOME"
  # 变量名后紧跟全角括号时必须用 ${} 包起来：bash 会把多字节字符当成变量名的一部分。
  echo "[install] 将修改：${ZSHENV} 与 ${SETTINGS}（内容无变化时不写、不备份）"
else
  echo "[install] PIPELINE_HOME=$PIPELINE_HOME"
  echo "[install] 只读模式（${MODE}）：检查 ${ZSHENV} 与 ${SETTINGS}"
fi

# 块与 JSON 的合并逻辑放进 node：settings.json 必须用真正的 JSON 解析器处理，
# 且任何情况下都只输出「加了什么」，不回显文件内容。
node --input-type=module - "$MODE" "$ZSHENV" "$SETTINGS" "$PIPELINE_HOME" "$(date +%Y%m%d-%H%M%S)" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [mode, zshenvPath, settingsPath, skillDir, stamp] = process.argv.slice(2);
const check = mode === 'check';
const dry = mode === 'dry-run';

const START = '# >>> paseo-pipeline >>>';
const END = '# <<< paseo-pipeline <<<';
const block = [START, `export PIPELINE_HOME=${JSON.stringify(skillDir)}`, END, ''].join('\n');

const HOOKS = [
  { event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit|NotebookEdit', script: 'scope-guard-hook.mjs' },
  { event: 'UserPromptSubmit', script: 'tier-reminder-hook.mjs' },
];

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// 只替换带标记的块；块外内容（含末尾是否有换行）原样保留。重复运行得到同样的字节。
function withBlock(existing) {
  if (existing === null) return block;
  const start = existing.indexOf(START);
  if (start < 0 || (start > 0 && existing[start - 1] !== '\n')) {
    if (existing === '') return block;
    const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return `${existing}${separator}${block}`;
  }
  const endAt = existing.indexOf(END, start);
  let end = endAt < 0 ? existing.length : endAt + END.length;
  if (existing[end] === '\n') end += 1;
  return `${existing.slice(0, start)}${block}${existing.slice(end)}`;
}

const currentZshenv = read(zshenvPath);
const nextZshenv = withBlock(currentZshenv);
const zshenvChanged = currentZshenv !== nextZshenv;

const currentSettings = read(settingsPath);
let settings = {};
if (currentSettings !== null) {
  try {
    settings = JSON.parse(currentSettings);
  } catch {
    // 不打印 error.message：新版 V8 的解析错误会带原文片段，而这里可能含 env 里的凭据。
    console.error(`[install] ${settingsPath} 不是合法 JSON，拒绝写入（exit 3）`);
    process.exit(3);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    console.error(`[install] ${settingsPath} 顶层不是 JSON 对象，拒绝写入（exit 3）`);
    process.exit(3);
  }
}
const before = JSON.stringify(settings);

if (settings.hooks === undefined) settings.hooks = {};
if (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
  console.error(`[install] ${settingsPath} 的 hooks 不是对象，拒绝改写（exit 3）`);
  process.exit(3);
}

const added = [];
const hints = [];
for (const spec of HOOKS) {
  const command = `node ${JSON.stringify(path.join(skillDir, 'hooks', spec.script))}`;
  const list = settings.hooks[spec.event];
  if (list !== undefined && !Array.isArray(list)) {
    console.error(`[install] ${settingsPath} 的 hooks.${spec.event} 不是数组，拒绝改写（exit 3）`);
    process.exit(3);
  }
  const group = list ?? [];
  if (list === undefined) settings.hooks[spec.event] = group;
  const existing = [];
  for (const entry of group) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (hook && typeof hook.command === 'string') existing.push(hook.command);
    }
  }
  // 等价性按 command 判：同一脚本换个路径注册过，就不再追加，只提示（不自动删）。
  if (existing.includes(command)) continue;
  for (const stale of existing) {
    if (stale.includes(spec.script)) {
      hints.push(`${spec.event} 已注册指向旧路径的 ${spec.script}，未删除，请手工确认：${stale}`);
    }
  }
  group.push(spec.matcher
    ? { matcher: spec.matcher, hooks: [{ type: 'command', command }] }
    : { hooks: [{ type: 'command', command }] });
  added.push({ event: spec.event, matcher: spec.matcher, command });
}
const settingsChanged = before !== JSON.stringify(settings);

if (check) {
  console.log(`[install] ${zshenvPath}: ${zshenvChanged ? '缺少或需要更新 PIPELINE_HOME 块' : '已是目标状态'}`);
  console.log(`[install] ${settingsPath}: ${settingsChanged ? `缺少 ${added.length} 个 hook 条目` : '已是目标状态'}`);
  for (const hint of hints) console.log(`[install] 提示：${hint}`);
  const ok = !zshenvChanged && !settingsChanged;
  console.log(ok ? '[install] 已是目标状态（exit 0）' : '[install] 尚未达到目标状态（exit 1）');
  process.exit(ok ? 0 : 1);
}

if (zshenvChanged) {
  console.log(`[install] ${zshenvPath} ${dry ? '将写入' : '写入'}以下块：`);
  for (const line of block.trimEnd().split('\n')) console.log(`  + ${line}`);
} else {
  console.log(`[install] ${zshenvPath} 已是目标状态，跳过`);
}

if (added.length === 0) {
  console.log(`[install] ${settingsPath} 两个 hook 已就位，跳过`);
} else {
  console.log(`[install] ${settingsPath} ${dry ? '将新增' : '新增'} ${added.length} 个 hook：`);
  for (const hook of added) {
    const matcher = hook.matcher ? `matcher=${hook.matcher} ` : '';
    console.log(`  + hooks.${hook.event} ${matcher}command=${hook.command}`);
  }
}
for (const hint of hints) console.log(`[install] 提示：${hint}`);

if (dry) {
  console.log('[install] --dry-run：未写入任何文件');
  process.exit(0);
}

function writeWithBackup(file, content, changed) {
  if (!changed) return;
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, backup);
    console.log(`[install] 备份 ${backup}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
writeWithBackup(zshenvPath, nextZshenv, zshenvChanged);
writeWithBackup(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, settingsChanged);
NODE

# --dry-run / --check 不写文件，也不做安装后的自检（--check 的退出码只表达目标状态）。
case "$MODE" in
  apply) ;;
  *) exit 0 ;;
esac

# 用刚装好的结果自检并透传退出码。显式传入本次解出的 PIPELINE_HOME：脚本内的赋值不会留在
# 调用者的 shell 里，但 doctor 的「PIPELINE_HOME 指向本目录」一项判的就是这次安装。
doctor_status=0
PIPELINE_HOME="$PIPELINE_HOME" node "$PIPELINE_HOME/pipeline-doctor.mjs" --home "$HOME" || doctor_status=$?

if [ -z "$ORIGINAL_PIPELINE_HOME" ]; then
  echo "[install] 当前 shell 没有 PIPELINE_HOME：请新开终端，并重启 Paseo daemon（已运行的 agent 不会继承）。"
elif [ "$ORIGINAL_PIPELINE_HOME" != "$PIPELINE_HOME" ]; then
  echo "[install] 当前 shell 的 PIPELINE_HOME=$ORIGINAL_PIPELINE_HOME 与安装目录 $PIPELINE_HOME 不同：新开终端后生效。"
fi
exit "$doctor_status"
