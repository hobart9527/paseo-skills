import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const skillPath = path.resolve('skills/paseo-pipeline/SKILL.md');
const lessonsPath = path.resolve('skills/paseo-pipeline/LESSONS.md');

const skillText = fs.readFileSync(skillPath, 'utf8');
const lessonsText = fs.readFileSync(lessonsPath, 'utf8');

test('SCEN-DISP-01: dispatch instructions use live profile values and require notifyOnFinish without hardcoded models', () => {
  assert.match(skillText, /list_profiles/);
  assert.match(skillText, /featureValues\s*(?:→|->)\s*settings\.features/);
  assert.match(skillText, /notifyOnFinish/);

  // Extract dispatch section
  const dispatchSection = skillText.match(/## 角色与派发[\s\S]*?(?=##|$)/)?.[0] ?? '';
  assert.ok(dispatchSection.length > 0, 'dispatch section should exist');
  assert.doesNotMatch(dispatchSection, /claude-3|claude-opus|gpt-4|gpt-5|glm-4|qwen-2/i, 'no hardcoded model names in dispatch section');
});

test('SCEN-EVT-01: limitation documented: no spontaneous wakeup, lazy reconcile, no default watchdog/heartbeat', () => {
  assert.match(skillText, /无法唤醒|无法自唤醒|no-spontaneous-wakeup/i);
  assert.match(skillText, /惰性对账|lazy reconcile/i);
  assert.doesNotMatch(skillText, /默认(?:运行|启用|创建)?(?:10\s*分钟|十分钟)?(?:看门狗|watchdog|heartbeat)/i);
});

test('SCEN-EVT-02: removed claims absent: <100ms guarantee, 0次 compaction criterion, mandatory rebase, reset --hard fallback, implicit mechanical', () => {
  for (const [name, text] of [['SKILL.md', skillText], ['LESSONS.md', lessonsText]]) {
    assert.doesNotMatch(text, /<100ms|100ms/, `${name} should not claim <100ms or 100ms guarantee`);
    assert.doesNotMatch(text, /0\s*次.*压缩|压缩.*0\s*次/, `${name} should not claim 0-compaction pass criterion`);
    assert.doesNotMatch(text, /(?<!(?:不|无|禁止|非)(?:要求)?)(?:必须|强制)\s*rebase/i, `${name} should not mandate rebase`);
    assert.doesNotMatch(text, /reset\s+--hard/, `${name} should not contain reset --hard fallback`);
    assert.doesNotMatch(text, /默认\s*mechanical|隐式\s*mechanical/i, `${name} should not have implicit mechanical approval`);
  }
});

test('SCEN-DOC-01: discipline sections present in SKILL.md', () => {
  // envelope format with kind: turn-idle | phase-complete | blocked
  assert.match(skillText, /turn-idle/);
  assert.match(skillText, /phase-complete/);
  assert.match(skillText, /blocked/);

  // task/attempt/phase mapping
  assert.match(skillText, /pipeline\.(?:task|attempt|phase)/);

  // dedupe key
  assert.match(skillText, /agent_id/);
  assert.match(skillText, /message-id|event-id/);
  assert.match(skillText, /revision/);

  // stale / duplicate handling
  assert.match(skillText, /去重|重复/);
  assert.match(skillText, /过期|stale/i);

  // permission pause handling
  assert.match(skillText, /权限暂停|UNRESOLVED/);

  // retry budget
  assert.match(skillText, /重试预算|≤2\s*次打回/);

  // OpenSpec CLI main-session exclusivity
  assert.match(skillText, /openspec\s*CLI\s*(?:由)?主会话独占|主会话独占.*openspec/i);

  // workspace retention
  assert.match(skillText, /保留工作区|workspace\s*保留|不自动归档/i);

  // grandchild -> Lead -> parent relay rule via explicit send_agent_prompt
  assert.match(skillText, /send_agent_prompt/);
  assert.match(skillText, /孙|grandchild/i);
});

test('SCEN-DOC-02: permission self-approval forbidden in SKILL.md', () => {
  assert.match(skillText, /严禁.*respond_to_permission|禁止.*respond_to_permission|不得.*respond_to_permission/);
  assert.match(skillText, /人类|人工/);
});
