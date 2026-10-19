// v0.10.9 回归测试：最后一轮不得在仍在生成时判定完成
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const root = __dirname;
const content = fs.readFileSync(path.join(root, 'install/content.js'), 'utf8');
const sidepanel = fs.readFileSync(path.join(root, 'install/sidepanel.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'install/manifest.json'), 'utf8'));

assert.ok(manifest.version.localeCompare('0.10.9') >= 0, `版本应不低于 0.10.9，实际 ${manifest.version}`);

// 1) DeepSeek 的极短状态文本必须被视为「生成中」
assert.ok(content.includes('const exactStatus ='), '缺少极短状态文本判据');
assert.ok(content.includes('思考中|正在思考|正在生成|生成中|停止生成'), '极短状态词表缺失');
assert.ok(content.includes('极短状态文本命中'), '生成状态证据必须记录极短文本命中');

// 2) 静默门槛
assert.ok(content.includes('const baseIdleMs = generationWasObserved ? 3000 : 15000;'), '未观测到生成时的静默门槛必须 ≥15s');
assert.ok(content.includes('const requiredIdleMs = Math.max(baseIdleMs, finalTurn ? 20000 : 0);'), '最后一轮必须抬到 20s 静默');

// 3) finalTurn 贯通
assert.ok(content.includes('async function sendAndWait(prompt, timeoutMs = 45000, externalSendResult = null, requireFreshPrompt = false, finalTurn = false)'), 'sendAndWait 必须接收 finalTurn');
assert.ok(content.includes('!!message.requireFreshPrompt, !!message.finalTurn'), '消息入口必须透传 finalTurn');
assert.ok(sidepanel.includes('finalTurn: turn === maxTurns'), '侧栏必须标记最后一轮');

// 4) 完成诊断要能解释判据
assert.ok(content.includes('generatorEvidence: lastGeneratingEvidence'), '完成结果必须记录生成状态证据');
assert.ok(content.includes('requiredIdleMs,'), '完成结果必须记录所需静默时长');

// 5) 行为断言：canAcceptAnswerCompletion 的边界
const start = content.indexOf('  function canAcceptAnswerCompletion(state) {');
const end = content.indexOf('  async function sendAndWait(', start);
assert.ok(start > 0 && end > start, '无法抽取 canAcceptAnswerCompletion');
const source = content.slice(start, end).replace(/^ {2}/gm, '');
const ctx = {};
vm.runInNewContext(`${source}\nthis.canAcceptAnswerCompletion = canAcceptAnswerCompletion;`, ctx);

const base = {
  answer: '这是一段足够长的回答正文，用于测试完成判定。',
  answerLength: 24,
  echoedPrompt: false,
  sameAsBefore: false,
  generating: false,
  continuationPending: false,
  stableFor: 2000,
  idleFor: 2000,
  requiredIdleMs: 15000,
  requireFreshPrompt: true,
  freshPromptConfirmed: true
};
assert.strictEqual(ctx.canAcceptAnswerCompletion({ ...base }), false, '静默不足 15s 时不得判定完成');
assert.strictEqual(ctx.canAcceptAnswerCompletion({ ...base, idleFor: 15000 }), true, '静默达到门槛后应允许完成');
assert.strictEqual(ctx.canAcceptAnswerCompletion({ ...base, idleFor: 15000, generating: true }), false, '仍在生成时不得完成');
assert.strictEqual(ctx.canAcceptAnswerCompletion({ ...base, idleFor: 20000, requiredIdleMs: 20000 }), true, '最后一轮 20s 门槛应可满足');
assert.strictEqual(ctx.canAcceptAnswerCompletion({ ...base, idleFor: 19999, requiredIdleMs: 20000 }), false, '未达 20s 时最后一轮不得完成');
assert.strictEqual(ctx.canAcceptAnswerCompletion({ ...base, idleFor: 15000, continueControlNow: null, continuationPending: true }), false, '存在续生成控件时不得完成');
assert.strictEqual(ctx.canAcceptAnswerCompletion({ ...base, idleFor: 15000, answerLength: 3 }), false, '过短候选不得完成');
assert.strictEqual(ctx.canAcceptAnswerCompletion({ ...base, idleFor: 15000, freshPromptConfirmed: false }), false, '未确认本轮提示词时不得完成');

console.log('v0.10.9 PASS: 极短状态文本识别、15s/20s 静默门槛、finalTurn 贯通、完成判据边界。');
