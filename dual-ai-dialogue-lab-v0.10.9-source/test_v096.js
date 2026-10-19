'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const sidepanel = fs.readFileSync(path.join(root, 'install/sidepanel.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'install/manifest.json'), 'utf8'));
assert.ok(manifest.version.localeCompare('0.10.4') >= 0, '版本应不低于 0.10.4');
const start = sidepanel.indexOf('function inspectAttachmentAccessFailure(value) {');
const end = sidepanel.indexOf('\nfunction setState(text)', start);
assert.ok(start >= 0 && end > start, 'production detector exists');
const source = sidepanel.slice(start, end);
const context = {};
const vm = require('node:vm');
vm.createContext(context);
vm.runInContext(`${source}\nthis.inspectAttachmentAccessFailure = inspectAttachmentAccessFailure; this.looksLikeAttachmentAccessFailure = looksLikeAttachmentAccessFailure;`, context);
const detect = value => context.inspectAttachmentAccessFailure(value);
const positives = [
  '当前会话没有可访问的附件。',
  '当前会话无法读取文件。',
  '我无法读取你上传的文件。',
  'I cannot access the attached file.',
  'No files were attached.'
];
for (const sample of positives) assert.equal(detect(sample).matched, true, `应识别明确否认：${sample}`);
const negatives = [
  '如果当前会话没有可访问的附件，请重新上传。',
  '若当前会话无法读取文件，需要说明具体限制。',
  '例如，文件无法读取时应明确说明。',
  '不能仅凭“无法读取文件”就认定附件投递失败。',
  '任务要求：若附件无法读取，必须指出具体文件。',
  '本报告讨论附件无法访问这一风险，并不意味着本轮文件不可用。',
  '我已经阅读了附件，下面依据表格数据进行分析。',
  '文件无法读取可能由格式或扫描质量导致。'
];
for (const sample of negatives) assert.equal(detect(sample).matched, false, `不应误判描述/假设：${sample}`);
const mixed = '文件格式说明：若附件无法读取，应提示用户。\n但当前会话没有可访问的附件。';
assert.equal(detect(mixed).matched, true, '混合回答中真实的明确否认仍应被识别');
const result = detect('当前会话无法读取文件。');
assert.equal(typeof result.rule, 'number');
assert.equal(typeof result.clauseIndex, 'number');
assert.match(sidepanel, /仅记录规则编号与分句序号，不保存回答正文/);
console.log(`v0.9.6 detector tests passed: ${positives.length} explicit-denial positives + ${negatives.length} false-positive negatives + mixed-clause and diagnostic checks.`);
