// change 名的唯一形态校验点（零依赖）。
//
// 为什么需要它：`run-state.mjs status --change foo` 这类「把旗标当位置参数」的调用
// 会**静默成功**——脚本把 `--change` 当成 change 名，在
// `.git/paseo-pipeline/--change/run-state.json` 新建一份游离账本，并照常领租约、记意图。
// 实测（2026-10-29，approval-hub）：`.git/paseo-pipeline/--change/run-state.json` 与
// `--key/run-state.json` 两份游离账本真实存在，前者还持有一份有效租约
// （owner b62b4a15… generation 1）。结果是同一个 change 的事实分裂到两个目录：
// 真正的账本里看不到那次 claim，租约校验却在一份没人读的文件上生效。
//
// 判据必须窄而硬：change 名只允许 slug 形态（与 openspec/changes 目录名一致），
// 任何以 `-` 开头的实参都是旗标误用，直接拒绝——不猜调用者意图、不自动纠正。

/** 合法 change 名：字母数字开头，后续允许字母数字与 `._-`（与目录名一致）。 */
export const CHANGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 该字符串是否是合法 change 名。 */
export function isChangeId(value) {
  return typeof value === 'string' && CHANGE_ID_RE.test(value);
}

/**
 * 校验 change 名，返回错误说明或 null。
 *
 * 单独区分「以 - 开头」这一种：它是唯一一种**静默分裂账本**的输入形态，
 * 报错文案必须点名，否则使用者只会以为参数位置写错了。
 */
export function changeIdProblem(value, label = 'change') {
  if (typeof value !== 'string' || value === '') return `${label} 为空；用法必须给出 change 名`;
  if (value.startsWith('-')) {
    return `${label} ${JSON.stringify(value)} 是旗标形态，不是 change 名；`
      + '位置参数顺序写错了（正确的是 <change> 在前、旗标在后）。按这个名字落账会把状态分裂到 '
      + `paseo-pipeline/${value}/ 这份没人读的文件里`;
  }
  if (!CHANGE_ID_RE.test(value)) {
    return `${label} ${JSON.stringify(value)} 含非法字符；须匹配 ${CHANGE_ID_RE}`;
  }
  return null;
}

