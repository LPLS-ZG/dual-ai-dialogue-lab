'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const sidepanel = fs.readFileSync(path.join(root, 'install/sidepanel.js'), 'utf8');
const content = fs.readFileSync(path.join(root, 'install/content.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'install/manifest.json'), 'utf8'));
assert.ok(manifest.version.localeCompare('0.10.4') >= 0, '版本应不低于 0.10.4');
for (const phase of ['附件基线', '文件控件预检', '原始字节传输', '附件可见性核验']) {
  assert.ok(sidepanel.includes(phase), `缺少阶段诊断：${phase}`);
}
for (const phase of ['baseline-start', 'baseline-done', 'probe-start', 'probe-done', 'transfer-start', 'transfer-done', 'verify-start', 'verify-confirmed', 'verify-unconfirmed']) {
  assert.ok(sidepanel.includes(phase), `缺少阶段状态：${phase}`);
}
assert.match(sidepanel, /provider === 'chatgpt' \? 45000 : 35000/, '附件核验等待应有明确上限');
assert.match(sidepanel, /withTimeout\(\s*\(\) => sendTabMessage\(tabId, \{\s*type:'DUO_VERIFY_ATTACHMENTS'/, '核验通信应有外层超时');
assert.match(content, /const noEvidenceGrace = PROVIDER === 'chatgpt' \? 15000 : 12000;/, '无附件证据应尽早转人工核验');
assert.match(content, /const requiredStableMs = PROVIDER === 'chatgpt' \? 4000 : 3500;/, '稳定观察时间应受控');
assert.match(sidepanel, /附件可见性核验通信失败或超时/, '核验超时必须留下明确诊断');
assert.match(sidepanel, /不会创建 Downloads 临时文件/, '不得回退到下载目录临时副本');
console.log('v0.9.8 inherited stage/timeout regression passed: 4 visible stages, 9 transition markers, bounded verification, explicit timeout diagnostics.');
