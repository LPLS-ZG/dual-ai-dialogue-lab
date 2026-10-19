// v0.10.7 patch: 替换 composerAttachmentEvidence，细化失败分类，扩充核验历史字段。
const fs = require('fs');
const file = 'install/content.js';
let s = fs.readFileSync(file, 'utf8');
const steps = [];

// ---- 1. 替换 composerAttachmentEvidence ----
const startMarker = '  function composerAttachmentEvidence(fileNames, baselineCounts = {}) {';
const endMarker = '  async function waitForComposerAttachmentEvidence(';
const start = s.indexOf(startMarker);
const end = s.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) throw new Error('未找到 composerAttachmentEvidence 边界');
const replacement = fs.readFileSync('_new_composer_fn.js', 'utf8');
s = s.slice(0, start) + replacement + s.slice(end);
steps.push('composerAttachmentEvidence 重写');

function replaceOnce(from, to, label) {
  if (!s.includes(from)) throw new Error('未找到锚点：' + label);
  if (s.split(from).length !== 2) throw new Error('锚点不唯一：' + label);
  s = s.replace(from, to);
  steps.push(label);
}

// ---- 2. summarize 增加卡片证据 ----
replaceOnce(
  '      diagnosticNodes:(r?.diagnosticNodes || []).slice(0,12).map(n=>({tag:n.tag,text:n.text,descriptor:n.descriptor,rect:n.rect})),\n      composerRect:r?.composerRect || null, evidenceScope:r?.evidenceScope || \'\'',
  [
    '      diagnosticNodes:(r?.diagnosticNodes || []).slice(0,14).map(n=>({tag:n.tag,text:n.text,descriptor:n.descriptor,rect:n.rect,matchReason:n.matchReason || \'\'})),',
    '      cardCount:Number(r?.cardCount || 0),',
    '      attachmentCards:(r?.attachmentCards || []).slice(0,8),',
    '      cardPresentNoName:(r?.cardPresentNoName || []).slice(0,8),',
    '      scopeBox:r?.scopeBox || null,',
    '      composerRect:r?.composerRect || null, evidenceScope:r?.evidenceScope || \'\''
  ].join('\n'),
  'summarize 增加卡片证据'
);

// ---- 3. 失败分类细化 ----
replaceOnce(
  [
    '        const disappearedAfterUpload = hadImmediateUploadEvidence && !(result.matched || []).length;',
    "        const failureClass = result.error ? 'page-upload-error' : result.busy ? 'upload-still-busy' : disappearedAfterUpload ? 'initial-evidence-disappeared' : (result.missing?.length ? 'filename-not-detected' : 'stability-timeout');"
  ].join('\n'),
  [
    '        const disappearedAfterUpload = hadImmediateUploadEvidence && !(result.matched || []).length;',
    '        const cardCount = Number(result.cardCount || 0);',
    '        const missingNames = Array.isArray(result.missing) ? result.missing : [];',
    '        const nameUnreadable = Array.isArray(result.cardPresentNoName) ? result.cardPresentNoName : [];',
    '        // v0.10.7：把「卡片在但名字读不出」和「根本没有卡片」分开。',
    '        // 旧实现只有 initial-evidence-disappeared，用户看不出到底是漏检还是附件真的没了。',
    "        const failureClass = result.error ? 'page-upload-error'",
    "          : result.busy ? 'upload-still-busy'",
    "          : (disappearedAfterUpload && cardCount === 0) ? 'attachments-vanished-after-upload'",
    "          : disappearedAfterUpload ? 'initial-evidence-disappeared'",
    "          : (missingNames.length && nameUnreadable.length === missingNames.length && cardCount >= missingNames.length) ? 'card-present-name-unreadable'",
    "          : (missingNames.length && cardCount > 0) ? 'card-present-unmatched'",
    "          : missingNames.length ? 'filename-not-detected'",
    "          : 'stability-timeout';",
    '        const failureDetail = result.error ? `网页错误提示：${String(result.error).slice(0, 160)}`',
    '          : result.busy ? `上传忙碌：${String(result.busyReason || \'\').slice(0, 160)}`',
    '          : `卡片数=${cardCount}；缺失=${missingNames.join(\'、\') || \'无\'}；卡片存在但名称不可读=${nameUnreadable.join(\'、\') || \'无\'}；即时证据=${hadImmediateUploadEvidence ? \'有\' : \'无\'}；最后匹配=${(result.matched || []).join(\'、\') || \'无\'}`;'
  ].join('\n'),
  '失败分类细化'
);

// 超时返回里带上 failureDetail
replaceOnce(
  '        return { ...result, confirmed:false, reason:timeoutReason, failureClass, initialEvidence, evidenceHistory, hadImmediateUploadEvidence };',
  '        return { ...result, confirmed:false, reason:timeoutReason, failureClass, failureDetail, initialEvidence, evidenceHistory, hadImmediateUploadEvidence };',
  '超时返回带 failureDetail'
);

// ---- 4. 无证据提前退出也用同一套分类 ----
replaceOnce(
  "        return { ...result, confirmed:false, reason:result.reason || '等待期间没有检测到本轮新附件', initialEvidence, evidenceHistory, hadImmediateUploadEvidence };",
  "        return { ...result, confirmed:false, reason:result.reason || '等待期间没有检测到本轮新附件', failureClass:(Number(result.cardCount||0)>0 ? 'card-present-unmatched' : 'no-evidence-after-transfer'), failureDetail:`卡片数=${Number(result.cardCount||0)}；缺失=${(result.missing||[]).join('、')||'无'}；即时证据=${hadImmediateUploadEvidence?'有':'无'}`, initialEvidence, evidenceHistory, hadImmediateUploadEvidence };",
  '无证据退出分类'
);

fs.writeFileSync(file, s, 'utf8');
console.log('patched:', steps.join(' | '));
