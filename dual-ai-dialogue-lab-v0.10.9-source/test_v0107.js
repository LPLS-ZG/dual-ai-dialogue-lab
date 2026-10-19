// v0.10.7 回归测试
// 1) 静态断言：作用域退化修复、附件卡片通道、失败分类、诊断不再被截断
// 2) 行为断言：从 content.js 抽取真实文件名匹配函数，验证中文名/别名/截断名的行为
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const root = __dirname;
const content = fs.readFileSync(path.join(root, 'install/content.js'), 'utf8');
const side = fs.readFileSync(path.join(root, 'install/sidepanel.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'install/manifest.json'), 'utf8'));

// ---------- 1. 版本与静态断言 ----------
assert.ok(manifest.version.localeCompare('0.10.7') >= 0, `manifest 版本应不低于 0.10.7，实际 ${manifest.version}`);

// 作用域：不再使用「视口坐标 + 固定 760/180 偏移」
assert.ok(!content.includes('composerRect.top - 760'), '不应再使用固定 760 像素的局部范围');
assert.ok(!content.includes('composerRect.bottom + 180'), '不应再使用固定 180 像素的局部范围');
assert.ok(content.includes('const scopeBox = (() =>'), '必须存在 composer 祖先作用域盒');
assert.ok(content.includes('degraded: true'), '作用域退化分支必须存在');
assert.ok(content.includes('const inScope = (r, pad = 320) =>'), '必须有统一的 inScope 判定');

// 附件卡片通道
assert.ok(content.includes('const FILE_SEMANTIC ='), '缺少附件语义正则');
assert.ok(content.includes('const REMOVE_SEMANTIC ='), '缺少移除控件语义正则');
assert.ok(content.includes('attachmentCards: attachmentCards.slice(0, 12)'), '返回值必须带 attachmentCards');
assert.ok(content.includes('cardNameMatches'), '必须输出按文件名匹配到的卡片');
assert.ok(content.includes('cardPresentNoName'), '必须区分「卡片存在但名称读不出」');
// v0.10.8：侧边栏与上传触发按钮不得计入卡片数（v0.10.7 实测 4 张卡片里有 2 张是误报）
assert.ok(content.includes("el.closest('nav, aside, [role=\"navigation\"], [data-testid*=\"sidebar\"], [aria-label*=\"侧栏\"]')"), '卡片识别必须排除侧边栏/导航区域');
assert.ok(content.includes('添加文件|附加文件|上传文件|添加附件'), '必须排除上传触发按钮');
assert.ok(content.includes('(?:\\\\d{8}(?:[\\\\s_-]*\\\\d{4,6})?|\\\\d{4,6}|\\\\d{1,3})'), '文件名别名必须支持连字符/下划线日期时间');

// 失败分类
for (const cls of ['page-upload-error', 'upload-still-busy', 'attachments-vanished-after-upload', 'initial-evidence-disappeared', 'card-present-name-unreadable', 'card-present-unmatched', 'filename-not-detected', 'no-evidence-after-transfer']) {
  assert.ok(content.includes(cls), `缺少失败分类：${cls}`);
}
assert.ok(content.includes('failureDetail'), '超时结果必须带判定依据');

// 诊断采样优先级
assert.ok(content.includes('const diagnosticBuckets ='), '诊断节点必须按优先级分桶');
assert.ok(content.includes('...diagnosticBuckets.nameMatch'), '文件名匹配节点必须优先');

// 诊断不再被一刀切截断
assert.ok(!side.includes('JSON.stringify(evidenceDiagnostics).slice(0, 7000)'), '不应再用 slice(0,7000) 截断证据 JSON');
assert.ok(side.includes('function boundedEvidenceJson('), '必须使用有界结构化序列化');
assert.ok(side.includes('boundedEvidenceJson(evidenceDiagnostics)'), '核验证据必须经由 boundedEvidenceJson 序列化');
assert.ok(side.includes('providedDetails.slice(0, 12000)'), 'recordDiagnostic 的详情上限必须放宽');
assert.ok(side.includes("detailParts.join('\\n').slice(0, 14000)"), 'recordDiagnostic 的合并上限必须放宽');
assert.ok(side.includes('failureDetail:verification?.failureDetail'), '证据对象必须透传 failureDetail');

// ---------- 2. 行为断言：真实文件名匹配函数 ----------
const normStart = content.indexOf("    const norm = value => String(value || '')");
const normEnd = content.indexOf('    const rectOf = el =>', normStart);
const fileStart = content.indexOf('    const escapeRegex = ', normEnd);
const fileEnd = content.indexOf('    const counts = {}, evidenceByName = {}, inputFileEvidenceByName = {};', fileStart);
assert.ok(normStart > 0 && normEnd > normStart, '无法抽取 norm 定义');
assert.ok(fileStart > 0 && fileEnd > fileStart, '无法抽取文件名匹配函数块');
const block = (content.slice(normStart, normEnd) + content.slice(fileStart, fileEnd)).replace(/^ {4}/gm, '');
const ctx = { String, RegExp, Set, Object, Array };
vm.runInNewContext(`${block}
this.norm = norm; this.filenamePattern = filenamePattern; this.containsFilename = containsFilename;
this.containsStem = containsStem; this.stemOf = stemOf; this.countFilenameOccurrences = countFilenameOccurrences;`, ctx);

const names = ['A题.pdf', '附件1.xlsx', '附件2.xlsx'];
for (const name of names) {
  assert.ok(ctx.containsFilename(ctx.norm(name), name), `完整文件名必须自匹配：${name}`);
  assert.ok(ctx.containsStem(ctx.norm(name), name), `词干必须自匹配：${name}`);
}
// 上传界面常见的别名
assert.ok(ctx.containsFilename(ctx.norm('A题（20261019 044718）.pdf'), 'A题.pdf'), '全角括号时间戳别名必须匹配');
assert.ok(ctx.containsFilename(ctx.norm('A题.pdf (4)'), 'A题.pdf'), '重复上传后缀必须匹配');
assert.ok(ctx.containsFilename(ctx.norm('文件：附件1.xlsx 540.4 KB'), '附件1.xlsx'), '行内嵌在文本中的文件名必须匹配');
// v0.10.8：ChatGPT 实测使用「日期-时间」连字符别名，旧规则漏掉它，导致卡片名称读到了却判 0/N
assert.ok(ctx.containsFilename(ctx.norm('A题(20261019-123948).pdf'), 'A题.pdf'), '连字符日期时间别名必须匹配');
assert.ok(ctx.containsFilename(ctx.norm('A题(20261019 123948).pdf'), 'A题.pdf'), '空格日期时间别名必须匹配');
assert.ok(ctx.containsFilename(ctx.norm('A题(20261019_123948).pdf'), 'A题.pdf'), '下划线日期时间别名必须匹配');
assert.ok(ctx.containsFilename(ctx.norm('A题(20261019123948).pdf'), 'A题.pdf'), '无分隔日期时间别名必须匹配');
assert.ok(ctx.containsFilename(ctx.norm('A题(20261019).pdf'), 'A题.pdf'), '只带日期的别名必须匹配');
// 不能误匹配
assert.ok(!ctx.containsFilename(ctx.norm('B题.pdf'), 'A题.pdf'), '不同文件名不能互相匹配');
assert.ok(!ctx.containsFilename(ctx.norm('B题(20261019-123948).pdf'), 'A题.pdf'), '别名不得让不同文件互相匹配');
assert.ok(!ctx.containsFilename(ctx.norm('附件1.xlsxa'), '附件1.xlsx'), '扩展名后缀粘连不应匹配');
// 卡片把扩展名截断时，词干匹配仍要成立（这是 v0.10.7 新增通道的依据）
assert.ok(ctx.containsStem(ctx.norm('A题.pd'), 'A题.pdf'), '截断的卡片名应能通过词干匹配识别');
assert.ok(ctx.containsStem(ctx.norm('A题(20261019-123948).pd'), 'A题.pdf'), '带别名的截断卡片名也应能被词干识别');
assert.ok(!ctx.containsStem(ctx.norm('A题库'), 'A题.pdf'), '词干匹配不得跨词边界误命中');

// ---------- 3. 行为断言：有界诊断序列化必须保住结论字段 ----------
const boundedStart = side.indexOf('function boundedEvidenceJson(');
const boundedEnd = side.indexOf('async function attachOriginalFilesToTab(');
assert.ok(boundedStart > 0 && boundedEnd > boundedStart, '无法从 sidepanel.js 抽取 boundedEvidenceJson');
const boundedSource = side.slice(boundedStart, boundedEnd);
const evidenceCtx = { JSON, String, Number, Array, Object };
vm.runInNewContext(`${boundedSource}\nthis.boundedEvidenceJson = boundedEvidenceJson;`, evidenceCtx);
const hugeEvidence = {
  failureClass: 'card-present-name-unreadable',
  failureDetail: 'x'.repeat(2000),
  matched: ['A题.pdf'], missing: ['附件1.xlsx'],
  counts: {}, baselineCounts: {},
  cardCount: 3,
  cardPresentNoName: ['附件1.xlsx'],
  busy: false, busyReason: '', pageError: '',
  scopeBox: { left: 0, top: 0, right: 800, bottom: 400, degraded: false },
  composerRect: { x: 0, y: 0, width: 800, height: 120 },
  hadImmediateUploadEvidence: true,
  attachmentCards: Array.from({ length: 12 }, (_, i) => ({ text: 'card-' + i + '-' + 'y'.repeat(400), descriptor: 'file', rect: {} })),
  evidenceByName: { 'A题.pdf': { descriptor: 'file-chip' } },
  localEvidenceByName: { 'A题.pdf': { source: 'visible-composer-neighborhood' } },
  inputFileEvidenceByName: {},
  nativeFileInputState: [{ index: 0, fileCount: 0, files: [] }],
  transferImmediateEvidence: { matched: ['A题.pdf'], cardCount: 1, busy: false, pageError: '', attachmentCards: [{ text: 'A题.pdf' }] },
  verificationHistory: Array.from({ length: 40 }, (_, i) => ({ tMs: i * 1000, matched: [], missing: ['附件1.xlsx'], busy: false, cardCount: 1 })),
  diagnosticNodes: Array.from({ length: 40 }, () => ({ tag: 'div', text: 'z'.repeat(300), descriptor: 'noise', rect: {} }))
};
const boundedJson = evidenceCtx.boundedEvidenceJson(hugeEvidence);
assert.ok(boundedJson.length <= 11000, `有界诊断超出预算：${boundedJson.length}`);
assert.ok(boundedJson.includes('card-present-name-unreadable'), '最终判定必须保留');
assert.ok(boundedJson.includes('附件1.xlsx'), '缺失文件名必须保留');
assert.ok(boundedJson.includes('verificationHistory'), '最近核验历史必须保留');
const parsed = JSON.parse(boundedJson);
assert.strictEqual(parsed.failureClass, 'card-present-name-unreadable');
assert.strictEqual(parsed.cardCount, 3);

console.log('v0.10.7 PASS: 作用域退化修复、附件卡片结构化通道、失败分类细化、诊断不再截断（含超长证据保留结论）、文件名/词干匹配行为。');
