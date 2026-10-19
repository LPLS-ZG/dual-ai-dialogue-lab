// 双 AI 对话实验室 · 内容脚本 v0.8.23
//
// 与旧版的根本区别（回答检测层重写）：
//   旧版把回答检测完全绑定在站点特定 DOM 上——所有助手节点选择器都以 'main ' 开头，
//   兜底文本提取也先要求 document.querySelector('main') 存在，助手节点类名假定为
//   .ds-markdown / [data-message-author-role="assistant"]。任一假设不成立，检测链路
//   整体返回空，而发送链路（background.js 用输入框祖先链 + document 兜底）不受影响，
//   于是出现"消息发出去了、网页上也回复了、插件却说检测不到"。
//
//   本版改为三条互不依赖的通道，只要任一条成立就能取回本轮回答：
//     通道 1（主）：页面文本快照 + 提示词文本锚点。把页面文本归一化成「仅字母数字
//                   汉字」的信号串，在其中定位本轮提示词，取其后原文作为回答。锚点
//                   先试尾部（提示词结尾），失败再试头部（提示词开头 + 前缀推进），
//                   对空白折叠、Markdown 符号重排、类名改版免疫。
//     通道 2（备）：快照前缀差分。与发送前的快照做最长公共前缀比较，新增段即本轮
//                   用户消息 + 回答，剥掉用户消息后得到回答。
//     通道 3（末）：通用 DOM 助手节点提取（不限定 main 前缀与固定类名）。
//   三个通道的结果都要通过"内容必须是发送前不存在的新文本"校验，避免把旧回答当成
//   本轮回答转发给另一个 AI。
(() => {
  try { if (typeof window.__duoLabDispose === 'function') window.__duoLabDispose(); } catch {}

  let cancelled = false;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const normalize = value => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const isWordChar = ch => /[\p{L}\p{N}]/u.test(ch);
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const textOf = el => ((el && (el.innerText || el.textContent)) || '').trim();
  const editableText = el => String(el && ('value' in el ? el.value : (el.innerText || el.textContent || ''))).trim();
  const PROVIDER = (() => {
    const host = location.hostname.toLowerCase();
    if (host.includes('deepseek')) return 'deepseek';
    if (host.includes('chatgpt') || host.includes('openai')) return 'chatgpt';
    return 'unknown';
  })();
  const PROVIDER_LABEL = PROVIDER === 'chatgpt' ? 'ChatGPT' : 'DeepSeek';
  // DeepSeek renders its visible reasoning panel separately from the final answer.
  // Never include these subtrees in transcript snapshots or candidate extraction.
  // Keep this list site-specific: generic words such as "thinking" in answer text
  // must not cause an otherwise legitimate reply to be removed.
  const DEEPSEEK_THINKING_SELECTOR = [
    '.ds-think-content', '.ds-thinking-content', '.ds-reasoning-content',
    '[class*="ds-think"]', '[class*="think-content"]', '[class*="thinking-content"]', '[class*="reasoning-content"]', '[class*="reasoning-panel"]',
    '[data-testid*="think-content"]', '[data-testid*="thinking"]', '[data-testid*="reasoning"]', '[data-testid*="thought"]',
    '[aria-label*="思考过程"]', '[aria-label*="reasoning" i]', '[aria-label*="thinking" i]'
  ].join(',');
  function isDeepSeekThinkingElement(el) {
    if (PROVIDER !== 'deepseek' || !el || el.nodeType !== Node.ELEMENT_NODE) return false;
    try { if (el.matches(DEEPSEEK_THINKING_SELECTOR)) return true; } catch {}
    const attrs = [el.id, el.getAttribute?.('data-testid'), el.getAttribute?.('data-test-id'), el.getAttribute?.('aria-label'),
      typeof el.className === 'string' ? el.className : (el.className?.baseVal || '')].filter(Boolean).join(' ').toLowerCase();
    return /(?:ds[-_ ]?(?:think|thinking|reasoning)[-_ ]?(?:content|panel|block|process)|(?:think|thinking|reasoning)[-_ ]?(?:content|panel|block|process)|chain[-_ ]?of[-_ ]?thought|cot[-_ ]?content)/i.test(attrs);
  }
  // ChatGPT can render a preference-feedback card over the conversation after a
  // reply: “你更喜欢哪个选项？” / Option 1 / Option 2 / “跳过”. It is UI, not
  // part of the model response. Identify the whole compact card by its combined
  // unique labels rather than deleting generic words such as “选项” from prose.
  const CHATGPT_PREFERENCE_TITLE_RE = /你更喜欢哪个\s*(?:选项|回答)|which (?:response|answer|option) do you prefer/i;
  function isChatGPTPreferenceFeedbackElement(el) {
    if (PROVIDER !== 'chatgpt' || !el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el === document.body || el === document.documentElement) return false;
    const raw = String(el.textContent || '');
    if (!raw || raw.length > 2400 || !CHATGPT_PREFERENCE_TITLE_RE.test(raw)) return false;
    const text = normalize(raw).toLowerCase();
    const hasOption1 = /(?:选项|option)\s*1/i.test(text);
    const hasOption2 = /(?:选项|option)\s*2/i.test(text);
    const hasFeedbackDescription = /告诉我们哪个选项更好|帮助我们改善你的体验|tell us which option|help us improve your experience/i.test(text);
    const hasPreferAction = /我更喜欢这个选项|i prefer this option|i prefer this response/i.test(text);
    const hasSkip = /跳过|\bskip\b/i.test(text);
    if (!(hasOption1 && hasOption2 && hasFeedbackDescription && hasPreferAction && hasSkip)) return false;
    let controls = 0;
    try { controls = el.querySelectorAll('button,[role="button"],a').length; } catch {}
    const attrs = [el.getAttribute?.('role'), el.getAttribute?.('aria-modal'), el.getAttribute?.('data-testid'),
      typeof el.className === 'string' ? el.className : ''].filter(Boolean).join(' ');
    return controls >= 2 || /dialog|modal|feedback|preference|rating/i.test(attrs);
  }
  function findChatGPTPreferenceFeedbackElements(root) {
    const found = new Set();
    if (PROVIDER !== 'chatgpt' || !root || typeof document.createTreeWalker !== 'function') return found;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (!CHATGPT_PREFERENCE_TITLE_RE.test(String(textNode.nodeValue || ''))) continue;
      let el = textNode.parentElement;
      for (let depth = 0; el && depth < 12; depth++, el = el.parentElement) {
        if (isChatGPTPreferenceFeedbackElement(el)) { found.add(el); break; }
        if (el === root) break;
      }
    }
    return found;
  }
  function answerTextOf(el) {
    if (!el || isDeepSeekThinkingElement(el) || isChatGPTPreferenceFeedbackElement(el)) return '';
    try { if (el.closest?.(DEEPSEEK_THINKING_SELECTOR)) return ''; } catch {}
    let copy;
    try { copy = el.cloneNode(true); } catch { return textOf(el); }
    if (PROVIDER === 'deepseek') {
      try { copy.querySelectorAll(DEEPSEEK_THINKING_SELECTOR).forEach(node => node.remove()); } catch {}
    }
    if (PROVIDER === 'chatgpt') {
      const feedbackNodes = [...findChatGPTPreferenceFeedbackElements(copy)];
      feedbackNodes.sort((a, b) => {
        const depth = node => { let n = 0; for (let cur = node; cur; cur = cur.parentElement) n++; return n; };
        return depth(b) - depth(a);
      });
      if (feedbackNodes.includes(copy)) return '';
      for (const node of feedbackNodes) { try { node.remove(); } catch {} }
    }
    return textOf(copy);
  }
  // Raw file chunks are transferred through extension messaging and assembled
  // as File objects in memory. This avoids writing temporary copies to Downloads.
  const rawFileTransferSessions = new Map();
  const MAX_RAW_TRANSFER_BYTES = 64 * 1024 * 1024;
  const MAX_RAW_CHUNK_BYTES = 512 * 1024;
  function fnv1aChunks(chunks) {
    let hash = 0x811c9dc5;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i++) {
        hash ^= chunk[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
    }
    return hash.toString(16).padStart(8, '0');
  }
  function shortInputDescriptor(input) {
    return [input?.id, input?.name, input?.accept, input?.getAttribute?.('data-testid'), input?.getAttribute?.('class')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 220);
  }

  // ---------- 页面文本快照 ----------
  const SKIP_SELECTOR = 'script,style,noscript,textarea,input,select,option,svg,[contenteditable="true"],[aria-hidden="true"]';
  const CHROME_REGIONS = 'nav,aside,header,footer,[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"]';
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TD', 'TH', 'BLOCKQUOTE', 'PRE',
    'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'ADDRESS',
    'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV'
  ]);

  function pageRoot() {
    // 直接使用 body：它一定是「页面上所有可见文本」的超集。
    // v0.8.13 实测：ChatGPT 的 <main> 只有 1430 字符（不含对话）；
    // DeepSeek 的消息节点公共祖先又只覆盖助手区、漏掉用户消息 ——
    // 两种「聪明」的推测都会漏内容，只有 body 不会。
    return document.body;
  }
  function describeRoot(root) {
    const node = root || pageRoot();
    if (!node) return '无';
    if (node === document.body) return 'body';
    return node.tagName.toLowerCase() + (node.id ? '#' + node.id : '');
  }

  // 读取「可见对话文本」：raw 保留标点与换行，sig 只保留字母/数字/汉字（小写），
  // map[i] 记录 sig[i] 在 raw 中的下标，用于把定位结果映射回可读原文。
  function snapshot() {
    const root = pageRoot();
    const parts = [];
    const map = [];
    let sig = '';
    let rawLen = 0;
    if (!root) return { root: null, raw: '', sig, map };
    const isBody = root === document.body;
    const composerForSkip = findComposer();
    const chatGptPreferenceNodes = PROVIDER === 'chatgpt' ? findChatGPTPreferenceFeedbackElements(root) : new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // 编辑器里还没提交的草稿绝不能算进对话文本，否则「刚输入的提示词」会被当成已发送的消息。
          if (composerForSkip && (node === composerForSkip || composerForSkip.contains(node))) return NodeFilter.FILTER_REJECT;
          // DeepSeek 的思考面板不是最终回答：将整个子树从锚点快照中排除，
          // 否则页面尾部通道可能把“已思考（用时…）”及其内容转发给下一模型。
          if (isDeepSeekThinkingElement(node)) return NodeFilter.FILTER_REJECT;
          // Exclude the entire ChatGPT preference-feedback card from snapshot anchors.
          if (chatGptPreferenceNodes.has(node)) return NodeFilter.FILTER_REJECT;
          let skip = false;
          try { skip = node.matches(SKIP_SELECTOR) || (isBody && node.matches(CHROME_REGIONS)); } catch { skip = false; }
          return skip ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
        return (node.nodeValue && node.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    const push = text => { if (text) { parts.push(text); rawLen += text.length; } };
    let prevParent = null;
    let node = root;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'BR') { push('\n'); prevParent = null; }
        continue;
      }
      const parent = node.parentElement;
      if (prevParent && parent && parent !== prevParent && BLOCK_TAGS.has(parent.tagName)) push('\n');
      prevParent = parent;
      const text = node.nodeValue.replace(/[\t\u00a0]+/g, ' ');
      const base = rawLen;
      push(text);
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (isWordChar(ch)) { sig += ch.toLowerCase(); map.push(base + i); }
      }
    }
    return { root, raw: parts.join(''), sig, map };
  }

  function sigOf(value) {
    let out = '';
    for (const ch of String(value == null ? '' : value)) if (isWordChar(ch)) out += ch.toLowerCase();
    return out;
  }
  function occurrencePositions(haystack, needle) {
    if (!needle) return [];
    const positions = [];
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
      positions.push(index);
      index += Math.max(1, needle.length);
    }
    return positions;
  }
  function countOccurrences(haystack, needle) {
    return occurrencePositions(haystack, needle).length;
  }
  // Return the first occurrence beyond those already present before sending.
  // Returning the latest occurrence unconditionally is unsafe: if the prompt
  // was repeated in historical messages, an older prefix can look like this turn.
  function newOccurrenceIndex(currentSig, beforeSig, needle) {
    const current = occurrencePositions(currentSig || '', needle);
    const previousCount = occurrencePositions(beforeSig || '', needle).length;
    return current.length > previousCount ? current[previousCount] : -1;
  }

  // ---------- 站点界面文字清理（只清尾部的按钮/提示行，不动正文） ----------
  const CHROME_WORDS = [
    '复制', '分享', '重新生成', '重新回答', '重新发送', '点赞', '点踩', '朗读', '编辑', '编辑消息', '删除', '引用',
    '展开', '收起', '折叠', '深度思考', '已深度思考', '思考中', '思考', '联网搜索', '联网', '搜索', '停止生成',
    '停止', '继续生成', '生成中', '复制代码', '下载', '全屏', '预览', '查看', '保存', '追问', '重试', '新对话',
    '清空', '内容由 AI 生成，请仔细甄别', 'DeepSeek 可能会出错。请核实重要信息。',
    'ChatGPT 可能会出错。请核查重要信息。', 'ChatGPT may make mistakes. Check important info.',
    '最新一条回复', '最新回复', '正在思考'
  ];
  const CHROME_EXACT = new Set(CHROME_WORDS.map(word => word.toLowerCase()));
  const CHROME_TAIL = ['复制', '分享', '重新生成', '重新回答', '点赞', '点踩', '朗读', '编辑', '深度思考', '联网搜索'];
  // UI-only text observed in production logs (e.g. “显示更多正在思考正在分析”
  // and “深度思考智能搜索”) must never be treated as an assistant answer.
  // Remove only complete known UI phrases for this quality check; ordinary answer
  // text that merely mentions thinking/searching remains valid.
  const UI_ONLY_PHRASES = [
    '显示更多', '查看更多', '展开全文', '最新一条回复', '最新回复', '继续生成', '停止生成',
    '正在思考', '思考中', '正在分析', '分析中', '正在整理', '整理中', '正在处理', '处理中', '正在生成回答', '正在生成', '等待回答', '请稍等', '请稍候', '正在搜索', '搜索中', '已深度思考', '深度思考',
    '智能搜索', '联网搜索', '复制代码', '重新生成', '重新回答', '重新发送', '展开', '收起', '折叠',
    '分享', '复制', '点赞', '点踩', '朗读', '编辑消息', '编辑', '删除', '引用', '追问', '重试',
    '新对话', '清空', '下载', '全屏', '预览', '查看', '保存', '生成中',
    'show more', 'view more', 'expand', 'collapse', 'thinking', 'analyzing', 'searching the web',
    'web search', 'deep thinking', 'smart search', 'searching', 'generating', 'thinking...', 'searching...',
    'copy code', 'regenerate', 'stop generating', 'continue generating', 'response stopped', 'try again',
    'read aloud', 'share', 'copy', 'retry', 'message actions', 'copy response', 'edit message', 'thumbs up', 'thumbs down'
  ].sort((a, b) => b.length - a.length);

  function uiOnlyResidual(value) {
    let compact = String(value == null ? '' : value).normalize('NFKC').toLowerCase()
      .replace(/[\p{White_Space}\p{P}\p{S}\p{Default_Ignorable_Code_Point}\p{Cf}]+/gu, '');
    const original = compact;
    let matched = false;
    let removedLength = 0;
    const matchedPhrases = [];
    for (const phrase of UI_ONLY_PHRASES) {
      const token = phrase.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{P}\p{S}\p{Default_Ignorable_Code_Point}\p{Cf}]+/gu, '');
      if (!token || !compact.includes(token)) continue;
      matched = true;
      const beforeLength = compact.length;
      compact = compact.split(token).join('');
      removedLength += beforeLength - compact.length;
      matchedPhrases.push(phrase);
    }
    const residual = sigOf(compact);
    const ratio = original.length ? removedLength / original.length : 0;
    return { matched, residual, original: sigOf(original), ratio, matchedPhrases };
  }

  function isUiOnlyAnswer(value) {
    const text = String(value == null ? '' : value).trim();
    if (!text) return true;
    const result = uiOnlyResidual(text);
    return result.matched && (result.residual.length <= 2 || (text.length <= 48 && result.ratio >= 0.72 && result.residual.length <= 5));
  }

  function isUiControlNode(el, rawText = '') {
    if (!el) return false;
    try {
      if (el.matches('button,[role="button"],[role="status"],[aria-live],input,textarea,[contenteditable="true"]')) return true;
      if (el.closest('button,[role="button"],[role="status"],[aria-live],form,[contenteditable="true"]')) return true;
      const attrs = [el.id, el.getAttribute('data-testid'), el.getAttribute('data-test-id'), typeof el.className === 'string' ? el.className : ''].join(' ').toLowerCase();
      if (/(?:toolbar|message-actions|response-actions|action-bar|copy-button|feedback-button|thinking-indicator|search-indicator|status-label|progress-label|composer)/i.test(attrs) && String(rawText || '').length < 120) return true;
    } catch {}
    return isUiOnlyAnswer(rawText);
  }

  let rejectedUiOnlyCandidateCount = 0;
  let lastRejectedUiOnlySignature = '';
  let lastRejectedUiOnlyPhrases = [];
  function noteRejectedUiOnlyCandidate(value) {
    if (!isUiOnlyAnswer(value)) return;
    const signature = sigOf(value).slice(0, 80) || String(value).replace(/\s+/g, ' ').slice(0, 80);
    const reason = uiOnlyResidual(value);
    if (signature && signature !== lastRejectedUiOnlySignature) {
      rejectedUiOnlyCandidateCount++;
      lastRejectedUiOnlySignature = signature;
      lastRejectedUiOnlyPhrases = reason.matchedPhrases.slice(0, 8);
    }
  }
  let rejectedDeepSeekThinkingCount = 0;
  let lastRejectedDeepSeekThinkingSignature = '';
  function isDeepSeekThinkingText(value) {
    if (PROVIDER !== 'deepseek') return false;
    const text = String(value == null ? '' : value).replace(/^\uFEFF/, '').trimStart();
    // Deliberately require a leading, standalone DeepSeek reasoning heading. Do not
    // reject ordinary answers that discuss thinking/reasoning in their own prose.
    return /^(?:已(?:经)?(?:深度)?思考(?:\s*[（(][^）)\n]{0,80}[）)])?|思考过程|推理过程|reasoning(?:\s+process)?|thought process)\s*(?:[:：-]\s*)?/i.test(text);
  }
  function noteRejectedDeepSeekThinkingCandidate(value) {
    const signature = sigOf(String(value || '').slice(0, 180));
    if (signature && signature !== lastRejectedDeepSeekThinkingSignature) {
      rejectedDeepSeekThinkingCount++;
      lastRejectedDeepSeekThinkingSignature = signature;
    }
  }
  const UI_CHROME_EXACT_LINES = new Set([
    'to pick up a draggable item, press the space bar',
    'while dragging, use the arrow keys to move the item',
    'press space again to drop the item in its new position, or press escape to cancel',
    '最新一条回复思考', '最新回复思考', '最新一条回复', '最新回复',
    '回答已完成', '深度思考智能搜索', '已深度思考', '智能搜索'
  ]);
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
  function stripKnownUiChromeLines(value) {
    const lines = stripChatGPTPreferenceFeedbackText(value).split(/\r?\n/);
    const kept = lines.filter(line => {
      const key = String(line || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.!。！]+$/g, '').trim();
      if (!key) return true;
      if (UI_CHROME_EXACT_LINES.has(key)) return false;
      if (/^(?:回答已完成\s*){1,4}$/u.test(key)) return false;
      if (/^(?:latest reply|latest response)\s*(?:thinking)?$/i.test(key)) return false;
      return true;
    });
    return kept.join('\n')
      .replace(/(?:\s*To pick up a draggable item, press the space bar\.?)\s*(?:While dragging, use the arrow keys to move the item\.?)\s*(?:Press space again to drop the item in its new position, or press escape to cancel\.?)\s*$/i, '')
      .replace(/(?:\s*回答已完成){2,4}\s*$/u, '')
      .trim();
  }

  // 用户消息被站点截断展示时，会插在用户消息与回答之间的界面词。
  const UI_NOISE = ['展开', '收起', '显示更多', '查看更多', '全文', '展开全文'];

  function cleanAnswer(value) {
    // Internal turn markers must never leak into the answer forwarded to the other AI.
    // Remove the exact extension-authored instruction and marker wherever a UI fallback
    // accidentally captured the edge of the submitted user message.
    const initial = stripKnownUiChromeLines(String(value == null ? '' : value)
      .replace(/请忽略下一行扩展内部校验标记，不要在回答中提及。/gi, '')
      .replace(/DUOLABTURN[A-Z0-9]+/gi, ''));
    // Do not ever accept DeepSeek's visible reasoning panel as the model's final
    // answer. If the site exposes only this block, return empty so sendAndWait keeps
    // waiting for a separate final-answer node instead of relaying/saving it.
    if (isDeepSeekThinkingText(initial)) {
      noteRejectedDeepSeekThinkingCandidate(initial);
      return '';
    }
    if (isUiOnlyAnswer(initial)) return '';
    const lines = initial.split('\n');
    for (let guard = 0; guard < 40 && lines.length; guard++) {
      const last = normalize(lines[lines.length - 1]);
      if (!last) { lines.pop(); continue; }
      if (CHROME_EXACT.has(last.toLowerCase()) || /^(?:ChatGPT\s*)?(?:可能会出错|may make mistakes)/i.test(last)) { lines.pop(); continue; }
      break;
    }
    let out = lines.join('\n')
      .replace(/(?:ChatGPT\s*可能会出错。?请核查重要信息。?|ChatGPT may make mistakes\.? Check important info\.?|内容由 AI 生成，?请仔细甄别|DeepSeek\s*可能会出错。?请核实重要信息。?)(?=\s|$)/gi, '')
      .replace(/(?:最新一条回复|最新回复)\s*(?:思考|正在思考)?\s*$/i, '')
      .replace(/(?:思考|正在思考)\s*$/i, '')
      .trim();
    for (const word of CHROME_TAIL) if (out.endsWith(word)) out = out.slice(0, -word.length).trim();
    out = out.trim();
    return isUiOnlyAnswer(out) ? '' : out;
  }

  function skipUiNoise(sig, index) {
    let i = index;
    for (let guard = 0; guard < 4; guard++) {
      let matched = false;
      for (const word of UI_NOISE) {
        if (word && sig.startsWith(word, i)) { i += word.length; matched = true; break; }
      }
      if (!matched) break;
    }
    return i;
  }

  // ---------- 通道 1：提示词锚点 ----------
  function anchorsFor(promptSig) {
    const list = [];
    if (promptSig.length >= 40) list.push(promptSig);
    for (const len of [240, 120, 64, 32]) if (promptSig.length > len) list.push(promptSig.slice(-len));
    return [...new Set(list)];
  }
  function headAnchorsFor(promptSig) {
    const list = [];
    for (const len of [240, 120, 48, 24]) if (promptSig.length > len) list.push(promptSig.slice(0, len));
    if (!list.length && promptSig.length >= 12) list.push(promptSig);
    return [...new Set(list)];
  }
  function usable(snap, startSig) {
    if (startSig == null || startSig >= snap.sig.length) return null;
    const rawStart = snap.map[startSig];
    if (rawStart == null) return null;
    if (sigOf(cleanAnswer(snap.raw.slice(rawStart))).length < 3) return null;
    return rawStart;
  }
  // 尾部锚点：提示词完整渲染时最稳，切点就在回答开头。
  function locateStartByAnchor(snap, promptSig, beforeSig = null) {
    if (!snap.sig || !promptSig) return null;
    for (const anchor of anchorsFor(promptSig)) {
      const at = beforeSig == null
        ? snap.sig.lastIndexOf(anchor)
        : newOccurrenceIndex(snap.sig, beforeSig, anchor);
      if (at < 0) continue;
      const rawStart = usable(snap, at + anchor.length);
      if (rawStart == null) continue;
      return { rawStart, anchorLength: anchor.length, channel: beforeSig == null ? '锚点(尾)' : '锚点(尾·本轮新提示词)', confirmedNewPrompt: beforeSig != null };
    }
    return null;
  }
  // 头部锚点：站点将用户消息折叠为“前 N 字 + 展开”时使用。
  // 必须命中发送前基线中新增的前缀，不能把历史里相同的短前缀当成本轮起点。
  function locateStartByHeadAnchor(snap, promptSig, beforeSig = null) {
    if (!snap.sig || promptSig.length < 24) return null;
    for (const anchor of headAnchorsFor(promptSig)) {
      const at = beforeSig == null
        ? snap.sig.lastIndexOf(anchor)
        : newOccurrenceIndex(snap.sig, beforeSig, anchor);
      if (at < 0) continue;
      let p = 0;
      while (p < promptSig.length && snap.sig[at + p] === promptSig[p]) p++;
      if (p < Math.min(24, promptSig.length)) continue;
      const rawStart = usable(snap, skipUiNoise(snap.sig, at + p));
      if (rawStart == null) continue;
      return { rawStart, anchorLength: anchor.length, channel: beforeSig == null ? '锚点(头)' : '锚点(头·本轮新提示词)', confirmedNewPrompt: beforeSig != null };
    }
    return null;
  }

  // ---------- 通道 2：发送前后快照差分 ----------
  function locateStartByDiff(before, now, promptSig) {
    // Only accept the complete prompt or an end-anchored suffix. A head prefix
    // is not a safe cut point: slicing after it can return the rest of the user's
    // old/unsent prompt as though it were the assistant's answer.
    const a = before.sig || '', b = now.sig || '';
    const max = Math.min(a.length, b.length);
    if (!max) return null;
    let k = 0;
    while (k < max && a[k] === b[k]) k++;
    if (k < max * 0.9) return null; // 历史被大幅重排/裁剪，差分不可信
    let end = -1;
    let channel = '';
    if (promptSig) {
      const at = newOccurrenceIndex(b, a, promptSig);
      if (at >= k) { end = at + promptSig.length; channel = '差分(完整本轮提示词)'; }
    }
    if (end < 0) {
      for (const len of [240, 120, 64, 32]) {
        const tail = promptSig ? promptSig.slice(-len) : '';
        if (!tail) continue;
        const at = newOccurrenceIndex(b, a, tail);
        if (at >= k) { end = at + tail.length; channel = '差分(本轮提示词尾锚点)'; break; }
      }
    }
    if (end < 0) return null;
    const rawStart = usable(now, end);
    if (rawStart == null) return null;
    return { rawStart, anchorLength: 0, channel, confirmedNewPrompt: true };
  }

  function locateAfterTurnMarker(snap, markerSig, beforeSig = '') {
    if (!snap?.sig || !markerSig) return null;
    const at = newOccurrenceIndex(snap.sig, beforeSig || '', markerSig);
    if (at < 0) return null;
    // Keep the raw position immediately after the marker's final character so
    // the answer's leading Markdown punctuation/newline is not stripped by sig-map.
    const lastMarkerRawIndex = snap.map[at + markerSig.length - 1];
    if (lastMarkerRawIndex == null) return null;
    const rawStart = lastMarkerRawIndex + 1;
    if (sigOf(cleanAnswer(snap.raw.slice(rawStart))).length < 3) return null;
    return { rawStart, anchorLength: markerSig.length, channel: '唯一轮次标记(本轮新消息)', confirmedNewPrompt: true };
  }

  // Anchor/diff channels only return an answer after proving that the matching
  // prompt occurrence was added after the pre-send baseline. The DOM channel
  // separately excludes exact previous assistant-message signatures.

  // ---------- 通道 3：通用 DOM 助手节点（不限定 main 前缀与固定类名） ----------
  function assistantNodes(promptCoreSig = '', turnMarkerSig = '') {
    const root = pageRoot();
    if (!root) return [];
    // Prefer semantic assistant-message containers. Only fall back to markdown
    // classes when the site exposes no semantic role, so nested markdown spans
    // do not accidentally reduce a whole answer to its final paragraph.
    const selectorGroups = PROVIDER === 'deepseek' ? [
      ['.ds-markdown'],
      ['[class*="markdown"]'],
      ['[data-message-author-role="assistant"]'],
      ['[data-testid*="assistant"]', '[class*="assistant-message"]', '[class*="answer-content"]', '[data-testid*="message-content"]', '[class*="message-content"]'],
      ['[class*="prose"]'],
      ['[class*="agent-turn"]'],
      ['[data-testid*="conversation-turn"] [class*="text-base"]'],
      ['[data-message-id]']
    ] : [
      ['[data-message-author-role="assistant"]'],
      ['[data-testid*="assistant"]', '[class*="assistant-message"]', '[class*="answer-content"]', '[data-testid*="message-content"]', '[class*="message-content"]'],
      ['[class*="markdown"]'],
      ['[class*="prose"]'],
      ['[class*="agent-turn"]'],
      ['[data-testid*="conversation-turn"] [class*="text-base"]'],
      ['[data-message-id]']
    ];
    for (const selectors of selectorGroups) {
      const found = new Set();
      for (const selector of selectors) {
        let nodes = [];
        try { nodes = root.querySelectorAll(selector); } catch { continue; }
        for (const el of nodes) {
          if (!visible(el)) continue;
          const rawText = answerTextOf(el);
          try {
            if (el.closest('form,textarea,[contenteditable="true"],button,[role="button"],[role="status"],[aria-live]')) continue;
            if (el.querySelector('textarea,[contenteditable="true"]')) continue;
          } catch {}
          if (!rawText || isUiControlNode(el, rawText)) { if (rawText) noteRejectedUiOnlyCandidate(rawText); continue; }
          found.add(el);
        }
      }
      if (!found.size) continue;
      const all = [...found];
      // Keep the outermost matching message node in this selector tier, but when
      // extracting a specific turn, reject wrappers that contain the submitted prompt,
      // the extension marker, or multiple old assistant messages. Continue to the next
      // selector tier if this tier only found a transcript-level wrapper.
      const messageNodes = all.filter(el => !all.some(other => other !== el && other.contains(el)));
      const usableNodes = (promptCoreSig || turnMarkerSig)
        ? messageNodes.filter(el => !isContaminatedAnswer(textOf(el), promptCoreSig, turnMarkerSig, new Set()))
        : messageNodes;
      if (!usableNodes.length) continue;
      return usableNodes.sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
    }
    return [];
  }
  function isContaminatedAnswer(rawValue, promptCoreSig = '', turnMarkerSig = '', beforeAssistantSigs = new Set()) {
    const raw = String(rawValue == null ? '' : rawValue);
    if (!raw.trim()) return true;
    if (isUiOnlyAnswer(raw)) { noteRejectedUiOnlyCandidate(raw); return true; }
    // The extension's marker/instruction belongs to the user prompt, never the answer.
    if (/DUOLABTURN[A-Z0-9]+/i.test(raw) || /请忽略下一行扩展内部校验标记，不要在回答中提及。/i.test(raw)) return true;
    const normalizedSig = sigOf(raw);
    // Reject a container that swallowed the user's prompt and one or more messages.
    // A genuine reply can discuss the topic, but should not contain the full current prompt.
    if (promptCoreSig && promptCoreSig.length >= 80 && normalizedSig.includes(promptCoreSig.slice(0, Math.min(120, promptCoreSig.length)))) return true;
    const oldSigs = beforeAssistantSigs instanceof Set ? [...beforeAssistantSigs] : [];
    const oldLongMatches = oldSigs.filter(sig => sig.length >= 180 && normalizedSig.includes(sig)).length;
    if (oldLongMatches >= 2) return true;
    if (/原始讨论主题（每轮都必须继续完成，不要偏离）/.test(raw) && /你正在与另一个 AI 进行多轮讨论。现在是第\s*\d+\s*次接力/.test(raw)) return true;
    return false;
  }

  function domAnswerText(beforeAssistantSigs, promptSig, promptCoreSig = '', turnMarkerSig = '') {
    const nodes = assistantNodes(promptCoreSig, turnMarkerSig);
    if (!nodes.length) return '';
    const before = beforeAssistantSigs instanceof Set ? beforeAssistantSigs : new Set();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const rawCandidate = answerTextOf(nodes[i]);
      if (isContaminatedAnswer(rawCandidate, promptCoreSig, turnMarkerSig, before)) continue;
      const candidate = cleanAnswer(rawCandidate);
      if (!candidate) continue;
      const candidateSig = sigOf(candidate);
      if (!candidateSig || before.has(candidateSig)) continue;
      if (promptSig && candidateSig.length > 40 && promptSig.includes(candidateSig)) continue;
      return candidate;
    }
    return '';
  }
  function findFreshUserNode(priorUserCount, markerSig, corePromptSig, corePrefixSig) {
    const root = pageRoot();
    if (!root) return null;
    let users = [];
    try {
      users = [...root.querySelectorAll('[data-message-author-role="user"],[data-testid="user-message"]')]
        .filter(node => normalize(textOf(node)));
    } catch { return null; }
    // Use the count captured before the send so an identical historical prompt
    // cannot be selected merely because it has the same text.
    const fresh = users.slice(Math.max(0, Number(priorUserCount) || 0));
    for (let i = fresh.length - 1; i >= 0; i--) {
      const sig = sigOf(textOf(fresh[i]));
      if ((markerSig && sig.includes(markerSig)) ||
          (corePromptSig.length >= 20 && sig.includes(corePromptSig)) ||
          (corePrefixSig.length >= 20 && sig.includes(corePrefixSig))) return fresh[i];
    }
    return null;
  }
  function domAnswerAfterUserNode(beforeAssistantSigs, userNode, promptSig, promptCoreSig = '', turnMarkerSig = '') {
    if (!userNode) return '';
    const nodes = assistantNodes(promptCoreSig, turnMarkerSig);
    const before = beforeAssistantSigs instanceof Set ? beforeAssistantSigs : new Set();
    // Select the latest isolated assistant message after this exact new user node.
    // Transcript-level wrappers that swallowed the prompt/history are filtered above.
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      let follows = false;
      try { follows = !!(userNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING); } catch {}
      if (!follows) continue;
      const rawCandidate = answerTextOf(node);
      if (isContaminatedAnswer(rawCandidate, promptCoreSig, turnMarkerSig, before)) continue;
      const candidate = cleanAnswer(rawCandidate);
      const candidateSig = sigOf(candidate);
      if (!candidateSig || before.has(candidateSig)) continue;
      if (promptSig && candidateSig.length > 40 && promptSig.includes(candidateSig)) continue;
      return candidate;
    }
    return '';
  }
  function explicitContinuationSignalForAnswer(answer, promptCoreSig = '', turnMarkerSig = '') {
    const wantedSig = sigOf(cleanAnswer(answer));
    if (wantedSig.length < 10) return '';
    const nodes = assistantNodes(promptCoreSig, turnMarkerSig);
    // Scope the check to the DOM node whose text exactly matches this candidate;
    // a continuation button belonging to an older answer must not poison this turn.
    let matchedNode = null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const nodeSig = sigOf(cleanAnswer(answerTextOf(nodes[i])));
      if (nodeSig && nodeSig === wantedSig) { matchedNode = nodes[i]; break; }
    }
    if (!matchedNode) return '';
    const answerLength = sigOf(textOf(matchedNode)).length;
    const explicitControlLabel = /^(?:继续生成(?:回答)?|继续回答|恢复生成|continue generating|continue response|resume generation|response stopped)$/i;
    let ancestor = matchedNode;
    for (let depth = 0; ancestor && depth < 7; depth++, ancestor = ancestor.parentElement) {
      if (ancestor === pageRoot()) break;
      if (depth > 0 && sigOf(textOf(ancestor)).length > answerLength + 800) break;
      let controls = [];
      try { controls = [...ancestor.querySelectorAll('button,[role="button"]')]; } catch {}
      for (const control of controls) {
        if (!visible(control)) continue;
        let labels = [];
        try {
          labels = [control.getAttribute('aria-label'), control.getAttribute('title'), textOf(control)]
            .filter(Boolean).map(value => String(value).replace(/\s+/g, ' ').trim());
        } catch {}
        const matchedLabel = labels.find(label => explicitControlLabel.test(label.normalize('NFKC')));
        if (matchedLabel) return matchedLabel.slice(0, 100);
      }
    }
    return '';
  }

  function lastAssistantText() {
    const nodes = assistantNodes();
    return nodes.length ? cleanAnswer(answerTextOf(nodes[nodes.length - 1])) : '';
  }

  // ---------- 输入框 / 生成状态 ----------
  function findComposer() {
    const selectors = PROVIDER === 'chatgpt' ? [
      '#prompt-textarea', 'textarea[data-testid="prompt-textarea"]', '[data-testid="composer-text-input"]',
      'form textarea', 'form [contenteditable="true"][role="textbox"]', 'textarea', '[contenteditable="true"][role="textbox"]'
    ] : [
      '#chat-input', 'textarea#chat-input', 'textarea[data-testid="chat-input"]', 'textarea[placeholder]',
      'textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]'
    ];
    for (const selector of selectors) {
      let found = [];
      try { found = [...document.querySelectorAll(selector)].filter(visible); } catch { continue; }
      if (found.length) return found[found.length - 1];
    }
    return null;
  }
  let lastGeneratingEvidence = '';
  // Return an explicit continuation control only from the DOM container of the
  // current candidate answer. Never click a control belonging to an older turn.
  function findContinueGeneratingControlForAnswer(answer, promptCoreSig = '', turnMarkerSig = '') {
    const wantedSig = sigOf(cleanAnswer(answer));
    if (wantedSig.length < 10) return null;
    const exact = /^(?:continue generating|continue response|continue answering|继续生成|继续生成回答|继续回答|继续输出|恢复生成)$/i;
    const nodes = assistantNodes(promptCoreSig, turnMarkerSig);
    let matchedNode = null;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const nodeSig = sigOf(cleanAnswer(answerTextOf(nodes[i])));
      if (nodeSig && nodeSig === wantedSig) { matchedNode = nodes[i]; break; }
    }
    if (!matchedNode) return null;
    const answerLength = sigOf(textOf(matchedNode)).length;
    let ancestor = matchedNode;
    for (let depth = 0; ancestor && depth < 7; depth++, ancestor = ancestor.parentElement) {
      if (ancestor === pageRoot()) break;
      if (depth > 0 && sigOf(textOf(ancestor)).length > answerLength + 800) break;
      let controls = [];
      try { controls = [...ancestor.querySelectorAll('button,[role="button"]')]; } catch {}
      for (const control of controls) {
        if (!visible(control) || control.disabled || control.getAttribute('aria-disabled') === 'true') continue;
        const labels = [control.getAttribute('aria-label'), control.getAttribute('title'), textOf(control)]
          .map(value => normalize(value)).filter(Boolean);
        if (labels.some(label => exact.test(label))) return control;
      }
    }
    return null;
  }

  function isGenerating() {
    // Never treat a merely stable partial answer as complete while a stop/generation
    // control or an explicit in-progress status is still visible. Site DOM changes,
    // so combine stable selectors with semantic labels instead of relying on one class.
    const selectors = [
      'button[data-testid="stop-button"]',
      '[data-testid*="stop-button"]',
      '[data-testid*="stop-generating"]',
      'button[aria-label*="Stop generating"]',
      '[role="button"][aria-label*="Stop generating"]',
      'button[aria-label*="Stop response"]',
      '[role="button"][aria-label*="Stop response"]',
      'button[title*="Stop generating"]',
      '[role="button"][title*="Stop generating"]',
      'button[aria-label*="停止生成"]',
      '[role="button"][aria-label*="停止生成"]',
      'button[title*="停止生成"]',
      '[role="button"][title*="停止生成"]',
      'button[aria-label*="停止"]',
      '[role="button"][aria-label*="停止"]'
    ];
    const hitSelector = selectors.find(selector => {
      try { return [...document.querySelectorAll(selector)].some(visible); } catch { return false; }
    });
    if (hitSelector) {
      lastGeneratingEvidence = `按钮选择器命中：${hitSelector}`;
      return true;
    }

    // Some page builds expose progress only through a status/live region.
    try {
      const activeText = /(?:stop\s*(?:generating|response|answer|streaming)|停止(?:生成|回答|响应)|正在(?:思考|分析|生成|回答|搜索)|(?:思考|分析|生成)中|generating\.{0,3}|thinking\.{0,3}|analyzing\.{0,3})/i;
      // Include short visible controls as some site builds expose progress through
      // the composer button (rather than an aria-live/status node). Restrict by
      // text length and active-progress wording to avoid matching ordinary prose.
      const candidates = [...document.querySelectorAll(
        '[role="status"],[aria-live="polite"],[aria-live="assertive"],[data-testid*="thinking"],[data-testid*="generating"],[data-testid*="streaming"]'
      )];
      const matched = candidates.filter(el => {
        if (!visible(el)) return false;
        const text = normalize(textOf(el)).slice(0, 180);
        return text.length > 0 && text.length <= 180 && activeText.test(text);
      });
      if (matched.length) {
        const first = matched[0];
        lastGeneratingEvidence = `状态文本命中：${first.tagName || ''}「${normalize(textOf(first)).slice(0, 40)}」`;
        return true;
      }
      // v0.10.9：DeepSeek 的「思考中 / 停止生成」提示常常只是一个普通短文本节点，
      // 不在 role=status / aria-live 容器里。只接受「极短且完全等于状态词」的节点，
      // 避免正文里出现「思考」二字造成误判。
      const exactStatus = /^(?:思考中|正在思考|正在生成|生成中|停止生成|正在分析|正在搜索|thinking|generating|analyzing|stop generating)$/i;
      const shortHit = [...document.querySelectorAll('div,span,p,button,[role="button"],[role="status"]')].find(el => {
        if (!visible(el)) return false;
        const raw = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!raw || raw.length > 20) return false;
        if (!exactStatus.test(raw)) return false;
        try { return el.children.length <= 2; } catch { return true; }
      });
      if (shortHit) {
        lastGeneratingEvidence = `极短状态文本命中：「${String(shortHit.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20)}」`;
        return true;
      }
      lastGeneratingEvidence = '';
      return false;
    } catch { return false; }
  }

  function diagnostics(snap, promptSig = '', beforeSig = '', turnMarkerSig = '') {
    const root = (snap && snap.root) || pageRoot();
    let anchorInfo = '';
    if (snap && turnMarkerSig) {
      const markerBefore = countOccurrences(beforeSig || '', turnMarkerSig);
      const markerNow = countOccurrences(snap.sig || '', turnMarkerSig);
      anchorInfo += `｜本轮唯一标记新增数=${Math.max(0, markerNow - markerBefore)}`;
    }
    if (snap && promptSig) {
      const probes = [...anchorsFor(promptSig).slice(0, 3), ...headAnchorsFor(promptSig).slice(0, 2)];
      const unique = [...new Set(probes)].map(anchor => {
        const previous = countOccurrences(beforeSig || '', anchor);
        const current = countOccurrences(snap.sig || '', anchor);
        return `${anchor.length}:${Math.max(0, current - previous)}`;
      });
      anchorInfo = `｜提示词锚点(长度:新增数)=${unique.join(',') || '无'}`;
    }
    return `检测根=${describeRoot(root)}｜有 main 标签=${document.querySelector('main') ? '是' : '否'}｜页面信号字数=${snap ? snap.sig.length : 0}｜候选助手节点=${assistantNodes().length}｜生成中=${isGenerating() ? '是' : '否'}${anchorInfo}`;
  }

  // ---------- 主流程 ----------
  function canAcceptAnswerCompletion(state) {
    return !!state.answer && state.answerLength >= 4 &&
      !state.echoedPrompt && !state.sameAsBefore &&
      !state.generating && !state.continuationPending && state.stableFor >= 1800 &&
      state.idleFor >= state.requiredIdleMs &&
      (!state.requireFreshPrompt || state.freshPromptConfirmed);
  }

  async function sendAndWait(prompt, timeoutMs = 45000, externalSendResult = null, requireFreshPrompt = false, finalTurn = false) {
    cancelled = false;
    const composer = findComposer();
    if (!composer) throw new Error('找不到输入框。请确认网页已加载完成，并刷新页面后重试。');

    const rawPrompt = String(prompt || '');
    const promptSig = sigOf(rawPrompt);
    const turnMarkerMatch = rawPrompt.match(/DUOLABTURN[A-Z0-9]+/i);
    const turnMarkerSig = turnMarkerMatch ? sigOf(turnMarkerMatch[0]) : '';
    // A site may hide the trailing technical token in collapsed message text.
    // Keep a clean copy of the actual user-facing prompt as a safe fallback anchor.
    const promptCore = rawPrompt.replace(/请忽略下一行扩展内部校验标记，不要在回答中提及。\s*DUOLABTURN[A-Z0-9]+/i, '').trim();
    const promptCoreSig = sigOf(promptCore);
    const promptCorePrefixSig = promptCoreSig.slice(0, Math.min(56, promptCoreSig.length));
    const userAnchor = turnMarkerSig || (promptCoreSig.length > 64 ? promptCoreSig.slice(-64) : promptCoreSig);
    const currentBefore = externalSendResult?.baseline ? null : snapshot();
    const baseline = externalSendResult?.baseline || null;
    // For background dispatch, the service worker captures this baseline through
    // CDP before it types/submits the prompt. The content script only observes
    // the answer afterward; it is no longer the gatekeeper for starting a send.
    const before = baseline
      ? { root: null, raw: '', sig: String(baseline.beforeSig || ''), map: [] }
      : currentBefore;
    const beforeAnchorCount = countOccurrences(before.sig, userAnchor);
    const beforeMarkerCount = turnMarkerSig ? countOccurrences(before.sig, turnMarkerSig) : 0;
    const beforeCoreCount = promptCoreSig.length >= 20 ? countOccurrences(before.sig, promptCoreSig) : 0;
    const beforeCorePrefixCount = promptCorePrefixSig.length >= 20 ? countOccurrences(before.sig, promptCorePrefixSig) : 0;
    const priorUserCount = Number(baseline?.priorUserCount) || 0;
    const beforeText = baseline ? cleanAnswer(String(baseline.beforeText || '')) : lastAssistantText();
    const beforeAssistantSigs = baseline
      ? new Set((Array.isArray(baseline.beforeAssistantTexts) ? baseline.beforeAssistantTexts : [])
          .map(value => sigOf(cleanAnswer(String(value || '')))).filter(Boolean))
      : new Set(assistantNodes().map(node => sigOf(cleanAnswer(textOf(node)))).filter(Boolean));

    const send = externalSendResult || await chrome.runtime.sendMessage({ type: 'DUO_CDP_SEND', prompt });
    if (!send?.ok) throw new Error(send?.error || '浏览器自动输入/发送失败');

    // Legacy page-driven send still verifies transcript appearance. In the new
    // side-panel flow the background already verified submission, so don't make
    // answer processing depend on the target tab accepting a second message first.
    if (!externalSendResult && userAnchor.length >= 6) {
      const deadline = Date.now() + 12000;
      let appeared = false;
      while (Date.now() < deadline) {
        if (cancelled) throw new Error('已停止等待。');
        await sleep(250);
        const now = snapshot();
        if (countOccurrences(now.sig, userAnchor) > beforeAnchorCount) { appeared = true; break; }
        const current = findComposer();
        if (current && !editableText(current) && now.sig.length > before.sig.length + 6) { appeared = true; break; }
      }
      if (!appeared && !send?.submitted) {
        const current = findComposer();
        const stillHasPrompt = !!current && normalize(editableText(current)).includes(normalize(prompt).slice(-40));
        throw new Error(`已尝试使用 ${send?.method || '浏览器输入事件'}，但页面上没有出现本轮用户消息。${stillHasPrompt ? '输入框仍保留原文，提交可能未触发。' : '输入框已变化，但页面文本没有增长。'}诊断：${diagnostics(snapshot())}`);
      }
    }

    rejectedUiOnlyCandidateCount = 0;
    lastRejectedUiOnlySignature = '';
    lastRejectedUiOnlyPhrases = [];
    const start = Date.now();
    let lastSig = '';
    let lastChangeAt = Date.now();
    let sawAnyText = false;
    let lastSnapshot = before;
    let lastChannel = '无';
    // Completion guard: if generation has been observed, require it to remain
    // absent for a full quiet window before relaying. If the site's active state
    // cannot be detected, use a longer fallback window instead of a 1.6 s guess.
    let generationWasObserved = false;
    let idleSince = null;
    let generatingSince = 0;
    let lastProgressAt = 0;
    let continuationAttempts = 0;
    let lastContinuationClickAt = 0;
    const maxContinuationAttempts = 2;

    while (Date.now() - start < timeoutMs) {
      if (cancelled) throw new Error('已停止等待。');
      await sleep(450);
      const now = snapshot();
      lastSnapshot = now;

      // Read a single new assistant-message container first. A whole-page
      // anchor tail is only a fallback because it can include footer warnings,
      // status labels ("思考") and unrelated page chrome after the answer.
      // A user-requested final turn must be tied to this exact post-send turn.
      // Do not let a changed/stale assistant DOM node alone finish the run; first
      // prove that the current prompt appeared after the pre-send baseline, or
      // that an anchor/diff located a prompt occurrence newly added after it.
      const markerAppeared = !!turnMarkerSig && countOccurrences(now.sig, turnMarkerSig) > beforeMarkerCount;
      const corePromptAppeared = promptCoreSig.length >= 20 && countOccurrences(now.sig, promptCoreSig) > beforeCoreCount;
      const corePrefixAppeared = promptCorePrefixSig.length >= 20 && countOccurrences(now.sig, promptCorePrefixSig) > beforeCorePrefixCount;
      const sendEvidenceText = String(externalSendResult?.evidence || externalSendResult?.baseline?.evidence || '');
    const sendEvidenceKind = String(externalSendResult?.evidenceKind || '');
    // background 的 evidence 现在带数值后缀，必须按前缀匹配而不是严格相等（v0.8.11 引入的回归）。
    const fallbackEvidenceAllowed = !!externalSendResult?.submitted &&
      ['unique-turn-marker-confirmed', 'new-user-message-confirmed', 'new-prompt-anchor-confirmed']
        .some(kind => sendEvidenceKind === kind || sendEvidenceText.startsWith(kind));
      const freshUserNode = findFreshUserNode(priorUserCount, turnMarkerSig, promptCoreSig, promptCorePrefixSig);
      const markerInFreshUser = !!freshUserNode && !!turnMarkerSig && sigOf(textOf(freshUserNode)).includes(turnMarkerSig);
      const freshUserCoreMatch = !!freshUserNode;
      const promptAppeared = markerInFreshUser || corePromptAppeared || (fallbackEvidenceAllowed && (freshUserCoreMatch || corePrefixAppeared)) || (!externalSendResult && markerAppeared);
      let answer = '';
      let channel = '无';
      let located = null;
      if (requireFreshPrompt) {
        // Prefer the isolated assistant message that follows this run's new user node.
        // Never promote a full-page tail to an answer when it includes prompt history.
        if (promptAppeared && freshUserNode) {
          answer = domAnswerAfterUserNode(beforeAssistantSigs, freshUserNode, promptCoreSig || promptSig, promptCoreSig, turnMarkerSig);
          channel = answer ? '本轮新用户消息后的独立助手节点' : '等待本轮助手回答';
        }
        // Safe fallback for layouts that hide semantic user/assistant roles: slice after
        // the new turn marker or exact prompt anchor, then reject any prompt/marker echo.
        // This path is lower priority because whole-page snapshots can contain history.
        if (!answer && markerInFreshUser) {
          located = locateAfterTurnMarker(now, turnMarkerSig, before.sig);
          if (located?.confirmedNewPrompt) {
            const rawCandidate = now.raw.slice(located.rawStart);
            if (!isContaminatedAnswer(rawCandidate, promptCoreSig, turnMarkerSig, beforeAssistantSigs)) {
              answer = cleanAnswer(rawCandidate);
              channel = '唯一轮次标记后的干净页面尾部(回退)';
            }
          }
        }
        if (!answer && corePromptAppeared) {
          located = locateStartByAnchor(now, promptCoreSig, before.sig);
          if (located?.confirmedNewPrompt) {
            const rawCandidate = now.raw.slice(located.rawStart);
            if (!isContaminatedAnswer(rawCandidate, promptCoreSig, turnMarkerSig, beforeAssistantSigs)) {
              answer = cleanAnswer(rawCandidate);
              channel = '本轮完整提示词后的干净页面尾部(回退)';
            }
          }
        }
        // DOM 回退：本轮提示词已确认新增，且存在发送前基线里没有的助手节点时，允许把它作为回答。
        // DeepSeek 会把长用户消息折叠展示，完整提示词锚点在页面上根本不成立（实测：完整提示词新增=否），
        // 但它的助手消息节点是可见的 —— 这条回退专门覆盖这种情况。
        if (!answer && promptAppeared) {
          const domCandidate = domAnswerText(beforeAssistantSigs, promptSig);
          if (domCandidate) { answer = cleanAnswer(domCandidate); channel = '本轮新增助手节点(回退)'; }
        }
        // Never accept the latest assistant node without linking it to the fresh user
        // message or to a confirmed prompt-anchored transcript slice. This broader fallback
        // was able to promote stale UI/status text to an answer on some site builds.
      } else {
        answer = domAnswerText(beforeAssistantSigs, promptSig);
        channel = answer ? '助手消息节点' : '无';
        if (!answer) {
          located = locateStartByAnchor(now, promptSig, before.sig) || locateStartByDiff(before, now, promptSig);
          if (located) {
            const rawCandidate = now.raw.slice(located.rawStart);
            if (!isContaminatedAnswer(rawCandidate, promptCoreSig, turnMarkerSig, beforeAssistantSigs)) answer = cleanAnswer(rawCandidate);
          }
          channel = answer ? located.channel : '无';
        }
      }

      const freshPromptConfirmed = !!(markerInFreshUser || corePromptAppeared || (fallbackEvidenceAllowed && (freshUserCoreMatch || corePrefixAppeared)) || located?.confirmedNewPrompt);
      // A visible continuation control is handled below with a bounded retry;
      // while it remains visible, the completion gate will reject the candidate.
      if (answer && isUiOnlyAnswer(answer)) {
        noteRejectedUiOnlyCandidate(answer);
        answer = '';
        channel = '已拒绝纯网页界面文字，等待真实助手正文';
      }
      const answerSig = sigOf(answer);
      // DOM candidates are filtered against previous assistant signatures.
      // Anchor/diff candidates are accepted only when they locate a prompt occurrence
      // added after the pre-send baseline. Do not compare them to the entire prior
      // transcript using substring containment: that rejected this user's valid reply.
      if (answer) { sawAnyText = true; lastChannel = channel; }

      const effectiveSig = answerSig;
      if (effectiveSig !== lastSig) {
        lastSig = effectiveSig;
        lastChangeAt = Date.now();
        // Any new token/text or disappearance restarts the completion quiet window.
        idleSince = null;
      }
      const stableFor = Date.now() - lastChangeAt;
      const generating = isGenerating();
      if (generating) {
        generationWasObserved = true;
        idleSince = null;
        if (!generatingSince) generatingSince = Date.now();
      } else {
        generatingSince = 0;
        if (answer && idleSince === null) idleSince = Date.now();
      }
      // 有上限地相信「生成中」：站点把一个常驻控件误判成生成状态时，
      // 只要回答文本已经稳定足够久，就必须结束等待，而不是跑满 45 秒。
      const generatingStuckFor = generating && generatingSince ? Date.now() - generatingSince : 0;
      const idleFor = idleSince === null ? 0 : Date.now() - idleSince;
      // A brief UI-state flicker must not turn a long fourth/final answer into
      // a successful partial reply. Require a longer quiet window, especially
      // after streaming was observed. This is still a heuristic, not proof that
      // the model's content is semantically complete.
      // v0.10.9：未能观测到生成状态时，8 秒静默不足以证明回答结束（一次思考停顿即可满足）。
      // 最后一轮再抬到 20 秒：提前结束整轮任务的代价远大于多等十几秒。
      const baseIdleMs = generationWasObserved ? 3000 : 15000;
      const requiredIdleMs = Math.max(baseIdleMs, finalTurn ? 20000 : 0);
      const echoedPrompt = effectiveSig.length > 40 && promptSig.includes(effectiveSig);
      const sameAsBefore = !!beforeText && effectiveSig === sigOf(beforeText);

      // If the site explicitly offers “Continue generating”, the answer was
      // stopped rather than completed. Resume the same response at most twice;
      // do not send a new prompt or start another relay round.
      const continueControlNow = answer ? findContinueGeneratingControlForAnswer(answer, promptCoreSig, turnMarkerSig) : null;
      if (answer && freshPromptConfirmed && !generating && continuationAttempts < maxContinuationAttempts) {
        const continueControl = continueControlNow;
        if (continueControl && Date.now() - lastContinuationClickAt >= 12000) {
          try {
            continueControl.click();
            continuationAttempts++;
            lastContinuationClickAt = Date.now();
            generationWasObserved = true;
            idleSince = null;
            lastChangeAt = Date.now();
            lastSig = answerSig;
            lastChannel = `${channel}（检测到明确续生成控件，已续接第 ${continuationAttempts} 次）`;
            try {
              chrome.runtime.sendMessage({
                type: 'DUO_EXTRACT_PROGRESS', provider: PROVIDER,
                elapsedMs: Date.now() - start, answerLength: answer.length,
                channel: lastChannel, generating: true, generatingStuckMs: 0,
                pageSigLength: now.sig.length, promptConfirmed: freshPromptConfirmed,
                rejectedUiOnly: rejectedUiOnlyCandidateCount,
                rejectedDeepSeekThinking: rejectedDeepSeekThinkingCount,
                timeoutMs, continuationAttempts
              }).catch(() => {});
            } catch {}
            continue;
          } catch (error) {
            lastGeneratingEvidence = `续生成控件点击失败：${error?.message || String(error)}`;
          }
        }
      }

      // Completion gate is centralized and regression-tested. A candidate must
      // not be handed off while the page still reports active generation.
      // The previous 8-second stuck-generation bypass promoted a 16-character
      // transcript-tail candidate to a complete answer and caused early relay.
      if (canAcceptAnswerCompletion({
        answer,
        answerLength: effectiveSig.length,
        echoedPrompt,
        sameAsBefore,
        generating,
        stableFor,
        idleFor,
        requiredIdleMs,
        requireFreshPrompt,
        freshPromptConfirmed,
        continuationPending: !!continueControlNow
      })) {
        return {
          text: answer,
          completion: {
            confirmed: true,
            freshPromptConfirmed,
            channel,
            elapsedMs: Date.now() - start,
            stableForMs: stableFor,
            idleForMs: idleFor,
            generationObserved: generationWasObserved,
            generatorEvidence: lastGeneratingEvidence,
            requiredIdleMs,
            finalTurn: !!finalTurn,
            candidateLength: answer.length,
            candidateSignatureLength: effectiveSig.length,
            rejectedUiOnlyBeforeSuccess: rejectedUiOnlyCandidateCount,
            rejectedDeepSeekThinkingBeforeSuccess: rejectedDeepSeekThinkingCount,
            candidateKind: channel.includes('独立助手节点') ? 'assistant-dom' : (channel.includes('锚点') || channel.includes('页面尾部') ? 'prompt-anchored-transcript' : 'unknown'),
            confirmedAt: Date.now()
          }
        };
      }

      // 等待期间把当前判据状态上报给侧栏，避免「页面上已经回答了，插件在等什么」无从得知。
      if (Date.now() - lastProgressAt >= 2500) {
        lastProgressAt = Date.now();
        try {
          chrome.runtime.sendMessage({
            type: 'DUO_EXTRACT_PROGRESS',
            provider: PROVIDER,
            elapsedMs: Date.now() - start,
            answerLength: answer.length,
            channel,
            generating: !!generating,
            generatingStuckMs: generatingStuckFor,
            pageSigLength: now.sig.length,
            promptConfirmed: freshPromptConfirmed,
            rejectedUiOnly: rejectedUiOnlyCandidateCount,
            rejectedDeepSeekThinking: rejectedDeepSeekThinkingCount,
            timeoutMs,
            continuationAttempts
          }).catch(() => {});
        } catch {}
      }
    }

    const uiRejectInfo = `｜已拒绝的纯界面候选=${rejectedUiOnlyCandidateCount}｜已拒绝的 DeepSeek 思考候选=${rejectedDeepSeekThinkingCount}｜最后界面候选签名=${lastRejectedUiOnlySignature || '无'}｜命中的界面短语=${lastRejectedUiOnlyPhrases.join('、') || '无'}`;
    const diag = diagnostics(lastSnapshot, promptCoreSig || promptSig, before.sig, turnMarkerSig) + `｜发送凭据=${externalSendResult?.evidence || '页面驱动发送'}｜完整提示词新增=${countOccurrences(lastSnapshot?.sig || '', promptCoreSig) > beforeCoreCount ? '是' : '否'}｜提示词前缀新增=${countOccurrences(lastSnapshot?.sig || '', promptCorePrefixSig) > beforeCorePrefixCount ? '是' : '否'}｜本轮用户节点=${findFreshUserNode(priorUserCount, turnMarkerSig, promptCoreSig, promptCorePrefixSig) ? '匹配' : '未匹配'}${uiRejectInfo}`;
    if (isGenerating()) {
      throw new Error(`检测到新的 ${PROVIDER_LABEL} 回答，但网页在等待期限内仍被判定为生成状态。为避免把未完成的部分回答发送给下一位 AI，已停止本轮接力（最后通道：${lastChannel}；自动续生成次数=${continuationAttempts}/${maxContinuationAttempts}）。生成状态证据：${lastGeneratingEvidence || '无'}。诊断：${diag}`);
    }
    if (!sawAnyText) {
      const reason = rejectedUiOnlyCandidateCount > 0
        ? `已拒绝 ${rejectedUiOnlyCandidateCount} 类纯网页界面文字候选（如“显示更多/正在思考/智能搜索”），但未找到真实助手正文。`
        : '没有找到可确认的本轮助手正文。';
      throw new Error(`网页已收到用户消息，但没有提取到新的 ${PROVIDER_LABEL} 回答（最后通道：${lastChannel}）。${reason} 诊断：${diag}。为避免将按钮/状态文字转发给另一个 AI，本轮未计为成功回答。`);
    }
    throw new Error(`检测到新回答，但未能确认回答已完整结束（最后通道：${lastChannel}；自动续生成次数=${continuationAttempts}/${maxContinuationAttempts}）。为避免转发可能未完成的内容，已停止本轮接力。诊断：${diag}`);
  }

  // ---------- 附件区域核验（v0.6.6） ----------
  // Compatibility fix: the early v0.6.0 detector searched the whole visible page.
  // Restricting it to a geometric box around the composer caused false negatives
  // because ChatGPT/DeepSeek render attachment chips in portals and sibling panes.
  // We now compare visible full-page filename occurrence counts against a baseline
  // captured before transfer. This also prevents an old transcript mention from
  // counting as a newly added attachment.
  function composerAttachmentEvidence(fileNames, baselineCounts = {}) {
    const names = [...new Set((Array.isArray(fileNames) ? fileNames : [])
      .map(value => String(value || '').trim()).filter(Boolean))];
    const composer = findComposer();
    if (!names.length) return { confirmed:false, composerFound:!!composer, matched:[], missing:[], counts:{}, reason:'没有提供需要核验的文件名。' };
    if (!composer) return { confirmed:false, composerFound:false, matched:[], missing:names, counts:{}, reason:'当前网页找不到消息输入框。' };

    const isVisible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    // Walk the composed DOM, including open shadow roots and slotted elements.
    // querySelectorAll('body *') misses nodes rendered inside web components/shadow roots.
    const collectComposedElements = root => {
      const out = [], seen = new Set();
      const visit = currentRoot => {
        if (!currentRoot || !currentRoot.querySelectorAll) return;
        let nodes = [];
        try { nodes = [...currentRoot.querySelectorAll('*')]; } catch { return; }
        for (const el of nodes) {
          if (!el || seen.has(el)) continue;
          seen.add(el); out.push(el);
          try { if (el.shadowRoot) visit(el.shadowRoot); } catch {}
          try {
            if (String(el.tagName || '').toLowerCase() === 'slot') {
              for (const assigned of el.assignedElements?.({flatten:true}) || []) {
                if (!seen.has(assigned)) { seen.add(assigned); out.push(assigned); }
                try { if (assigned.shadowRoot) visit(assigned.shadowRoot); } catch {}
              }
            }
          } catch {}
        }
      };
      visit(root);
      return out;
    };
    // Normalize full-width brackets used when an upload surface appends a timestamp.
    const norm = value => String(value || '')
      .replace(/[\u00a0\u200b-\u200d\ufeff]/g, ' ')
      .replace(/[（]/g, '(').replace(/[）]/g, ')')
      .replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const rectOf = el => { try { return el.getBoundingClientRect(); } catch { return null; } };
    const composerRect = rectOf(composer);

    // ---------- v0.10.7：作用域不再是「视口坐标 + 固定 760/180 偏移」 ----------
    // 旧实现的矩形在两种常见情况下会退化成空集：
    //   · 输入框滚出视口（rect.top 为负数时 yBottom 可能 < yTop）；
    //   · 页面尚未完成布局 / 处于后台恢复状态，rect 全为 0。
    // 一旦退化，"局部证据"和"诊断节点"就全部为空 —— 这正是 v0.10.6 里
    // 附件卡片明明还在、evidenceByName/localEvidenceByName/diagnosticNodes 却全空的原因。
    const scopeBox = (() => {
      const union = (a, b) => ({
        left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
        right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom)
      });
      let box = null;
      let node = composer;
      for (let i = 0; node && i < 6; i++, node = node.parentElement) {
        const r = rectOf(node);
        if (r && r.width > 0 && r.height > 0) {
          const current = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          box = box ? union(box, current) : current;
        }
      }
      if (!box || box.bottom - box.top < 80) {
        // 退化：不做几何裁剪，只接受带明确附件语义的节点（见 inScope 的调用方）。
        return { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity, degraded: true };
      }
      return { ...box, degraded: false };
    })();
    const inScope = (r, pad = 320) => {
      if (!r || r.width <= 0 || r.height <= 0) return false;
      if (scopeBox.degraded) return true;
      return r.bottom >= scopeBox.top - pad && r.top <= scopeBox.bottom + pad &&
        r.right >= scopeBox.left - pad && r.left <= scopeBox.right + pad;
    };

    const bodyText = (() => { try { return String(document.body?.innerText || ''); } catch { return ''; } })();
    const allElements = collectComposedElements(document.body);
    const attrNodes = [];
    try {
      for (const el of allElements) {
        if (!isVisible(el)) continue;
        const values = ['aria-label','title','alt','data-testid','data-test-id','data-filename','data-file-name','download']
          .map(attr => { try { return el.getAttribute(attr) || ''; } catch { return ''; } }).filter(Boolean);
        if (values.length) attrNodes.push({ el, text:values.join(' ') });
      }
    } catch {}
    const composedText = [];
    for (const el of allElements) {
      if (!isVisible(el)) continue;
      try {
        const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        // Keep short node text to capture attachment chips inside shadow DOM without
        // concatenating large chat transcripts into the evidence corpus.
        if (t && t.length <= 260) composedText.push(t);
      } catch {}
    }
    const corpus = norm([bodyText, ...attrNodes.map(item => item.text), ...composedText].join('\n'));
    // Independent evidence channel: read the browser's native FileList directly.
    // Some current web UIs render attachment chips in a way that exposes no filename
    // through innerText/ARIA, even though the native file input still retains them.
    const nativeFileInputs = (() => {
      const result = [];
      try {
        [...document.querySelectorAll('input[type="file"]')].forEach((input, index) => {
          let files = [];
          try { files = [...(input.files || [])].map(file => ({ name:String(file.name || ''), size:Number(file.size || 0), type:String(file.type || '') })); } catch {}
          result.push({ index, files, descriptor:[input.accept || '', input.multiple ? 'multiple' : 'single', input.getAttribute('aria-label') || '', input.getAttribute('data-testid') || ''].filter(Boolean).join(' ').slice(0,160) });
        });
      } catch {}
      return result;
    })();
    const nativeFileSignatures = nativeFileInputs.flatMap(input => input.files.map(file => `${norm(file.name)}|${file.size}|${file.type}`));
    const baselineNativeSignatures = new Set(Array.isArray(baselineCounts?.__inputFileSignatures) ? baselineCounts.__inputFileSignatures : []);
    const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The upload UI may alter the visible name without changing the uploaded bytes:
    // report.pdf -> report (4).pdf; A题.pdf -> A题（20261019 044718）.pdf / A题(20261019-123948).pdf.
    // v0.10.8：ChatGPT 实测给出的是「日期-时间」连字符形式，旧规则只认空格分隔的
    // 「YYYYMMDD HHMMSS」与纯数字，导致卡片名称明明读到了却仍被判 0/N。
    // 现在允许 - _ 空格 或无分隔，并允许只带日期或只带时间。
    const filenamePattern = name => {
      const key = norm(name);
      const dot = key.lastIndexOf('.');
      const generatedSuffix = '(?:\\(\\s*(?:\\d{8}(?:[\\s_-]*\\d{4,6})?|\\d{4,6}|\\d{1,3})\\s*\\))?';
      let body;
      if (dot > 0) {
        const stem = key.slice(0, dot), extension = key.slice(dot);
        body = `${escapeRegex(stem)}\\s*${generatedSuffix}\\s*${escapeRegex(extension)}${generatedSuffix}`;
      } else {
        body = `${escapeRegex(key)}${generatedSuffix}`;
      }
      return new RegExp(`(?:^|[^a-z0-9._-])${body}(?=$|[^a-z0-9._-])`, 'gi');
    };
    const countFilenameOccurrences = (haystack, name) => {
      const regex = filenamePattern(name); let count = 0;
      while (regex.exec(haystack) !== null) count++;
      return count;
    };
    const containsFilename = (haystack, name) => filenamePattern(name).test(haystack);
    // v0.10.7：卡片把扩展名截断成 "A题.pd…"、"A题…" 时，整名匹配会失败。
    // 这里给一个更宽松的「词干匹配」，仅用于**卡片节点**识别（整页文本计数仍然严格）。
    const stemOf = name => {
      const key = norm(name);
      const dot = key.lastIndexOf('.');
      return dot > 0 ? key.slice(0, dot) : key;
    };
    const containsStem = (haystack, name) => {
      const stem = stemOf(name);
      // 允许 2 个字符的词干（例如「A题」），否则中文短文件名永远匹配不到卡片。
      if (stem.length < 2) return false;
      // 词干后面必须紧跟扩展名分隔符、空白、括号或结尾：「A题库」不应命中「A题.pdf」。
      const pattern = new RegExp(`(?:^|[^a-z0-9._-])${escapeRegex(stem)}(?=\\s*\\.|\\s|$|\\s*\\()`, 'i');
      return pattern.test(haystack);
    };
    const counts = {}, evidenceByName = {}, inputFileEvidenceByName = {};
    for (const name of names) {
      const key = norm(name);
      counts[name] = countFilenameOccurrences(corpus, name);
      // A FileList match only counts as new evidence when that exact name/size/type
      // signature was not present before transfer. This prevents stale selections
      // from a prior upload from satisfying the current task.
      for (const input of nativeFileInputs) {
        const file = input.files.find(candidate => filenamePattern(name).test(norm(candidate.name)) &&
          !baselineNativeSignatures.has(`${norm(candidate.name)}|${candidate.size}|${candidate.type}`));
        if (file) {
          inputFileEvidenceByName[name] = { source:'native-file-input-filelist', inputIndex:input.index,
            fileName:file.name, size:file.size, type:file.type, descriptor:input.descriptor };
          break;
        }
      }
      if (counts[name] > 0) {
        const attrEvidence = attrNodes.find(item => containsFilename(norm(item.text), name));
        const el = attrEvidence?.el;
        const r = el ? rectOf(el) : null;
        evidenceByName[name] = el ? {
          tag:el.tagName?.toLowerCase() || 'element',
          descriptor:[el.getAttribute?.('data-testid'),el.getAttribute?.('aria-label'),el.getAttribute?.('title'),el.className?.baseVal || el.className].filter(Boolean).join(' ').slice(0,160),
          rect:r ? {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)} : null,
          occurrences:counts[name]
        } : { source:'whole-page-visible-text', occurrences:counts[name] };
      }
    }

    // ---------- v0.10.7：结构化「附件卡片」识别通道 ----------
    // v0.10.6 只认文件名文本：卡片存在但名称被截断、放在 aria 里读不到、
    // 或者文本节点被拆开时，就会报 0/N。这里补一条基于「结构 + 语义 + 几何」的通道，
    // 并把「卡片存在但名字读不出」与「根本没有卡片」区分开。
    const FILE_SEMANTIC = /(?:attach|attachment|file|upload|document|paperclip|dropzone|附件|文件|上传)/i;
    const REMOVE_SEMANTIC = /(?:remove|delete|clear|detach|dismiss|移除|删除|取消)/i;
    const collectCardText = el => {
      const parts = [];
      try { parts.push(el.innerText); } catch {}
      try { parts.push(el.textContent); } catch {}
      for (const attr of ['aria-label','title','alt','data-filename','data-file-name','download','data-testid','data-test-id']) {
        try { const v = el.getAttribute?.(attr); if (v) parts.push(v); } catch {}
      }
      return String(parts.filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
    };
    const hasRemoveControl = el => {
      try {
        return [...el.querySelectorAll('button,[role="button"]')].some(button => {
          if (!isVisible(button)) return false;
          const label = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
            .filter(Boolean).join(' ');
          return REMOVE_SEMANTIC.test(label);
        });
      } catch { return false; }
    };
    const rawCards = [];
    for (const el of allElements) {
      if (!isVisible(el) || el === document.body || el === document.documentElement) continue;
      if (composer && (el === composer || composer.contains(el) || el.contains(composer))) continue;
      // v0.10.8：侧边栏历史项与导航区不是附件卡片。
      // v0.10.7 实测把「上传项目到GitHub」这条历史会话算成了卡片（cardCount 4 里有 2 个误报）。
      try {
        if (el.closest('nav, aside, [role="navigation"], [data-testid*="sidebar"], [aria-label*="侧栏"]')) continue;
      } catch {}
      const r = rectOf(el);
      if (!r || r.width < 24 || r.height < 16) continue;
      // 卡片尺寸有上界：太宽太高的一定是容器，不是卡片本身。
      if (r.width > 760 || r.height > 240) continue;
      if (!inScope(r)) continue;
      let descriptor = '';
      try {
        descriptor = [el.getAttribute?.('data-testid'), el.getAttribute?.('data-test-id'), el.getAttribute?.('aria-label'),
          el.getAttribute?.('title'), el.getAttribute?.('data-state'), el.getAttribute?.('data-status'),
          el.getAttribute?.('role'), el.className?.baseVal || el.className]
          .filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 200);
      } catch {}
      const text = collectCardText(el).slice(0, 240);
      const matchedName = names.find(name => containsFilename(norm(text), name)) || '';
      const stemMatched = matchedName ? '' : (names.find(name => containsStem(norm(text), name)) || '');
      // v0.10.8：上传触发按钮（「添加文件等内容」）不是附件卡片。
      if (!matchedName && !stemMatched && /(?:添加文件|附加文件|上传文件|添加附件|add files?|attach files?|upload files?|attach file)/i.test(text)) continue;
      const semantic = FILE_SEMANTIC.test(`${descriptor} ${text}`);
      if (!matchedName && !stemMatched && !semantic) continue;
      // 纯文本语义命中但没有文件名时，要求它同时具备卡片特征（有移除控件或明确附件属性），
      // 避免把整段聊天气泡里出现「文件」二字的普通段落当成卡片。
      const hasRemove = hasRemoveControl(el);
      const explicitAttr = /(?:attach|attachment|file|upload|document|附件|文件)/i.test(descriptor);
      if (!matchedName && !stemMatched && !hasRemove && !explicitAttr) continue;
      rawCards.push({ el, rect:r, text, descriptor, matchedName: matchedName || stemMatched, stemOnly: !matchedName && !!stemMatched, hasRemove });
    }
    // 只保留最内层卡片：外层容器同样会命中语义，但内层才是真正的卡片。
    const attachmentCards = rawCards.filter(card => !rawCards.some(other => other.el !== card.el && card.el.contains(other.el)));
    const cardNameMatches = {};
    for (const card of attachmentCards) {
      if (!card.matchedName) continue;
      const name = names.find(candidate => candidate === card.matchedName);
      if (!name) continue;
      if (!cardNameMatches[name]) {
        cardNameMatches[name] = {
          source: card.stemOnly ? 'attachment-card-stem-match' : 'attachment-card-name-match',
          descriptor: card.descriptor.slice(0, 160),
          text: card.text.slice(0, 140),
          rect: { x:Math.round(card.rect.x), y:Math.round(card.rect.y), width:Math.round(card.rect.width), height:Math.round(card.rect.height) },
          hasRemoveControl: card.hasRemove
        };
      }
    }

    // A page-wide text delta is useful, but it can undercount real attachments when
    // the filename already exists in hidden/accessibility text or the page updates
    // the attachment chip without increasing body.innerText's occurrence count.
    // Prefer direct, visible evidence in the active composer neighborhood when present.
    const localEvidenceByName = {};
    // ---------- v0.10.7：诊断采样改为按优先级收集，不再按 DOM 顺序取前 N 个 ----------
    // 旧实现按 DOM 遍历顺序取前 36 个，侧边栏与历史会话文字会挤占名额，
    // 真正需要看的附件卡片反而进不来。
    const diagnosticBuckets = { nameMatch: [], card: [], state: [], other: [] };
    const pushDiagnostic = (bucket, node) => {
      if (diagnosticBuckets[bucket].length >= 14) return;
      diagnosticBuckets[bucket].push(node);
    };
    for (const el of allElements) {
      if (!isVisible(el) || el === document.body || el === document.documentElement) continue;
      const r = rectOf(el);
      if (!r || r.width <= 0 || r.height <= 0) continue;
      if (!inScope(r)) continue;
      let text = '';
      try {
        text = [el.innerText, el.textContent, ...['aria-label','title','alt','data-filename','data-file-name','download']
          .map(attr => el.getAttribute?.(attr) || '')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      } catch {}
      if (!text || text.length > 260) continue;
      const descriptor = [el.getAttribute?.('data-testid'), el.getAttribute?.('data-test-id'), el.getAttribute?.('aria-label'), el.getAttribute?.('title'), el.getAttribute?.('data-state'), el.getAttribute?.('data-status'), el.getAttribute?.('role'), el.className?.baseVal || el.className].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 180);
      const node = {
        tag: el.tagName?.toLowerCase() || 'element',
        text: text.slice(0, 180),
        descriptor,
        rect: { x:Math.round(r.x), y:Math.round(r.y), width:Math.round(r.width), height:Math.round(r.height) },
        visible: true
      };
      const nameHit = names.some(name => containsFilename(norm(text), name));
      const cardHit = FILE_SEMANTIC.test(`${text} ${descriptor}`);
      const stateHit = /(upload|progress|spinner|loading|error|failed|上传|进度|失败)/i.test(`${text} ${descriptor}`);
      if (nameHit) pushDiagnostic('nameMatch', { ...node, matchReason:'filename' });
      else if (cardHit) pushDiagnostic('card', { ...node, matchReason:'file-semantics' });
      else if (stateHit) pushDiagnostic('state', { ...node, matchReason:'upload-state' });
      else pushDiagnostic('other', { ...node, matchReason:'near-composer' });
      for (const name of names) {
        if (localEvidenceByName[name]) continue;
        if (containsFilename(norm(text), name)) {
          localEvidenceByName[name] = {
            tag: el.tagName?.toLowerCase() || 'element',
            descriptor:[el.getAttribute?.('data-testid'),el.getAttribute?.('aria-label'),el.getAttribute?.('title'),el.className?.baseVal || el.className].filter(Boolean).join(' ').slice(0,160),
            rect:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},
            source:'visible-composer-neighborhood'
          };
        }
      }
    }
    // 优先级：文件名匹配 > 附件卡片 > 上传状态 > 其他；每类内部保持 DOM 顺序。
    const diagnosticNodes = [
      ...diagnosticBuckets.nameMatch,
      ...diagnosticBuckets.card,
      ...diagnosticBuckets.state,
      ...diagnosticBuckets.other
    ].slice(0, 40);

    const matched = names.filter(name =>
      Number(counts[name] || 0) > Number(baselineCounts?.[name] || 0) ||
      !!localEvidenceByName[name] ||
      !!inputFileEvidenceByName[name] ||
      !!cardNameMatches[name]
    );
    const missing = names.filter(name => !matched.includes(name));
    // 「卡片存在但读不出这个文件名」——与「根本没有卡片」是两种完全不同的故障，
    // 必须分开报告，否则用户只能看到笼统的 0/N。
    const cardPresentNoName = missing.filter(name => attachmentCards.length > 0 && !cardNameMatches[name]);
    let busy = false, busyReason = '', error = '';
    const busyText = /(?:uploading(?:\s+file)?|processing\s+file|正在上传|上传中|正在处理文件|文件处理中|上传文件中|正在添加文件)/i;
    const errorText = /(?:upload failed|failed to upload|could(?: not|n't) upload|unsupported file|file is too large|上传失败|无法上传|不支持.{0,12}(?:文件|格式)|文件.{0,8}(?:过大|不支持))/i;
    // Keep busy/error detection local to the active composer, so old assistant
    // messages about failed uploads elsewhere in the transcript do not block this turn.
    {
      let statusNodes = [];
      try {
        statusNodes = allElements.filter(el => {
          if (!isVisible(el)) return false;
          const r = rectOf(el);
          if (!r || r.width <= 0 || r.height <= 0) return false;
          if (!inScope(r, 180)) return false;
          // 退化作用域下只接受带上传语义的节点，避免把历史对话里的「上传失败」当成本轮状态。
          if (scopeBox.degraded) {
            const probe = `${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''} ${el.getAttribute?.('data-testid') || ''} ${el.className?.baseVal || el.className || ''}`;
            return FILE_SEMANTIC.test(probe) || /progress|spinner|loading|upload/i.test(probe);
          }
          return true;
        });
      } catch {}
      for (const el of statusNodes) {
        let text = '';
        try { text = String(el.innerText || el.textContent || '').replace(/\s+/g,' ').trim(); } catch {}
        if (text && text.length <= 260 && errorText.test(text)) { error = '网页显示附件上传失败或文件格式不受支持'; break; }
        if (text && text.length <= 260 && busyText.test(text)) { busy = true; busyReason = '网页仍显示上传或文件处理进行中'; }
        try {
          const cls = String(el.className?.baseVal || el.className || '');
          const descriptor = `${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('title') || ''} ${el.getAttribute?.('data-testid') || ''} ${cls}`;
          const progressLike = /progress|spinner|loading|animate-spin|is-uploading|uploading/i.test(descriptor) || el.matches?.('[role="progressbar"],progress,[aria-busy="true"],[data-state="loading"],[data-status="uploading"],[data-uploading="true"]');
          if (progressLike) { busy = true; busyReason = '附件区域仍有进度条或加载指示'; }
        } catch {}
      }
    }
    return {
      confirmed:missing.length === 0 && !busy && !error, composerFound:true, matched, missing, counts,
      baselineCounts:{...baselineCounts}, busy, busyReason, error, evidenceByName, localEvidenceByName,
      inputFileEvidenceByName,
      attachmentCards: attachmentCards.slice(0, 12).map(card => ({
        tag: card.el.tagName?.toLowerCase() || 'element',
        text: card.text.slice(0, 140),
        descriptor: card.descriptor.slice(0, 160),
        rect: { x:Math.round(card.rect.x), y:Math.round(card.rect.y), width:Math.round(card.rect.width), height:Math.round(card.rect.height) },
        matchedName: card.matchedName || '',
        stemOnly: !!card.stemOnly,
        hasRemoveControl: !!card.hasRemove
      })),
      cardCount: attachmentCards.length,
      cardNameMatches,
      cardPresentNoName,
      scopeBox: scopeBox.degraded ? { degraded:true } : {
        left:Math.round(scopeBox.left), top:Math.round(scopeBox.top),
        right:Math.round(scopeBox.right), bottom:Math.round(scopeBox.bottom), degraded:false
      },
      nativeFileInputState:nativeFileInputs.map(input => ({ index:input.index, fileCount:input.files.length, files:input.files.map(file => ({name:file.name,size:file.size,type:file.type})), descriptor:input.descriptor })),
      nativeFileSignatures,
      inputFileSignatures:nativeFileSignatures,
      diagnosticNodes,
      evidenceScope:'composed-visible-DOM-including-open-shadow-roots; composer-ancestor scope box (degrades to whole page); whole-page occurrence delta; native input.files FileList; duplicate-filename aliases; structured attachment-card detection (semantics + geometry + remove control); priority-ranked diagnostic sample',
      composerRect:composerRect ? {x:Math.round(composerRect.x),y:Math.round(composerRect.y),width:Math.round(composerRect.width),height:Math.round(composerRect.height)} : null,
      reason:error || (missing.length
        ? (attachmentCards.length
          ? `输入区检测到 ${attachmentCards.length} 个附件卡片，但未能确认本轮文件：${missing.join('、')}`
          : `当前网页可见区域没有检测到本轮新增附件：${missing.join('、')}`)
        : (busy ? busyReason : '当前网页可见区域检测到全部新增附件名称，且输入区附近没有上传忙碌标志'))
    };
  }

  async function waitForComposerAttachmentEvidence(fileNames, timeoutMs = 120000, baselineCounts = {}, initialEvidence = null) {
    const cap = Math.max(0, Math.min(Number(timeoutMs) || 0, 240000));
    const noEvidenceGrace = PROVIDER === 'chatgpt' ? 15000 : 12000;
    const requiredStableMs = PROVIDER === 'chatgpt' ? 4000 : 3500;
    const deadline = Date.now() + cap;
    const initialMatched = Array.isArray(initialEvidence?.matched) ? initialEvidence.matched : [];
    // If the page visibly entered an upload state immediately after dispatch, never
    // abort just because that transient card disappears for a while. Some composers
    // replace/remove the progress chip while the upload pipeline is still resolving.
    // Keep the normal timeout and require stable, non-busy attachment evidence to pass.
    const hadImmediateUploadEvidence = initialMatched.length > 0;
    const evidenceHistory = [];
    const summarize = (r, elapsedMs) => ({
      tMs:elapsedMs, matched:(r?.matched || []).slice(0, 12), missing:(r?.missing || []).slice(0, 12),
      busy:!!r?.busy, busyReason:String(r?.busyReason || '').slice(0, 100), error:String(r?.error || '').slice(0, 140),
      counts:r?.counts || {}, labels:Object.fromEntries(Object.entries(r?.evidenceByName || {}).map(([k,v]) => [k, String(v?.descriptor || v?.source || '').slice(0,100)])),
      nativeInputs:(r?.nativeFileInputState || []).map(x => ({index:x.index,fileCount:x.fileCount,files:(x.files||[]).map(f=>({name:f.name,size:f.size,type:f.type})),descriptor:x.descriptor})),
      diagnosticNodes:(r?.diagnosticNodes || []).slice(0,14).map(n=>({tag:n.tag,text:n.text,descriptor:n.descriptor,rect:n.rect,matchReason:n.matchReason || ''})),
      cardCount:Number(r?.cardCount || 0),
      attachmentCards:(r?.attachmentCards || []).slice(0,8),
      cardPresentNoName:(r?.cardPresentNoName || []).slice(0,8),
      scopeBox:r?.scopeBox || null,
      composerRect:r?.composerRect || null, evidenceScope:r?.evidenceScope || ''
    });
    let result = composerAttachmentEvidence(fileNames, baselineCounts);
    evidenceHistory.push(summarize(result, 0));
    let stableSamples = 0, stableSince = 0;
    while (true) {
      if (result.error) return { ...result, confirmed:false, failureClass:'page-upload-error', initialEvidence, evidenceHistory, hadImmediateUploadEvidence };
      if (result.confirmed) {
        if (!stableSamples) stableSince = Date.now();
        stableSamples++;
        if (stableSamples >= 6 && Date.now() - stableSince >= requiredStableMs) {
          return { ...result, stableSamples, stableMs:Date.now() - stableSince, requiredStableMs, initialEvidence, evidenceHistory, hadImmediateUploadEvidence };
        }
      } else {
        stableSamples = 0; stableSince = 0;
      }
      const elapsed = Date.now() - (deadline - cap);
      if (evidenceHistory.length < 40 && (elapsed - evidenceHistory[evidenceHistory.length - 1].tMs >= 1800 || result.error)) {
        evidenceHistory.push(summarize(result, elapsed));
      }
      if (Date.now() >= deadline) {
        const disappearedAfterUpload = hadImmediateUploadEvidence && !(result.matched || []).length;
        const cardCount = Number(result.cardCount || 0);
        const missingNames = Array.isArray(result.missing) ? result.missing : [];
        const nameUnreadable = Array.isArray(result.cardPresentNoName) ? result.cardPresentNoName : [];
        // v0.10.7：把「卡片在但名字读不出」和「根本没有卡片」分开。
        // 旧实现只有 initial-evidence-disappeared，用户看不出到底是漏检还是附件真的没了。
        const failureClass = result.error ? 'page-upload-error'
          : result.busy ? 'upload-still-busy'
          : (disappearedAfterUpload && cardCount === 0) ? 'attachments-vanished-after-upload'
          : disappearedAfterUpload ? 'initial-evidence-disappeared'
          : (missingNames.length && nameUnreadable.length === missingNames.length && cardCount >= missingNames.length) ? 'card-present-name-unreadable'
          : (missingNames.length && cardCount > 0) ? 'card-present-unmatched'
          : missingNames.length ? 'filename-not-detected'
          : 'stability-timeout';
        const failureDetail = result.error ? `网页错误提示：${String(result.error).slice(0, 160)}`
          : result.busy ? `上传忙碌：${String(result.busyReason || '').slice(0, 160)}`
          : `卡片数=${cardCount}；缺失=${missingNames.join('、') || '无'}；卡片存在但名称不可读=${nameUnreadable.join('、') || '无'}；即时证据=${hadImmediateUploadEvidence ? '有' : '无'}；最后匹配=${(result.matched || []).join('、') || '无'}`;
        const timeoutReason = disappearedAfterUpload
          ? '自动核验未能在稳定界面中重新识别本轮附件。此结果不等于文件已上传失败或已被网页移除；请检查当前消息输入区：若全部文件卡片仍在、没有上传中或失败提示，可使用“人工目视确认”继续；若卡片已消失或明确报错，则不要继续发送。'
          : (result.confirmed ? `附件可见，但在 ${Math.round(requiredStableMs/1000)} 秒稳定观察期内状态未能确认` : result.reason);
        return { ...result, confirmed:false, reason:timeoutReason, failureClass, failureDetail, initialEvidence, evidenceHistory, hadImmediateUploadEvidence };
      }
      if (!result.matched?.length && !hadImmediateUploadEvidence && elapsed >= Math.min(cap, noEvidenceGrace)) {
        return { ...result, confirmed:false, reason:result.reason || '等待期间没有检测到本轮新附件', failureClass:(Number(result.cardCount||0)>0 ? 'card-present-unmatched' : 'no-evidence-after-transfer'), failureDetail:`卡片数=${Number(result.cardCount||0)}；缺失=${(result.missing||[]).join('、')||'无'}；即时证据=${hadImmediateUploadEvidence?'有':'无'}`, initialEvidence, evidenceHistory, hadImmediateUploadEvidence };
      }
      await sleep(650);
      result = composerAttachmentEvidence(fileNames, baselineCounts);
    }
  }

  async function commitRawFileTransfer(transferId) {
    const session = rawFileTransferSessions.get(transferId);
    if (!session) throw new Error('原始文件传输会话不存在或已过期。');
    try {
      const files = [];
      let totalBytes = 0;
      for (const fileEntry of session.files) {
        const received = fileEntry.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        if (received !== fileEntry.meta.size) throw new Error(`文件 ${fileEntry.meta.name} 字节数不匹配：预期 ${fileEntry.meta.size}，收到 ${received}。`);
        if (fnv1aChunks(fileEntry.chunks) !== fileEntry.meta.checksum) throw new Error(`文件 ${fileEntry.meta.name} 的内存传输校验失败。`);
        totalBytes += received;
        files.push(new File(fileEntry.chunks, fileEntry.meta.name, {
          type: fileEntry.meta.mimeType || 'application/octet-stream',
          lastModified: Number(fileEntry.meta.lastModified) || Date.now()
        }));
      }
      if (totalBytes !== session.totalBytes) throw new Error(`所选文件总字节数不匹配：预期 ${session.totalBytes}，收到 ${totalBytes}。`);
      const inputs = [...document.querySelectorAll('input[type="file"]')];
      const input = inputs[session.inputIndex];
      if (!input || input.disabled) throw new Error('原生文件输入控件在传输期间发生变化或已禁用，请刷新网页后重试。');
      if (files.length > 1 && !input.multiple) throw new Error('目标文件输入控件不接受多文件，请分批投递。');
      const dt = new DataTransfer();
      files.forEach(file => dt.items.add(file));
      const win = input.ownerDocument.defaultView || window;
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'files')?.set;
      if (setter) setter.call(input, dt.files); else input.files = dt.files;
      const beforeDispatch = [...(input.files || [])].map(file => ({ name:file.name, size:file.size, type:file.type }));
      if (beforeDispatch.length !== files.length || beforeDispatch.some((item, index) => item.name !== files[index].name || item.size !== files[index].size)) {
        throw new Error('网页文件输入控件没有保留全部原始文件；本轮不会发送主题。');
      }
      input.dispatchEvent(new win.Event('input', { bubbles:true, composed:true }));
      input.dispatchEvent(new win.Event('change', { bubbles:true, composed:true }));
      await sleep(120);
      const afterDispatch = [...(input.files || [])].map(file => ({ name:file.name, size:file.size, type:file.type }));
      // Capture evidence immediately after dispatch. Some web apps clear the native
      // input after accepting the selection, so the later verifier must know whether
      // the input was cleared immediately and whether attachment UI evidence appeared.
      let immediateEvidence = null;
      try {
        const evidence = composerAttachmentEvidence(files.map(file => file.name), {});
        immediateEvidence = {
          matched:evidence.matched || [], missing:evidence.missing || [], counts:evidence.counts || {},
          evidenceByName:evidence.evidenceByName || {}, localEvidenceByName:evidence.localEvidenceByName || {},
          busy:!!evidence.busy, busyReason:evidence.busyReason || '', pageError:evidence.error || '',
          composerFound:!!evidence.composerFound, composerRect:evidence.composerRect || null,
          nativeFileInputState:evidence.nativeFileInputState || []
        };
      } catch (e) { immediateEvidence = { captureError:String(e?.message || e) }; }
      return { ok:true, count:beforeDispatch.length, names:beforeDispatch.map(file => file.name), files:beforeDispatch,
        afterDispatch, input:{index:session.inputIndex, descriptor:shortInputDescriptor(input), accept:input.accept || '', multiple:!!input.multiple,
          connected:!!input.isConnected, stillSameInput:!!input.isConnected && [...document.querySelectorAll('input[type=\"file\"]')][session.inputIndex] === input},
        immediateEvidence,
        note: afterDispatch.length === 0 ? '网页事件处理后 120ms 内原生文件控件已清空；这既可能是网页接收文件后的正常行为，也可能是网页忽略/重置了选择，必须结合即时附件界面证据判断。' : '内存文件在事件处理后仍保留于原生文件控件；仍需通过附件界面证据确认网站已接受文件。' };
    } finally {
      clearTimeout(session.expiryTimer);
      rawFileTransferSessions.delete(transferId);
    }
  }

  // ---------- 消息接口 ----------
  const onRuntimeMessage = (message, sender, sendResponse) => {
    if (!message?.type) return;
    if (message.type === 'DUO_RAW_FILE_TRANSFER_BEGIN') {
      try {
        if (sender?.id !== chrome.runtime.id) throw new Error('原始文件传输请求来源不合法。');
        const transferId = String(message.transferId || '');
        if (String(message.provider || '') !== PROVIDER) throw new Error('目标网页与文件投递适配器不匹配。');
        const files = Array.isArray(message.files) ? message.files : [];
        const totalBytes = Number(message.totalBytes || 0);
        const inputIndex = Number(message.inputIndex);
        if (!/^[a-zA-Z0-9_-]{12,100}$/.test(transferId)) throw new Error('原始文件传输 ID 不合法。');
        if (!files.length || files.length > 30 || !Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_RAW_TRANSFER_BYTES) throw new Error('原始文件数量或总大小超出限制。');
        if (!Number.isInteger(inputIndex) || inputIndex < 0) throw new Error('文件输入控件索引无效。');
        const inputs = [...document.querySelectorAll('input[type="file"]')];
        const input = inputs[inputIndex];
        if (!input || input.disabled) throw new Error('预检选择的文件输入控件不存在或已禁用。');
        if (files.length > 1 && !input.multiple) throw new Error('目标文件输入控件不支持一次投递多个文件，请分批选择。');
        const validFiles = files.map(meta => {
          const name = String(meta?.name || '').trim();
          const size = Number(meta?.size || 0);
          const checksum = String(meta?.checksum || '').toLowerCase();
          if (!name || !Number.isSafeInteger(size) || size < 1 || !/^[0-9a-f]{8}$/.test(checksum)) throw new Error('原始文件元数据无效。');
          return { meta:{ name, size, checksum, mimeType:String(meta.mimeType || 'application/octet-stream'), lastModified:Number(meta.lastModified) || Date.now() }, chunks:[], bytesReceived:0 };
        });
        if (validFiles.reduce((sum, item) => sum + item.meta.size, 0) !== totalBytes) throw new Error('文件清单大小与总大小不匹配。');
        for (const [id, existing] of rawFileTransferSessions) {
          if (Date.now() - Number(existing.createdAt || 0) > 180000) { clearTimeout(existing.expiryTimer); rawFileTransferSessions.delete(id); }
        }
        if (rawFileTransferSessions.size >= 3) throw new Error('网页中已有过多未完成的文件传输，请刷新页面后重试。');
        const session = { files:validFiles, totalBytes, inputIndex, provider:PROVIDER, createdAt:Date.now(), expiryTimer:null };
        session.expiryTimer = setTimeout(() => rawFileTransferSessions.delete(transferId), 180000);
        rawFileTransferSessions.set(transferId, session);
        sendResponse({ ok:true, transferId, inputIndex, input:shortInputDescriptor(input), expectedBytes:totalBytes, fileCount:validFiles.length });
      } catch (error) { sendResponse({ ok:false, error:error?.message || String(error) }); }
      return;
    }
    if (message.type === 'DUO_RAW_FILE_TRANSFER_CHUNK') {
      try {
        if (sender?.id !== chrome.runtime.id) throw new Error('文件分块来源不合法。');
        const session = rawFileTransferSessions.get(String(message.transferId || ''));
        if (!session) throw new Error('原始文件传输会话不存在或已过期。');
        const fileIndex = Number(message.fileIndex), chunkIndex = Number(message.chunkIndex), byteLength = Number(message.byteLength);
        const fileEntry = session.files[fileIndex];
        if (!fileEntry || !Number.isInteger(chunkIndex) || chunkIndex !== fileEntry.chunks.length) throw new Error('文件分块顺序不正确。');
        const base64 = String(message.data || '');
        if (!base64 || base64.length > 800000 || !Number.isInteger(byteLength) || byteLength < 1 || byteLength > MAX_RAW_CHUNK_BYTES) throw new Error('文件分块大小或内容无效。');
        const binary = atob(base64);
        if (binary.length !== byteLength) throw new Error('文件分块解码长度与发送端不匹配。');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        fileEntry.chunks.push(bytes);
        fileEntry.bytesReceived += bytes.byteLength;
        if (fileEntry.bytesReceived > fileEntry.meta.size) throw new Error('收到的分块超过原始文件长度。');
        sendResponse({ ok:true, transferId:message.transferId, fileIndex, chunkIndex, fileBytesReceived:fileEntry.bytesReceived });
      } catch (error) { sendResponse({ ok:false, error:error?.message || String(error) }); }
      return;
    }
    if (message.type === 'DUO_RAW_FILE_TRANSFER_COMMIT') {
      if (sender?.id !== chrome.runtime.id) { sendResponse({ ok:false, error:'原始文件提交来源不合法。' }); return; }
      commitRawFileTransfer(String(message.transferId || ''))
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ ok:false, error:error?.message || String(error) }));
      return true;
    }
    if (message.type === 'DUO_RAW_FILE_TRANSFER_ABORT') {
      if (sender?.id === chrome.runtime.id) { const id = String(message.transferId || ''); const session = rawFileTransferSessions.get(id); if (session) clearTimeout(session.expiryTimer); rawFileTransferSessions.delete(id); }
      sendResponse({ ok:true });
      return;
    }
    if (message.type === 'DUO_ATTACHMENT_BASELINE') {
      try {
        const baseline = composerAttachmentEvidence(message.fileNames, {});
        sendResponse({ ok: baseline.composerFound === true, composerFound: baseline.composerFound === true, confirmed: false, provider: PROVIDER, counts: baseline.counts || {}, inputFileSignatures:baseline.inputFileSignatures || [], nativeFileInputState:baseline.nativeFileInputState || [], matched: baseline.matched || [], reason: baseline.reason || '' });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error), provider: PROVIDER });
      }
      return;
    }
    if (message.type === 'DUO_VERIFY_ATTACHMENTS') {
      waitForComposerAttachmentEvidence(message.fileNames, Number(message.timeoutMs) || 1500, message.baselineCounts || {}, message.initialEvidence || null)
        .then(result => sendResponse({ ok: true, provider: PROVIDER, ...result }))
        .catch(error => sendResponse({ ok: false, confirmed: false, error: error?.message || String(error), provider: PROVIDER }));
      return true;
    }
    if (message.type === 'DUO_STATUS') {
      const snap = snapshot();
      const composer = findComposer();
      sendResponse({
        ok: true,
        provider: PROVIDER,
        title: document.title,
        ready: !!composer,
        path: location.pathname,
        hasMessages: snap.sig.length > 0,
        diagnostics: {
          root: describeRoot(snap.root),
          hasMain: !!document.querySelector('main'),
          pageChars: snap.sig.length,
          assistantNodes: assistantNodes().length,
          composerTag: composer ? composer.tagName : null,
          generating: isGenerating()
        }
      });
      return;
    }
    if (message.type === 'DUO_PROBE') {
      const snap = snapshot();
      const promptSig = sigOf(message.prompt || '');
      const located = promptSig ? (locateStartByAnchor(snap, promptSig) || locateStartByHeadAnchor(snap, promptSig)) : null;
      const answer = domAnswerText(new Set(), promptSig) || (located ? cleanAnswer(snap.raw.slice(located.rawStart)) : '');
      sendResponse({
        ok: true,
        provider: PROVIDER,
        diagnostics: diagnostics(snap),
        channel: answer && assistantNodes().length ? '助手消息节点/文本锚点' : (located ? located.channel : '无'),
        answerPreview: answer.slice(0, 300),
        tailPreview: snap.raw.slice(-300)
      });
      return;
    }
    if (message.type === 'DUO_STOP') { cancelled = true; sendResponse({ ok: true }); return; }
    if (message.type === 'DUO_WAIT_ANSWER') {
      sendAndWait(String(message.prompt || ''), Number(message.timeoutMs) || 100000, message.sendResult || null, !!message.requireFreshPrompt, !!message.finalTurn)
        .then(result => sendResponse({ ok: true, text: result.text, completion: result.completion, provider: PROVIDER }))
        .catch(error => sendResponse({ ok: false, error: error?.message || String(error), provider: PROVIDER }));
      return true;
    }
    if (message.type === 'DUO_SEND') {
      // Backward compatibility for the legacy page-driven send pathway.
      sendAndWait(String(message.prompt || ''), Number(message.timeoutMs) || 100000)
        .then(result => sendResponse({ ok: true, text: result.text, completion: result.completion, provider: PROVIDER }))
        .catch(error => sendResponse({ ok: false, error: error?.message || String(error), provider: PROVIDER }));
      return true;
    }
  };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  window.__duoLabDispose = () => {
    cancelled = true;
    for (const session of rawFileTransferSessions.values()) clearTimeout(session.expiryTimer);
    rawFileTransferSessions.clear();
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch {}
    try { delete window.__duoLabDispose; } catch { window.__duoLabDispose = null; }
  };
})();
