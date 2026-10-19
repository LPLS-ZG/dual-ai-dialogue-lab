'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const content = fs.readFileSync(path.join(root, 'install/content.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'install/manifest.json'), 'utf8'));
assert.ok(manifest.version.localeCompare('0.10.4') >= 0, '版本应不低于 0.10.4');
assert.ok(content.includes(`.replace(/[（]/g, '(').replace(/[）]/g, ')')`), '必须归一化全角括号');
// v0.10.8：别名后缀放宽为「日期[分隔符]时间 | 时间 | 重复序号」，
// 必须同时覆盖 ChatGPT 实测的连字符形式（A题(20261019-123948).pdf）。
assert.ok(content.includes(String.raw`\\d{8}(?:[\\s_-]*\\d{4,6})?`), '必须允许 YYYYMMDD[分隔符]HHMMSS 别名');
assert.ok(content.includes(String.raw`\\d{1,3}`), '必须允许数字重名后缀');
// Mirror the narrow matcher used by composerAttachmentEvidence to test actual examples.
const norm = value => String(value || '')
  .replace(/[\u00a0\u200b-\u200d\ufeff]/g, ' ')
  .replace(/[（]/g, '(').replace(/[）]/g, ')')
  .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const filenamePattern = name => {
  const key = norm(name), dot = key.lastIndexOf('.');
  const generatedSuffix = '(?:\\(\\s*(?:\\d{8}\\s+\\d{6}|\\d+)\\s*\\))?';
  let body;
  if (dot > 0) {
    const stem = key.slice(0, dot), extension = key.slice(dot);
    body = `${escapeRegex(stem)}\\s*${generatedSuffix}\\s*${escapeRegex(extension)}${generatedSuffix}`;
  } else body = `${escapeRegex(key)}${generatedSuffix}`;
  return new RegExp(`(?:^|[^a-z0-9._-])${body}(?=$|[^a-z0-9._-])`, 'gi');
};
const has = (visibleText, expected) => filenamePattern(expected).test(norm(visibleText));
assert.equal(has('A题（20261019 044718）.pdf', 'A题.pdf'), true, '必须匹配实际报告中的全角括号时间戳文件名');
assert.equal(has('A题(20261019 044718).pdf', 'A题.pdf'), true, '必须匹配半角括号时间戳');
assert.equal(has('A题 (4).pdf', 'A题.pdf'), true, '必须保留原有数字重名后缀兼容');
assert.equal(has('A题.pdf (4)', 'A题.pdf'), true, '必须保留扩展名后的数字后缀兼容');
assert.equal(has('A题（20261019 044718）.pdf', 'B题.pdf'), false, '不得将不同主文件名误判为匹配');
// Baseline invariant: an alias already present before transfer must not count as new.
const occurrenceCount = (text, name) => { const r = filenamePattern(name); let n = 0; while (r.exec(norm(text))) n++; return n; };
const baseline = occurrenceCount('旧消息里提到 A题（20261019 044718）.pdf', 'A题.pdf');
const after = occurrenceCount('旧消息里提到 A题（20261019 044718）.pdf\nA题（20261019 044718）.pdf', 'A题.pdf');
assert.ok(after > baseline, '新增同名别名附件应通过前后计数差识别');
console.log('v0.9.8 filename alias tests passed: full-width timestamp suffix, numeric suffix, wrong-name rejection, and baseline delta.');
