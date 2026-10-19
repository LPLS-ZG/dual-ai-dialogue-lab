/* v0.9.1: independent section collapse with locally persisted state and diagnostic report export. */
(function initSectionCollapse() {
  const storageKey = 'duoLabSectionCollapseV1';
  const sections = Array.from(document.querySelectorAll('body > section'));
  const getHeading = (section, index) => (section.querySelector('#chatgptTab') && section.querySelector('#deepseekTab'))
    ? 'AI 网页选择'
    : section.querySelector('h2')?.textContent?.trim()
      || section.querySelector('strong')?.textContent?.trim()
      || section.querySelector('label')?.textContent?.trim()
      || `部分 ${index + 1}`;

  chrome.storage.local.get([storageKey]).then((saved) => {
    const states = saved?.[storageKey] && typeof saved[storageKey] === 'object' ? saved[storageKey] : {};
    sections.forEach((section, index) => {
      if (section.querySelector(':scope > .sectionCollapseToggle')) return;
      const heading = getHeading(section, index);
      const key = `section-${index}-${heading}`;
      const collapsed = states[key] === true;
      section.classList.toggle('sectionCollapsed', collapsed);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'sectionCollapseToggle';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.textContent = `${collapsed ? '▶' : '▼'} ${heading}（${collapsed ? '展开' : '收起'}）`;
      toggle.addEventListener('click', () => {
        const nextCollapsed = section.classList.toggle('sectionCollapsed');
        toggle.setAttribute('aria-expanded', String(!nextCollapsed));
        toggle.textContent = `${nextCollapsed ? '▶' : '▼'} ${heading}（${nextCollapsed ? '展开' : '收起'}）`;
        states[key] = nextCollapsed;
        chrome.storage.local.set({ [storageKey]: states }).catch((error) => {
          console.warn('保存区块折叠状态失败：', error);
        });
      });
      section.insertBefore(toggle, section.firstChild);
    });
  }).catch((error) => {
    console.warn('读取区块折叠状态失败，将使用默认展开状态：', error);
    sections.forEach((section, index) => {
      if (section.querySelector(':scope > .sectionCollapseToggle')) return;
      const heading = getHeading(section, index);
      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'sectionCollapseToggle';
      toggle.setAttribute('aria-expanded', 'true'); toggle.textContent = `▼ ${heading}（收起）`;
      toggle.addEventListener('click', () => {
        const collapsed = section.classList.toggle('sectionCollapsed');
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.textContent = `${collapsed ? '▶' : '▼'} ${heading}（${collapsed ? '展开' : '收起'}）`;
      });
      section.insertBefore(toggle, section.firstChild);
    });
  });
})();

const $ = (id) => document.getElementById(id);
const els = {
  chatgptTab: $('chatgptTab'), deepseekTab: $('deepseekTab'), refreshTabs: $('refreshTabs'),
  chatgptStatus: $('chatgptStatus'), deepseekStatus: $('deepseekStatus'), topic: $('topic'), conversationMode: $('conversationMode'), modeHelp: $('modeHelp'), guidanceLabel: $('guidanceLabel'), discussionGuidance: $('discussionGuidance'),
  firstSpeaker: $('firstSpeaker'), rounds: $('rounds'), customRoundsWrap: $('customRoundsWrap'), customRounds: $('customRounds'), roundsHelp: $('roundsHelp'), askToConclude: $('askToConclude'), askToConcludeLabel: $('askToConcludeLabel'), endingModeHelp: $('endingModeHelp'), newChatPerRun: $('newChatPerRun'),
  startBtn: $('startBtn'), endBtn: $('endBtn'), stopBtn: $('stopBtn'), transcript: $('transcript'), runState: $('runState'),
  copyLog: $('copyLog'), downloadLog: $('downloadLog'), clearLog: $('clearLog'),
  fileInput: $('fileInput'), uploadMaterials: $('uploadMaterials'), refreshMaterials: $('refreshMaterials'),
  clearMaterials: $('clearMaterials'), materialsList: $('materialsList'), materialsStatus: $('materialsStatus'),
  materialDropZone: $('materialDropZone'), confirmExternalUpload: $('confirmExternalUpload'),
  manualAttachFallback: $('manualAttachFallback'), manualAttachMessage: $('manualAttachMessage'), manualAttachContinue: $('manualAttachContinue'), manualAttachVisualConfirm: $('manualAttachVisualConfirm'), manualAttachVisualContinue: $('manualAttachVisualContinue'),
  copyDiagnostics: $('copyDiagnostics'), downloadDiagnostics: $('downloadDiagnostics'), clearDiagnostics: $('clearDiagnostics'),
  diagnosticsSummary: $('diagnosticsSummary'), diagnosticsLog: $('diagnosticsLog'), diagnosticsScope: $('diagnosticsScope'), recordScope: $('recordScope'),
  draftRecovery: $('draftRecovery'), draftRecoverySummary: $('draftRecoverySummary'), draftRecoverySelect: $('draftRecoverySelect'),
  draftRecoveryText: $('draftRecoveryText'), toggleRecoveredDraft: $('toggleRecoveredDraft'), copyRecoveredDraft: $('copyRecoveredDraft'), deleteRecoveredDraft: $('deleteRecoveredDraft')
};
let running = false;
let stopRequested = false;
// Active round state is shared with the End button so its request takes effect
// at a safe round boundary without interrupting the answer currently generating.
let activeTurnNumber = 0;
let activeTurnPhase = 'idle'; // idle | preparing | awaiting | between
let activeRunMaxTurns = null;
let requestedFinalTurn = null;
// 等待回答期间的进度快照节流：状态栏实时更新，诊断每 6 秒落一条。
let lastProgressLogAt = 0;
let lastProgressState = '';
let entries = [];
let materials = [];
let diagnostics = [];
let currentRunId = '';
let currentRunTitle = '';
let currentRunStartedAt = 0;
const MAX_DIAGNOSTICS = 240;
const MAX_SAVED_ENTRIES = 120;
const MAX_SAVED_ENTRY_CHARS = 60000;
let restorePromise = Promise.resolve();
let manualAttachmentResolver = null;
let manualAttachmentPending = null;
let materialUploadStates = {};
const RECOVERED_DRAFTS_KEY = 'duoLabRecoveredWebDraftsV078';
const SESSION_MODE_STORAGE_KEY = 'duoLabSessionModeV0816';
const DISCUSSION_GUIDANCE_STORAGE_KEY = 'duoLabDiscussionGuidanceV0818';
const ASK_TO_CONCLUDE_STORAGE_KEY = 'duoLabAskToConcludeV0818';
const CONVERSATION_MODE_STORAGE_KEY = 'duoLabConversationModeV0819';
let recoveredWebDrafts = [];
function createRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `run_${stamp}_${suffix}`;
}
function shortRunId(value) {
  const id = String(value || '未关联任务');
  return id.length > 22 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}
function resolveManualAttachment(outcome) {
  const resolver = manualAttachmentResolver;
  manualAttachmentResolver = null;
  manualAttachmentPending = null;
  if (els.manualAttachFallback) els.manualAttachFallback.hidden = true;
  if (els.manualAttachVisualConfirm) els.manualAttachVisualConfirm.checked = false;
  if (els.manualAttachVisualContinue) els.manualAttachVisualContinue.disabled = true;
  if (resolver) resolver(outcome || false);
}

function diagnosticAdvice(stage, errorText) {
  const e = String(errorText || '').toLowerCase();
  if (/illegal invocation|storagearea|chrome\.storage|本机恢复区.*失败|存储 api/.test(e)) return '扩展存储 API 调用失败：检查 chrome.storage.local 的调用是否保留 StorageArea 作为调用对象；本次错误发生在本机存储/草稿备份阶段，不是 AI 网页回答错误。修复后应重新加载扩展再试。';
  if (/附件|投递|文件输入控件|上传.*失败|manual|required/.test(e)) return '附件投递未能自动确认：请检查网页当前消息输入区，缺失时用网页附件按钮手动补传；自动检测仍漏报时，仅在你亲眼确认全部文件显示且无上传中/失败提示后，才使用“人工目视确认”继续。诊断会明确区分自动核验与人工确认。';
  if (/提交状态按“未知”处理|发送状态不明|操作结果可能仍在后台完成|后台发送等待超时/.test(e)) return '发送状态不明：不要立即重试。先检查目标 AI 网页是否已经出现本轮提示词、是否开始生成或是否已有新回答；若仍无法判断，先刷新/查看当前会话并核对诊断中的发送尝试 ID，再决定是否手动继续。扩展不会因超时自动重发。';
  if (/继续生成.*控件|响应中断控件|可能因中断或长度限制而未结束|未将候选当作完整回答/.test(e)) return '回答可能被网页中断或长度限制截断：扩展已阻止将这段候选保存/转发为完整回答。请在目标网页检查是否有“继续生成/重试”控件，先让网页真正结束或人工续完，再重新发起接力；不要把当前部分回答当作最终结果。';
  if (/没有出现本轮用户消息|自动输入\/发送失败|浏览器输入事件|提交可能未触发|debugger|调试器/.test(e)) return '发送阶段失败：扩展可能未能触发网页提交，或浏览器阻止了自动输入。请确认目标网页已登录、输入框可用，并检查浏览器是否显示调试权限提示。';
  if (/网页.*仍处于生成状态|未能确认回答已完整结束|没有提取到新的|检测到新回答但内容仍在变化|页面响应超时|超时/.test(e)) return '接收阶段失败：网页可能仍在生成，或页面结构更新导致回答检测未识别到新消息。诊断记录会附带轮次、目标 AI 和错误原文；可先在网页上确认是否已生成完整回答。';
  if (/receiving end does not exist|could not establish connection|网页通信失败|重新注入脚本失败|无法建立连接/.test(e)) return '网页通信阶段失败：扩展内容脚本可能未运行，或标签页刚刷新/切换。请刷新目标 AI 网页，再点“刷新”重试。';
  if (/indexeddb|本地资料库|保存资料|读取资料|quota/.test(e)) return '本地资料库阶段失败：可能是浏览器本地存储不可用或空间不足。请先刷新侧边栏；若仍失败，导出诊断报告后反馈。';
  if (/file|文件|大小|格式/.test(e)) return '原始文件阶段失败：请确认文件字节完整、大小未超过扩展限制，并检查目标 AI 网页是否支持该格式。网页拒绝时可尝试手动上传或转换为目标网页支持的格式。';
  if (stage.includes('接力')) return '接力阶段失败：上一轮回答可能未提取成功，或下一轮发送未完成。请看本条之前的“接收回答”和“发送提示词”记录，定位第一个失败步骤。';
  return '系统已记录出错步骤和原始错误。若要反馈，只需复制“自动诊断”报告，无需逐项手动排查。';
}
function diagnosticErrorCategory(stage, errorText) {
  const e = String(errorText || '').toLowerCase();
  if (/illegal invocation|storagearea|chrome\.storage|存储 api/.test(e)) return '扩展本机存储 API 调用失败';
  if (/继续生成.*控件|响应中断控件|可能因中断或长度限制而未结束|未将候选当作完整回答/.test(e)) return '回答可能未完整生成（检测到继续/中断信号）';
  if (/网页.*仍处于生成状态|未能确认回答已完整结束/.test(e)) return '回答仍在生成或尚未确认完成（安全中断）';
  if (/timeout|timed out|超时|等待时间已到/.test(e)) return '等待超时';
  if (/receiving end does not exist|could not establish connection|message port closed|网页通信失败|重新注入脚本失败|无法建立连接/.test(e)) return '网页通信/脚本连接失败';
  if (/没有提取到新的|检测到新回答|回答正文为空|未能读取回答|成功状态.*正文为空/.test(e)) return '回答提取失败';
  if (/没有出现本轮用户消息|自动输入\/发送失败|输入校验失败|提交可能未触发|找不到输入框|发送失败|debugger|调试器/.test(e)) return '发送失败';
  if (String(stage || '').includes('发送/接收')) return '发送/接收阶段异常（待进一步分类）';
  return '未分类错误';
}
function renderDiagnostics() {
  if (!els.diagnosticsLog) return;
  els.diagnosticsLog.replaceChildren();
  if (!diagnostics.length) {
    const p = document.createElement('p'); p.className = 'empty'; p.textContent = '开始对话或导入资料后，这里会显示步骤和错误原因。'; els.diagnosticsLog.append(p);
    els.diagnosticsSummary.textContent = '尚无诊断记录。'; return;
  }
  const errors = diagnostics.filter(d => d.level === 'error').length;
  const warnings = diagnostics.filter(d => d.level === 'warning').length;
  const currentRunEvents = currentRunId ? diagnostics.filter(d => d.runId === currentRunId) : [];
  const latest = currentRunEvents[currentRunEvents.length - 1] || diagnostics[diagnostics.length - 1];
  els.diagnosticsSummary.textContent = `共 ${diagnostics.length} 条记录；错误 ${errors} 条，警告 ${warnings} 条。当前任务：${shortRunId(currentRunId)}；最近阶段：${latest.stage} / ${latest.title}`;
  const selected = els.diagnosticsScope?.value === 'all' || !currentRunId
    ? diagnostics
    : diagnostics.filter(d => d.runId === currentRunId || !d.runId);
  for (const d of selected.slice(-80).reverse()) {
    const item = document.createElement('div'); item.className = `diagItem ${d.level || 'info'}`;
    const context = [d.provider ? providerName(d.provider) : '', d.runId ? `任务 ${shortRunId(d.runId)}` : '非任务事件', d.turn ? `第 ${d.turn} 轮` : '', d.phase ? `阶段 ${d.phase}` : '', Number.isFinite(d.elapsedMs) ? `任务内 +${(d.elapsedMs / 1000).toFixed(1)}s` : '', d.tabId ? `标签页 ${d.tabId}` : ''].filter(Boolean).join(' · ');
    const meta = document.createElement('div'); meta.className = 'diagMeta'; meta.textContent = `${d.time} · ${d.stage}${context ? ' · ' + context : ''}`;
    const title = document.createElement('div'); title.className = 'diagTitle'; title.textContent = d.title;
    const details = document.createElement('div'); details.className = 'diagDetails';
    details.textContent = [d.category ? `错误类别：${d.category}` : '', d.details, d.advice ? `建议：${d.advice}` : ''].filter(Boolean).join('\n');
    item.append(meta, title, details); els.diagnosticsLog.append(item);
  }
}
async function recordDiagnostic(stage, title, options = {}) {
  const errorObject = options.error;
  const errorText = errorObject ? String(errorObject?.message || errorObject?.error || errorObject) : '';
  const providedDetails = String(options.details || '').trim();
  const detailParts = [];
  if (providedDetails) detailParts.push(providedDetails.slice(0, 12000));
  if (errorObject?.name && errorText && !providedDetails.includes(`错误类型：${errorObject.name}`)) detailParts.push(`错误类型：${String(errorObject.name).slice(0, 100)}`);
  if (errorText && !providedDetails.slice(0, 12000).includes(errorText)) detailParts.push(`原始错误：${errorText.slice(0, 1200)}`);
  if (errorObject?.stack) detailParts.push(`异常堆栈：${String(errorObject.stack).slice(0, 1600)}`);
  const now = Date.now();
  const d = {
    time: new Date(now).toLocaleString(), timestamp: now,
    stage, title,
    runId: options.runId || currentRunId || '',
    turn: Number.isFinite(options.turn) ? options.turn : (activeTurnNumber || 0),
    phase: options.phase || activeTurnPhase || 'idle',
    elapsedMs: currentRunStartedAt ? Math.max(0, now - currentRunStartedAt) : null,
    provider: options.provider || '',
    tabId: Number.isFinite(options.tabId) ? options.tabId : null,
    level: options.level || (errorText ? 'error' : 'info'),
    category: options.category || (errorText ? diagnosticErrorCategory(stage, errorText) : ''),
    details: detailParts.join('\n').slice(0, 14000),
    advice: options.advice || (errorText ? diagnosticAdvice(stage, errorText) : '')
  };
  diagnostics.push(d);
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics = diagnostics.slice(-MAX_DIAGNOSTICS);
  renderDiagnostics();
  // Diagnostics are useful, but persisting them must never hold the whole relay
  // state machine indefinitely. The in-memory/UI entry is already available; if
  // storage stalls, continue the task and leave a console warning instead of
  // leaving the side panel frozen on an awaited diagnostic write.
  try {
    await withTimeout(
      () => chrome.storage.local.set({ duoLabDiagnosticsV051: diagnostics }),
      5000,
      '保存自动诊断记录'
    );
  } catch (e) {
    console.warn('诊断记录持久化未在限定时间内完成；本次不会因此阻断接力流程。', e);
  }
}
function diagnosticReport() {
  const report = [
    '双 AI 对话实验室故障诊断报告',
    `扩展版本：${chrome.runtime.getManifest?.().version || '未知'}`,
    `生成时间：${new Date().toLocaleString()}`,
    `当前任务 ID：${currentRunId || '无'}`,
    `报告范围：${els.diagnosticsScope?.value === 'all' || !currentRunId ? '全部诊断记录' : '当前任务及未关联记录'}`,
    `运行环境：${navigator.userAgent || '未知浏览器环境'}`,
    `当前任务已运行：${currentRunStartedAt ? ((Date.now() - currentRunStartedAt) / 1000).toFixed(1) + ' 秒' : '未运行'}`,
    '说明：包含阶段、任务 ID、轮次、阶段状态、目标标签页、耗时、原始错误摘要及可能的异常堆栈；不包含完整对话正文或上传文件原文。',
    ''
  ];
  const selected = els.diagnosticsScope?.value === 'all' || !currentRunId
    ? diagnostics
    : diagnostics.filter(d => d.runId === currentRunId || !d.runId);
  report.push(`本报告包含 ${selected.length} 条诊断记录；错误 ${selected.filter(d => d.level === 'error').length} 条，警告 ${selected.filter(d => d.level === 'warning').length} 条，成功 ${selected.filter(d => d.level === 'success').length} 条。`, '');
  for (const d of selected) {
    const meta = [
      `[${d.time}]`, `[${String(d.level || 'info').toUpperCase()}]`,
      `任务=${d.runId || '未关联'}`, `轮次=${d.turn || 0}`, `阶段状态=${d.phase || '未知'}`,
      Number.isFinite(d.elapsedMs) ? `任务内=${(d.elapsedMs / 1000).toFixed(1)}s` : '',
      d.provider ? providerName(d.provider) : '', d.tabId ? `标签页=${d.tabId}` : ''
    ].filter(Boolean).join(' ');
    report.push(`${meta}\n${d.stage}：${d.title}${d.category ? '\n错误类别：' + d.category : ''}${d.details ? '\n详情：' + d.details : ''}${d.advice ? '\n建议：' + d.advice : ''}`);
  }
  report.push('', '首要排查方式：找到本任务第一条 ERROR，优先检查它之前最后一条 SUCCESS 与该 ERROR 的阶段是否一致；后续的“对话中断”通常是结果，不一定是根因。');
  return report.join('\n\n');
}
async function restoreDiagnostics() {
  try {
    const saved = await chrome.storage.local.get(['duoLabDiagnosticsV051']);
    diagnostics = Array.isArray(saved.duoLabDiagnosticsV051) ? saved.duoLabDiagnosticsV051.slice(-MAX_DIAGNOSTICS) : [];
    // Older diagnostic records did not carry a task ID; keep them explicitly unassociated.
    diagnostics = diagnostics.map(d => ({ ...d, runId: d.runId || '', turn: Number(d.turn) || 0, phase: d.phase || '' }));
    if (diagnostics.length) {
      const latestRunEvent = [...diagnostics].reverse().find(d => d.runId);
      const latestEntryAt = Number(entries[entries.length - 1]?.timestamp) || 0;
      const latestDiagnosticAt = Number(latestRunEvent?.timestamp) || 0;
      if (latestRunEvent && (!currentRunId || latestDiagnosticAt >= latestEntryAt)) {
        currentRunId = latestRunEvent.runId;
        if (!entries.some(entry => entry.runId === currentRunId)) currentRunTitle = '';
        if (!currentRunStartedAt) {
          const runEvents = diagnostics.filter(d => d.runId === currentRunId && Number(d.timestamp) > 0);
          if (runEvents.length) currentRunStartedAt = Math.min(...runEvents.map(d => Number(d.timestamp)));
        }
      }
    }
  } catch (e) { diagnostics = []; }
  renderDiagnostics();
}

async function persistEntries() {
  const saved = entries.slice(-MAX_SAVED_ENTRIES).map(e => ({
    provider: e.provider, label: e.label || '', time: e.time || new Date().toLocaleString(),
    text: String(e.text || '').slice(0, MAX_SAVED_ENTRY_CHARS), runId: e.runId || '',
    runTitle: String(e.runTitle || '').slice(0, 180), turn: Number(e.turn) || 0,
    timestamp: Number(e.timestamp) || Date.now()
  }));
  try { await chrome.storage.local.set({ duoLabEntriesV021: saved }); }
  catch (error) { setState('警告：插件记录未能写入本机存储，请立即导出 TXT。'); console.error('persistEntries failed', error); }
}
function migrateEntryGroups(rawItems, now = Date.now()) {
  const raw = Array.isArray(rawItems) ? rawItems : [];
  let legacyNumber = 0;
  let legacyRunId = 'legacy_before_first_topic';
  let legacyRunTitle = '旧版未分组记录';
  const fallbackTimeBase = now - raw.length * 1000;
  return raw.map((item, index) => {
    const entry = { ...item };
    if (!entry.runId) {
      if (entry.label === '初始主题') {
        legacyNumber++;
        legacyRunId = `legacy_run_${legacyNumber}`;
        legacyRunTitle = String(entry.text || '').slice(0, 180) || `历史任务 ${legacyNumber}`;
      }
      entry.runId = legacyRunId;
      entry.runTitle = entry.runTitle || legacyRunTitle;
    }
    entry.turn = Number(entry.turn) || 0;
    entry.timestamp = Number(entry.timestamp) || Date.parse(entry.time || '') || (fallbackTimeBase + index * 1000);
    return entry;
  });
}
async function restoreEntries() {
  const saved = await chrome.storage.local.get(['duoLabEntriesV021']);
  const raw = Array.isArray(saved.duoLabEntriesV021) ? saved.duoLabEntriesV021.slice(-MAX_SAVED_ENTRIES) : [];
  const migrated = migrateEntryGroups(raw);
  entries = migrated.map(entry => sanitizeTranscriptEntry(entry));
  const sanitizedLegacyRecord = entries.some((entry, index) => entry.text !== migrated[index]?.text);
  if (entries.length) {
    const latest = entries[entries.length - 1];
    currentRunId = latest.runId || '';
    currentRunTitle = latest.runTitle || '';
  }
  renderTranscript();
  // Persist migrated run IDs so old logs remain grouped on future loads.
  if (sanitizedLegacyRecord || raw.some((item, i) => !item.runId && entries[i]?.runId)) void persistEntries();
}

async function refreshRecoveredDrafts() {
  if (!els.draftRecovery || !els.draftRecoverySelect) return;
  try {
    const saved = await chrome.storage.local.get([RECOVERED_DRAFTS_KEY]);
    const incoming = Array.isArray(saved?.[RECOVERED_DRAFTS_KEY]) ? saved[RECOVERED_DRAFTS_KEY] : [];
    const previousId = els.draftRecoverySelect.value;
    recoveredWebDrafts = incoming.filter(item => item && typeof item.text === 'string' && item.id).slice(0, 6);
    els.draftRecoverySelect.replaceChildren();
    for (const item of recoveredWebDrafts) {
      const option = document.createElement('option');
      option.value = item.id;
      const when = item.createdAt ? new Date(item.createdAt).toLocaleString() : '时间未知';
      option.textContent = `${providerName(item.provider)} · ${when} · ${Number(item.length || item.text.length)} 字符`;
      els.draftRecoverySelect.append(option);
    }
    els.draftRecovery.hidden = recoveredWebDrafts.length === 0;
    if (!recoveredWebDrafts.length) {
      els.draftRecoveryText.value = '';
      els.draftRecoveryText.hidden = true;
      return;
    }
    if (recoveredWebDrafts.some(item => item.id === previousId)) els.draftRecoverySelect.value = previousId;
    const item = recoveredWebDrafts.find(item => item.id === els.draftRecoverySelect.value) || recoveredWebDrafts[0];
    els.draftRecoverySelect.value = item.id;
    els.draftRecoverySummary.textContent = `本机恢复区有 ${recoveredWebDrafts.length} 份草稿。所选：${providerName(item.provider)}，${Number(item.length || item.text.length)} 字符。草稿不会自动发送给 AI。`;
    els.draftRecoveryText.value = item.text;
  } catch (error) {
    if (els.draftRecoverySummary) els.draftRecoverySummary.textContent = `读取本机草稿恢复区失败：${error?.message || String(error)}`;
  }
}
function selectedRecoveredDraft() {
  return recoveredWebDrafts.find(item => item.id === els.draftRecoverySelect?.value) || null;
}
if (els.draftRecoverySelect) els.draftRecoverySelect.addEventListener('change', () => {
  const item = selectedRecoveredDraft();
  if (item) {
    els.draftRecoveryText.value = item.text;
    els.draftRecoverySummary.textContent = `本机恢复区有 ${recoveredWebDrafts.length} 份草稿。所选：${providerName(item.provider)}，${Number(item.length || item.text.length)} 字符。草稿不会自动发送给 AI。`;
  }
});
if (els.toggleRecoveredDraft) els.toggleRecoveredDraft.addEventListener('click', () => {
  const item = selectedRecoveredDraft(); if (!item) return;
  const willShow = els.draftRecoveryText.hidden;
  els.draftRecoveryText.hidden = !willShow;
  els.toggleRecoveredDraft.textContent = willShow ? '隐藏草稿' : '查看草稿';
});
if (els.copyRecoveredDraft) els.copyRecoveredDraft.addEventListener('click', async () => {
  const item = selectedRecoveredDraft(); if (!item) return;
  try { await navigator.clipboard.writeText(item.text); setState('已复制本机备份的网页草稿；不会自动发送。'); }
  catch { els.draftRecoveryText.hidden = false; els.draftRecoveryText.value = item.text; setState('自动复制失败，已展开草稿，可手动选择复制。'); }
});
if (els.deleteRecoveredDraft) els.deleteRecoveredDraft.addEventListener('click', async () => {
  const item = selectedRecoveredDraft(); if (!item) return;
  if (!confirm(`确定删除这份本机草稿备份（${Number(item.length || item.text.length)} 字符）吗？此操作不会影响网页历史聊天。`)) return;
  try {
    const next = recoveredWebDrafts.filter(entry => entry.id !== item.id);
    if (next.length) await chrome.storage.local.set({ [RECOVERED_DRAFTS_KEY]: next });
    else await chrome.storage.local.remove(RECOVERED_DRAFTS_KEY);
    await refreshRecoveredDrafts();
    setState('已删除所选本机草稿备份。');
  } catch (error) { setState(`删除草稿备份失败：${error?.message || String(error)}`); }
});

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
async function refreshMaterials() {
  try {
    const [storedMaterials, savedUploadStates] = await Promise.all([
      DuoMaterials.getAll(), chrome.storage.local.get(['duoLabFileUploadStatesV060'])
    ]);
    if (savedUploadStates?.duoLabFileUploadStatesV060 && typeof savedUploadStates.duoLabFileUploadStatesV060 === 'object') {
      materialUploadStates = savedUploadStates.duoLabFileUploadStatesV060;
    }
    materials = storedMaterials.map(item => ({
      ...item,
      uploadState: materialUploadStates[item.id] || item.uploadState || { chatgpt: '未投递', deepseek: '未投递' }
    }));
    renderMaterials();
    const selected = materials.filter(m => m.selected === true).length;
    els.materialsStatus.textContent = `本机保存 ${materials.length} 个原始文件；已选中 ${selected} 个。文件尚未发送，开始讨论并确认后才会投递到 AI 网页。`;
  } catch (error) {
    els.materialsStatus.textContent = `读取本地资料库失败：${error?.message || String(error)}`;
    await recordDiagnostic('本地资料库', '读取资料列表失败', { error });
  }
}
function hasOriginalBytes(item) {
  return item?.raw instanceof ArrayBuffer || ArrayBuffer.isView(item?.raw) || item?.raw instanceof Blob;
}
function uploadStateLabel(item, provider) {
  const value = item?.uploadState?.[provider];
  return value && value !== '未投递' ? `${providerName(provider)}：${value}` : `${providerName(provider)}：待投递`;
}
function renderMaterials() {
  els.materialsList.replaceChildren();
  if (!materials.length) {
    const p = document.createElement('p'); p.className = 'empty';
    p.textContent = '还没有资料。可拖入或选择任意原始文件；扩展不会在本地识别文件内容。';
    els.materialsList.append(p); return;
  }
  for (const item of materials) {
    const card = document.createElement('div'); card.className = 'materialItem';
    const top = document.createElement('div'); top.className = 'materialTop';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = item.selected === true;
    checkbox.title = `选择后，在明确确认时将原文件发送至 ChatGPT 和 DeepSeek：${item.name}`;
    checkbox.setAttribute('aria-label', `投递原文件 ${item.name}`);
    checkbox.addEventListener('change', async () => {
      item.selected = checkbox.checked;
      try { await DuoMaterials.put(item); await refreshMaterials(); }
      catch (error) { els.materialsStatus.textContent = `保存选择失败：${error?.message || String(error)}`; }
    });
    const info = document.createElement('div'); info.className = 'materialInfo';
    const name = document.createElement('div'); name.className = 'materialName'; name.textContent = item.name;
    const meta = document.createElement('div'); meta.className = 'materialMeta';
    meta.textContent = `${String(item.type || 'FILE').toUpperCase()} · ${formatBytes(Number(item.size) || 0)} · ${item.mimeType || 'MIME 未知'} · ${hasOriginalBytes(item) ? '原文件已保存' : '缺少原始字节'}`;
    const providerStates = document.createElement('div'); providerStates.className = 'materialMeta';
    providerStates.textContent = `${uploadStateLabel(item, 'chatgpt')} · ${uploadStateLabel(item, 'deepseek')}`;
    info.append(name, meta, providerStates); top.append(checkbox, info); card.append(top);
    if (!hasOriginalBytes(item)) {
      const warning = document.createElement('div'); warning.className = 'materialWarning';
      warning.textContent = '此历史记录中没有可投递的原始文件字节，请重新导入原文件。'; card.append(warning);
    }
    if (item.migrationNote) {
      const note = document.createElement('div'); note.className = 'materialWarning'; note.textContent = item.migrationNote; card.append(note);
    }
    const actions = document.createElement('div'); actions.className = 'materialActions';
    const detailsBtn = document.createElement('button'); detailsBtn.type = 'button'; detailsBtn.textContent = '文件信息';
    const removeBtn = document.createElement('button'); removeBtn.type = 'button'; removeBtn.textContent = '删除';
    const details = document.createElement('div'); details.className = 'materialPreview'; details.hidden = true;
    details.textContent = `文件名：${item.name}\n大小：${formatBytes(Number(item.size) || 0)}\n类型：${item.mimeType || '未知'}\n保存位置：浏览器本地 IndexedDB\n处理方式：原文件投递；不做本地 OCR 或文本提取。`;
    detailsBtn.addEventListener('click', () => { details.hidden = !details.hidden; detailsBtn.textContent = details.hidden ? '文件信息' : '收起信息'; });
    removeBtn.addEventListener('click', async () => {
      if (running) { els.materialsStatus.textContent = '讨论进行中不能删除资料，请先停止讨论。'; return; }
      try {
        await DuoMaterials.remove(item.id);
        delete materialUploadStates[item.id];
        await chrome.storage.local.set({ duoLabFileUploadStatesV060: materialUploadStates });
        await refreshMaterials();
      } catch (error) { els.materialsStatus.textContent = `删除失败：${error?.message || String(error)}`; }
    });
    actions.append(detailsBtn, removeBtn); card.append(actions, details); els.materialsList.append(card);
  }
}
async function handleUpload(files, source = '文件选择') {
  const list = [...(files || [])];
  if (!list.length) {
    if (source === '拖拽') els.materialsStatus.textContent = '没有检测到可导入的文件。请拖入文件本身，不要拖入文件夹。';
    return;
  }
  if (running) {
    els.materialsStatus.textContent = '讨论进行中暂不导入资料，请先停止讨论后再导入。';
    await recordDiagnostic('原始文件导入', '导入已阻止：讨论正在进行', { details: `来源：${source}；文件数：${list.length}`, level: 'error' });
    return;
  }
  if (els.uploadMaterials.disabled) {
    els.materialsStatus.textContent = '已有一批文件正在导入，请等当前导入完成。';
    return;
  }
  els.uploadMaterials.disabled = true;
  els.materialDropZone?.classList.add('is-busy');
  let succeeded = 0; const failures = [];
  try {
    await recordDiagnostic('原始文件导入', `开始导入 ${list.length} 个文件`, { details: `来源：${source}；` + list.map(f => `${f.name} (${formatBytes(f.size)})`).join('；') });
    for (const file of list) {
      els.materialsStatus.textContent = `正在保存原文件：${file.name}（${succeeded + failures.length + 1}/${list.length}）`;
      try {
        const item = await DuoMaterials.addFile(file);
        // Re-importing a file with identical metadata may replace its bytes; clear
        // the old upload badge so it cannot imply that the new bytes were sent.
        delete materialUploadStates[item.id];
        await chrome.storage.local.set({ duoLabFileUploadStatesV060: materialUploadStates });
        succeeded++;
        await recordDiagnostic('原始文件导入', `原文件已保存在本机：${file.name}`, {
          level: 'success',
          details: `大小 ${formatBytes(file.size)}；MIME ${item.mimeType || file.type || '未知'}。没有进行本地 OCR、文本提取或外部上传。`,
          advice: '勾选文件并确认外部上传后，插件才会尝试将原文件附加到 ChatGPT 和 DeepSeek 网页。'
        });
      } catch (error) {
        failures.push(`${file.name}：${error?.message || String(error)}`);
        await recordDiagnostic('原始文件导入', `保存失败：${file.name}`, { error, details: `文件大小：${formatBytes(file.size)}；MIME：${file.type || '浏览器未提供'}` });
      }
    }
    await refreshMaterials();
    els.materialsStatus.textContent = `导入完成：成功保存 ${succeeded} 个原文件，失败 ${failures.length} 个。新导入文件默认未选中，也不会自动上传。${failures.length ? '\n' + failures.join('\n') : ''}`;
    await recordDiagnostic('原始文件导入', `导入结束：成功 ${succeeded}，失败 ${failures.length}`, { level: failures.length ? 'warning' : 'success', details: failures.join('\n') || '原文件字节已保存到 IndexedDB。' });
  } catch (error) {
    els.materialsStatus.textContent = `导入流程异常：${error?.message || String(error)}`;
    await recordDiagnostic('原始文件导入', '导入流程出现未预期错误', { error, details: `来源：${source}；文件数：${list.length}` });
  } finally {
    els.uploadMaterials.disabled = false;
    els.materialDropZone?.classList.remove('is-busy', 'is-dragging', 'is-error');
    els.fileInput.value = '';
  }
}

function providerFromUrl(url = '') {
  const value = String(url).toLowerCase();
  if (value.includes('deepseek')) return 'deepseek';
  if (value.includes('chatgpt') || value.includes('openai')) return 'chatgpt';
  return null;
}
function providerName(p) { if (p === 'chatgpt') return 'ChatGPT'; if (p === 'deepseek') return 'DeepSeek'; if (p === 'user') return '你'; return '系统'; }
function inspectAttachmentAccessFailure(value) {
  // Evaluate individual clauses, not the whole answer. A task answer may discuss
  // hypothetical unreadable files or repeat the prompt's safety requirements;
  // those are not evidence that the current upload failed.
  const text = String(value || '').slice(0, 12000).normalize('NFKC');
  const clauses = text.split(/[\n。！？!?；;]+/u).map(part => part.trim()).filter(Boolean);
  const hypotheticalOrMeta = /(?:如果|若|假如|倘若|例如|比如|举例|假设|是否|可能|或许|不代表|并不意味着|不能仅凭|不可仅凭|要求|提示词|任务要求|验收标准|需要明确指出|应当指出|must state|if (?:the|a|any)|for example|hypothetical|does not mean|cannot infer)/iu;
  const explicitDenialPatterns = [
    /(?:当前会话|本会话|这个对话|此对话).{0,24}(?:没有|无|未检测到).{0,18}(?:可访问|可用|已上传|已附加)?\s*(?:的)?\s*(?:文件|附件)/iu,
    /(?:当前会话|本会话|这个对话|此对话).{0,24}(?:无法|不能).{0,16}(?:访问|读取|查看|打开).{0,12}(?:文件|附件)/iu,
    /我(?:目前|现在)?(?:看不到|无法访问|无法读取|不能访问|不能读取|没有收到|未收到|没有看到|未看到).{0,20}(?:附件|文件|上传的文档)/iu,
    /(?:i|we)\s+(?:can(?:not|'t)|could not|cannot)\s+(?:access|read|see|open).{0,30}(?:file|attachment|document)/iu,
    /no (?:accessible |available |attached )?(?:file|files|attachment|attachments|document|documents) (?:was|were|is|are) (?:provided|attached|available|accessible)/iu,
    /i (?:don't|do not) have access to (?:the )?(?:uploaded |attached )?(?:file|files|attachment|document)/iu
  ];
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    // Ignore conditional, instructional, and explicitly non-evidentiary clauses.
    if (hypotheticalOrMeta.test(clause)) continue;
    for (let ruleIndex = 0; ruleIndex < explicitDenialPatterns.length; ruleIndex++) {
      if (explicitDenialPatterns[ruleIndex].test(clause)) {
        return { matched: true, rule: ruleIndex + 1, clauseIndex: i + 1 };
      }
    }
  }
  return { matched: false, rule: 0, clauseIndex: 0 };
}
function looksLikeAttachmentAccessFailure(value) {
  return inspectAttachmentAccessFailure(value).matched;
}
function setState(text) { els.runState.textContent = text; }
function updateEndButtonState() {
  if (!els.endBtn) return;
  const configuredLastTurnReached = Number.isFinite(activeRunMaxTurns) && activeTurnNumber >= activeRunMaxTurns;
  const finalTurnAlreadyScheduled = requestedFinalTurn !== null;
  els.endBtn.disabled = !running || configuredLastTurnReached || finalTurnAlreadyScheduled;
  els.endBtn.textContent = finalTurnAlreadyScheduled ? '已安排结束' : '结束';
  els.endBtn.title = finalTurnAlreadyScheduled
    ? `第 ${requestedFinalTurn} 次回答已设为最后一轮。`
    : '若 AI 正在回答，让当前回答完成后再进行最后一轮；若下一轮尚未发送，则直接将下一轮设为最后一轮。';
}
function setRunning(value) {
  running = value;
  els.startBtn.disabled = value;
  els.stopBtn.disabled = !value;
  els.refreshTabs.disabled = value;
  els.rounds.disabled = value;
  els.customRounds.disabled = value;
  if (els.conversationMode) els.conversationMode.disabled = value;
  if (els.discussionGuidance) els.discussionGuidance.disabled = value;
  if (els.newChatPerRun) els.newChatPerRun.disabled = value;
  if (els.askToConclude) els.askToConclude.disabled = value;
  updateEndButtonState();
}
function getRequestedFinalTurn() {
  // Before the current prompt is committed, mark this pending turn final.
  // Once a prompt is committed or a reply has completed, schedule the next turn.
  return activeTurnPhase === 'preparing'
    ? Math.max(1, activeTurnNumber)
    : activeTurnNumber + 1;
}
function getRoundConfig() {
  const choice = els.rounds.value;
  if (choice === 'unlimited') return { maxTurns: Infinity, label: '不限制' };
  if (choice === 'custom') {
    const raw = String(els.customRounds.value || '').trim();
    if (!/^\d+$/.test(raw)) throw new Error('自定义回答次数必须填写一个不小于 2 的偶数，例如 8、12、20。');
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 2 || value % 2 !== 0) {
      throw new Error('自定义回答次数必须是大于或等于 2 的偶数，例如 8、12、20。');
    }
    return { maxTurns: value, label: String(value) };
  }
  const value = Number(choice);
  if (![2, 4, 6].includes(value)) throw new Error('请选择 2、4、6 次回答、自定义偶数或不限制。');
  return { maxTurns: value, label: String(value) };
}
function refreshRoundControls() {
  const custom = els.rounds.value === 'custom';
  els.customRoundsWrap.hidden = !custom;
  if (!custom) {
    els.customRounds.removeAttribute('aria-invalid');
    els.roundsHelp.textContent = '请输入大于或等于 2 的偶数，例如 8、12、20。';
    els.roundsHelp.style.color = '';
    return;
  }
  try {
    getRoundConfig();
    els.customRounds.setAttribute('aria-invalid', 'false');
    els.roundsHelp.textContent = `有效设置：${els.customRounds.value} 次回答。`;
    els.roundsHelp.style.color = 'var(--accent)';
  } catch (error) {
    els.customRounds.setAttribute('aria-invalid', 'true');
    els.roundsHelp.textContent = error.message;
    els.roundsHelp.style.color = 'var(--danger)';
  }
}
function appendEntry(provider, text, label = '') {
  const normalizedEntry = sanitizeTranscriptEntry({ provider, text: String(text == null ? '' : text) });
  const entry = {
    provider, text: normalizedEntry.text, label, time: new Date().toLocaleString(), timestamp: Date.now(),
    runId: currentRunId || 'unassociated', runTitle: currentRunTitle || '未关联任务',
    turn: activeTurnNumber || 0
  };
  entries.push(entry);
  if (entries.length > MAX_SAVED_ENTRIES) entries = entries.slice(-MAX_SAVED_ENTRIES);
  renderTranscript();
  void persistEntries();
  return entry;
}
function renderTranscript() {
  if (!els.transcript) return;
  els.transcript.replaceChildren();
  let visibleEntries = entries;
  if (els.recordScope?.value !== 'all' && currentRunId) visibleEntries = entries.filter(e => e.runId === currentRunId);
  if (!visibleEntries.length) {
    const p = document.createElement('p'); p.className = 'empty';
    p.textContent = currentRunId ? '当前任务还没有对话记录；可切换到“全部任务”查看历史记录。' : '设置主题后，点击“开始对话”。';
    els.transcript.append(p); return;
  }
  let previousRun = null;
  for (const entry of visibleEntries) {
    const runId = entry.runId || 'unassociated';
    if (runId !== previousRun) {
      const divider = document.createElement('div'); divider.className = 'runDivider';
      const title = document.createElement('div'); title.className = 'runDividerTitle';
      title.textContent = `任务：${String(entry.runTitle || (entry.label === '初始主题' ? entry.text : '历史任务')).slice(0, 100)}`;
      const meta = document.createElement('div'); meta.className = 'runDividerMeta';
      meta.textContent = `任务 ID：${shortRunId(runId)}${entry.time ? ' · 首条记录：' + entry.time : ''}`;
      divider.append(title, meta); els.transcript.append(divider);
      previousRun = runId;
    }
    renderEntry(entry);
  }
  els.transcript.scrollTop = els.transcript.scrollHeight;
}
function renderEntry(entry) {
  const card = document.createElement('article');
  card.className = `message ${entry.provider || ''}`;
  const meta = document.createElement('div'); meta.className = 'meta';
  const name = document.createElement('span'); name.textContent = `${providerName(entry.provider)}${entry.label ? ' · ' + entry.label : ''}${entry.turn ? ` · 轮次 ${entry.turn}` : ''}`;
  const time = document.createElement('span'); time.textContent = entry.time;
  const body = document.createElement('div'); body.className = 'body'; body.textContent = sanitizeTranscriptEntry(entry).text;
  meta.append(name, time); card.append(meta, body); els.transcript.append(card);
}
function addSystem(text) { appendEntry(null, text, '系统'); }
function logText() {
  const selected = els.recordScope?.value === 'all' || !currentRunId ? entries : entries.filter(e => e.runId === currentRunId);
  const lines = [];
  let previousRun = null;
  for (const e of selected) {
    const runId = e.runId || 'unassociated';
    if (runId !== previousRun) {
      lines.push(`【任务开始】${e.runTitle || '历史任务'}\n任务 ID：${runId}\n开始记录：${e.time || ''}`);
      previousRun = runId;
    }
    lines.push(`[${e.time}] ${e.label === '系统' ? '系统' : providerName(e.provider)}${e.label && e.label !== '系统' ? ' · ' + e.label : ''}${e.turn ? ' · 第 ' + e.turn + ' 轮' : ''}\n${sanitizeTranscriptEntry(e).text}`);
  }
  return lines.join('\n\n' + '─'.repeat(32) + '\n\n');
}
async function refreshTabs() {
  const tabs = await chrome.tabs.query({});
  const chatgpt = tabs.filter(t => providerFromUrl(t.url) === 'chatgpt');
  const deepseek = tabs.filter(t => providerFromUrl(t.url) === 'deepseek');
  fillSelect(els.chatgptTab, chatgpt, '没有找到 ChatGPT 标签页');
  fillSelect(els.deepseekTab, deepseek, '没有找到 DeepSeek 标签页');
  const selectedChatGPT = chatgpt.find(t => String(t.id) === els.chatgptTab.value) || chatgpt[0];
  const selectedDeepSeek = deepseek.find(t => String(t.id) === els.deepseekTab.value) || deepseek[0];
  await checkTab('chatgpt', selectedChatGPT);
  await checkTab('deepseek', selectedDeepSeek);
}
function fillSelect(select, tabs, emptyText) {
  const previous = select.value;
  select.replaceChildren();
  if (!tabs.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = emptyText; select.append(option); return;
  }
  tabs.forEach((tab, i) => {
    const option = document.createElement('option'); option.value = String(tab.id);
    let host = ''; try { host = new URL(tab.url).hostname; } catch {}
    option.textContent = `${tab.title || host || '未命名标签页'}${i === 0 ? '（最近匹配）' : ''}`;
    select.append(option);
  });
  if ([...select.options].some(o => o.value === previous)) select.value = previous;
}
async function checkTab(provider, tab) {
  const statusEl = provider === 'chatgpt' ? els.chatgptStatus : els.deepseekStatus;
  if (!tab) { statusEl.textContent = '未找到对应网页'; return; }
  try {
    let response;
    try {
      response = await sendTabMessage(tab.id, { type: 'DUO_STATUS' }, 1800);
    } catch (firstError) {
      // Existing tabs may have been opened before the extension was installed/reloaded.
      // Try injecting the content script on demand, then retry the status message.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await new Promise(resolve => setTimeout(resolve, 250));
      response = await sendTabMessage(tab.id, { type: 'DUO_STATUS' }, 4000);
    }
    const d = response?.diagnostics || {};
    const parts = [];
    if (d.root) parts.push(`检测根 ${d.root}`);
    if (d.hasMain === false) parts.push('无 <main>（已用通用检测）');
    if (d.assistantNodes !== undefined) parts.push(`助手节点 ${d.assistantNodes}`);
    const suffix = parts.length ? ` · ${parts.join(' · ')}` : '';
    if (response?.ready) {
      statusEl.textContent = `已连接 · 输入框可用（${response.provider || provider}）${suffix}`;
    } else {
      statusEl.textContent = `网页已找到，但输入框尚未就绪（${response?.provider || provider}）${suffix}`;
    }
  } catch (error) {
    statusEl.textContent = `连接失败：${error?.message || '无法注入或读取页面'}。请检查网页地址与扩展权限`;
    await recordDiagnostic('标签页连接', `${providerName(provider)}网页连接失败`, { provider, error, details: `标签页 ID ${tab.id}；页面标题 ${tab.title || '未知'}` });
  }
}
function sendBackgroundMessage(message, timeout = 45000, hooks = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      try { hooks.onTimeout?.(); } catch (hookError) { console.warn('发送超时回调失败', hookError); }
      reject(new Error(`扩展后台发送任务等待超过 ${Math.round(timeout / 1000)} 秒；本次操作结果可能仍在后台完成，提交状态按“未知”处理，未自动重发。`));
    }, timeout);
    try {
      chrome.runtime.sendMessage(message, response => {
        const err = chrome.runtime.lastError;
        if (timedOut) {
          // Chrome may deliver the runtime callback after the side-panel deadline. Preserve
          // this late evidence for diagnostics; never turn it into an automatic resend.
          try { hooks.onLateResponse?.(err ? { ok: false, error: err.message } : response); }
          catch (hookError) { console.warn('迟到的后台发送回执处理失败', hookError); }
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(new Error(err.message));
        else resolve(response);
      });
    } catch (error) {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    }
  });
}

function withTimeout(operation, timeoutMs, label = '操作') {
  let timer = null;
  const task = Promise.resolve().then(() => typeof operation === 'function' ? operation() : operation);
  const timeout = new Promise((_, reject) => {
    const waitText = timeoutMs >= 1000 && timeoutMs % 1000 === 0 ? `${timeoutMs / 1000} 秒` : `${timeoutMs} 毫秒`;
    timer = setTimeout(() => reject(new Error(`${label}等待超过 ${waitText}。`)), timeoutMs);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

function sendTabMessageOnce(tabId, message, timeout = 105000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error('页面响应超时')); }
    }, timeout);
    try {
      chrome.tabs.sendMessage(Number(tabId), message, response => {
        const err = chrome.runtime.lastError;
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(new Error(err.message));
        else resolve(response);
      });
    } catch (error) {
      if (!done) { done = true; clearTimeout(timer); reject(error); }
    }
  });
}

function isMissingReceiver(error) {
  return /receiving end does not exist|could not establish connection|no receiving end/i.test(String(error?.message || error || ''));
}

async function injectFreshContentScript(tabId) {
  // Injection is deliberately attempted only after Chrome reports that the tab
  // has no message receiver, avoiding routine duplicate listeners. Some page
  // transitions can leave executeScript pending; bound the whole operation so
  // a status/answer message cannot stall the side panel indefinitely.
  await withTimeout(() => chrome.scripting.executeScript({
    target: { tabId: Number(tabId) },
    files: ['content.js']
  }), 7000, `向标签页 ${Number(tabId)} 注入网页脚本`);
  await new Promise(resolve => setTimeout(resolve, 180));
}

async function sendTabMessage(tabId, message, timeout = 105000) {
  try {
    return await sendTabMessageOnce(tabId, message, timeout);
  } catch (firstError) {
    if (!isMissingReceiver(firstError)) throw firstError;
    try {
      await injectFreshContentScript(tabId);
    } catch (injectError) {
      throw new Error(`网页没有接收端，且重新注入脚本失败：${injectError?.message || String(injectError)}`);
    }
    try {
      return await sendTabMessageOnce(tabId, message, timeout);
    } catch (retryError) {
      throw new Error(`网页通信失败；自动重新注入后仍未收到响应。原始错误：${retryError?.message || String(retryError)}`);
    }
  }
}
function sendRuntimeMessageWithTimeout(message, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`等待文件控件预检超过 ${Math.round(timeoutMs / 1000)} 秒。`));
    }, timeoutMs);
    chrome.runtime.sendMessage(message, response => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function hasRawBytesForTransfer(item) {
  return item?.raw instanceof ArrayBuffer || ArrayBuffer.isView(item?.raw) || item?.raw instanceof Blob;
}
function fnv1aBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { hash ^= bytes[i]; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
function bytesToBase64(bytes) {
  let binary = '';
  const stride = 0x8000;
  for (let i = 0; i < bytes.length; i += stride) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + stride, bytes.length)));
  return btoa(binary);
}
async function transferOriginalFilesInMemory(tabId, provider, selectedItems, chosenInput) {
  const transferId = `duo${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(2)).join('_')}`;
  const chunksPerFile = [];
  let totalBytes = 0;
  for (const item of selectedItems) {
    const buffer = await DuoMaterials.toArrayBuffer(item.raw);
    if (buffer.byteLength !== Number(item.size)) throw new Error(`文件 ${item.name} 原始字节长度不匹配。`);
    const bytes = new Uint8Array(buffer);
    totalBytes += bytes.byteLength;
    const meta = {
      id:item.id, name:item.name, size:bytes.byteLength,
      mimeType:item.mimeType || DuoMaterials.mimeForName(item.name) || 'application/octet-stream',
      lastModified:Number(item.lastModified) || Date.now(), checksum:fnv1aBuffer(buffer)
    };
    chunksPerFile.push({ meta, bytes });
  }
  if (totalBytes > DuoMaterials.MAX_SELECTED_UPLOAD_BYTES) throw new Error('所选原始文件总量超过单次投递限制。');

  const begin = await sendTabMessage(tabId, {
    type:'DUO_RAW_FILE_TRANSFER_BEGIN', transferId, provider,
    inputIndex:Number(chosenInput.index), totalBytes,
    files:chunksPerFile.map(item => item.meta)
  }, 15000);
  if (!begin?.ok) throw new Error(begin?.error || '网页内容脚本没有接受内存文件传输初始化。');

  let transferredBytes = 0;
  try {
    const CHUNK_BYTES = 384 * 1024;
    for (let fileIndex = 0; fileIndex < chunksPerFile.length; fileIndex++) {
      const { bytes, meta } = chunksPerFile[fileIndex];
      let chunkIndex = 0;
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES, chunkIndex++) {
        const slice = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length));
        const response = await sendTabMessage(tabId, {
          type:'DUO_RAW_FILE_TRANSFER_CHUNK', transferId, fileIndex, chunkIndex,
          byteLength:slice.byteLength, data:bytesToBase64(slice)
        }, 20000);
        if (!response?.ok) throw new Error(response?.error || `文件 ${meta.name} 第 ${chunkIndex + 1} 个数据块未被网页接受。`);
        transferredBytes += slice.byteLength;
      }
    }
    if (transferredBytes !== totalBytes) throw new Error(`文件传输总字节数不匹配：${transferredBytes}/${totalBytes}。`);
    const committed = await sendTabMessage(tabId, { type:'DUO_RAW_FILE_TRANSFER_COMMIT', transferId }, 30000);
    if (!committed?.ok) throw new Error(committed?.error || '网页文件输入控件未能接收内存中的原始文件。');
    return { ...committed, transferId, totalBytes, transferredBytes };
  } catch (error) {
    await sendTabMessage(tabId, { type:'DUO_RAW_FILE_TRANSFER_ABORT', transferId }, 3000).catch(() => {});
    throw error;
  }
}

// v0.10.7：诊断证据不再用 JSON.stringify(...).slice(0,7000) 一刀切。
// 那会把「核验历史」「最终分类」「附件卡片证据」这类决定性的字段整段截掉，
// 用户拿到的报告只剩侧边栏噪声。这里改为：结论字段优先且永不丢弃，
// 明细按剩余预算依次追加，总长度仍有上界。
function boundedEvidenceJson(evidence, maxTotal = 11000) {
  const pick = (value, limit) => {
    if (value === undefined || value === null) return '';
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    return String(raw).slice(0, limit);
  };
  // 关键：不能对序列化后的字符串直接 slice —— 那会把对象截成半截，产出非法 JSON，
  // 用户粘回来的诊断反而无法解析。这里按「条目」裁剪，保证序列化结果始终合法。
  const fit = (value, limit, maxItems = 24) => {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value.slice(0, maxItems)) {
        const candidate = out.concat([item]);
        if (JSON.stringify(candidate).length > limit) break;
        out.push(item);
      }
      return out;
    }
    if (typeof value === 'object') {
      if (JSON.stringify(value).length <= limit) return value;
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        const candidate = { ...out, [key]: item };
        if (JSON.stringify(candidate).length > limit) break;
        out[key] = item;
      }
      return out;
    }
    return String(value).slice(0, limit);
  };
  const conclusion = {
    failureClass: evidence?.failureClass || 'unclassified',
    failureDetail: pick(evidence?.failureDetail, 900),
    matched: Array.isArray(evidence?.matched) ? evidence.matched.slice(0, 8) : [],
    missing: Array.isArray(evidence?.missing) ? evidence.missing.slice(0, 8) : [],
    counts: evidence?.counts || {},
    baselineCounts: evidence?.baselineCounts || {},
    cardCount: Number(evidence?.cardCount || 0),
    cardPresentNoName: Array.isArray(evidence?.cardPresentNoName) ? evidence.cardPresentNoName.slice(0, 8) : [],
    busy: !!evidence?.busy,
    busyReason: pick(evidence?.busyReason, 200),
    pageError: pick(evidence?.pageError, 200),
    scopeBox: evidence?.scopeBox || null,
    composerRect: evidence?.composerRect || null,
    hadImmediateUploadEvidence: evidence?.hadImmediateUploadEvidence === true
  };
  let out = JSON.stringify(conclusion);
  const append = (key, value, limit = 3000) => {
    if (value === undefined || value === null) return;
    const fitted = fit(value, limit);
    if (fitted === null) return;
    const piece = `,"${key}":${JSON.stringify(fitted)}`;
    if (out.length + piece.length > maxTotal) return;
    out = out.slice(0, -1) + piece + '}';
  };
  append('attachmentCards', evidence?.attachmentCards, 3000);
  append('evidenceByName', evidence?.evidenceByName, 1500);
  append('localEvidenceByName', evidence?.localEvidenceByName, 1500);
  append('inputFileEvidenceByName', evidence?.inputFileEvidenceByName, 1200);
  append('nativeFileInputState', evidence?.nativeFileInputState, 1200);
  append('transferInput', evidence?.transferInput, 800);
  if (evidence?.transferImmediateEvidence) {
    const immediate = evidence.transferImmediateEvidence;
    append('transferImmediateEvidence', {
      matched: immediate.matched || [], cardCount: immediate.cardCount || 0,
      busy: !!immediate.busy, pageError: immediate.pageError || '',
      attachmentCards: Array.isArray(immediate.attachmentCards) ? immediate.attachmentCards.slice(0, 6) : []
    }, 2000);
  }
  // 核验历史从最新往回取，保证「最后一次采样」一定在报告里。
  const history = Array.isArray(evidence?.verificationHistory) ? evidence.verificationHistory : [];
  const kept = [];
  for (let i = history.length - 1; i >= 0 && kept.length < 10; i -= 1) kept.unshift(history[i]);
  append('verificationHistory', kept, 6000);
  append('diagnosticNodes', evidence?.diagnosticNodes, 6000);
  return out;
}

async function attachOriginalFilesToTab(tabId, provider, selectedItems) {
  const stageStartedAt = Date.now();
  const stage = async (name, message, details = '', level = 'info') => {
    setState(`${providerName(provider)}附件投递：${message}`);
    await recordDiagnostic('附件投递进度', `${providerName(provider)}：${message}`, {
      provider, tabId, level,
      details: `${details}${details ? '；' : ''}阶段累计耗时 ${Date.now() - stageStartedAt} ms。`
    });
  };
  const totalBytes = selectedItems.reduce((sum, item) => sum + Number(item.size || 0), 0);
  if (totalBytes > DuoMaterials.MAX_SELECTED_UPLOAD_BYTES) {
    return { ok:false, confirmed:false, needsManual:true, error:`所选文件总量 ${formatBytes(totalBytes)} 超过本扩展单次投递上限 ${formatBytes(DuoMaterials.MAX_SELECTED_UPLOAD_BYTES)}。` };
  }
  if (!selectedItems.length || selectedItems.some(item => !hasRawBytesForTransfer(item))) {
    return { ok:false, confirmed:false, needsManual:false, baselineKnown:false, error:'至少一个所选资料没有原始文件字节，请重新导入。' };
  }
  const fileMeta = selectedItems.map(item => ({ name:item.name, size:Number(item.size), mimeType:item.mimeType || DuoMaterials.mimeForName(item.name) || 'application/octet-stream' }));
  let baseline;
  try {
    await stage('附件基线', `正在检查 ${providerName(provider)} 当前输入区`, `文件数 ${selectedItems.length}；总大小 ${formatBytes(totalBytes)}；阶段=baseline-start`);
    baseline = await withTimeout(
      () => sendTabMessage(tabId, { type:'DUO_ATTACHMENT_BASELINE', fileNames:selectedItems.map(item => item.name) }, 12000),
      14000, `${providerName(provider)}附件基线检查`
    );
    if (!baseline?.ok || !baseline?.composerFound || !baseline.counts || typeof baseline.counts !== 'object') {
      throw new Error(baseline?.reason || baseline?.error || '网页输入区未就绪或未返回有效基线');
    }
    await stage('附件基线', '输入区基线检查完成', `文件名基线计数已取得；输入区已找到；阶段=baseline-done`, 'success');
  } catch (error) {
    await recordDiagnostic('附件投递进度', `${providerName(provider)}附件基线检查失败`, { provider, tabId, level:'error', error, details:`阶段=baseline-failed；累计耗时 ${Date.now() - stageStartedAt} ms。` });
    return { ok:false, confirmed:false, baselineKnown:false, needsManual:false, error:`无法建立附件基线：${error?.message || String(error)}。已阻止发送主题。` };
  }
  const baselineCounts = { ...baseline.counts, __inputFileSignatures: baseline.inputFileSignatures || [] };

  let probe;
  try {
    await stage('文件控件预检', '正在定位网页原生文件控件', `文件数 ${fileMeta.length}；阶段=probe-start`);
    probe = await withTimeout(
      () => sendRuntimeMessageWithTimeout({ type:'DUO_CDP_PROBE_FILES', tabId, provider, files:fileMeta }, 20000),
      22000, `${providerName(provider)}文件控件预检`
    );
    if (!probe?.ok || !probe?.chosen) {
      const reason = probe?.error || '没有找到当前聊天框的文件输入控件。';
      await recordDiagnostic('附件投递进度', `${providerName(provider)}文件控件预检未通过`, {
        provider, tabId, level:'warning',
        details:`阶段=probe-unavailable；原因=${String(reason).slice(0, 500)}；累计耗时 ${Date.now() - stageStartedAt} ms。`
      });
      return { ok:false, confirmed:false, baselineKnown:true, baselineCounts, needsManual:true, error:reason, inputDiagnostics:probe?.inputDiagnostics || [] };
    }
    await stage('文件控件预检', '已找到候选文件控件', `控件索引 ${Number(probe.chosen.index)}；阶段=probe-done`, 'success');
  } catch (error) {
    await recordDiagnostic('附件投递进度', `${providerName(provider)}文件控件预检失败`, { provider, tabId, level:'error', error, details:`阶段=probe-failed；累计耗时 ${Date.now() - stageStartedAt} ms。` });
    return { ok:false, confirmed:false, baselineKnown:true, baselineCounts, needsManual:true, error:`网页上传控件预检失败：${error?.message || String(error)}`, inputDiagnostics:probe?.inputDiagnostics || [] };
  }

  let assignment;
  try {
    await stage('原始字节传输', '正在以内存分块传输原始文件', `文件数 ${selectedItems.length}；总大小 ${formatBytes(totalBytes)}；阶段=transfer-start；不创建 Downloads 临时副本`);
    assignment = await withTimeout(
      () => transferOriginalFilesInMemory(tabId, provider, selectedItems, probe.chosen),
      90000, `${providerName(provider)}原始文件内存传输`
    );
    await stage('原始字节传输', '原始字节已交给网页文件控件，开始核验附件卡片', `已传输 ${formatBytes(assignment.transferredBytes || 0)} / ${formatBytes(assignment.totalBytes || totalBytes)}；阶段=transfer-done；事件后原生控件文件数=${(assignment.afterDispatch || []).length}；即时界面匹配=${(assignment.immediateEvidence?.matched || []).length}/${selectedItems.length}；控件仍连接=${assignment.input?.connected === true}；控件身份未变=${assignment.input?.stillSameInput === true}`, 'success');
  } catch (error) {
    await sendTabMessage(tabId, { type:'DUO_RAW_FILE_TRANSFER_ABORT', transferId:assignment?.transferId || '' }, 3000).catch(() => {});
    await recordDiagnostic('内存附件投递', '无法把原始文件直接交给网页文件控件', {
      provider, tabId, level:'error', details:`${error?.message || String(error)}。本版本不会创建 Downloads 临时文件。阶段=transfer-failed；累计耗时 ${Date.now() - stageStartedAt} ms。`
    });
    return { ok:false, confirmed:false, baselineKnown:true, baselineCounts, needsManual:true, error:`内存附件投递失败：${error?.message || String(error)}`, inputDiagnostics:probe?.inputDiagnostics || [] };
  }

  // Keep attachment confirmation bounded and visible. The previous 240s wait made
  // a successfully populated file input look frozen when DOM evidence was delayed.
  const timeoutMs = provider === 'chatgpt' ? 45000 : 35000;
  let verification;
  try {
    await stage('附件可见性核验', `文件已交给网页，正在确认 ${selectedItems.length} 个附件在当前输入区可见`, `核验上限 ${Math.round(timeoutMs / 1000)} 秒；阶段=verify-start；注意：文件控件已赋值不等于网页附件卡片已确认`);
    verification = await withTimeout(
      () => sendTabMessage(tabId, {
        type:'DUO_VERIFY_ATTACHMENTS', fileNames:selectedItems.map(item => item.name), baselineCounts, timeoutMs, initialEvidence:assignment?.immediateEvidence || null
      }, timeoutMs + 5000),
      timeoutMs + 7000, `${providerName(provider)}附件可见性核验`
    );
  } catch (error) {
    await recordDiagnostic('附件投递进度', `${providerName(provider)}附件可见性核验通信失败或超时`, {
      provider, tabId, level:'error', error,
      details:`阶段=verify-failed；核验上限 ${timeoutMs} ms；累计耗时 ${Date.now() - stageStartedAt} ms；文件已交给网页输入控件，但不能据此认定网页已接受全部附件。`
    });
    return { ok:false, confirmed:false, baselineKnown:true, baselineCounts, needsManual:true, error:`文件已交给网页输入控件，但附件可见性核验失败：${error?.message || String(error)}`, inputDiagnostics:probe?.inputDiagnostics || [], assignment };
  }
  if (!verification?.ok || !verification.confirmed) {
    const reason = verification?.reason || verification?.error || '文件已赋给网页输入控件，但当前聊天输入区未能确认所有附件已被网站接受。';
    const evidenceDiagnostics = {
      failureClass:verification?.failureClass || (verification?.error ? 'page-upload-error' : verification?.busy ? 'upload-still-busy' : 'unclassified'),
      failureDetail:verification?.failureDetail || '',
      matched:verification?.matched || [], missing:verification?.missing || selectedItems.map(item => item.name),
      counts:verification?.counts || {}, baselineCounts:verification?.baselineCounts || baselineCounts,
      evidenceByName:verification?.evidenceByName || {}, localEvidenceByName:verification?.localEvidenceByName || {},
      inputFileEvidenceByName:verification?.inputFileEvidenceByName || {},
      attachmentCards:verification?.attachmentCards || [], cardCount:Number(verification?.cardCount || 0),
      cardPresentNoName:verification?.cardPresentNoName || [], scopeBox:verification?.scopeBox || null,
      nativeFileInputState:verification?.nativeFileInputState || [],
      inputFileSignatures:verification?.inputFileSignatures || [],
      composerRect:verification?.composerRect || null, evidenceScope:verification?.evidenceScope || 'unavailable', diagnosticNodes:verification?.diagnosticNodes || [],
      busy:!!verification?.busy, busyReason:verification?.busyReason || '', pageError:verification?.error || '',
      transferAfterDispatch:assignment?.afterDispatch || [],
      transferInput:assignment?.input || null,
      transferImmediateEvidence:assignment?.immediateEvidence || null,
      verificationInitialEvidence:verification?.initialEvidence || null,
      verificationHistory:verification?.evidenceHistory || [],
      hadImmediateUploadEvidence:verification?.hadImmediateUploadEvidence === true,
      transferNote:assignment?.note || ''
    };
    await stage('附件可见性核验', '自动核验未能确认全部附件，将暂停并请求人工核对', `阶段=verify-unconfirmed；故障分类=${evidenceDiagnostics.failureClass}；判定依据=${String(evidenceDiagnostics.failureDetail || '').slice(0, 400)}；匹配 ${verification?.matched?.length || 0}/${selectedItems.length}；缺失 ${(verification?.missing || selectedItems.map(item => item.name)).join('、')}；原因=${String(reason).slice(0, 350)}；核验证据=${boundedEvidenceJson(evidenceDiagnostics)}`, 'warning');
    return { ok:false, confirmed:false, baselineKnown:true, baselineCounts, needsManual:true,
      error:reason, matchedVisibleNames:verification?.matched || [], missing:verification?.missing || selectedItems.map(item => item.name),
      inputDiagnostics:probe?.inputDiagnostics || [], assignment, transfer:{ totalBytes:assignment.totalBytes, transferredBytes:assignment.transferredBytes, input:assignment.input } };
  }
  await stage('附件可见性核验', '已确认全部附件稳定可见，继续发送本轮提示词', `阶段=verify-confirmed；匹配 ${verification.matched?.length || selectedItems.length}/${selectedItems.length}；稳定采样 ${verification.stableSamples || '未知'} 次；稳定时长 ${verification.stableMs || 0} ms`, 'success');
  return { ok:true, confirmed:true, baselineKnown:true, baselineCounts, files:selectedItems.map(item => item.name), fileCount:selectedItems.length,
    evidence:'memory-FileList + input/change events + full-page visible filename occurrence delta + local upload-state check',
    matchedVisibleNames:verification.matched || selectedItems.map(item => item.name), evidenceByName:verification.evidenceByName || {},
    stableSamples:verification.stableSamples, stableMs:verification.stableMs, requiredStableMs:verification.requiredStableMs,
    transfer:{ totalBytes:assignment.totalBytes, transferredBytes:assignment.transferredBytes, input:assignment.input, afterDispatch:assignment.afterDispatch },
    inputDiagnostics:probe.inputDiagnostics || [], note:'未创建下载目录临时副本。附件卡片稳定可见表示网页已接受文件；不代表 AI 已成功解析文件内容。' };
}

async function updateMaterialsUploadState(items, provider, state) {
  for (const item of items) {
    const uploadState = { ...(materialUploadStates[item.id] || item.uploadState || { chatgpt: '未投递', deepseek: '未投递' }), [provider]: state };
    materialUploadStates[item.id] = uploadState;
    item.uploadState = uploadState;
  }
  // Keep per-site state separate so updating a badge does not rewrite large binary files in IndexedDB.
  await chrome.storage.local.set({ duoLabFileUploadStatesV060: materialUploadStates });
  await refreshMaterials();
}
async function pauseForManualAttachment(info) {
  manualAttachmentPending = info;
  els.manualAttachFallback.hidden = false;
  if (els.manualAttachVisualConfirm) els.manualAttachVisualConfirm.checked = false;
  if (els.manualAttachVisualContinue) els.manualAttachVisualContinue.disabled = true;
  els.manualAttachMessage.textContent = `目标：${providerName(info.provider)}。自动投递结果：${info.reason}。先检查对应网页当前消息输入区：如果附件未显示或仍在上传，请手动补传并等待完成，再点“重新检查网页附件”。如果附件确实显示但自动检测一直漏报，可勾选下方人工确认；该路径会明确记录为“用户人工目视确认”，不会伪装成自动检测成功。文件：${info.files.map(file => file.name).join('、')}`;
  setState(`暂停：请在 ${providerName(info.provider)} 网页核对附件，完成后继续。`);
  els.materialsStatus.textContent = `等待核验：${providerName(info.provider)} 当前输入区是否显示全部指定文件名。`;
  try { await chrome.tabs.update(Number(info.tabId), { active: true }); } catch {}
  await recordDiagnostic('附件回退', `自动投递未能确认：${providerName(info.provider)}`, {
    provider: info.provider, level: 'warning',
    details: `文件：${info.files.map(file => `${file.name} (${formatBytes(file.size)})`).join('；')}。原因：${info.reason}`,
    advice: '检查当前网页附件区域，确认所有文件都已添加后再继续。若网页不支持该类型，请不要继续发送；改用支持的格式重新导入。'
  });
  return new Promise(resolve => { manualAttachmentResolver = resolve; });
}

async function getSelectedTabs() {
  const chatgptId = Number(els.chatgptTab.value), deepseekId = Number(els.deepseekTab.value);
  if (!chatgptId || !deepseekId) throw new Error('请先打开并选择 ChatGPT 与 DeepSeek 网页。');
  if (chatgptId === deepseekId) throw new Error('两个选择不能是同一个标签页。');
  const [chatgpt, deepseek] = await Promise.all([chrome.tabs.get(chatgptId), chrome.tabs.get(deepseekId)]);
  if (providerFromUrl(chatgpt.url) !== 'chatgpt' || providerFromUrl(deepseek.url) !== 'deepseek') throw new Error('标签页选择不正确，请刷新列表后重新选择。');
  return { chatgpt: chatgptId, deepseek: deepseekId };
}
const UI_ONLY_REPLY_PHRASES = [
  '显示更多', '查看更多', '展开全文', '正在思考', '思考中', '正在分析', '分析中', '正在整理', '整理中', '正在处理', '处理中', '正在生成回答', '正在生成', '等待回答', '请稍等', '请稍候', '正在搜索', '搜索中',
  '已深度思考', '深度思考', '智能搜索', '联网搜索', '停止生成', '继续生成', '生成中', '重新生成',
  '重新回答', '重新发送', '复制代码', '展开', '收起', '折叠', '分享', '复制', '点赞', '点踩',
  '朗读', '编辑消息', '编辑', '删除', '引用', '追问', '重试', '新对话', '清空', '下载', '全屏',
  '预览', '查看', '保存', '最新一条回复', '最新回复', 'show more', 'view more', 'thinking',
  'analyzing', 'searching the web', 'web search', 'deep thinking', 'smart search', 'searching', 'generating',
  'thinking...', 'searching...', 'copy code', 'regenerate', 'stop generating', 'continue generating',
  'response stopped', 'try again', 'read aloud', 'share', 'copy', 'retry', 'message actions', 'copy response',
  'edit message', 'thumbs up', 'thumbs down'
].sort((a, b) => b.length - a.length);
function inspectUiOnlyExtractedReply(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return { rejected: true, matchedPhrases: [], residualLength: 0, ratio: 0 };
  let compact = text.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{P}\p{S}\p{Default_Ignorable_Code_Point}\p{Cf}]+/gu, '');
  const originalLength = compact.length;
  let matched = false;
  let removedLength = 0;
  const matchedPhrases = [];
  for (const phrase of UI_ONLY_REPLY_PHRASES) {
    const token = phrase.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{P}\p{S}\p{Default_Ignorable_Code_Point}\p{Cf}]+/gu, '');
    if (!token || !compact.includes(token)) continue;
    matched = true;
    const beforeLength = compact.length;
    compact = compact.split(token).join('');
    removedLength += beforeLength - compact.length;
    matchedPhrases.push(phrase);
  }
  const residual = compact.replace(/[^\p{L}\p{N}]/gu, '');
  const ratio = originalLength ? removedLength / originalLength : 0;
  const rejected = matched && (residual.length <= 2 || (text.length <= 48 && ratio >= 0.72 && residual.length <= 5));
  return { rejected, matchedPhrases, residualLength: residual.length, ratio, normalizedLength: originalLength };
}
function isUiOnlyExtractedReply(value) {
  return inspectUiOnlyExtractedReply(value).rejected;
}

function stripChatGPTPreferenceFeedbackText(value) {
  let text = String(value == null ? '' : value);
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
  const hasPreferenceTitle = /你更喜欢哪个\s*(?:选项|回答)|which (?:response|answer|option) do you prefer/i.test(normalized);
  const hasDescription = /告诉我们哪个选项更好.{0,24}帮助我们改善你的体验|tell us which option.{0,80}help us improve your experience/i.test(normalized);
  const hasOption1 = /(?:选项|option)\s*1/i.test(normalized);
  const hasOption2 = /(?:选项|option)\s*2/i.test(normalized);
  const hasPreferenceAction = /我更喜欢这个选项|i prefer this (?:option|response)/i.test(normalized);
  const hasSkipAction = /跳过|\bskip\b/i.test(normalized);
  // Only strip option/skip labels when the complete, distinctive feedback-card signature
  // is present. A normal answer may legitimately discuss “option 1”, “option 2”, or skipping.
  const fullPanelSignature = hasPreferenceTitle && hasDescription && hasOption1 && hasOption2 && hasPreferenceAction && hasSkipAction;
  if (!fullPanelSignature) return text;
  const patterns = [
    /你更喜欢哪个\s*(?:选项|回答)[？?]?\s*告诉我们哪个选项更好[，,]\s*帮助我们改善你的体验[。.]?\s*选项\s*1[\s\S]{0,240}?选项\s*2[\s\S]{0,240}?我更喜欢这个选项[\s\S]{0,120}?跳过/giu,
    /which (?:response|answer|option) do you prefer\??\s*tell us which option is better[,.]?\s*help us improve your experience[.!]?\s*option\s*1[\s\S]{0,240}?option\s*2[\s\S]{0,240}?i prefer this option[\s\S]{0,120}?skip/giu
  ];
  const before = text;
  for (const pattern of patterns) text = text.replace(pattern, '');
  if (text === before) {
    const cardLines = new Set([
      '你更喜欢哪个选项？', '你更喜欢哪个选项?', '你更喜欢哪个回答？', '你更喜欢哪个回答?',
      '告诉我们哪个选项更好，', '告诉我们哪个选项更好，帮助我们改善你的体验。', '帮助我们改善你的体验。',
      '选项 1', '选项1', '选项 2', '选项2', '我更喜欢这个选项', '跳过',
      'which response do you prefer?', 'which answer do you prefer?', 'which option do you prefer?',
      'tell us which option is better,', 'help us improve your experience.', 'option 1', 'option 2', 'i prefer this option', 'skip'
    ]);
    text = text.split(/\r?\n/).filter(line => !cardLines.has(String(line || '').replace(/\s+/g, ' ').trim().toLowerCase())).join('\n');
  }
  return text;
}

const UI_CHROME_EXACT_LINES = new Set([
  'to pick up a draggable item, press the space bar',
  'while dragging, use the arrow keys to move the item',
  'press space again to drop the item in its new position, or press escape to cancel',
  '最新一条回复思考', '最新回复思考', '最新一条回复', '最新回复',
  '回答已完成', '深度思考智能搜索', '已深度思考', '智能搜索',
  '显示更多', '查看更多', '展开全文', '收起', '展开', 'show more', 'read more'
]);

// Canonicalize a formula only for the narrow purpose of detecting immediately
// repeated renderings of the same equation (plain text + LaTeX/accessibility text).
// This is not a symbolic algebra engine and must not alter a lone equation.
function canonicalEquationText(value) {
  let text = String(value || '');
  text = text.replace(/\\(?:left|right)\\?\b/g, '');
  text = text.replace(/\\Delta\s*/g, 'delta').replace(/Δ/g, 'delta').replace(/δ/g, 'delta');
  for (let i = 0; i < 5; i++) {
    const before = text;
    text = text
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
      .replace(/\\(?:mathrm|text|operatorname)\s*\{([^{}]*)\}/g, '$1');
    if (text === before) break;
  }
  text = text
    .replace(/\\times|\\cdot|×|·/g, '*')
    .replace(/\\div|÷/g, '/')
    .replace(/[−–—]/g, '-')
    .replace(/\\%/g, '%')
    .replace(/\\[,;!]|\\(?:quad|qquad)\b/g, '')
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, ch => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(ch)))
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    .replace(/[{}_$\\$`]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  return text;
}

function stripRepeatedEquationRepresentations(line) {
  const text = String(line || '');
  // Deliberately limit this to ordinary variable-like left sides followed by '='.
  // It will not rewrite arbitrary math, inequalities, or multi-line derivations.
  const starts = [];
  const pattern = /(?:\\[A-Za-z]+\s*)?[A-Za-zΔδΑ-ω](?:[A-Za-z0-9\u0300-\u036f\u2080-\u209f\u200b{}\\]|_\s*\{(?:[^{}]|\{[^{}]*\})*\}|_[A-Za-z0-9]+)*\s*=/gu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    starts.push(match.index);
    if (starts.length > 20) return text; // excessive matches: do not guess
  }
  if (starts.length < 2) return text;
  const pieces = [];
  let cursor = 0;
  let lastCanonical = '';
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    if (start > cursor) pieces.push(text.slice(cursor, start));
    const segment = text.slice(start, end);
    const canonical = canonicalEquationText(segment);
    const looksEquationLike = canonical.includes('=') && canonical.length >= 4 && canonical.length <= 220;
    if (!(looksEquationLike && lastCanonical && canonical === lastCanonical)) {
      pieces.push(segment);
      if (looksEquationLike) lastCanonical = canonical;
    }
    cursor = end;
  }
  return pieces.join('');
}

function stripCitationDebrisLine(line) {
  // Some rendered/search citation artifacts are serialized as punctuation + '-NN'
  // before a stable [S#] citation or at line end. Only remove this narrow suffix;
  // do not touch ordinary negative numbers, ISO dates, arithmetic, or numbered lists.
  return String(line || '').replace(/([。；，,])\s*-\s*\d{1,3}(?=\s*(?:\[\s*S\d+\s*\]|$))/gu, '$1');
}

function stripKnownUiChromeLines(value) {
  const lines = stripChatGPTPreferenceFeedbackText(value).split(/\r?\n/);
  const kept = lines.filter(line => {
    const key = String(line || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.!。！]+$/g, '');
    if (!key) return true;
    if (UI_CHROME_EXACT_LINES.has(key)) return false;
    if (/^(?:显示更多|查看更多)?\s*(?:思考了|已思考)\s*\d+(?:\.\d+)?\s*(?:s|秒|秒钟)(?:\s*(?:显示更多|查看更多|收起))?$/iu.test(key)) return false;
    if (/^(?:回答已完成\s*){1,4}$/u.test(key)) return false;
    if (/^(?:latest reply|latest response)\s*(?:thinking)?$/i.test(key)) return false;
    return true;
  });
  const cleanedLines = kept.map(line => stripRepeatedEquationRepresentations(stripCitationDebrisLine(line)));
  // If a page exposes the same equation as adjacent standalone lines, collapse only
  // exact canonical matches where each line contains nothing except that equation.
  const out = [];
  let lastEquationOnly = '';
  for (const line of cleanedLines) {
    const trimmed = String(line || '').trim();
    const equationOnly = /^(?:\\\(|\\\[)?[^\n]{3,220}=(?:[^\n]{1,220})(?:\\\)|\\\])?$/u.test(trimmed) &&
      /^[\s$\\A-Za-z0-9ΔδΑ-ωΩα-ω_{}.,:%+*/×·÷−–()\[\]\u2080-\u209f\u200b\u0300-\u036f-]+$/u.test(trimmed);
    const canonical = equationOnly ? canonicalEquationText(trimmed) : '';
    if (equationOnly && canonical && canonical === lastEquationOnly) continue;
    out.push(line);
    lastEquationOnly = equationOnly ? canonical : '';
  }
  return out.join('\n')
    .replace(/(?:\s*To pick up a draggable item, press the space bar\.?)\s*(?:While dragging, use the arrow keys to move the item\.?)\s*(?:Press space again to drop the item in its new position, or press escape to cancel\.?)\s*$/i, '')
    .replace(/(?:\s*回答已完成){2,4}\s*$/u, '')
    .replace(/^\s*(?:(?:ChatGPT|DeepSeek)\s*(?:说|回复|回答)|(?:ChatGPT|DeepSeek)\s*(?:says|said|reply|response))\s*[:：]\s*/iu, '')
    .trim();
}
function isDeepSeekThinkingLeak(provider, value) {
  if (String(provider || '').toLowerCase() !== 'deepseek') return false;
  const text = stripKnownUiChromeLines(value).replace(/^\uFEFF/, '').trimStart();
  return /^(?:已(?:经)?(?:深度)?思考(?:\s*[（(][^）)\n]{0,80}[）)])?|思考过程|推理过程|reasoning(?:\s+process)?|thought process)\s*(?:[:：-]\s*)?/i.test(text);
}
function sanitizeTranscriptEntry(entry) {
  if (!entry || !['chatgpt', 'deepseek'].includes(String(entry.provider || '').toLowerCase())) return entry;
  const original = String(entry.text == null ? '' : entry.text);
  const cleaned = stripKnownUiChromeLines(original);
  if (isDeepSeekThinkingLeak(entry.provider, cleaned)) {
    return { ...entry, text: '（旧版本记录疑似混入 DeepSeek 思考过程，原文已隐藏；请重新运行该轮以获取最终回答。）' };
  }
  return cleaned === original ? entry : { ...entry, text: cleaned };
}
function normalizeConversationMode(value) {
  return ['free', 'task', 'explore', 'custom'].includes(String(value || '')) ? String(value) : 'free';
}
function conversationModeLabel(mode) {
  return ({ free: '自由交流', task: '任务执行', explore: '探索讨论', custom: '自定义' })[normalizeConversationMode(mode)];
}
function taskEvidenceAndCalculationRules(topic = '') {
  // Shared, domain-neutral task-execution rules. Keep specialty-specific requirements
  // in the user's actual task or its applicable contest/course/publication rules.
  return [
    '直接回应原始任务并保留原始目标。先识别任务类型、交付物、限制条件与验收标准；信息缺失时列明必要假设及其影响，并继续可完成部分，不得擅自改变原始目标或验收标准。',
    '优先正确完成，按“正确性＞完整性＞格式＞表达”推进；每轮至少产生一个可核验的实质推进（交付物更新、关键不确定性消除或证据补强）。',
    '依据实际可获取材料作答，不编造事实、数据、引用或结果，不假装读取或完成未实际完成的内容；区分事实、推断与不确定项，集中记录假设、风险、影响与缓解。',
    '竞赛、论文等任务按具体赛事、期刊或课程规则执行适用的引用、格式、匿名、查重、伦理与可复现要求，不套用无关规则。',
    '对已有成果核查逻辑、计算、数据、代码、引用与格式。遇限制说明原因及影响，并完成可完成部分。'
  ].join('\n');
}
function inspectTaskOutputQuality(text, hasPriorRelayWork = false, isFinalTurn = false) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const warnings = [];
  if (hasPriorRelayWork && /(?:(?:当前|本次|本)(?:对话|会话|上下文).{0,50}(?:只有|仅有|不存在).{0,12}(?:一个|第二个|另一).{0,8}AI|第二个AI.{0,40}(?:不存在|无法实际获取|无法获取|未参与).{0,30}(?:审阅|审阅意见))/isu.test(source)) {
    warnings.push('疑似审阅状态矛盾：本轮收到并应审阅上一轮成果，却声称不存在第二个 AI 或无法发生交叉审阅。请区分“已对上一轮做交叉审阅”与“外部来源尚未独立核验”。');
  }

  const referenceHeadings = [...source.matchAll(/(?:^|\n|[。；])\s*(?:[一二三四五六七八九十\d]+[、.．]\s*)?(?:参考文献|参考资料|资料来源|来源清单)(?:\s*[（(][^）)]{0,60}[）)])?/g)];
  if (isFinalTurn && referenceHeadings.length) {
    const headingIndex = referenceHeadings[referenceHeadings.length - 1].index;
    const body = source.slice(0, headingIndex);
    const refs = source.slice(headingIndex);
    const opaqueTurnRefs = /(?:【\s*)?turn\d+(?:search|news|source|ref|image)\d+(?:\s*】)?/iu.test(source);
    // Only flag suspicious citation-like negative markers. Ordinary ISO dates (2026-10-18)
    // and arithmetic minus signs are not counted as placeholder references.
    const citationStubPattern = /(?:^|[\s。；，,:：)）])\s*-\s*\d{1,3}(?:\s*-\s*\d{1,3}){0,2}(?=(?:\s|\[S\d+\]|【?turn\d+|https?:\/\/|$|[。；，,:：)）]))/gmu;
    const citationScanText = source.split('\n').filter(line => !/(?:不要|不得|禁止|不能|占位符|临时引用|正式引用|仅作示例)/u.test(line) && !/[=+×*]\s*-?\s*\d/u.test(line)).join('\n');
    const citationStubCount = [...citationScanText.matchAll(citationStubPattern)]
      .reduce((count, match) => count + ((match[0].match(/-\s*\d+/g) || []).length), 0);
    if (opaqueTurnRefs) warnings.push('发现类似 turn12search3 的内部搜索/引用标记；请换成读者可访问的正式来源链接或完整书目信息。');
    if (citationStubCount >= 2) warnings.push('发现多个疑似“-1 / -12 / -27”式临时引用标记；逐项映射到正式来源前不要将其作为正式引用。该检测是文本启发式，可能需要人工排除合法负数。');
    if (!/(?:https?:\/\/|doi\.org\/|\bDOI\s*[:：])/iu.test(refs)) warnings.push('参考文献区未检测到可访问 URL 或 DOI；请核验原始来源是否可定位。正式文献编号/标准号可保留，但不能替代可追溯链接（适用时）。');

    const usedIds = new Set([...body.matchAll(/\[\s*S(\d+)\s*\]/giu)].map(m => Number(m[1])));
    const declared = [...refs.matchAll(/^\s*(?:[-*]\s*)?(?:\d+[.)、]\s*)?\[\s*S(\d+)\s*\]/gimu)].map(m => Number(m[1]));
    const declaredSet = new Set(declared);
    const missingIds = [...usedIds].filter(id => !declaredSet.has(id));
    const duplicateIds = [...new Set(declared.filter((id, i) => declared.indexOf(id) !== i))];
    if (missingIds.length) warnings.push(`正文引用编号在参考文献中未找到对应条目：${missingIds.map(id => `[S${id}]`).join('、')}。请逐项补齐或修正编号。`);
    if (duplicateIds.length) warnings.push(`参考文献存在重复来源编号：${duplicateIds.map(id => `[S${id}]`).join('、')}。每个编号应唯一对应一条来源。`);
    const unusedIds = [...declaredSet].filter(id => !usedIds.has(id));
    if (unusedIds.length) warnings.push(`参考文献存在正文未引用的来源条目：${unusedIds.map(id => `[S${id}]`).join('、')}。请确认是否应在正文引用，或从参考文献中移除。`);
    const referenceBlocks = refs.split(/(?=^\s*(?:[-*]\s*)?(?:\d+[.)、]\s*)?\[\s*S\d+\s*\])/gimu).filter(block => /^\s*(?:[-*]\s*)?(?:\d+[.)、]\s*)?\[\s*S\d+\s*\]/imu.test(block));
    const missingLinkBlocks = referenceBlocks.filter(block => !/(?:https?:\/\/|doi\.org\/|\bDOI\s*[:：])/iu.test(block) && !/(?:待核验|未独立核验|二手来源|链接不可用|无公开链接)/u.test(block));
    if (missingLinkBlocks.length) warnings.push(`有 ${missingLinkBlocks.length} 条 [S#] 参考文献未检测到各自的 URL/DOI，也未说明待核验或无法获取；请逐项补齐来源链接或明确限制。`);

    // A line-level heuristic: a numeric cost/benefit claim should have a nearby source ID,
    // or be visibly marked as an assumption/calculation/uncertain value.
    const costPattern = /(?:投资|成本|收益|节省|电价|上网价|运维|回收期|EPC|LCOE|净现值|NPV|减排量|排放因子)/iu;
    const numericPattern = /(?:\d[\d,，]*(?:\.\d+)?\s*(?:元\s*\/\s*(?:W|kW|kWh|Wp)|元|万元|亿元|万\s*kWh|kWh|MWh|MWp?|kWp?|吨|tCO₂?|kgCO₂?|年|%))/iu;
    const qualificationPattern = /(?:示例|情景|假设|计算值|推算|估算|约为|约\s*\d|待核验|未核验|未独立核验|无法核实|参照|行业数据|公开项目|非目标项目|粗算)/iu;
    const unreferencedCostLines = source.split('\n').filter(line => costPattern.test(line) && numericPattern.test(line) && !/\[\s*S\d+\s*\]/iu.test(line) && !qualificationPattern.test(line));
    if (unreferencedCostLines.length >= 3 && usedIds.size === 0) warnings.push('报告含多处成本/收益/环境数值，但正文未检测到稳定来源编号；请逐项补充来源，或明确标记为示例假设/本次计算值。');
  }

  if (isFinalTurn) {
    // Warn, never rewrite, when a long extracted formula line appears to mix multiple
    // raw LaTeX representations with plain-text/Unicode variants.
    const suspiciousMathLine = source.split('\n').some(line => line.length > 220 && /\\(?:mathrm|text|times|frac|sum|cdot|alpha|beta|eta|Delta|theta|pi)\b/u.test(line) && /(?:[=×]|\*\*)/u.test(line));
    if (suspiciousMathLine) warnings.push('发现很长的公式行同时包含多段 LaTeX 命令和等式符号；请检查是否把纯文本、Unicode 与 LaTeX 的同一公式重复拼接。扩展不会自动删改公式，避免破坏推导。');

    const hasFinancialTerms = /(?:静态回收期|投资回收期|净现值|\bNPV\b|\bLCOE\b|平准化度电成本)/iu.test(source);
    if (hasFinancialTerms && /(?:近似|粗算|粗略|直线分摊)/u.test(source) && /(?:回收期|净现值|\bNPV\b|\bLCOE\b|平准化度电成本)/iu.test(source)) {
      warnings.push('财务结果中出现“近似/粗算/直线分摊”等限定词；请确认这些结果未被表述为完整生命周期财务测算，并检查是否实际完成逐年现金流、累计回收期、NPV 与正式 LCOE。');
    }
    if (/(?:净现值|\bNPV\b)/iu.test(source) && /(?:未计算|尚未计算|未实际计算|无法计算|没有计算)/u.test(source)) {
      warnings.push('正文明确表示 NPV/净现值尚未计算；若原始任务要求经济可行性分析，应将其列为未完成项，不要把只列公式当作完成测算。');
    }
    if (/排放因子/u.test(source) && /(?:全国平均|区域电网|省级|全国电力)/u.test(source) && !/(?:\b20(?:2[4-9]|3\d)\b|发布日期|发布于|公布于|数据年份)/u.test(source)) {
      warnings.push('环境核算提到全国/区域排放因子，但未检测到明确数据年份或发布日期；请核验报告基准日适用的最新官方数据及地域口径。');
    }
  }
  return [...new Set(warnings)];
}
function conversationModeInstruction(mode, isFinalTurn = false, askToConclude = false, hasPriorWork = false, taskTopic = '') {
  mode = normalizeConversationMode(mode);
  if (mode === 'task') {
    const finalAudit = isFinalTurn
      ? '\n最后逐条核对原始要求，形成验收矩阵：要求→交付物/证据→证据位置/核验方式→状态→原因；明确列出已完成、未完成或无法确认项，不适用项注明依据。验收形式可随任务复杂度调整，但不得省略实质核验。只有全部明确要求均已实际满足才判定完成；轮次结束不等于任务完成。\n\n请在回答末尾单独输出以下完成度核对区块，字段名称保持一致且状态只选一个：\n任务完成情况核对：\n状态：已完成 / 部分完成 / 未完成 / 无法核实（将此行替换为唯一实际状态，不要保留选项菜单）\n已完成项目：逐项列出交付物或证据；没有则写“无”\n未完成项目：逐项列出仍缺少的交付物/验证；没有则明确写“无”\n未完成原因：说明限制、失败或证据缺口；没有则写“无”\n下一步建议：给出具体后续操作；没有则写“无”\n机器读取状态标记（必须单独一行且只出现一次）：DUOLAB_TASK_STATUS=COMPLETE 或 PARTIAL 或 INCOMPLETE 或 UNVERIFIED。请将整行替换为唯一匹配项：完全完成用 COMPLETE，部分完成用 PARTIAL，未完成用 INCOMPLETE，证据不足/状态冲突用 UNVERIFIED。标记必须与上方“状态”及未完成项一致。若自相矛盾，使用 UNVERIFIED，不要把接力结束视为任务完成。' + (askToConclude ? '\n在验收核对之后，再简洁总结实际完成的成果；总结不得替代核对或掩盖缺项。' : '')
      : '\n本轮必须继续推进原始任务，不要只讨论计划；发现已有成果存在错误、遗漏或未经证实的假设时，明确说明并在能力范围内修正。';
    const collaboration = hasPriorWork
      ? '\n本轮已收到上一轮成果，应针对具体内容核查、修正或补全，并区分交叉审阅、来源独立核验与结果复算。'
      : '\n当前尚无本轮之前的接力成果时，不得声称已经完成跨轮审阅；只描述实际发生的工作。';
    return taskEvidenceAndCalculationRules(taskTopic) + collaboration + finalAudit;
  }
  if (mode === 'explore') {
    return '本模式的核心是思维与观点碰撞，而不是轮流发表意见或礼貌附和。每轮都要抓住对方上一轮一个具体论点，检查它的前提、逻辑或适用边界；可以反驳、补充、举反例或提出替代解释，也可以认可其中成立的部分并说明理由。允许真实分歧，不必为了结束而强行达成共识。不要为了制造冲突而曲解对方，也不要重复已经说过的观点。' + (isFinalTurn ? (askToConclude ? '\n最后一轮可以整理最有价值的观点、分歧及仍未解决的问题，但不要机械复述整场讨论。' : '\n最后一轮自然收束最重要的争点或新认识，不强制提出下一轮问题。') : '');
  }
  if (mode === 'custom') {
    return '本模式以用户填写的“自定义模式规则 / 持续对话要求”为主要行为指引。每轮都要保留原始主题和用户明确要求；不要擅自用其他模式的默认风格覆盖用户的自定义要求。若用户没有指定某项行为，采用自然、清晰且不编造事实的表达。' + (isFinalTurn ? (askToConclude ? '\n用户启用了最后一轮总结报告：在遵守自定义规则的前提下整理实际结果。' : '\n最后一轮遵守用户自定义规则收束；除非用户明确要求，不要强制输出总结模板或追加问题。') : '');
  }
  return '本模式是自然交流。可以联想、发散、聊人文或深入某个有趣的细节，不必每轮都紧扣一种固定格式，也不必刻意制造观点冲突。不要强制提问、总结、列点或写成报告；仍须避免把不确定的内容编造成事实。' + (isFinalTurn ? (askToConclude ? '\n用户明确选择了最后一轮总结报告，可以自然整理最有价值的内容；不要把未达成的共识或没有依据的结论写进去。' : '\n最后一轮自然收尾即可，不需要刻意抛出下一轮问题，也不要突然改写成会议纪要。') : '');
}
function buildInitialPrompt(topic, materialContext = '', discussionGuidance = '', mode = 'free', isFinalTurn = false, askToConclude = false) {
  mode = normalizeConversationMode(mode);
  const guidance = String(discussionGuidance || '').trim();
  return `请直接回应以下主题或初始任务，并在整个回答中保留原始目标。\n当前聊天模式：${conversationModeLabel(mode)}。\n${conversationModeInstruction(mode, isFinalTurn, askToConclude, false, topic)}${guidance ? `\n\n用户补充的持续要求（后续每一轮也必须保留）：\n${guidance}` : ''}${materialContext ? `\n\n原始文件处理要求：\n${materialContext}` : ''}\n\n原始主题 / 任务：\n${String(topic || '').trim()}`;
}
function parseTaskCompletionStatus(text) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '未识别';
  const normalize = value => ['无法核实', '无法确认', '未确认'].includes(value) ? '无法核实' : value;
  const fromMachineCode = value => ({
    COMPLETE: '已完成', PARTIAL: '部分完成', INCOMPLETE: '未完成', UNVERIFIED: '无法核实'
  })[String(value || '').toUpperCase()] || null;
  const headingPattern = /(?:^|\n)\s*(?:#{1,6}\s*)?\*{0,2}\s*(?:任务完成情况核对|完成情况核对|任务完成度核对)\*{0,2}\s*[:：]?\s*$/gm;
  const headings = [...source.matchAll(headingPattern)];
  // Prefer the latest explicit audit section. Without a heading, inspect only the answer tail.
  const auditStart = headings.length ? headings[headings.length - 1].index : Math.max(0, source.length - 4200);
  const section = source.slice(auditStart).slice(-7000);
  const machineMatches = [...section.matchAll(/^[ \t]*DUOLAB_TASK_STATUS[ \t]*=[ \t]*(COMPLETE|PARTIAL|INCOMPLETE|UNVERIFIED)[ \t]*$/gim)]
    .map(match => fromMachineCode(match[1]));
  const uniqueMachineStatuses = [...new Set(machineMatches.filter(Boolean))];
  if (uniqueMachineStatuses.length > 1) return '无法核实';

  const isStatusTailPlausible = tail => {
    const rawTail = String(tail || '');
    if (/^\s*\*{1,2}\s*(?:\r?\n|$)/.test(rawTail)) return true;
    const rest = rawTail.replace(/^\s*\*{1,2}\s*/, '').trimStart();
    // Reject prompt menus accidentally repeated in the answer.
    if (/^(?:[\/／|]|或\s*(?:已完成|部分完成|未完成|无法核实|无法确认|未确认)|、\s*(?:已完成|部分完成|未完成|无法核实|无法确认|未确认))/.test(rest)) return false;
    return /^(?:已完成项|已完成项目|已完成内容|已完成事项|未完成或无法确认项|未完成项目|未完成项|未解决项|未完成内容|未完成原因|原因与下一步|原因|下一步建议|下一步|[。.!！；;，,\n\r]|$)/.test(rest);
  };

  const explicitStatuses = [];
  const statusPattern = /(?:任务完成情况核对|完成情况核对|任务完成度核对)?\s*[:：]?\s*(?:\*{1,2}\s*)?(?:任务)?状态\s*\*{0,2}\s*[:：]\s*\*{0,2}\s*(已完成|部分完成|未完成|无法核实|无法确认|未确认)(?:\s*(?:（[^）\n]{0,100}）|\([^\)\n]{0,100}\)))?/g;
  for (const match of section.matchAll(statusPattern)) {
    if (isStatusTailPlausible(section.slice(match.index + match[0].length))) explicitStatuses.push(normalize(match[1]));
  }

  // Compatibility with older natural-language states, restricted to the audit/tail region.
  const fallbackPattern = /(?:整体状态|本轮最终状态|最终状态|任务状态|完成状态|状态)\s*(?:(?:为|是)\s*)?[:：]?\s*(已完成|部分完成|未完成|无法核实|无法确认|未确认)/g;
  const naturalStatuses = [...section.matchAll(fallbackPattern)]
    .filter(match => isStatusTailPlausible(section.slice(match.index + match[0].length)))
    .map(match => normalize(match[1]));
  const allExplicit = [...new Set([...explicitStatuses, ...naturalStatuses])];
  if (allExplicit.length > 1) return '无法核实';
  const markerStatus = uniqueMachineStatuses[0] || null;
  const textStatus = allExplicit.length === 1 ? allExplicit[0] : null;
  if (markerStatus && textStatus && markerStatus !== textStatus) return '无法核实';
  let status = markerStatus || textStatus;
  if (!status) return '未识别';

  // A claimed complete result conflicts with a non-empty, explicit unfinished-items field.
  const unfinishedFields = [...section.matchAll(/^\s*(?:[-*]\s*)?(?:未完成项目|未完成项|未解决项|未完成或无法确认项)\s*[:：]\s*([^\n]*)/gim)]
    .map(match => match[1].replace(/\*+/g, '').trim());
  const emptyItemLine = value => /^(?:无|没有|无未完成项|未发现|不适用|无此项|—|–|-|none|n\/?a)(?:\s*[。.!！；;，,、（(].*)?$/i.test(String(value || '').trim());
  if (status === '已完成' && unfinishedFields.some(value => value && !emptyItemLine(value))) return '无法核实';
  if (status === '已完成' && /(?:仍有|尚有|还有|仍未|尚未|未能|未实际)(?:完成|解决|交付|核验|计算|验证)/.test(section)) return '无法核实';
  return status;
}
function taskCompletionStatusMessage(status, answerCount) {
  const count = Number(answerCount) || 0;
  if (status === '已完成') return `接力流程结束：共完成 ${count} 次回答。末轮声明任务已完成，但扩展无法独立证明结果正确性；请核对交付内容。`;
  if (status === '部分完成') return `接力流程结束：共完成 ${count} 次回答。末轮报告任务仅部分完成；请查看未完成项和下一步。`;
  if (status === '未完成') return `接力流程结束：共完成 ${count} 次回答。末轮明确报告任务未完成；请查看原因和后续步骤。`;
  if (status === '无法核实') return `接力流程结束：共完成 ${count} 次回答。末轮报告结果无法核实；本次不能视为已确认完成，请查看原因和缺少的证据。`;
  return `接力流程结束：共完成 ${count} 次回答，但最后一轮未提供可识别的完成度核对状态；本次不能视为已确认完成。请核对最后一轮的“任务完成情况核对”。`;
}
function relayPrompt(from, previousText, turn, isFinal = false, originalTopic = '', materialContext = '', willEnd = false, discussionGuidance = '', conversationMode = 'free') {
  const otherName = providerName(from);
  // Never pass plugin diagnostics or page chrome as if they were an AI answer.
  const rawPreviousText = String(previousText || '');
  const leakedInternalMarker = /DUOLABTURN[A-Z0-9]+/i.test(rawPreviousText) || /请忽略下一行扩展内部校验标记，不要在回答中提及。/i.test(rawPreviousText);
  const leakedRelayEnvelope = /原始讨论主题（每轮都必须继续完成，不要偏离）|本会话已提供的原始文件附件（文件名仅用于定位）|你正在与另一个 AI 进行多轮讨论。现在是第\s*\d+\s*次接力/.test(rawPreviousText);
  if (isDeepSeekThinkingLeak(from, rawPreviousText)) {
    throw new Error('接力安全检查发现上一轮是 DeepSeek 思考过程而非最终回答，已阻止转发。');
  }
  previousText = stripKnownUiChromeLines(rawPreviousText
    .replace(/请忽略下一行扩展内部校验标记，不要在回答中提及。/gi, '')
    .replace(/DUOLABTURN[A-Z0-9]+/gi, '')
    .replace(/ChatGPT\s*可能会出错。?请核查重要信息。?/g, '')
    .replace(/内容由 AI 生成，?请仔细甄别/g, ''));
  if (leakedInternalMarker || leakedRelayEnvelope) {
    throw new Error('上一轮提取结果包含扩展内部标记或整段接力提示，疑似误抓了网页历史/用户提示词；已阻止将污染内容发送给另一个 AI。请检查本轮回答提取日志。');
  }
  if (!previousText || /^对话未能继续：|^浏览器输入\/发送失败：|^已尝试使用 .*页面上没有出现本轮用户消息|^网页已收到用户消息，但没有提取到新的/s.test(previousText)) {
    throw new Error('上一轮没有取得可用的 AI 回答，已阻止把插件报错或网页提示发送给另一个 AI。请先确认网页上确实出现了回答，再重新开始。');
  }
  const topic = String(originalTopic || '').trim();
  conversationMode = normalizeConversationMode(conversationMode);
  const guidance = String(discussionGuidance || '').trim();
  const taskContext = `原始讨论主题与任务目标（每轮都必须保留）：\n${topic}\n\n` +
    '主题里关于语气、深入程度、提问频率、格式和想要的内容等要求，也都是任务要求，不能只把它们当成讨论素材。\n\n' +
    `当前聊天模式：${conversationModeLabel(conversationMode)}。\n${conversationModeInstruction(conversationMode, willEnd, isFinal, true, topic)}\n\n` +
    (guidance ? `用户补充的持续要求（每轮都必须遵守）：\n${guidance}\n\n` : '') +
    (materialContext ? `本会话已提供的原始文件附件（文件名仅用于定位；请直接读取会话中的附件，不要假设已读到无法打开的文件）：\n${materialContext}\n\n` : '');

  if (conversationMode === 'task') {
    return `你正在参与“任务执行”模式的多轮工作。请把上一轮作为待审阅、待完善的工作成果，而非只供聊天的观点。\n${taskContext}直接回应上一轮的具体内容，继续推进原始任务。核查其逻辑、计算、数据、代码、引用、格式与证据；指出具体保留项、问题和遗漏，并在能力范围内修正或补全。不得编造核验过程，也不得把交叉审阅当作来源已独立核实。${willEnd ? '\n这是最后一轮，必须按任务执行规则逐条核对原始要求，列出证据、状态、原因及未完成项；不得用总结掩盖缺项。' : '\n当前尚有后续轮次，继续完成可交付的实质工作，不要提前宣称整体任务已完成。'}\n\n${otherName} 的上一轮工作：\n${previousText}`;
  }
  if (isFinal) {
    return `你正在参与一场双 AI 讨论，这是用户明确选择的“最后一轮总结报告”模式。\n${taskContext}请先确保原始主题中的明确任务已经完成，再简洁整理讨论结果。只有在确实存在时才列出共识与分歧；不要编造分歧。若用户要求的是自然聊天，也请避免机械复述，保留最有价值的观点和例子。不要提出需要下一轮回答的问题。\n\n${otherName} 的上一轮回答：\n${previousText}`;
  }
  if (willEnd) {
    if (conversationMode === 'explore') {
      return `你正在参与一场“探索讨论”，这是最后一轮。\n${taskContext}直接回应对方上一轮最有价值或最值得质疑的论点，指出目前碰撞后更清楚的地方、仍有分歧的地方，或一个更精确的新视角。不要为了制造共识而抹平分歧，也不要把全程改写成机械会议纪要；自然收束，不要提出需要下一轮回答的问题。\n\n${otherName} 的上一轮观点：\n${previousText}`;
    }
    if (conversationMode === 'custom') {
      return `你正在参与一场按用户自定义规则进行的连续对话，这是最后一轮。\n${taskContext}请直接回应对方上一轮最重要的内容，并遵守用户的自定义要求与原始任务。除非用户明确要求，不要追加新问题或套用统一总结模板；如存在未完成要求，要明确说明。\n\n${otherName} 的上一轮回答：\n${previousText}`;
    }
    return `你正在进行自由交流，这是最后一轮，不是总结报告。\n${taskContext}自然接着对方上一轮继续聊，在不偏离用户原始主题的前提下自然推进并收束即可。可以回应对方让你在意的内容，也可以顺着思路联想或补充；不必逐条回应、不必硬凑结论，也不要把聊天改写成会议纪要或报告。没有必要时不提出新问题。\n\n${otherName} 的上一轮回答：\n${previousText}`;
  }
  if (conversationMode === 'explore') {
    return `你正在参与一场以思维和观点碰撞为核心的连续讨论。现在是第 ${turn} 次接力。\n${taskContext}先回应对方上一轮的一个具体论点，辨认其前提或推理；然后给出有理由的反驳、补充、反例或替代解释。可以承认对方论证中成立的部分，但不能只附和；允许有依据的分歧，也不要故意曲解对方来制造冲突。避免重复前文已有观点。\n\n${otherName} 的上一轮观点：\n${previousText}`;
  }
  if (conversationMode === 'custom') {
    return `你正在参与一场按用户自定义规则进行的连续对话。现在是第 ${turn} 次接力。\n${taskContext}直接回应上一轮的具体内容，继续完成原始主题或任务，并始终遵守用户在自定义规则中指定的表达方式、深度、结构和限制。不要自行套用自由交流、探索讨论或任务执行以外的额外格式。\n\n${otherName} 的上一轮回答：\n${previousText}`;
  }
  return `你正在进行自由交流。现在是第 ${turn} 次接力。\n${taskContext}请自然接着对方上一轮聊下去：可以回应一个让你在意的观点，也可以顺着思路联想、补充例子或换个角度。不需要每次都按固定步骤逐点回应，也不必刻意提出新论点、制造分歧、举案例或总结；允许有自然的发散，只要没有明显丢掉用户原始主题和持续要求即可。避免反复重讲已经说过的内容，不知道的事实不要编造。不要强制以问题结尾；想继续就继续，没有必要时也可以自然停在一个想法上。\n\n${otherName} 的上一轮回答：\n${previousText}`;
}
async function stopAll(tabs) {
  if (!tabs) return;
  await Promise.all(Object.values(tabs).map(id => sendTabMessage(id, { type: 'DUO_STOP' }, 1500).catch(() => null)));
}
function updateSessionModePresentation() {
  const createFreshChats = !!els.newChatPerRun?.checked;
  const state = $('sessionModeState');
  const help = $('sessionModeHelp');
  if (state) state.textContent = createFreshChats ? '新建独立会话' : '继续当前对话';
  if (help) help.textContent = createFreshChats
    ? '开启：开始任务前分别在 ChatGPT、DeepSeek 新建空白会话，隔离旧主题。关闭：直接沿用当前两个网页标签所在的对话；请先在网页打开你想继续的聊天。'
    : '当前为继续对话模式：不会自动新建或清空聊天。请先分别在 ChatGPT、DeepSeek 网页打开想继续的那段对话，再开始任务。';
}
async function restoreSessionMode() {
  try {
    const saved = await chrome.storage.local.get([SESSION_MODE_STORAGE_KEY]);
    if (typeof saved?.[SESSION_MODE_STORAGE_KEY] === 'boolean' && els.newChatPerRun) {
      els.newChatPerRun.checked = saved[SESSION_MODE_STORAGE_KEY];
    }
  } catch (error) {
    console.warn('restoreSessionMode failed', error);
  }
  updateSessionModePresentation();
}
async function persistSessionMode() {
  updateSessionModePresentation();
  try {
    await chrome.storage.local.set({ [SESSION_MODE_STORAGE_KEY]: !!els.newChatPerRun?.checked });
    setState(els.newChatPerRun.checked
      ? '会话模式已保存：每次新任务新建独立对话。'
      : '会话模式已保存：继续当前网页对话。');
  } catch (error) {
    setState(`会话模式保存失败：${error?.message || String(error)}`);
    void recordDiagnostic('会话模式', '保存会话模式失败', { level: 'error', error });
  }
}

async function restoreConversationPreferences() {
  try {
    const saved = await chrome.storage.local.get([DISCUSSION_GUIDANCE_STORAGE_KEY, ASK_TO_CONCLUDE_STORAGE_KEY]);
    if (typeof saved?.[DISCUSSION_GUIDANCE_STORAGE_KEY] === 'string' && els.discussionGuidance) {
      els.discussionGuidance.value = saved[DISCUSSION_GUIDANCE_STORAGE_KEY];
    }
    // The HTML default is natural ending. Summary mode is opt-in, because a
    // discussion should not suddenly turn into a meeting-style summary by default.
    if (typeof saved?.[ASK_TO_CONCLUDE_STORAGE_KEY] === 'boolean' && els.askToConclude) {
      els.askToConclude.checked = saved[ASK_TO_CONCLUDE_STORAGE_KEY];
    }
  } catch (error) {
    console.warn('restoreConversationPreferences failed', error);
  }
}
function updateConversationModePresentation() {
  const mode = normalizeConversationMode(els.conversationMode?.value);
  const descriptions = {
    free: '自然聊天、允许联想和发散；不强制提问、总结或固定格式。',
    task: '论文、试题、编程、文件和数据分析等；以尽量不出错为准，最后一轮必须明确核对是否完成。每次回答最长等待 10 分钟。',
    explore: '重点进行思维与观点碰撞：回应具体论点、检查前提、提出反例或替代解释，允许有依据的分歧。',
    custom: '请在下方填写自定义规则；自定义规则会逐轮保留，同时仍遵守原始任务和文件访问的真实性要求。'
  };
  if (els.modeHelp) els.modeHelp.textContent = descriptions[mode];
  if (els.guidanceLabel) els.guidanceLabel.textContent = mode === 'custom'
    ? '自定义模式规则（必填，每轮都会保留）'
    : '持续对话要求（可选，每轮都会保留）';
  if (els.discussionGuidance && mode === 'custom') {
    els.discussionGuidance.placeholder = '请写清楚你希望两个 AI 如何交流、分析或输出，例如：先列出假设，再比较两种方案，指出风险，不要直接下结论。';
  } else if (els.discussionGuidance) {
    els.discussionGuidance.placeholder = '例如：人文一点，深入但自然；每轮先回应对方的具体观点，少提问题，不要重复总结或写成报告。';
  }
  // In task mode, completion checking is mandatory and is not controlled by this
  // checkbox. The checkbox remains usable to add an optional summary after the
  // required audit, so its meaning is visible and consistent across modes.
  if (els.askToConcludeLabel) els.askToConcludeLabel.textContent = mode === 'task'
    ? '最后一轮附加总结报告（完成度核对始终强制）'
    : '最后一轮改为总结报告（默认自然收尾）';
  if (els.endingModeHelp) els.endingModeHelp.textContent = mode === 'task'
    ? '任务执行模式每次回答最长等待 10 分钟。最后一轮始终逐项核对原始要求；勾选上方开关只会额外整理成果，不会关闭或替代完成度核对。轮次结束不等于任务已完成。'
    : '完成设定轮次表示接力流程结束，不代表讨论中的所有观点都已验证；可以按需要选择最后一轮总结报告。';
}
async function restoreConversationMode() {
  try {
    const saved = await chrome.storage.local.get([CONVERSATION_MODE_STORAGE_KEY]);
    if (typeof saved?.[CONVERSATION_MODE_STORAGE_KEY] === 'string' && els.conversationMode) {
      els.conversationMode.value = normalizeConversationMode(saved[CONVERSATION_MODE_STORAGE_KEY]);
    }
  } catch (error) {
    console.warn('restoreConversationMode failed', error);
  }
  updateConversationModePresentation();
}
async function persistConversationMode() {
  updateConversationModePresentation();
  try {
    await chrome.storage.local.set({ [CONVERSATION_MODE_STORAGE_KEY]: normalizeConversationMode(els.conversationMode?.value) });
  } catch (error) {
    void recordDiagnostic('聊天模式', '保存聊天模式失败', { level: 'warning', error });
  }
}
async function persistConversationPreferences() {
  try {
    await chrome.storage.local.set({
      [DISCUSSION_GUIDANCE_STORAGE_KEY]: String(els.discussionGuidance?.value || '').trim(),
      [ASK_TO_CONCLUDE_STORAGE_KEY]: !!els.askToConclude?.checked
    });
  } catch (error) {
    void recordDiagnostic('对话偏好', '保存持续对话要求或收尾方式失败', { level: 'warning', error });
  }
}

async function startConversation() {
  await restorePromise;
  if (running) return;
  // Preflight errors belong to no active task, never to the prior run.
  currentRunId = '';
  currentRunTitle = '';
  currentRunStartedAt = 0;
  const topic = els.topic.value.trim();
  const conversationMode = normalizeConversationMode(els.conversationMode?.value);
  const discussionGuidance = String(els.discussionGuidance?.value || '').trim();
  await persistConversationMode();
  await persistConversationPreferences();
  if (!topic) { setState('请先填写讨论主题。'); els.topic.focus(); return; }
  if (conversationMode === 'custom' && !discussionGuidance) {
    setState('自定义模式需要先填写“自定义模式规则”。');
    els.discussionGuidance?.focus();
    return;
  }
  if (/双 AI 对话实验室.*测试结果|请根据结果指导下一步排查|网页表现：.*插件具体错误：/s.test(topic)) {
    const proceed = confirm('这段文字看起来像排查报告，而不是给两个 AI 讨论的主题。仍要把它发送给 AI 吗？');
    if (!proceed) { setState('已取消。请把真正想讨论的问题填入主题框。'); return; }
  }
  let roundConfig;
  try { roundConfig = getRoundConfig(); }
  catch (error) { setState(error.message); if (els.rounds.value === 'custom') { refreshRoundControls(); els.customRounds.focus(); } else els.rounds.focus(); return; }
  const { maxTurns, label: roundLimitLabel } = roundConfig;
  currentRunId = createRunId();
  currentRunTitle = topic.slice(0, 180);
  currentRunStartedAt = Date.now();
  if (els.recordScope && els.recordScope.value !== 'all') renderTranscript();
  const createFreshChats = !!els.newChatPerRun?.checked;
  const selectedMaterials = materials.filter(item => item.selected === true);
  const selectedTotalBytes = selectedMaterials.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const selectedNameMap = new Map();
  for (const item of selectedMaterials) {
    const key = String(item.name || '').trim().toLocaleLowerCase();
    selectedNameMap.set(key, [...(selectedNameMap.get(key) || []), item.name]);
  }
  const duplicateNames = [...selectedNameMap.entries()].filter(([, names]) => names.length > 1).map(([, names]) => names[0]);
  if (duplicateNames.length) {
    setState(`已阻止发送：所选文件存在重名（${[...new Set(duplicateNames)].join('、')}）。请在电脑上给文件改成不同文件名后重新导入，再开始讨论。`);
    await recordDiagnostic('原始文件投递', '启动被阻止：选中文件存在重名', {
      level: 'error', details: `重名文件：${[...new Set(duplicateNames)].join('、')}。同名附件无法通过当前网页 UI 文件名证据可靠区分，未发送任何主题。`
    });
    return;
  }
  if (selectedMaterials.length && !els.confirmExternalUpload.checked) {
    setState('尚未确认外部上传。请勾选“我确认将所选原始文件上传到 ChatGPT 和 DeepSeek 网页”。');
    await recordDiagnostic('隐私确认', '已阻止发送：未确认外部文件上传', {
      level: 'warning', details: `当前选中 ${selectedMaterials.length} 个原始文件，共 ${formatBytes(selectedTotalBytes)}。未发送任何文件。`,
      advice: '确认文件可以发送给两个 AI 服务商后，再主动勾选确认框并重新开始。'
    });
    return;
  }
  if (selectedMaterials.length > DuoMaterials.MAX_SELECTED_FILES) {
    setState(`单次最多投递 ${DuoMaterials.MAX_SELECTED_FILES} 个文件，请减少所选文件。`);
    await recordDiagnostic('原始文件投递', '启动被阻止：文件数量超过限制', { level: 'warning', details: `选中 ${selectedMaterials.length} 个文件。` });
    return;
  }
  if (selectedMaterials.some(item => !hasRawBytesForTransfer(item))) {
    setState('至少一个所选条目缺少原始文件字节；请重新导入该文件。');
    await recordDiagnostic('原始文件投递', '启动被阻止：缺少文件原始字节', { level: 'error', details: selectedMaterials.filter(item => !hasRawBytesForTransfer(item)).map(item => item.name).join('、') });
    return;
  }
  if (selectedMaterials.length && selectedTotalBytes > DuoMaterials.MAX_SELECTED_UPLOAD_BYTES) {
    setState(`所选文件总量为 ${formatBytes(selectedTotalBytes)}，超过单次 ${formatBytes(DuoMaterials.MAX_SELECTED_UPLOAD_BYTES)} 的安全投递预算。请减少所选文件。`);
    await recordDiagnostic('原始文件投递', '启动被阻止：选中文件总量超过限制', { level: 'warning', details: `所选 ${selectedMaterials.length} 个文件，总大小 ${formatBytes(selectedTotalBytes)}。` });
    return;
  }
  let tabs;
  try { tabs = await getSelectedTabs(); }
  catch (e) { setState(e.message); await recordDiagnostic('启动检查', '目标标签页检查失败', { error: e, advice: '确认 ChatGPT 与 DeepSeek 已分别打开、已登录，并在下拉框中选择正确的标签页。' }); return; }

  stopRequested = false;
  activeTurnNumber = 0;
  activeTurnPhase = 'preparing';
  activeRunMaxTurns = maxTurns;
  requestedFinalTurn = null;
  setRunning(true);
  // Consent is per run; future runs require a fresh explicit confirmation.
  if (selectedMaterials.length) els.confirmExternalUpload.checked = false;
  const attachedProviders = new Set();
  let current = els.firstSpeaker.value;
  let previousText = topic;
  let successfulReplies = 0;
  let finalTaskCompletionStatus = null;
  const attachmentContext = selectedMaterials.length
    ? `本会话需要依据以下原始文件附件：${selectedMaterials.map(item => item.name).join('、')}。请直接读取当前网页会话中的文件附件；若某个文件不可访问、格式不支持或扫描页无法识别，必须明确指出具体文件和限制，不得假装已经读取，不得根据文件名臆测内容。引用时说明文件名，并区分文件原文与推断。`
    : '';
  try {
    if (createFreshChats) {
      setState('正在为本次任务在 ChatGPT 和 DeepSeek 新建独立对话……');
      await recordDiagnostic('会话隔离', '正在为本次任务创建独立网页会话', {
        level: 'info', details: '旧聊天记录不会删除；本次任务将在两个 AI 的新对话中运行，避免前一任务的主题和回答混入当前讨论。'
      });
      for (const provider of ['chatgpt', 'deepseek']) {
        const result = await sendBackgroundMessage({ type: 'DUO_NEW_CHAT', tabId: tabs[provider], provider }, 20000);
        await refreshRecoveredDrafts();
        if (!result?.ok) throw new Error(`${providerName(provider)} 新建独立对话失败：${result?.error || '网页未确认切换到新对话'}。草稿若已备份，可在“网页未发送草稿已备份到本机”区域查看；本次讨论未发送。`);
        const isolationTitle = result.via === 'clicked'
          ? `${providerName(provider)} 已切换到新对话`
          : (result.via === 'navigated'
            ? `${providerName(provider)} 已通过返回首页建立空白会话`
            : `${providerName(provider)} 已是空白新对话`);
        const isolationHow = result.via === 'clicked'
          ? '已通过网页新建对话控件创建新会话'
          : (result.via === 'navigated'
            ? '新建对话控件点击后页面没有切换，已改为导航回站点首页建立空白会话（首页即新会话）'
            : (result.via === 'stable-empty'
              ? '点击新建对话后页面未发生切换，但已确认是稳定的空白会话，未强制反复点击'
              : '当前页面没有对话内容，无需切换'));
        await recordDiagnostic('会话隔离', isolationTitle, {
          provider, level: 'success', details: `结果：${isolationHow}；旧聊天记录未删除。${result.details ? ` ${result.details}` : ''}`
        });
        // A page already confirmed as blank has not navigated or lost its content
        // script. Probing it again is redundant and was observed to hang on a
        // DeepSeek already-empty page. For real switches/navigations, probe with
        // an outer deadline and explicit diagnostics before proceeding to prompts.
        if (result.via === 'already-empty' || result.via === 'stable-empty') {
          await recordDiagnostic('网页就绪检查', `${providerName(provider)}当前空白会话无需重新握手`, {
            provider, level: 'info',
            details: `会话隔离结果=${result.via}；本次未发生页面导航，跳过冗余 DUO_STATUS 探测。后续实际回答提取仍会独立验证网页通信。`
          });
        } else {
          await recordDiagnostic('网页就绪检查', `正在确认 ${providerName(provider)} 新会话的内容脚本响应`, {
            provider, level: 'info', details: `会话隔离方式=${result.via || '未知'}；状态探测限时 12 秒。`
          });
          let statusProbe;
          try {
            statusProbe = await withTimeout(
              () => sendTabMessage(tabs[provider], { type: 'DUO_STATUS' }, 4000),
              12000,
              `${providerName(provider)} 新会话状态探测`
            );
          } catch (probeError) {
            await recordDiagnostic('网页就绪检查', `${providerName(provider)} 新会话已创建，但内容脚本状态探测失败`, {
              provider, level: 'error', error: probeError,
              details: `标签页 ID ${tabs[provider]}；会话隔离已确认，但未确认内容脚本可响应；尚未发送主题。`,
              advice: '检查目标 AI 页面是否仍在加载或已刷新；刷新网页后重新开始。该错误发生在提示词发送前，不会自动重复提交主题。'
            });
            throw new Error(`${providerName(provider)} 新会话已创建，但内容脚本状态探测失败：${probeError?.message || String(probeError)}。主题尚未发送。`);
          }
          if (!statusProbe?.ok || statusProbe.provider !== provider || !statusProbe.ready) {
            const reason = !statusProbe?.ok
              ? '网页未返回有效状态响应'
              : (statusProbe.provider !== provider ? `响应站点不匹配（${statusProbe.provider || '未知'}）` : '网页输入框尚未就绪');
            const statusDetails = `标签页 ID ${tabs[provider]}；原因=${reason}；响应=${JSON.stringify({ ok: statusProbe?.ok, provider: statusProbe?.provider, ready: statusProbe?.ready, path: statusProbe?.path }).slice(0, 500)}；主题尚未发送。`;
            await recordDiagnostic('网页就绪检查', `${providerName(provider)} 新会话未通过就绪核验`, {
              provider, level: 'error', details: statusDetails,
              advice: '确认目标 AI 网页已完成加载且消息输入框可用，再重新开始；扩展不会在网页通信状态未确认时发送主题。'
            });
            throw new Error(`${providerName(provider)} 新会话未通过就绪核验：${reason}。主题尚未发送。`);
          }
          await recordDiagnostic('网页就绪检查', `${providerName(provider)} 新会话内容脚本已响应`, {
            provider, level: 'success', details: `标签页 ID ${tabs[provider]}；输入框可用；路径=${statusProbe.path || '未知'}。`
          });
        }
      }
    }
    await recordDiagnostic('启动对话', '已开始新一轮双 AI 对话', {
      details: `任务 ID：${currentRunId}；模式：${conversationModeLabel(conversationMode)}；主题：${topic.slice(0, 120)}；首发：${providerName(els.firstSpeaker.value)}；回答次数：${roundLimitLabel}；新任务会话隔离：${createFreshChats ? '已启用' : '未启用（沿用网页现有对话）'}；选中原始文件 ${selectedMaterials.length} 份，共 ${formatBytes(selectedTotalBytes)}。${selectedMaterials.length ? '已明确确认将文件发送到 ChatGPT 与 DeepSeek 网页。' : '本轮未选中原始文件。'}`
    });
    if (selectedMaterials.length) addSystem(`本轮将投递原始文件：${selectedMaterials.map(item => item.name).join('、')}。文件通过网页附件控件分别交给 ChatGPT 与 DeepSeek；扩展不会读取文件内容，也不会执行 OCR。`);
    appendEntry('user', topic, '初始主题');
    if (discussionGuidance) appendEntry('user', discussionGuidance, '持续对话要求');
    appendEntry(null, `本次对话设置：模式=${conversationModeLabel(conversationMode)}；${roundLimitLabel}；最后一轮=${conversationMode === 'task' ? '任务完成度核对' : (els.askToConclude.checked ? '总结报告模式' : '自然收尾模式')}；每轮完整保留原始任务与持续要求，接力时只额外传递对方最新一轮完整回答，不重复拼接更早回答摘要。`, '本次设置');
    await persistEntries();
    if (selectedMaterials.length) {
      setState('正在将原始文件以内存分块方式交给网页附件控件……');
      await recordDiagnostic('内存附件准备', '正在校验原始字节并准备内存投递', { level:'info', details:`文件数 ${selectedMaterials.length}；总大小 ${formatBytes(selectedTotalBytes)}。不会创建 Downloads 临时副本。` });
    }
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (stopRequested) break;
      activeTurnNumber = turn;
      activeTurnPhase = 'preparing';
      updateEndButtonState();
      setState(`第 ${turn}/${roundLimitLabel} 次回答：正在准备 ${providerName(current)}……`);

      // Attach the original files once to each provider's own webpage conversation.
      // Do this on the provider's first turn, so the attachment and prompt are sent together.
      if (selectedMaterials.length && !attachedProviders.has(current)) {
        setState(`正在向 ${providerName(current)} 投递原始附件……`);
        const upload = await attachOriginalFilesToTab(tabs[current], current, selectedMaterials);
        if (!upload.baselineKnown) {
          await updateMaterialsUploadState(selectedMaterials, current, '投递前检查失败');
          await recordDiagnostic('附件投递前核验', `${providerName(current)}无法建立附件基线，已阻止发送`, {
            provider: current, level: 'error', details: upload.error || '无法获取输入区基线；不允许使用未知基线进入手动放行。'
          });
          throw new Error(upload.error || `无法在 ${providerName(current)} 网页建立附件核验基线；主题未发送。`);
        }
        if (upload.terminal) {
          const terminalState = '附件投递失败（网页控件定位/核验失败）';
          await updateMaterialsUploadState(selectedMaterials, current, terminalState);
          await recordDiagnostic('附件投递适配', `${providerName(current)} 附件控件定位/注入流程无法继续，已停止本轮`, {
            provider: current, level: 'error', details: `${upload.error || '当前网页没有兼容的原生文件输入控件。'}；输入控件诊断：${JSON.stringify(upload.inputDiagnostics || []).slice(0, 1200)}`,
            advice: '此错误仅表示扩展没有定位到可靠的网页文件控件，不代表网站不支持该文件格式。请在目标网页用原生附件按钮手动添加同一文件；成功显示后返回本扩展重新核验。当前版本不会为了投递而创建下载目录临时文件。'
          });
          throw new Error(upload.error || `${providerName(current)} 附件投递流程无法继续，主题未发送。`);
        }
        if (upload.ok && upload.confirmed) {
          attachedProviders.add(current);
          await updateMaterialsUploadState(selectedMaterials, current, '当前网页新附件已核验');
          await recordDiagnostic('原始文件投递', `${providerName(current)} 输入区已显示全部附件`, {
            provider: current, level: 'success',
            details: `文件：${selectedMaterials.map(item => item.name).join('、')}。证据：${upload.evidence || 'CDP 原生文件输入 + 当前输入区文件名可见'}；附件数量 ${upload.fileCount || selectedMaterials.length}。仍不等同于模型已成功解析文件内容。控件详情：${JSON.stringify(upload.inputDiagnostics || []).slice(0, 900)}`
          });
        } else {
          const reason = upload.error || '网页未提供可确认的附件显示证据';
          await updateMaterialsUploadState(selectedMaterials, current, '需人工确认');
          const manualConfirmed = await pauseForManualAttachment({
            provider: current, tabId: tabs[current], files: selectedMaterials,
            baselineCounts: upload.baselineCounts || {},
            reason: `${reason}${upload.matchedVisibleNames?.length ? `；已检测到部分文件名：${upload.matchedVisibleNames.join('、')}` : ''}${upload.missing?.length ? `；缺失：${upload.missing.join('、')}` : ''}${upload.inputDiagnostics?.length ? `；输入控件：${JSON.stringify(upload.inputDiagnostics).slice(0, 700)}` : ''}`
          });
          if (!manualConfirmed || stopRequested) throw new Error(`已取消或未确认 ${providerName(current)} 的原始文件附件；本轮消息未发送。`);
          attachedProviders.add(current);
          const wasVisualConfirm = manualConfirmed === 'visual';
          await updateMaterialsUploadState(selectedMaterials, current, wasVisualConfirm ? '人工目视确认（自动检测漏报）' : '手动附加（页面核验）');
          await recordDiagnostic(wasVisualConfirm ? '附件人工目视确认' : '附件回退',
            wasVisualConfirm ? `用户人工确认 ${providerName(current)} 当前输入区显示全部附件；自动检测未能识别` : `已在 ${providerName(current)} 当前网页核验到全部附件`, {
              provider: current, level: 'warning',
              details: `文件：${selectedMaterials.map(item => item.name).join('、')}。${wasVisualConfirm ? '状态由用户明确确认网页当前待发送区域显示全部文件且无上传中/失败提示；这不是自动 DOM 检测，也不证明模型已经解析文件内容。' : '此状态来自网页可见附件名称核验；仍不代表模型已成功解析文件内容。'}`
            });
        }
      }
      if (stopRequested) break;

      // Re-read the final-turn marker after attachment preparation: the user may
      // click End while attachments are being prepared, before this reply is sent.
      const isUserRequestedFinalTurn = requestedFinalTurn === turn;
      const isConfiguredFinalTurn = Number.isFinite(maxTurns) && turn === maxTurns;
      const isFinalTurn = isUserRequestedFinalTurn || isConfiguredFinalTurn;
      setState(`第 ${turn}/${roundLimitLabel} 次回答${isFinalTurn ? '（最后一轮）' : ''}：正在等待 ${providerName(current)}……`);
      const basePrompt = turn === 1
        ? buildInitialPrompt(topic, attachmentContext, discussionGuidance, conversationMode, isFinalTurn, !!els.askToConclude.checked)
        : relayPrompt(current === 'chatgpt' ? 'deepseek' : 'chatgpt', previousText, turn, isFinalTurn && els.askToConclude.checked, topic, attachmentContext, isFinalTurn, discussionGuidance, conversationMode);
      // Do not send model-visible DUOLABTURN transport tags. They can be echoed
      // into replies and then copied into subsequent prompts. Current-turn identity
      // is established through the pre-send baseline plus the new user-message / prompt anchor.
      const prompt = basePrompt.trim();
      // From this point this turn is committed to being sent. If End is pressed
      // now (or while the page is generating), schedule the following reply as final.
      activeTurnPhase = 'awaiting';
      await recordDiagnostic('发送提示词', `第 ${turn}/${roundLimitLabel} 轮：准备发送提示词`, {
        provider: current,
        details: `提示词长度 ${prompt.length} 字符；原始附件 ${selectedMaterials.length} 份（首次到达该 AI 网页时附加）；上一轮回答长度 ${turn === 1 ? 0 : previousText.length} 字符。`
      });
      if (isFinalTurn) {
        await recordDiagnostic('结束控制', `第 ${turn} 轮已设为最后一轮，提交后将等待该 AI 的完整回答`, {
          provider: current, level: 'info',
          details: '最后一轮不会在网页提交提示词后立即结束；必须完成本轮回答提取与完成态确认后，才允许正常结束。'
        });
      }
      let sendAttemptId = '';
      try {
        // Allow long reasoning runs enough time to finish; the content script
        // independently guards against returning while a generation indicator is active.
        // The configured last answer gets a larger deadline because it may
        // contain the final audit / deliverable. A timeout never counts as success.
        const responseTimeoutMs = conversationMode === 'task'
          ? (isFinalTurn ? 900000 : 600000)
          : 120000;
        const dispatchStartedAt = Date.now();
        sendAttemptId = `${currentRunId || 'run-unknown'}:${turn}:${Date.now()}`;
        const sendContext = {
          runId: currentRunId, turn, provider: current, tabId: tabs[current], phase: activeTurnPhase
        };
        const sendTimeoutHooks = {
          onTimeout: () => {
            setState(`${providerName(current)}后台发送等待超时：提交状态不明，扩展未自动重发。请先检查目标网页是否已出现本轮提示词/回答。`);
            void recordDiagnostic('发送状态核验', `${providerName(current)}后台发送等待超时，状态未知`, {
              ...sendContext, level: 'warning', category: '发送状态不明',
              details: `发送尝试 ID=${sendAttemptId}；等待上限 90 秒。后台操作可能仍在继续，因此不自动重发；请先核对目标网页，避免重复提交。`
            });
          },
          onLateResponse: late => {
            const confirmed = !!(late?.ok && late?.submitted && late?.baseline);
            void recordDiagnostic('发送迟到回执', confirmed
              ? `${providerName(current)}后台发送超时后收到迟到的提交确认`
              : `${providerName(current)}后台发送超时后收到迟到回执，但提交未确认`, {
              ...sendContext, level: confirmed ? 'warning' : 'error', category: confirmed ? '迟到的提交确认' : '迟到回执未确认',
              details: `发送尝试 ID=${sendAttemptId}；原等待已超时。回执=${confirmed ? '网页确认本轮提示词已提交' : String(late?.error || '没有可验证的提交结果').slice(0, 500)}；不会自动再次发送。${confirmed ? `证据：${String(late.evidence || '未知').slice(0, 500)}。` : '请先检查目标网页当前状态。'}`
            });
          }
        };
        // A 45-second UI deadline used to discard late runtime callbacks. Use a bounded
        // 90-second send deadline and retain late receipts as diagnostic evidence. A timeout
        // remains an unknown state and never triggers an automatic blind resend.
        const sendResult = await sendBackgroundMessage({
          type: 'DUO_CDP_SEND', tabId: tabs[current], prompt, attemptId: sendAttemptId
        }, 90000, sendTimeoutHooks);
        const dispatchElapsed = Date.now() - dispatchStartedAt;
        if (!sendResult?.ok || !sendResult?.submitted || !sendResult?.baseline) {
          throw new Error(`${providerName(current)}后台发送未获网页提交确认或缺少发送前基线：${sendResult?.error || '没有可验证的提交结果'}`);
        }
        await recordDiagnostic('后台实际发送', `${providerName(current)}网页已确认提交提示词`, {
          provider: current, level: 'success',
          details: `发送尝试 ID=${sendAttemptId}；从扩展发起到网页确认提交耗时 ${dispatchElapsed} ms；方式：${sendResult.method || 'CDP 浏览器输入'}；证据：${sendResult.evidence || '网页状态已更新'}；安全重发=${sendResult.safeResendAttempted ? '已执行一次并确认' : '未触发'}；DeepSeek 专项重试=${sendResult.deepseekRetryAttempted ? '已执行' : '未触发'}；目标标签页前台激活=${sendResult.deepseekTabActivated ? '是' : '否'}；确认路径=${sendResult.evidence || '未知'}。`
        });
        const result = await sendTabMessage(tabs[current], {
          type: 'DUO_WAIT_ANSWER', prompt, timeoutMs: responseTimeoutMs, sendResult,
          // Every turn must be bound to the freshly submitted prompt. Otherwise
          // a prior assistant answer can be mistaken for the new round if the
          // site's composer failed to submit.
          requireFreshPrompt: true,
          // v0.10.9：最后一轮提前判定「完成」的代价最大（整轮任务就此结束），
          // 因此让内容脚本对最后一轮使用更长的静默门槛。
          finalTurn: turn === maxTurns
        }, responseTimeoutMs + 15000);
        if (!result?.ok) throw new Error(`${providerName(current)}：${result?.error || '未能读取回答'}`);
        if (!String(result.text || '').trim()) throw new Error(`${providerName(current)}返回成功状态，但回答正文为空。`);
        // Defense in depth: even if a future page-layout change bypasses the
        // content-script DOM/snapshot filters, never save or relay DeepSeek's
        // visible chain-of-thought panel as the user-facing final answer.
        if (isDeepSeekThinkingLeak(current, result.text)) {
          await recordDiagnostic('回答质量核验', '已拦截 DeepSeek 思考过程候选，未保存或接力', {
            provider: current, tabId: tabs[current], turn, phase: activeTurnPhase, level: 'error',
            details: `候选长度=${String(result.text).length}；提取通道=${result.completion?.channel || '未知'}；检测到以“已思考/思考过程/Reasoning”开头的 DeepSeek 候选。未记录正文，未发送给 ChatGPT。`
          });
          throw new Error('检测到 DeepSeek 的思考过程区域而非最终回答，已阻止保存和转发；继续等待或检查页面提取通道。');
        }
        const sanitizedReplyText = stripKnownUiChromeLines(result.text);
        if (!sanitizedReplyText) throw new Error(`${providerName(current)}回答清理后为空，疑似只提取到了网页界面文字；未保存或接力。`);
        if (isUiOnlyExtractedReply(sanitizedReplyText)) {
          const uiError = new Error(`${providerName(current)}回答提取只得到网页界面按钮/状态文字（例如“显示更多”“正在思考”），未获得真实助手正文；已阻止保存和发送给下一个 AI。`);
          await recordDiagnostic('回答质量核验', '已拦截纯网页界面文字，未计为回答', {
            provider: current, tabId: tabs[current], turn, phase: activeTurnPhase, level: 'error', error: uiError,
            details: `候选回答长度 ${String(result.text).length} 字符；提取通道 ${result.completion?.channel || '未知'}；命中的界面短语=${inspectUiOnlyExtractedReply(result.text).matchedPhrases.slice(0, 8).join('、') || '未识别'}；归一化后残留长度=${inspectUiOnlyExtractedReply(result.text).residualLength}；本轮未计入成功回答，也未发送给另一个 AI。`
          });
          throw uiError;
        }
        if (!result.completion?.confirmed) {
          throw new Error(`${providerName(current)}本轮未返回“回答已完整结束”的确认，已阻止结束任务。`);
        }
        if (!result.completion.freshPromptConfirmed) {
          throw new Error(`${providerName(current)}没有确认本轮新提示词与回答对应，已阻止把历史回答记为本轮结果。`);
        }
        if (isFinalTurn) {
          await recordDiagnostic('结束控制', `第 ${turn} 轮最后网页回答已确认完成`, {
            provider: current, level: 'success',
            details: `回答长度 ${result.text.length} 字符；等待 ${Math.round(result.completion.elapsedMs || 0)} ms；通道 ${result.completion.channel || '未知'}；本轮提示词确认=${result.completion.freshPromptConfirmed ? '是' : '否'}；观察到生成状态=${result.completion.generationObserved ? '是' : '否'}。这里只确认网页生成与回答提取完成，可以结束接力流程；不代表原始任务内容已完成。`
          });
        }
        const attachmentAccessCheck = selectedMaterials.length
          ? inspectAttachmentAccessFailure(sanitizedReplyText)
          : { matched: false, rule: 0, clauseIndex: 0 };
        if (attachmentAccessCheck.matched) {
          await updateMaterialsUploadState(selectedMaterials, current, 'AI 无法访问附件（明确否认待核验）');
          const reason = `${providerName(current)}的回答命中了附件不可访问规则 ${attachmentAccessCheck.rule}（第 ${attachmentAccessCheck.clauseIndex} 个分句）；为避免将未经文件核实的内容接力，流程已暂停。请检查回答和网页附件状态后重试。`;
          await recordDiagnostic('附件访问核验', '回答命中明确附件不可访问规则，已暂停接力', {
            provider: current, level: 'error', details: `${reason} 回答长度：${String(sanitizedReplyText).length}；仅记录规则编号与分句序号，不保存回答正文。`
          });
          throw new Error(reason);
        }
        if (isFinalTurn && conversationMode === 'task') {
          finalTaskCompletionStatus = parseTaskCompletionStatus(sanitizedReplyText);
          await recordDiagnostic('任务完成度核对', `末轮完成度状态：${finalTaskCompletionStatus}`, {
            provider: current,
            level: 'warning',
            details: finalTaskCompletionStatus === '已完成'
              ? '末轮模型声明所有要求已完成。扩展只识别了完成度状态，无法独立验证计算、论证、文件读取或交付结果是否正确；请人工检查成果。'
              : finalTaskCompletionStatus === '未识别'
                ? '扩展未能从末轮回答中识别出明确的任务状态。该状态表示“未识别”，不等于模型报告任务未完成；轮次耗尽仍不代表任务已完成，请核对末轮正文。'
                : `末轮明确报告任务状态为“${finalTaskCompletionStatus}”。扩展不会把轮次走完视为任务完成；请查看最后一轮明确列出的未完成项、无法确认项和下一步。`
          });
        }
        if (conversationMode === 'task') {
          const qualityWarnings = inspectTaskOutputQuality(sanitizedReplyText, turn > 1, isFinalTurn);
          if (qualityWarnings.length) {
            await recordDiagnostic('任务质量核验', '发现需要人工复核的风险提示', {
              provider: current, tabId: tabs[current], turn, phase: activeTurnPhase, level: 'warning',
              details: `${qualityWarnings.join('；')} 这些是基于文本模式的风险提示，不代表扩展已证明来源错误，也不代表扩展实际打开或独立核验了网页；扩展不会自动改写引用或判断任意计算正确性。`
            });
          }
        }
        previousText = sanitizedReplyText;
        activeTurnPhase = 'between';
        await recordDiagnostic('接收回答', `第 ${turn}/${roundLimitLabel} 轮：成功提取回答`, { provider: current, level: 'success', details: `回答长度 ${result.text.length} 字符；提取通道=${result.completion?.channel || '未知'}；候选类型=${result.completion?.candidateKind || '未知'}；本轮新提示词确认=${result.completion?.freshPromptConfirmed ? '是' : '否'}；生成状态曾被观察=${result.completion?.generationObserved ? '是' : '否'}；稳定观察=${Math.round(result.completion?.stableForMs || 0)}ms；静默观察=${Math.round(result.completion?.idleForMs || 0)}ms；纯界面候选已拒绝=${Number(result.completion?.rejectedUiOnlyBeforeSuccess)||0}。` });
      } catch (sendError) {
        await recordDiagnostic('发送/接收', `第 ${turn}/${roundLimitLabel} 轮：${providerName(current)}失败`, { provider: current, tabId: tabs[current], turn, phase: activeTurnPhase, error: sendError, details: `发送尝试 ID=${sendAttemptId || '未分配'}；目标标签页 ID ${tabs[current]}；提示词长度 ${prompt.length} 字符；已完成回答数 ${successfulReplies}；当前流程阶段 ${activeTurnPhase}。` });
        throw sendError;
      }
      successfulReplies++;
      appendEntry(current, previousText, `第 ${turn} 次回答`);
      await persistEntries();
      if (stopRequested) break;
      if (isFinalTurn) {
        const finishReason = isUserRequestedFinalTurn ? '用户点击“结束”，已完成指定的最后一轮' : '已达到设置的回答次数';
        if (conversationMode === 'task') {
          const statusMessage = taskCompletionStatusMessage(finalTaskCompletionStatus, successfulReplies);
          addSystem(statusMessage);
          setState(statusMessage);
          await recordDiagnostic('接力流程结束', finishReason, {
            level: 'warning', details: `最后完成的轮次：${turn}；本次共完成 ${successfulReplies} 次回答；末轮模型自报状态=${finalTaskCompletionStatus || '无法核实'}。接力流程结束不代表任务已被独立验证为完成。`
          });
        } else {
          await recordDiagnostic('结束控制', finishReason, {
            level: 'success', details: `最后完成的轮次：${turn}；本次共完成 ${successfulReplies} 次回答。接力流程结束不代表其中所有事实或观点都已独立验证。`
          });
          if (isUserRequestedFinalTurn) setState(`已按“结束”完成最后一轮。共完成 ${successfulReplies} 次回答。`);
        }
        break;
      }
      await recordDiagnostic('接力', `第 ${turn} 轮回答已保存，下一轮将发送给 ${providerName(current === 'chatgpt' ? 'deepseek' : 'chatgpt')}`, { level: 'success', details: `上一轮正文已提取并保存，长度 ${previousText.length} 字符。下一轮为第 ${turn + 1} 次回答；下一个 AI 的会话将首次附加所选原始文件，然后继续接力。` });
      await persistEntries();
      current = current === 'chatgpt' ? 'deepseek' : 'chatgpt';
    }
    if (stopRequested) {
      const stoppedMessage = conversationMode === 'task'
        ? `已停止：任务完成度未核实。共完成 ${successfulReplies} 次回答；请检查已有成果，不能视为任务已完成。`
        : `已停止。共完成 ${successfulReplies} 次回答。`;
      setState(stoppedMessage);
      await recordDiagnostic('运行结束', '用户请求停止接力', { level: conversationMode === 'task' ? 'warning' : 'info', details: `${stoppedMessage}。` });
      if (conversationMode === 'task') addSystem(stoppedMessage);
    }
    else {
      if (conversationMode === 'task' && finalTaskCompletionStatus === null) {
        const notAudited = `接力流程中止：任务完成度未核实。共完成 ${successfulReplies} 次回答；不能视为任务已完成。`;
        setState(notAudited);
        addSystem(notAudited);
        await recordDiagnostic('接力流程结束', '流程停止但未取得末轮任务完成度核对', { level: 'warning', details: notAudited });
      } else if (conversationMode !== 'task' && !String(els.runState.textContent || '').startsWith('已按“结束”')) {
        setState(`接力流程结束。共完成 ${successfulReplies} 次回答。`);
        await recordDiagnostic('运行结束', '对话接力流程正常结束', { level: 'success', details: `成功完成 ${successfulReplies} 次回答。` });
      } else if (conversationMode === 'task') {
        await recordDiagnostic('运行结束', '任务模式的接力流程结束', { level: 'warning', details: `成功完成 ${successfulReplies} 次回答；完成度状态=${finalTaskCompletionStatus}。` });
      } else {
        await recordDiagnostic('运行结束', '对话接力流程正常结束', { level: 'success', details: `成功完成 ${successfulReplies} 次回答。` });
      }
    }
  } catch (error) {
    const interruptionMessage = conversationMode === 'task'
      ? `任务执行中断，尚未确认完成：${error.message}`
      : `中断：${error.message}`;
    setState(interruptionMessage);
    await recordDiagnostic('对话中断', '自动检测到错误并中断流程', { level: conversationMode === 'task' ? 'warning' : 'error', error, details: `已成功回答 ${successfulReplies} 轮。${conversationMode === 'task' ? '任务未被确认完成。' : ''}` });
    addSystem(`${conversationMode === 'task' ? '任务执行未完成' : '对话未能继续'}：${error.message}\n自动诊断建议：${diagnosticAdvice('对话中断', error.message)}\n如需反馈，可点击“复制诊断”或“导出诊断”。`);
  } finally {
    resolveManualAttachment(false);
    await persistEntries();
    activeTurnNumber = 0;
    activeTurnPhase = 'idle';
    activeRunMaxTurns = null;
    requestedFinalTurn = null;
    setRunning(false);
    updateEndButtonState();
  }
}
els.copyDiagnostics.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(diagnosticReport()); setState('故障诊断报告已复制。'); }
  catch { setState('复制失败，请点击“导出故障报告”。'); }
});
els.downloadDiagnostics.addEventListener('click', () => {
  const blob = new Blob([diagnosticReport()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `双AI故障诊断报告_${new Date().toISOString().slice(0,10)}.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
els.clearDiagnostics.addEventListener('click', async () => {
  diagnostics = []; renderDiagnostics();
  try { await chrome.storage.local.remove('duoLabDiagnosticsV051'); setState('自动诊断记录已清空。'); }
  catch (e) { setState('清空诊断记录失败：' + (e?.message || String(e))); }
});

window.addEventListener('error', event => {
  void recordDiagnostic('JavaScript 异常', '侧边栏脚本发生运行时错误', { error: event.message || '未知脚本错误', details: `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}` });
});
window.addEventListener('unhandledrejection', event => {
  const reason = event.reason?.message || String(event.reason || '未知 Promise 错误');
  void recordDiagnostic('异步异常', '侧边栏出现未处理的异步错误', { error: reason, details: event.reason?.stack || '' });
});

els.refreshTabs.addEventListener('click', () => { void refreshTabs().catch(error => { setState(`刷新标签页失败：${error?.message || String(error)}`); void recordDiagnostic('标签页刷新', '刷新 AI 标签页列表失败', { error }); }); });
els.rounds.addEventListener('change', refreshRoundControls);
els.customRounds.addEventListener('input', refreshRoundControls);
if (els.newChatPerRun) els.newChatPerRun.addEventListener('change', () => { void persistSessionMode(); });
if (els.conversationMode) els.conversationMode.addEventListener('change', () => { void persistConversationMode(); });
if (els.discussionGuidance) els.discussionGuidance.addEventListener('change', () => { void persistConversationPreferences(); });
if (els.askToConclude) els.askToConclude.addEventListener('change', () => { void persistConversationPreferences(); });
if (els.recordScope) els.recordScope.addEventListener('change', renderTranscript);
if (els.diagnosticsScope) els.diagnosticsScope.addEventListener('change', renderDiagnostics);
// Select the current value on focus so typing a new count replaces it directly.
els.customRounds.addEventListener('focus', () => els.customRounds.select());
refreshRoundControls();
els.endBtn.addEventListener('click', async () => {
  if (!running || stopRequested) return;
  if (requestedFinalTurn !== null) {
    setState(`已安排第 ${requestedFinalTurn} 次回答为最后一轮。`);
    return;
  }
  if (Number.isFinite(activeRunMaxTurns) && activeTurnNumber >= activeRunMaxTurns) {
    setState('当前已处于设定的最后一轮，完成后会自动结束。');
    updateEndButtonState();
    return;
  }
  requestedFinalTurn = getRequestedFinalTurn();
  if (Number.isFinite(activeRunMaxTurns) && requestedFinalTurn > activeRunMaxTurns) {
    setState('当前已经没有额外轮次可安排，任务会按设定的回答次数结束。');
    updateEndButtonState();
    return;
  }
  updateEndButtonState();
  const detail = `当前轮次：${activeTurnNumber}；当前阶段：${activeTurnPhase}；已将第 ${requestedFinalTurn} 次回答设为最后一轮。已发送/正在生成的回答不会被打断；如果下一轮尚未发送，则将下一轮直接作为最后一轮。`;
  setState(`已安排结束：第 ${requestedFinalTurn} 次回答将是最后一轮。`);
  await recordDiagnostic('结束控制', '用户请求结束：下一轮设为最后一轮', { level: 'info', details: detail });
});
els.startBtn.addEventListener('click', () => {
  void startConversation().catch(async error => {
    activeTurnNumber = 0; activeTurnPhase = 'idle'; activeRunMaxTurns = null; requestedFinalTurn = null;
    setRunning(false); setState(`未处理错误：${error?.message || String(error)}`);
    await recordDiagnostic('未处理异常', '启动或运行流程出现未捕获错误', { error, details: error?.stack || '' });
    addSystem(`插件自动检测到未处理错误：${error?.message || String(error)}\n请在“自动诊断”中复制诊断报告，无需手动逐项排查。`);
  });
});
els.manualAttachContinue.addEventListener('click', async () => {
  if (!manualAttachmentPending || !manualAttachmentResolver) return;
  const info = manualAttachmentPending;
  els.manualAttachContinue.disabled = true;
  const expectedNames = info.files.map(file => file.name);
  try {
    const verification = await sendTabMessage(info.tabId, {
      type: 'DUO_VERIFY_ATTACHMENTS', fileNames: expectedNames, baselineCounts: info.baselineCounts || {}, timeoutMs: 120000
    }, 123000);
    if (!verification?.ok || !verification.confirmed) {
      const missing = verification?.missing?.length ? verification.missing : expectedNames;
      const reason = verification?.reason || verification?.error || '目标网页没有提供当前输入区附件的有效证据';
      els.manualAttachMessage.textContent = `仍未通过附件核验：${reason}。缺失/未确认：${missing.join('、')}。请在网页的当前消息输入区用网站自己的附件按钮手动添加文件，再回来重新核验。插件不会仅凭点击按钮就发送主题。`;
      els.materialsStatus.textContent = '附件核验未通过；主题仍未发送。';
      await recordDiagnostic('附件回退核验', '手动回退未通过：当前输入区没有显示全部指定文件', {
        provider: info.provider, level: 'error', details: `期望：${expectedNames.join('、')}；匹配：${verification?.matched?.join('、') || '无'}；缺失：${missing.join('、')}；原因：${reason}`
      });
      return;
    }
    await recordDiagnostic('附件回退核验', `已在 ${providerName(info.provider)} 当前输入区核验到全部手动附件`, {
      provider: info.provider, level: 'warning',
      details: `核验文件：${expectedNames.join('、')}。依据是当前输入区可见附件卡片中的文件名，而不是按钮点击。该证据仍不代表 AI 已成功解析文件。`
    });
    resolveManualAttachment('detected');
  } catch (error) {
    els.manualAttachMessage.textContent = `附件核验请求失败：${error?.message || String(error)}。主题未发送；请刷新 AI 网页后重试。`;
    await recordDiagnostic('附件回退核验', '无法联系目标网页核验附件', { provider: info.provider, error });
  } finally {
    if (els.manualAttachContinue) els.manualAttachContinue.disabled = false;
  }
});
if (els.manualAttachVisualConfirm && els.manualAttachVisualContinue) {
  els.manualAttachVisualConfirm.addEventListener('change', () => {
    els.manualAttachVisualContinue.disabled = !els.manualAttachVisualConfirm.checked;
  });
  els.manualAttachVisualContinue.addEventListener('click', async () => {
    if (!manualAttachmentPending || !manualAttachmentResolver) return;
    if (!els.manualAttachVisualConfirm.checked) {
      els.manualAttachMessage.textContent = '请先勾选确认框：你已经亲眼确认目标网页当前消息输入区显示全部指定文件，且没有上传中或失败提示。';
      return;
    }
    const info = manualAttachmentPending;
    const names = info.files.map(file => file.name);
    els.manualAttachVisualContinue.disabled = true;
    try {
      await recordDiagnostic('附件人工目视确认', `用户确认 ${providerName(info.provider)} 网页中附件可见；绕过自动 DOM 漏报`, {
        provider: info.provider, level: 'warning',
        details: `文件：${names.join('、')}。用户勾选确认当前消息输入区显示全部附件且无上传中/失败提示。自动检测未能识别；此记录明确标记为人工确认，不伪装成自动检测成功。`
      });
      resolveManualAttachment('visual');
    } catch (error) {
      els.manualAttachMessage.textContent = `记录人工确认时发生错误：${error?.message || String(error)}。主题未发送；请重试。`;
      els.manualAttachVisualContinue.disabled = !els.manualAttachVisualConfirm.checked;
    }
  });
}

els.stopBtn.addEventListener('click', async () => {
  stopRequested = true;
  if (els.endBtn) els.endBtn.disabled = true;
  resolveManualAttachment(false);
  setState('正在请求停止……');
  try { await stopAll({ chatgpt: Number(els.chatgptTab.value), deepseek: Number(els.deepseekTab.value) }); } catch {}
});
els.copyLog.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(logText()); setState('对话记录已复制。'); }
  catch { setState('复制失败。请尝试导出 TXT。'); }
});
els.downloadLog.addEventListener('click', () => {
  const blob = new Blob([logText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `双AI对话记录_${new Date().toISOString().slice(0,10)}.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
els.clearLog.addEventListener('click', () => {
  if (running) return;
  entries = []; renderTranscript();
  chrome.storage.local.set({ duoLabEntriesV021: [] }).then(() => setState('记录已清空。')).catch(() => setState('本机记录清理失败，请重试。'));
});
els.uploadMaterials.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => { void handleUpload(els.fileInput.files, '文件选择'); });
// Accept dropped files in the material area without navigating the extension panel.
let materialDragDepth = 0;
const dropZone = els.materialDropZone;
if (dropZone) {
  for (const eventName of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    dropZone.addEventListener(eventName, event => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
  dropZone.addEventListener('dragenter', event => {
    materialDragDepth++;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!running && !els.uploadMaterials.disabled) dropZone.classList.add('is-dragging');
  });
  dropZone.addEventListener('dragover', event => {
    if (event.dataTransfer) event.dataTransfer.dropEffect = (running || els.uploadMaterials.disabled) ? 'none' : 'copy';
  });
  dropZone.addEventListener('dragleave', () => {
    materialDragDepth = Math.max(0, materialDragDepth - 1);
    if (materialDragDepth === 0) dropZone.classList.remove('is-dragging');
  });
  dropZone.addEventListener('drop', event => {
    materialDragDepth = 0;
    dropZone.classList.remove('is-dragging');
    const droppedFiles = event.dataTransfer?.files;
    if (!droppedFiles?.length) {
      dropZone.classList.add('is-error');
      els.materialsStatus.textContent = '未检测到文件。请把电脑中的文件拖到虚线框内，不要拖文件夹或网页链接。';
      window.setTimeout(() => dropZone.classList.remove('is-error'), 1800);
      return;
    }
    void handleUpload(droppedFiles, '拖拽');
  });
}
els.refreshMaterials.addEventListener('click', () => { void refreshMaterials(); });
els.clearMaterials.addEventListener('click', async () => {
  if (running) { els.materialsStatus.textContent = '讨论进行中不能清空资料库，请先停止讨论。'; return; }
  if (!materials.length) { els.materialsStatus.textContent = '资料库已经是空的。'; return; }
  if (!confirm('确定删除本机资料库中的全部已保存资料吗？此操作不会删除原始电脑文件。')) return;
  try { for (const item of materials) await DuoMaterials.remove(item.id); materialUploadStates = {}; await chrome.storage.local.set({ duoLabFileUploadStatesV060: {} }); await refreshMaterials(); els.materialsStatus.textContent = '本机资料库已清空。'; }
  catch (error) { els.materialsStatus.textContent = `清空失败：${error?.message || String(error)}`; }
});

restorePromise = Promise.all([
  restoreEntries().catch(error => { setState('读取本机记录失败：' + (error?.message || String(error))); }),
  restoreSessionMode(),
  restoreConversationPreferences(),
  restoreConversationMode()
]);
restorePromise.then(async () => { await restoreDiagnostics(); await Promise.all([refreshTabs(), refreshMaterials(), refreshRecoveredDrafts()]); }).catch(error => { setState('初始化失败：' + (error?.message || String(error))); void recordDiagnostic('初始化', '侧边栏初始化失败', { error }); });


chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && Object.prototype.hasOwnProperty.call(changes, RECOVERED_DRAFTS_KEY)) {
    void refreshRecoveredDrafts();
  }
});

// 等待回答期间，内容脚本每 2.5 秒上报一次判据快照。
// 状态栏直接显示「在等什么」，诊断按 6 秒一条落盘 —— 这样「页面上已经回答了、插件还在等」
// 这种问题不必等到超时才知道原因。
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'DUO_EXTRACT_PROGRESS') return;
  const provider = message.provider || '';
  const elapsedSec = Math.max(0, Number(message.elapsedMs) || 0) / 1000;
  const answerLength = Number(message.answerLength) || 0;
  const stuckSec = Math.round((Number(message.generatingStuckMs) || 0) / 1000);
  setState(`第 ${activeTurnNumber}/${activeRunMaxTurns || '?'} 次回答：正在等待 ${providerName(provider)}……已等 ${elapsedSec.toFixed(0)}s｜页面候选 ${answerLength} 字符｜通道=${message.channel || '无'}｜生成中=${message.generating ? '是' : '否'}${stuckSec ? `（已持续 ${stuckSec}s）` : ''}｜本轮提示词确认=${message.promptConfirmed ? '是' : '否'}`);
  const signature = `${message.channel}|${message.generating}|${Math.floor(elapsedSec / 6)}`;
  if (Date.now() - lastProgressLogAt >= 6000 && signature !== lastProgressState) {
    lastProgressLogAt = Date.now();
    lastProgressState = signature;
    void recordDiagnostic('接收回答', `${providerName(provider)}仍在等待回答（进度快照）`, {
      provider, level: 'info',
      details: `已等 ${elapsedSec.toFixed(1)}s／上限 ${(Number(message.timeoutMs) || 0) / 1000}s；页面候选长度=${answerLength}；候选取自=${message.channel || '无'}；生成中=${message.generating ? '是' : '否'}；生成状态已持续=${stuckSec}s；页面文本字数=${message.pageSigLength ?? '未知'}；本轮提示词确认=${message.promptConfirmed ? '是' : '否'}；已拒绝纯界面候选=${message.rejectedUiOnly || 0}。`
    });
  }
});
