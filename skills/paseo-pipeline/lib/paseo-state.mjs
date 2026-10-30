// Paseo 运行态单一适配器（零依赖）。
//
// 背景（2026-10-25 实测，Paseo CLI 0.12.0）：
//   `paseo ls --json` 每条记录只有 8 个字段
//   {created, cwd, id, name, provider, shortId, status, thinking} —— **不含 labels**。
//   `--all`、`-o yaml` 相同；`inspect --json` 也无 Labels。
//   但 `--label k=v` 过滤确实生效（daemon 侧过滤），且 labels 真实存在于
//   `~/.paseo/agents/<cwd-slug>/<id>.json` 的 `labels` 键中，原生 MCP list_agents 也返回 labels。
//
// 因此旧实现 `reconcile.mjs:180` 的 `if (labels["pipeline.change"] !== change) continue`
// 会跳过全部 agent：ACTIVE/UNMAPPED/UNRESOLVED 恒空、cap 背压失效、fail-closed 成死代码、
// 正在运行的任务被判 READY 重复派发、runtime 仍是假绿灯 "ok"。
//
// 本模块是运行态的唯一读取点，业务逻辑禁止再自行读 a.labels：
//   主源  ~/.paseo/agents/*/*.json   —— 有 labels（唯一来源）
//   校验  paseo ls --json --all      —— 交叉校验 id 集合与 status
//   权限  paseo permit ls --json     —— 权限暂停（持久文件不含此字段）
//
// runtime 三态，非 ok 一律由调用方清空派发：
//   ok           主源可读 + 每条记录都有 labels 键 + CLI 交叉校验通过
//   degraded     能读到部分状态（缺 labels 键 / CLI 不可用 / id 集合不一致）
//   unavailable  主源与 CLI 都读不到
//
// 测试注入：PIPELINE_PASEO_HOME 覆盖 ~/.paseo；PIPELINE_PASEO_BIN 覆盖 paseo 可执行名。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** LIVE: 仍占用运行槽位的状态。其余（含 idle/closed/error）为终态，须有 disposition 才算了结。 */
export const LIVE_STATUSES = new Set(['initializing', 'running']);

/** 实测出现的全部状态：closed / idle / running（1586 条持久记录）。 */
export const KNOWN_STATUSES = new Set(['initializing', 'running', 'idle', 'closed', 'error']);

/** 持久记录中被我读取的键；缺失任一必需键即视为 schema 漂移。 */
const REQUIRED_AGENT_KEYS = ['id', 'labels', 'lastStatus'];

function homeDir() {
  return process.env.PIPELINE_PASEO_HOME || path.join(os.homedir(), '.paseo');
}

function paseoBin() {
  return process.env.PIPELINE_PASEO_BIN || 'paseo';
}

/** 持久 Agent 记录目录中的所有 JSON 文件（跳过读取失败的单文件，计入 unreadable）。 */
function readPersistentRecords(dir) {
  const records = [];
  const unreadable = [];
  const agentsDir = path.join(dir, 'agents');
  let slugs;
  try {
    slugs = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch (error) {
    return { records, unreadable, present: false, error: error.message };
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const slugDir = path.join(agentsDir, slug.name);
    let files;
    try {
      files = fs.readdirSync(slugDir);
    } catch (error) {
      unreadable.push({ file: slugDir, reason: error.message });
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(slugDir, file);
      try {
        records.push(JSON.parse(fs.readFileSync(full, 'utf8')));
      } catch (error) {
        unreadable.push({ file: full, reason: error.message });
      }
    }
  }
  return { records, unreadable, present: true, error: null };
}

/** CLI JSON 调用；失败返回 { ok:false, reason }，绝不抛。 */
function runCliJson(bin, args) {
  let raw;
  try {
    raw = execFileSync(bin, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
    return { ok: false, reason: stderr || error.message || 'CLI 调用失败' };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: 'CLI 输出不是合法 JSON' };
  }
}

/** `paseo permit ls --json` → Map<agentId, permission[]>。失败返回空 Map 并记录原因。 */
function readPendingPermissions(bin) {
  const result = runCliJson(bin, ['permit', 'ls', '--json']);
  const byAgent = new Map();
  if (!result.ok || !Array.isArray(result.value)) {
    return { byAgent, ok: false, reason: result.ok ? 'permit ls 输出不是数组' : result.reason };
  }
  for (const item of result.value) {
    const agentId = item?.agentId;
    if (typeof agentId !== 'string') continue;
    if (!byAgent.has(agentId)) byAgent.set(agentId, []);
    byAgent.get(agentId).push({ id: item.id ?? null, name: item.name ?? null });
  }
  return { byAgent, ok: true, reason: null };
}

/**
 * 读取并规范化 Paseo 运行态。
 *
 * @returns {{
 *   runtime: 'ok'|'degraded'|'unavailable',
 *   runtimeEvidence: string[],
 *   agents: Array<{id,title,status,live,labels,labelsPresent,pendingPermission,permissionRequests}>,
 *   cliIds: string[]|null,
 * }}
 *
 * agents 为**全量**记录（不按 change 过滤）；过滤属于调用方策略，适配器只保证字段可信。
 */
export function readPaseoState() {
  const evidence = [];
  const dir = homeDir();
  const bin = paseoBin();

  const persistent = readPersistentRecords(dir);
  if (!persistent.present) {
    evidence.push(`主源不可读：${path.join(dir, 'agents')}（${persistent.error}）`);
  } else {
    evidence.push(`主源持久 JSON：${persistent.records.length} 条（不可读 ${persistent.unreadable.length}）`);
  }
  if (persistent.unreadable.length > 0) {
    evidence.push(`不可读样本：${persistent.unreadable.slice(0, 3).map((u) => path.basename(u.file)).join(', ')}`);
  }

  const ls = runCliJson(bin, ['ls', '--json', '--all']);
  let cliIds = null;
  const cliStatus = new Map();
  if (!ls.ok) {
    evidence.push(`CLI 交叉校验不可用：paseo ls --json --all（${ls.reason}）`);
  } else if (!Array.isArray(ls.value)) {
    evidence.push('CLI 交叉校验失败：paseo ls --json --all 输出不是数组');
  } else {
    const rowKeys = ls.value.length > 0 ? Object.keys(ls.value[0]) : [];
    if (ls.value.length > 0 && !rowKeys.includes('id')) {
      evidence.push(`CLI 交叉校验失败：ls 行字段集合变化 ${JSON.stringify(rowKeys)}`);
    } else {
      cliIds = ls.value.map((row) => row.id).filter((id) => typeof id === 'string');
      for (const row of ls.value) cliStatus.set(row.id, row.status);
      evidence.push(`CLI 交叉校验：paseo ls --json --all ${cliIds.length} 条`);
      if (rowKeys.length > 0 && !rowKeys.includes('labels')) {
        evidence.push('CLI 行不含 labels（预期；labels 只存在于持久 JSON 与原生 MCP）');
      }
    }
  }

  const permissions = readPendingPermissions(bin);
  if (!permissions.ok) evidence.push(`权限源不可用：paseo permit ls（${permissions.reason}）`);
  else evidence.push(`权限源：paseo permit ls ${permissions.byAgent.size} 个 agent 有待批请求`);

  // CLI 是否可用于交叉校验（规范化阶段判定 archivedAt 时也要用）。
  const cliUsable = ls.ok && cliIds !== null;

  // --- 规范化 ---
  const labelsMissing = [];
  const schemaDrift = [];
  const agents = [];
  for (const record of persistent.records) {
    if (typeof record?.id !== 'string') {
      schemaDrift.push('记录缺少 id 字段');
      continue;
    }
    for (const key of REQUIRED_AGENT_KEYS) {
      if (!(key in record)) schemaDrift.push(`${record.id.slice(0, 8)} 缺少必需键 ${key}`);
    }
    const labelsPresent = record.labels !== null && typeof record.labels === 'object';
    if (!labelsPresent) labelsMissing.push(record.id);
    const cliState = cliStatus.get(record.id);
    if (typeof cliState === 'string' && typeof record.lastStatus === 'string' && cliState !== record.lastStatus) {
      evidence.push(`状态不一致 ${record.id.slice(0, 8)}: 持久=${record.lastStatus} CLI=${cliState}`);
    }
    // 已归档但 lastStatus 仍是 running：两条事实互相矛盾（archive_agent 会中断运行中的 agent）。
    // 判定按 CLI 交叉验证，方向不对称：
    //   - CLI 也不认识它 → 确实不在运行，不按 live（否则一条陈旧记录会永久占住 cap，任务卡死）；
    //   - CLI 仍报它运行 / CLI 不可用 → 按 live 保守占位（漏算真实写手会放开 cap 造成双写）。
    const archivedAt = typeof record.archivedAt === 'string' ? record.archivedAt : null;
    const cliKnows = cliUsable && cliState !== undefined;
    const staleArchive = archivedAt !== null && LIVE_STATUSES.has(record.lastStatus);
    if (staleArchive && !cliKnows) {
      evidence.push(`已归档且 CLI 不认识：${record.id.slice(0, 8)}（按非 live 处理，不占 cap）`);
    } else if (staleArchive) {
      evidence.push(`已归档但状态为 ${record.lastStatus}：${record.id.slice(0, 8)}（按 live 保守占位）`);
    }
    // 两源矛盾时按 live 保守计，且**任一源报 live 即 live**。
    // 持久文件是落盘快照，会滞后于 daemon：persistent=closed 而 CLI=running 时，
    // 只信持久文件会把一个正在写文件的 agent 算成终态写手 → cap 放行 → 同一 scope 双写。
    // 反方向（persistent=running 但 CLI 已终态）只可能在 archive 生效后出现，已被上面排除。
    const live = (LIVE_STATUSES.has(record.lastStatus) && !(staleArchive && !cliKnows))
      || LIVE_STATUSES.has(cliState);
    agents.push({
      id: record.id,
      title: typeof record.title === 'string' ? record.title : null,
      status: typeof record.lastStatus === 'string' ? record.lastStatus : null,
      live,
      labels: labelsPresent ? record.labels : {},
      labelsPresent,
      pendingPermission: permissions.byAgent.has(record.id),
      permissionRequests: permissions.byAgent.get(record.id) ?? [],
      requiresAttention: record.requiresAttention === true,
      attentionReason: record.attentionReason ?? null,
      archivedAt,
    });
  }

  // --- runtime 判定 ---
  // 两源一致性：CLI 返回了主源里没有的 id（主源滞后），或主源有记录而 CLI 一条都没有
  // （daemon 不认识这些 agent，CLI 输出不可用于交叉校验）—— 都说明两源讲的是不同的事实。
  const idMismatch = (() => {
    if (cliIds === null) return false;
    const persistentIds = new Set(agents.map((a) => a.id));
    if (cliIds.some((id) => !persistentIds.has(id))) return true;
    return agents.length > 0 && cliIds.length === 0;
  })();

  // 判定原则：主源非空时它是唯一可信的 labels 来源，CLI 只做交叉校验；
  // 主源为空时不构成「确实没有 agent」的正向证据（可能是目录尚未建立、被清理或读取不全），
  // 必须有 CLI 一致为空来确认；两者都读不到 → unavailable（fail closed）。
  let runtime;
  // 权限源不可用 = 无法区分「在干活」和「等人批权限」。有 agent 时这是实质降级：
  // 否则 pendingPermission 恒为 false，一个卡在权限上的 agent 会被当成正常推进，
  // 人永远不知道该去批。没有 agent 时无事可隐藏，不因此降级（否则干净环境永远不放行）。
  const permissionsUsable = permissions.ok || agents.length === 0;
  if (persistent.present && agents.length > 0) {
    const clean = labelsMissing.length === 0 && schemaDrift.length === 0 && cliUsable
      && !idMismatch && permissionsUsable;
    runtime = clean ? 'ok' : 'degraded';
  } else if (persistent.present && cliUsable && !idMismatch) {
    // 两源一致为空：没有 agent 是真实状态，没有 labels 需要判定，不算降级。
    runtime = 'ok';
    evidence.push('主源与 CLI 均为空集合：当前无 agent');
  } else if (cliIds !== null) {
    runtime = 'degraded';
    evidence.push('仅 CLI 可用：labels 不可得，任何按 change/role 的映射都会退化为标题推断');
  } else {
    runtime = 'unavailable';
    if (persistent.present) {
      evidence.push('主源为空且 CLI 不可用：无法确认是否确实为空，fail closed');
    }
  }

  if (labelsMissing.length > 0) {
    evidence.push(`缺 labels 键的记录 ${labelsMissing.length} 条：${labelsMissing.slice(0, 3).map((i) => i.slice(0, 8)).join(', ')}`);
  }
  if (!permissions.ok && agents.length > 0) {
    evidence.push('权限源不可用且有 agent 在场：无法识别权限暂停，按降级处理（清空派发）');
  }
  if (schemaDrift.length > 0) {
    evidence.push(`持久记录 schema 漂移 ${schemaDrift.length} 处：${schemaDrift.slice(0, 3).join('; ')}`);
  }
  if (idMismatch) {
    evidence.push('CLI 返回了主源中不存在的 agent id（持久文件滞后或主源不完整）');
  }
  evidence.push(`runtime=${runtime}`);

  return { runtime, runtimeEvidence: evidence, agents, cliIds };
}

/**
 * 从规范化记录中按 change 过滤。
 *
 * 归属判定双通道（实测：`paseo ls --label pipeline.change=X` 返回的 12 条里，
 * 只有 6 条同时带 `pipeline.change` 标签与 `[Pipeline]` 标题，另 6 条只有标题）：
 *   1. 标签通道 `labels['pipeline.change']` —— **可信**，可继续读 role/task/attempt/phase；
 *   2. 标题通道 `[Pipeline] <role> <task> <change>` —— 只能证明「属于本 change」，
 *      role/task 不可信（真实标题还会被截断到 60 字符：`governance-seam-and-isolated-servic`）。
 * 两通道都不命中 → 未归属。
 */
const PIPELINE_TITLE = /^\[Pipeline\]\s+(.*)$/;

/**
 * change 名与标题尾 token 的模糊匹配：兼容 60 字符截断（单向前缀）。
 *
 * 只保留 `change.startsWith(token)` 一个方向：标题被 60 字符截断时，尾 token 是
 * change 的**前缀**（`governance-seam-and-isolated-servic`）。反向
 * `token.startsWith(change)` 会把 change `foo` 与 `foo-bar` 互绑——`foo-bar` 是
 * 另一个 change 的完整 slug，把它归属到 `foo` 会让两个 change 互相占 cap、互相冻结
 * （2026-10-26 走查实测推演）。token 比 change 长时不成立归属，交由 namesAnotherChange
 * 判定是否为外部 change。
 */
function slugMatches(token, change) {
  if (typeof token !== 'string' || token === '') return false;
  return token === change || change.startsWith(token);
}

export function attributeAgent(agent) {
  const labels = agent.labels ?? {};
  const labelChange = labels['pipeline.change'];
  if (typeof labelChange === 'string' && labelChange !== '') {
    return {
      change: labelChange,
      source: 'label',
      trusted: true,
      role: typeof labels['pipeline.role'] === 'string' ? labels['pipeline.role'] : null,
      task: typeof labels['pipeline.task'] === 'string' ? labels['pipeline.task'] : null,
      attempt: labels['pipeline.attempt'] ?? null,
      phase: labels['pipeline.phase'] ?? null,
      disposition: typeof labels['pipeline.disposition'] === 'string' ? labels['pipeline.disposition'] : null,
    };
  }
  const titleMatch = typeof agent.title === 'string' ? agent.title.match(PIPELINE_TITLE) : null;
  if (!titleMatch) {
    return { change: null, source: null, trusted: false, role: null, task: null, attempt: null, phase: null, disposition: null };
  }
  const rest = titleMatch[1].trim().split(/\s+/).filter(Boolean);
  if (rest.length === 0) {
    return { change: null, source: null, trusted: false, role: null, task: null, attempt: null, phase: null, disposition: null };
  }
  const tail = rest[rest.length - 1];
  return {
    change: tail,
    source: 'title',
    trusted: false,
    role: rest[0] ?? null,
    task: rest.length >= 3 ? rest[1] : null,
    attempt: null,
    phase: null,
    disposition: null,
  };
}

/** 归属判定是否需要模糊匹配：调用方传 change 后按 slug 规则比对。 */
export function belongsToChange(agent, change) {
  const attribution = attributeAgent(agent);
  if (attribution.change === null) return { belongs: false, attribution };
  if (attribution.source === 'label') return { belongs: attribution.change === change, attribution };
  return { belongs: slugMatches(attribution.change, change), attribution };
}

/** 是否带流水线标记：任一 `pipeline.*` 标签，或标题以 `[Pipeline]` 开头。 */
export function hasPipelineMarker(agent) {
  const labels = agent.labels ?? {};
  if (Object.keys(labels).some((key) => key.startsWith('pipeline.'))) return true;
  return typeof agent.title === 'string' && agent.title.startsWith('[Pipeline]');
}

/**
 * 按 change 取出规范化成员。
 *
 * `suspicious` 只收「带流水线标记、活体、且**归属完全无法判定**」的 agent：
 * 它们可能正在写本 change 的文件，但身份不可信，必须 fail closed。
 * 两类不参与判定：
 *   1. 归属明确指向**另一个** change 的活体 agent —— 那是 FOREIGN（跨 change 资源共享风险），
 *      只报告并按需声明共享资源，不能无依据冻结本 change（否则任何并行 change 都会互锁）；
 *   2. 完全无关的人类会话（无 pipeline.* 标签、标题也不是 [Pipeline]）—— 否则一次旁路会话就永久冻死派发。
 */
export function selectChange(state, change) {
  const members = [];
  const suspicious = [];
  for (const agent of state.agents) {
    const { belongs, attribution } = belongsToChange(agent, change);
    if (belongs) {
      members.push({ ...agent, attribution });
    } else if (agent.live && hasPipelineMarker(agent) && !namesAnotherChange(attribution, agent, change)) {
      suspicious.push({ ...agent, attribution });
    }
  }
  return { members, suspicious };
}

/** slug 形态判定（namesAnotherChange 两个路径共用）。 */
function isSlugToken(token) {
  if (typeof token !== 'string' || token === '') return false;
  if (/^T-\d+$/.test(token)) return false;
  if (token.startsWith('[')) return false;
  return /^[a-z0-9][a-z0-9._-]*$/.test(token) && token.length >= 6;
}

/**
 * 标题通道解析出的「另一个 change」是否可信到可以排除嫌疑。
 *
 * 两条路径（满足其一即可排除）：
 *   1. 尾 token 路径（标题契约 `[Pipeline] <role> <task> <change>` 把 change 放在末尾）：
 *      尾 token 形如 change slug 即采信；`T-02`、`Runner`、空串等说明标题格式不规范，
 *      归属不可判定 → 仍需 fail closed。
 *   2. 任一 token 路径：真实标题并不都遵守契约——中文角色词（总控/产品/巡检）与
 *      自由格式动作（`[Pipeline] 巡检 复核 <change> 进行中`）会把 change 挤到中段、
 *      尾部留下中文，尾 token 必然失配，于是别 change 的正常 agent 也冻死本 change 的
 *      派发。此时任一 slug 形态的中段 token 即可证明它属于**另一个** change。
 *      中段 token 缺少位置锚点，证据必须更强：要求含 `-`、`.` 或数字
 *      （排除 `dispatch`/`hotfix`/`review` 这类标题动词），且不得与本 change 有前缀关系
 *      （可能是本 change 被 60 字符截断后的 slug——那种情况归属不可判定，不得用来排除）。
 */
function namesAnotherChange(attribution, agent, currentChange) {
  const tail = attribution.change;
  if (isSlugToken(tail)) return true;
  const title = typeof agent?.title === 'string' ? agent.title : '';
  for (const token of title.split(/\s+/)) {
    if (!isSlugToken(token)) continue;
    if (!/[-.\d]/.test(token)) continue;
    if (slugMatches(token, currentChange)) continue;
    return true;
  }
  return false;
}

/**
 * 按 agent id 读取真实创建记录（证据交叉核对用）。
 *
 * 为什么需要：`check-evidence` 过去只校验 `child_agent_id` 是一个格式合法的 UUID，
 * 于是 native-closure 的 smoke 写了一个**不存在的** UUID（与真实 agent 前 8 位相同、
 * 其余不同），`dispatched_at` 还早于真实 createdAt 十分钟，两份闸门都放行。
 * 「收据里有一个 UUID」与「这个 UUID 真的被创建过」是两件事。
 *
 * 返回 null 表示读不到（Paseo 目录不存在、无该 id 的文件、JSON 损坏）——调用方必须
 * 把 null 当失败处理（fail closed），不能当成「没有反证所以通过」。
 */
export function findAgentRecord(agentId) {
  if (typeof agentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(agentId.trim())) return null;
  const wanted = agentId.trim().toLowerCase();
  const root = path.join(homeDir(), 'agents');
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, `${wanted}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      // provider/model 供异构审查判据使用：实测分布里 gongbu=claude、gaogong=codex、
      // anchasi=codex、hanlin=claude——「换了别名」不等于「换了模型家族」，
      // 只有拿真实记录里的 provider 才能判断审查者与写手是否同源。
      const runtimeInfo = record.runtimeInfo && typeof record.runtimeInfo === 'object' ? record.runtimeInfo : {};
      const config = record.config && typeof record.config === 'object' ? record.config : {};
      return {
        id: record.id ?? wanted,
        createdAt: record.createdAt ?? null,
        archivedAt: record.archivedAt ?? null,
        title: record.title ?? null,
        labels: record.labels ?? {},
        provider: typeof record.provider === 'string' ? record.provider
          : (typeof runtimeInfo.provider === 'string' ? runtimeInfo.provider : null),
        model: typeof runtimeInfo.model === 'string' ? runtimeInfo.model
          : (typeof config.model === 'string' ? config.model : null),
        file,
      };
    } catch {
      return null;
    }
  }
  return null;
}
