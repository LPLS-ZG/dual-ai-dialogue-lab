'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = __dirname;
const install = path.join(root, 'install');
const sidepanel = fs.readFileSync(path.join(install, 'sidepanel.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(install, 'manifest.json'), 'utf8'));

function extractBetween(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `找不到代码起点：${startText}`);
  const end = source.indexOf(endText, start);
  assert.notEqual(end, -1, `找不到代码终点：${endText}`);
  return source.slice(start, end);
}

async function main() {
  assert.ok(manifest.version.localeCompare('0.10.4') >= 0, '版本应不低于 0.10.4');
  const parserSource = extractBetween(sidepanel, 'function parseTaskCompletionStatus(text) {', '\nfunction taskCompletionStatusMessage(status, answerCount) {');
  const parserContext = {};
  vm.createContext(parserContext);
  vm.runInContext(`${parserSource}\nthis.parseTaskCompletionStatus = parseTaskCompletionStatus;`, parserContext);
  const parse = value => parserContext.parseTaskCompletionStatus(value);

  const cases = [
    ['机器标记和状态一致：完成', '任务完成情况核对：\n状态：已完成\n已完成项目：报告、计算和附件检查均有证据\n未完成项目：无\nDUOLAB_TASK_STATUS=COMPLETE', '已完成'],
    ['机器标记和状态一致：部分完成', '任务完成情况核对：\n状态：部分完成\n已完成项目：完成前两项\n未完成项目：数值验证尚未完成\nDUOLAB_TASK_STATUS=PARTIAL', '部分完成'],
    ['机器标记和状态一致：未完成', '任务完成情况核对：\n状态：未完成\n未完成项目：尚未形成任何交付物\nDUOLAB_TASK_STATUS=INCOMPLETE', '未完成'],
    ['机器标记和状态一致：无法核实', '任务完成情况核对：\n状态：无法核实\n未完成项目：关键原始数据无法读取\nDUOLAB_TASK_STATUS=UNVERIFIED', '无法核实'],
    ['兼容旧版自然语言状态', '分析过程……\n任务完成情况核对\n整体状态为部分完成\n未完成项：缺少验证', '部分完成'],
    ['兼容旧版状态字段', '任务完成情况核对：\n状态：已完成\n已完成项目：全部要求\n未完成项目：无', '已完成'],
    ['旧版扁平化 DOM 文本', '任务完成情况核对状态：部分完成已完成项目：A；未完成项目：B', '部分完成'],
    ['状态和机器标记矛盾时无法核实', '任务完成情况核对：\n状态：已完成\n未完成项目：无\nDUOLAB_TASK_STATUS=PARTIAL', '无法核实'],
    ['重复机器标记矛盾时无法核实', '任务完成情况核对：\n状态：部分完成\n未完成项目：B\nDUOLAB_TASK_STATUS=PARTIAL\nDUOLAB_TASK_STATUS=COMPLETE', '无法核实'],
    ['声明完成但存在未完成项时无法核实', '任务完成情况核对：\n状态：已完成\n未完成项目：NPV 计算尚未完成\nDUOLAB_TASK_STATUS=COMPLETE', '无法核实'],
    ['声明完成且明确无未完成项', '任务完成情况核对：\n状态：已完成\n未完成项目：无\nDUOLAB_TASK_STATUS=COMPLETE', '已完成'],
    ['只出现状态菜单不误认完成', '任务完成情况核对：\n状态：已完成 / 部分完成 / 未完成 / 无法核实（选择一个）', '未识别'],
    ['缺失状态不视为完成', '任务完成情况核对：\n已完成项目：A\n未完成项目：B', '未识别'],
    ['自然语言无法确认别名', '正文\n最终状态：无法确认', '无法核实'],
    ['同一核查区块有冲突状态', '任务完成情况核对：\n状态：部分完成\n最终状态：已完成\n未完成项目：B', '无法核实']
  ];
  for (const [label, input, expected] of cases) {
    assert.equal(parse(input), expected, `${label}\n实际解析：${parse(input)}`);
  }

  // Verify the production task-mode final-turn instruction actually emits the fields and marker.
  const instructionSource = extractBetween(sidepanel, 'function conversationModeInstruction(', '\nfunction buildInitialPrompt(');
  const instructionContext = {
    normalizeConversationMode: value => value,
    conversationModeLabel: value => value,
    taskEvidenceAndCalculationRules: () => '任务执行基本规则'
  };
  vm.createContext(instructionContext);
  vm.runInContext(`${instructionSource}\nthis.conversationModeInstruction = conversationModeInstruction;`, instructionContext);
  const finalInstruction = instructionContext.conversationModeInstruction('task', true, false, false, '回归测试任务');
  for (const field of ['任务完成情况核对：', '状态：已完成 / 部分完成 / 未完成 / 无法核实', '已完成项目：', '未完成项目：', '未完成原因：', '下一步建议：', 'DUOLAB_TASK_STATUS=COMPLETE']) {
    assert.ok(finalInstruction.includes(field), `末轮任务提示缺少字段：${field}`);
  }

  // Exercise the production truncation/interruption signal detector with small fake DOM nodes.
  const extractionGuardSource = extractBetween(
    fs.readFileSync(path.join(install, 'content.js'), 'utf8'),
    'function explicitContinuationSignalForAnswer(',
    '\n  function lastAssistantText() {'
  );
  function fakeNode(text, controls = [], parentElement = null) {
    return {
      textContent: text,
      parentElement,
      querySelectorAll() { return controls; },
      getAttribute() { return null; }
    };
  }
  function fakeControl(label) {
    return {
      textContent: label,
      getAttribute(name) { return name === 'aria-label' ? label : null; }
    };
  }
  const answerText = 'This is a sufficiently long answer candidate that is not yet complete.';
  const rootNode = fakeNode('root');
  const continuation = fakeControl('Continue generating');
  const answerNode = fakeNode(answerText, [continuation], rootNode);
  const guardContext = {
    sigOf(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); },
    cleanAnswer(value) { return String(value || '').trim(); },
    assistantNodes() { return [answerNode]; },
    answerTextOf(node) { return node.textContent; },
    textOf(node) { return node.textContent; },
    pageRoot() { return rootNode; },
    visible() { return true; }
  };
  vm.createContext(guardContext);
  vm.runInContext(`${extractionGuardSource}\nthis.explicitContinuationSignalForAnswer = explicitContinuationSignalForAnswer;`, guardContext);
  assert.equal(guardContext.explicitContinuationSignalForAnswer(answerText), 'Continue generating', '明确继续生成控件应阻止候选被当作完成回答');
  answerNode.querySelectorAll = () => [fakeControl('Copy')];
  assert.equal(guardContext.explicitContinuationSignalForAnswer(answerText), '', '普通复制控件不应误判为截断');
  const olderIncomplete = fakeNode('Older answer with a Continue generating button that must not match this candidate.', [continuation], rootNode);
  guardContext.assistantNodes = () => [olderIncomplete, answerNode];
  assert.equal(guardContext.explicitContinuationSignalForAnswer(answerText), '', '旧回答中的继续生成控件不能污染当前回答');

  // Exercise the production sendBackgroundMessage wrapper with a simulated late callback.
  const helperSource = extractBetween(sidepanel, 'function sendBackgroundMessage(message, timeout = 45000, hooks = {}) {', '\nfunction withTimeout(operation, timeoutMs, label = \'操作\') {');
  let runtimeCallback = null;
  let runtimeSendCount = 0;
  const lateReplies = [];
  let timeoutCount = 0;
  const context = {
    setTimeout, clearTimeout, console,
    chrome: { runtime: {
      lastError: null,
      sendMessage(_message, callback) { runtimeSendCount++; runtimeCallback = callback; }
    } }
  };
  vm.createContext(context);
  vm.runInContext(`${helperSource}\nthis.sendBackgroundMessage = sendBackgroundMessage;`, context);
  const pending = context.sendBackgroundMessage({ type: 'DUO_CDP_SEND' }, 15, {
    onTimeout() { timeoutCount++; },
    onLateResponse(response) { lateReplies.push(response); }
  });
  await assert.rejects(pending, /状态按“未知”处理，未自动重发/);
  assert.equal(timeoutCount, 1, '超时钩子应触发一次');
  assert.equal(runtimeSendCount, 1, '发送消息只能发起一次，不能因等待超时而重发');
  assert.equal(typeof runtimeCallback, 'function');
  runtimeCallback({ ok: true, submitted: true, baseline: { capturedAt: 1 }, evidence: 'new-user-message-confirmed' });
  assert.equal(lateReplies.length, 1, '迟到的后台回执应被保留');
  assert.equal(lateReplies[0].submitted, true, '迟到回执中的提交确认应保留');
  assert.equal(runtimeSendCount, 1, '处理迟到回执不得触发第二次发送');

  // Source-level guardrails that complement the behavior tests.
  assert.match(sidepanel, /等待上限 90 秒/);
  assert.match(sidepanel, /不会自动再次发送/);
  assert.match(sidepanel, /DUOLAB_TASK_STATUS=COMPLETE/);
  assert.match(fs.readFileSync(path.join(install, 'content.js'), 'utf8'), /function explicitContinuationSignalForAnswer/);
  assert.match(fs.readFileSync(path.join(install, 'content.js'), 'utf8'), /function findContinueGeneratingControlForAnswer/);
  assert.match(sidepanel, /发送尝试 ID=/);

  console.log(`v0.9.4 兼容回归测试通过（当前包版本 0.9.7）：${cases.length} 项状态识别 + 末轮提示词模板 + 截断/中断信号保护 + 迟到回执/无自动重发测试 + 版本与静态约束。`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
