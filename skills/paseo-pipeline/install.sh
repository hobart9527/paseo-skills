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
#     标记块必须成对且唯一：只有开头（会吞掉后面所有内容）、只有结尾、结尾在开头前、
#     出现多个块，一律视为损坏并拒绝写入（exit 4），绝不猜着合并。
#   - ~/.claude/settings.json：只增不删地合并两个 hook，不碰 env 等其他键。该文件含凭据，
#     脚本从不打印它的内容（JSON 解析错误信息可能带原文片段，所以也只报事实）。
#   两个文件都先备份再原子替换（同目录临时文件 + rename）；指向软链时写真实目标、保留链接。
#
# 用法: bash install.sh [--dry-run | --check]
#   --dry-run  不写任何文件，只打印将发生的变化（zshenv 块与将新增的 hook），不跑自检
#   --check    不写，只判断是否已是目标状态：已满足 exit 0，否则 exit 1，不跑自检
# 退出码: 0 成功 · 2 用法错误 · 3 settings.json 无法解析 · 4 zshenv 标记块损坏 · 1 其余失败
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
退出码: 0 成功 · 2 用法错误 · 3 settings.json 无法解析 · 4 zshenv 标记块损坏 · 1 其余失败
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
node --input-type=module - "$MODE" "$ZSHENV" "$SETTINGS" "$PIPELINE_HOME" "$(date +%Y%m%d-%H%M%S)-$$" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [mode, zshenvPath, settingsPath, skillDir, stamp] = process.argv.slice(2);
const check = mode === 'check';
const dry = mode === 'dry-run';

const START = '# >>> paseo-pipeline >>>';
const END = '# <<< paseo-pipeline <<<';
const block = [START, `export PIPELINE_HOME=${JSON.stringify(skillDir)}`, END, ''].join('\n');

// 与两个 hook 的 `--install-help` 输出必须保持等价（matcher 与 command 的形状）：
// 改这里的元数据时同步改 hooks/scope-guard-hook.mjs、hooks/tier-reminder-hook.mjs。
const HOOKS = [
  { event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit|NotebookEdit', script: 'scope-guard-hook.mjs' },
  { event: 'UserPromptSubmit', script: 'tier-reminder-hook.mjs' },
];

function resolveTarget(file) {
  // 软链写真实目标：覆盖链接本身会把链接换成普通文件，用户后续更新 skill 就失效了。
  try { return fs.realpathSync(file); } catch { /* 不存在或悬空软链，往下走 */ }
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      // 悬空软链也照样写它指向的位置；只解析父目录，链接本身保持不动。
      const linkTarget = path.resolve(path.dirname(file), fs.readlinkSync(file));
      try { return path.join(fs.realpathSync(path.dirname(linkTarget)), path.basename(linkTarget)); } catch { return linkTarget; }
    }
  } catch { /* 文件不存在 */ }
  return file;
}

function read(file) {
  const target = resolveTarget(file);
  try {
    return { text: fs.readFileSync(target, 'utf8'), target };
  } catch (error) {
    if (error.code === 'ENOENT') return { text: null, target };
    throw error;
  }
}

// 标记块必须成对且唯一。这里返回错误字符串而不是就地修复：缺结尾时向后扫到文件末尾会把
// 用户后续导出全吞掉（实测过），出现两块时猜哪块对也会写坏另一份配置。宁可拒绝。
function markerProblem(text) {
  const starts = [...text.matchAll(new RegExp(`^${START}$`, 'gm'))].map((m) => m.index);
  const ends = [...text.matchAll(new RegExp(`^${END}$`, 'gm'))].map((m) => m.index);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length > 1 || ends.length > 1) {
    return `有 ${starts.length} 个开头标记、${ends.length} 个结尾标记（只允许一个块）`;
  }
  if (starts.length === 0) return '只有结尾标记，没有开头标记';
  if (ends.length === 0) return '只有开头标记，没有结尾标记';
  if (ends[0] < starts[0]) return '结尾标记出现在开头标记之前';
  return null;
}

// 只替换带标记的块；块外内容（含末尾是否有换行）原样保留。重复运行得到同样的字节。
function withBlock(existing) {
  if (existing === null) return block;
  const start = existing.indexOf(START);
  if (start < 0) {
    if (existing === '') return block;
    const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return `${existing}${separator}${block}`;
  }
  const end = existing.indexOf(END, start) + END.length;
  const rest = existing[end] === '\n' ? end + 1 : end;
  return `${existing.slice(0, start)}${block}${existing.slice(rest)}`;
}

const currentZshenv = read(zshenvPath);
const problem = currentZshenv.text === null ? null : markerProblem(currentZshenv.text);
if (problem) {
  console.error(`[install] ${zshenvPath} 里 paseo-pipeline 标记块损坏：${problem}。`);
  console.error('[install] 拒绝写入（exit 4）：请手工把它整理成一个完整的块（或全部删掉）后重跑。');
  process.exit(4);
}
const nextZshenv = withBlock(currentZshenv.text);
const zshenvChanged = currentZshenv.text !== nextZshenv;

const currentSettings = read(settingsPath);
let settings = {};
if (currentSettings.text !== null) {
  try {
    settings = JSON.parse(currentSettings.text);
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
  // 等价判定比 command 与 matcher 两项：同一 command 挂在 matcher=Bash 上是「装了但没守护
  // Write/Edit」，只比 command 会静默放过（实测 check exit 0 而写入无人拦）。
  let installed = false;
  for (const entry of group) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook.command !== 'string') continue;
      if (hook.command === command && (entry.matcher ?? null) === (spec.matcher ?? null)) installed = true;
      else if (hook.command === command) {
        hints.push(`${spec.event} 已有同 command 但 matcher=${entry.matcher ?? '(无)'} 的同名 hook，未删除，请手工确认：${command}`);
      } else if (hook.command.includes(spec.script)) {
        hints.push(`${spec.event} 已注册指向旧路径的 ${spec.script}，未删除，请手工确认：${hook.command}`);
      }
    }
  }
  if (installed) continue;
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

// 原子替换：先写同目录临时文件、设好 mode 再 rename。直接 writeFileSync 覆盖时进程被杀会留下
// 截断的 settings.json——里面是凭据，截断等于把用户的登录配置弄坏。mode 由调用方按
// 「已有文件保持原样 / 新建 settings.json 用 0600（它随后就装 token）/ 新建 .zshenv 用 0644」决定。
function writeAtomic(target, content, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${stamp}`);
  fs.writeFileSync(temp, content);
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, target);
}

function writeWithBackup(file, content, target) {
  const exists = fs.existsSync(target);
  if (exists) {
    const backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(target, backup);
    // 备份跟原文件同权限：settings.json 的备份若放宽到 0644，等于把凭据多复制一份可读。
    fs.chmodSync(backup, fs.statSync(target).mode & 0o777);
    console.log(`[install] 备份 ${backup}`);
  }
  // 新建 settings.json 用 0600（它随后就会装 token）；新建 .zshenv 不含凭据，0644 即可。
  const mode = exists ? fs.statSync(target).mode & 0o777 : (file === settingsPath ? 0o600 : 0o644);
  writeAtomic(target, content, mode);
}

if (zshenvChanged) writeWithBackup(zshenvPath, nextZshenv, currentZshenv.target);
if (settingsChanged) writeWithBackup(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, currentSettings.target);
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
