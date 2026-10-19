const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Invoke Chrome extension APIs with their owning namespace as `this`.
// Several APIs (notably chrome.storage.local methods) throw
// "Illegal invocation / Function must be called on an object of type StorageArea"
// when passed around as detached function references.
function callChrome(owner, methodName, ...args) {
  return new Promise((resolve, reject) => {
    const fn = owner && owner[methodName];
    if (typeof fn !== 'function') {
      reject(new Error(`Chrome API 不存在或不可调用：${String(methodName)}`));
      return;
    }
    fn.call(owner, ...args, result => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}
async function cdp(debuggee, method, params = {}) {
  return callChrome(chrome.debugger, 'sendCommand', debuggee, method, params);
}
async function attach(debuggee) {
  await callChrome(chrome.debugger, 'attach', debuggee, '1.3');
}
async function detach(debuggee) {
  try { await callChrome(chrome.debugger, 'detach', debuggee); } catch {}
}


const RECOVERED_DRAFTS_KEY = 'duoLabRecoveredWebDraftsV078';
const MAX_RECOVERED_DRAFT_CHARS = 100000;
async function saveRecoveredComposerDraft(provider, tabId, url, text) {
  const value = String(text || '');
  if (!value.length) return null;
  if (value.length > MAX_RECOVERED_DRAFT_CHARS) {
    throw new Error(`网页有 ${value.length} 字符的未发送草稿，超过自动备份安全上限；草稿未清除。请先在网页中复制或保存后再重试。`);
  }
  const saved = await callChrome(chrome.storage.local, 'get', RECOVERED_DRAFTS_KEY);
  const existing = Array.isArray(saved?.[RECOVERED_DRAFTS_KEY]) ? saved[RECOVERED_DRAFTS_KEY] : [];
  const entry = {
    id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    provider: String(provider || ''),
    tabId: Number(tabId),
    url: String(url || '').slice(0, 1000),
    createdAt: new Date().toISOString(),
    length: value.length,
    text: value
  };
  // Keep a small, local-only recovery history. Never put draft text in diagnostics.
  const next = [entry, ...existing.filter(item => item && item.id !== entry.id)].slice(0, 6);
  await callChrome(chrome.storage.local, 'set', { [RECOVERED_DRAFTS_KEY]: next });
  return { id: entry.id, length: entry.length, provider: entry.provider, createdAt: entry.createdAt };
}
async function cdpClearComposer(debuggee, providerKey) {
  const provider = String(providerKey || '').toLowerCase();
  const expression = `(() => {
    const visible=e=>!!e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
    const deepseek=location.hostname.toLowerCase().includes('deepseek');
    const selectors=deepseek
      ? ['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea','[contenteditable="true"][role="textbox"]','[contenteditable="true"]']
      : ['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[data-testid="composer-text-input"]','main textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]'];
    let el=null;
    for(const selector of selectors){const found=[...document.querySelectorAll(selector)].filter(visible);if(found.length){el=found[found.length-1];break;}}
    if(!el)return {ok:false,reason:'no-composer'};
    const norm=s=>String(s||'').replace(/[\\p{White_Space}\\p{Default_Ignorable_Code_Point}\\p{Cf}\\u2800\\u115F\\u1160\\u3164\\uFFA0]/gu,'');
    const read=()=>String(('value'in el)?el.value:(el.innerText||el.textContent||''));
    const before=read();
    if(!before.length)return {ok:true,beforeLength:0,beforeMeaningfulLength:0,afterLength:0,meaningfulLength:0};
    try{el.focus({preventScroll:true});}catch{try{el.focus();}catch{}}
    if(('value'in el) && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)){
      const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
      if(setter)setter.call(el,'');else el.value='';
    } else {
      try {
        const selection=window.getSelection();
        const range=document.createRange();
        range.selectNodeContents(el);
        selection?.removeAllRanges(); selection?.addRange(range);
        document.execCommand('delete',false,null);
      } catch {}
      if(read().length) el.textContent='';
    }
    try{el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null}));}catch{el.dispatchEvent(new Event('input',{bubbles:true}));}
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return {ok:norm(read()).length===0,beforeLength:before.length,beforeMeaningfulLength:norm(before).length,afterLength:read().length,meaningfulLength:norm(read()).length,tag:el.tagName};
  })()`;
  const result = await cdp(debuggee, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const value = result?.result?.value || { ok: false, reason: 'empty-result' };
  if (value.ok) return value;

  // Fallback: a framework-controlled composer may restore the value after a JS setter.
  // The draft is already backed up locally before this path is reached.
  try {
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(100);
    const verify = await cdp(debuggee, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const second = verify?.result?.value;
    if (second?.ok) return { ...second, method: 'native-setter+input-event/keyboard-fallback' };
    return { ...(second || value), ok: false, method: 'native-setter+keyboard-fallback' };
  } catch (error) {
    return { ...value, ok: false, fallbackError: String(error?.message || error) };
  }
}

// ---------- 会话隔离判定：只用结构化证据，不看主区域文本长度 ----------
// 空白新会话的欢迎语、建议卡片、免责声明同样会渲染出近 2000 字符的可见文本，
// 所以「主区域文本 < N 字符」既不能证明页面空白、也不能证明存在历史会话。
// v0.8.3 用「主区域文本长度小于 1200」判定空白，遇到 1961 字符的空白欢迎页就必然误判：
// 会去点「新建对话」，而站点本来就停在空白起始页，点击不产生任何切换信号，
// 于是确认循环永远不满足，最终报「新建独立对话失败」。这里改为三类结构证据：
//   1) 对话轮容器数量（article / conversation-turn / [data-message-id] / .ds-markdown 等）
//   2) 每条回答下方的消息工具按钮（复制/重新生成/点赞）：存在即证明页面已有助手消息
//   3) URL 中的会话标识（ChatGPT /c/<id>、DeepSeek /chat/s/<id>、查询参数形式）
function sessionKeyOf(url = '') {
  let parsed = null;
  try { parsed = new URL(String(url || '')); } catch { return ''; }
  const path = parsed.pathname || '';
  const chatgpt = /\/c\/([A-Za-z0-9-]{8,})/.exec(path);
  if (chatgpt) return chatgpt[1];
  const deepseek = /\/(?:a\/)?chat\/s\/([A-Za-z0-9_-]{6,})/.exec(path);
  if (deepseek) return deepseek[1];
  const query = /[?&](?:chat_?id|conversation_?id|thread_?id)=([A-Za-z0-9_-]{6,})/i.exec(parsed.search || '');
  if (query) return query[1];
  return '';
}
function isConversationPageUrl(url = '') {
  let parsed = null;
  try { parsed = new URL(String(url || '')); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname || '';
  if (host.includes('deepseek')) return !/\/(?:sign_?in|signup|login|oauth|usage|api|skills)\b/i.test(path);
  return !/\/(?:share|gpts|admin|pricing|settings|auth|login)\b/i.test(path);
}
// 严格判据（进入流程前）：没有轮容器、没有消息工具按钮、有输入框
// → 当前页面本身就是空白会话，直接用它，不需要再点「新建对话」。
// 站点差异（均来自实测日志）：
//   · DeepSeek 的轮容器选择器有效（有内容时能数到 2 个），而「新对话」会立刻生成会话 id
//     却不产生任何消息 —— 所以会话 id 不能作为「有旧会话」的证据。
//   · ChatGPT 的消息节点选择器实测失效（v0.8.7/v0.8.8 两次退回 main/body），所以有
//     会话标识时宁可保守地用导航兜底重建，也不直接把主题发进去。
function isBlankSession(state, provider) {
  const s = state || {};
  const empty = Number(s.messageCount || 0) === 0 && !s.hasMessageTools && !!s.hasComposer;
  if (!empty) return false;
  if (String(provider || '').toLowerCase().includes('deepseek')) return true;
  return !String(s.sessionKey || '');
}
// 宽松判据（点击之后）：只要没有轮容器与消息工具按钮即认为已进入空会话
// （此时站点可能已经给出新的会话标识，但还没有任何消息）。
function isEmptiedConversation(state) {
  const s = state || {};
  return Number(s.messageCount || 0) === 0 && !s.hasMessageTools && !!s.hasComposer;
}
function describeConversationState(state) {
  const s = state || {};
  return `对话轮容器 ${Number(s.messageCount || 0)}（用户 ${Number(s.userCount || 0)}/助手 ${Number(s.assistantCount || 0)}，轮节点 ${Number(s.turnCount || 0)}），消息工具按钮 ${s.hasMessageTools ? '存在' : '无'}，会话标识 ${String(s.sessionKey || '') || '无'}，主区域文本 ${Number(s.textLength || 0)} 字符（仅用于诊断）`;
}
function urlPathOf(url = '') {
  try { return new URL(String(url || '')).pathname.slice(0, 120) || '/'; } catch { return '/' }
}

async function cdpNewChat(tabId, providerKey) {
  const debuggee = { tabId };
  let attached = false;
  const provider = String(providerKey || '').toLowerCase();
  try {
    const tab = await callChrome(chrome.tabs, 'get', tabId);
    if (!isSupportedAiUrl(tab?.url)) throw new Error('目标标签页不是受支持的 ChatGPT/DeepSeek HTTPS 页面。');
    const actualProvider = String(tab.url).toLowerCase().includes('deepseek') ? 'deepseek' : 'chatgpt';
    if (provider !== actualProvider) throw new Error(`所选标签页与 ${providerKey} 不匹配。`);
    if (!isConversationPageUrl(tab.url)) throw new Error(`当前标签页不是对话页面（${urlPathOf(tab.url)}），未修改任何会话。请切换到 ChatGPT/DeepSeek 的聊天页面后重试。`);
    await attach(debuggee); attached = true;
    await cdp(debuggee, 'Runtime.enable');
    const inspectExpr = `(() => {
      const visible=e=>!!e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
      const deepseek=location.hostname.toLowerCase().includes('deepseek');
      ${TRANSCRIPT_ROOT_HELPER}
      const root=transcriptRoot();
      const text=String(root?.innerText||root?.textContent||'').replace(/\\s+/g,' ').trim();
      const norm=s=>String(s||'').replace(/\\s+/g,' ').trim();
      const sessionKeyOfUrl=href=>{try{const u=new URL(String(href||''));const p=u.pathname||'';const c=/\\/c\\/([A-Za-z0-9-]{8,})/.exec(p);if(c)return c[1];const d=/\\/(?:a\\/)?chat\\/s\\/([A-Za-z0-9_-]{6,})/.exec(p);if(d)return d[1];const q=/[?&](?:chat_?id|conversation_?id|thread_?id)=([A-Za-z0-9_-]{6,})/i.exec(u.search||'');if(q)return q[1];return '';}catch{return '';}};
      const userSelectors=['[data-message-author-role="user"]','[data-testid="user-message"]','[data-message-role="user"]','[class*="message-user"]'];
      const assistantSelectors=deepseek?['[data-message-author-role="assistant"]','[data-testid*="assistant"]','[class*="assistant-message"]','.ds-markdown','[data-message-id]']:['[data-message-author-role="assistant"]','[data-testid*="assistant"]','[class*="assistant-message"]','[class*="agent-turn"]','[data-message-id]'];
      const turnSelectors=['article[data-testid^="conversation-turn-"]','[data-testid^="conversation-turn-"]','article[data-message-id]','[data-message-id]','.ds-markdown','[class*="chat-message"]','[class*="message-item"]'];
      const collect=selectors=>{const set=new Set();for(const selector of selectors){try{for(const n of root.querySelectorAll(selector)){if(visible(n)&&norm(n.innerText||n.textContent))set.add(n);}}catch{}}const all=[...set];return all.filter(n=>!all.some(o=>o!==n&&o.contains(n)));};
      const users=collect(userSelectors); const assistants=collect(assistantSelectors);
      const turns=collect(turnSelectors);
      // 消息工具按钮（复制/重新生成/点赞）只出现在已有回答下方，是「页面已有助手消息」
      // 的强证据；它比角色属性更耐改版，用来防止选择器失效时把旧会话误判成空白会话。
      const toolSelectors=['[data-testid*="copy-turn-action-button"]','[data-testid*="good-response"]','[data-testid*="bad-response"]','[data-testid*="regenerate"]','button[aria-label*="复制"]','button[aria-label*="Copy" i]','button[aria-label*="重新生成"]','button[aria-label*="Regenerate" i]','[role="button"][aria-label*="复制"]','[role="button"][aria-label*="重新生成"]','.ds-icon-button[aria-label*="复制"]'];
      const hasMessageTools=toolSelectors.some(selector=>{try{return [...root.querySelectorAll(selector)].some(visible);}catch{return false;}});
      const sessionKey=sessionKeyOfUrl(location.href);
      const composerSelectors=deepseek?['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea','[contenteditable="true"][role="textbox"]','[contenteditable="true"]']:['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[data-testid="composer-text-input"]','main textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]'];
      let composer=null;for(const selector of composerSelectors){const a=[...document.querySelectorAll(selector)].filter(visible);if(a.length){composer=a[a.length-1];break;}}
      const val = composer ? String(('value' in composer) ? composer.value : (composer.innerText || composer.textContent || '')) : '';
      const composerMeaningfulLength=val.replace(/[\\p{White_Space}\\p{Default_Ignorable_Code_Point}\\p{Cf}\\u2800\\u115F\\u1160\\u3164\\uFFA0]/gu,'').length;
      const labels=e=>[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('data-testid'),e.getAttribute('data-test-id'),typeof e.className==='string'?e.className:'',e.innerText,e.textContent].filter(Boolean).join(' ').replace(/\\s+/g,' ').trim();
      const newRE=/(?:new[\\s_-]*(?:chat|conversation)|create[\\s_-]*new[\\s_-]*(?:chat|conversation)|新建对话|新对话|新建聊天|新聊天|开始新对话|开始新聊天)/i;
      const badRE=/(?:history|历史|archive|归档|delete|删除|rename|重命名|search|搜索|setting|设置)/i;
      const nodes=[...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
      const candidates=[];
      for(const e of nodes){const label=labels(e);const attrs=[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('data-testid'),e.getAttribute('data-test-id')].filter(Boolean).join(' ');if(!newRE.test(label)||badRE.test(attrs))continue;const r=e.getBoundingClientRect();let score=0;if(/create-new-chat|new-chat|new_conversation/i.test(attrs))score+=400;if(/aria-label|title/i.test(label)&&newRE.test(attrs))score+=200;if(/^(?:new chat|new conversation|新建对话|新对话|新建聊天|新聊天)$/i.test(norm(e.innerText||e.textContent)))score+=160;if(e.tagName==='BUTTON'||e.getAttribute('role')==='button')score+=30;if(r.width>0&&r.height>0)score+=20;candidates.push({x:r.left+r.width/2,y:r.top+r.height/2,label:label.slice(0,140),score,tag:e.tagName,href:e.getAttribute('href')||''});}
      candidates.sort((a,b)=>b.score-a.score);
      const messageCount=Math.max(turns.length,users.length+assistants.length);
      return {url:location.href,urlPath:location.pathname.slice(0,120)||'/',provider:deepseek?'deepseek':'chatgpt',sessionKey,turnCount:turns.length,hasMessageTools,textLength:text.length,textPreview:text.slice(0,180),userCount:users.length,assistantCount:assistants.length,messageCount,composerLength:val.length,composerMeaningfulLength,composerDraft:val,hasComposer:!!composer,candidate:candidates[0]||null,candidates:candidates.slice(0,5).map(c=>({label:c.label,score:c.score,tag:c.tag,href:c.href}))};
    })()`;
    const readState = async () => {
      const result = await cdp(debuggee, 'Runtime.evaluate', { expression: inspectExpr, returnByValue: true, awaitPromise: true });
      return result?.result?.value || null;
    };
    const before = await readState();
    if (!before) throw new Error('无法读取网页状态，未尝试新建对话。');
    if (!before.hasComposer) throw new Error('当前网页找不到消息输入框，未尝试新建对话。');
    let recoveredDraft = null;
    const composerDraft = String(before.composerDraft || '');
    const composerMeaningfulBefore = Number(before.composerMeaningfulLength ?? composerDraft.replace(/[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\u2800\u115F\u1160\u3164\uFFA0]/gu, '').length);
    const composerCodePoints = composerDraft.length <= 8 ? [...composerDraft].map(ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`) : [];
    // Empty contenteditables can expose one newline/default-ignorable placeholder.
    // Ignore it as a draft; only preserve meaningful characters in local recovery storage.
    if (composerDraft.length > 0 && composerMeaningfulBefore > 0) {
      recoveredDraft = await saveRecoveredComposerDraft(provider, tabId, before.url, composerDraft);
    }

    // IMPORTANT: do not make a harmless residual composer character a hard blocker.
    // cdpSend() focuses the selected composer, performs Ctrl+A + Backspace, inserts the
    // exact new prompt, and verifies the leading text before it can click Send. Thus, if
    // the transcript is already empty, the current page is already an isolated session;
    // a stubborn composer value can be replaced safely after its contents are backed up.
    if (isBlankSession(before, provider)) {
      let clearNote = '';
      if (composerDraft.length > 0) {
        try {
          const cleared = await cdpClearComposer(debuggee, provider);
          await sleep(180);
          const afterClear = await readState();
          const residual = afterClear
            ? Number(afterClear.composerMeaningfulLength ?? afterClear.composerLength ?? 0)
            : null;
          if (!cleared?.ok || residual === null || residual > 0) {
            clearNote = `输入框清理未能完全确认（剩余有效字符数=${residual === null ? '未知' : residual}；原始字符数=${composerDraft.length}；码点=${composerCodePoints.join(',') || '未记录'}）；${recoveredDraft ? '真实草稿已备份' : '无有效草稿备份'}；正式发送前会再次全选替换并校验。`;
          } else if (recoveredDraft) {
            clearNote = `旧输入框草稿已备份到本机恢复区（${composerDraft.length} 字符），空白会话已就绪。`;
          } else {
            clearNote = `已清理 ${composerDraft.length} 个空白/不可见占位字符（有效字符数 ${composerMeaningfulBefore}），未创建无意义草稿备份。`;
          }
        } catch (clearError) {
          clearNote = `输入框清理动作未能确认（${String(clearError?.message || clearError).slice(0, 160)}）；${recoveredDraft ? '真实草稿已备份' : '无有效草稿备份'}；正式发送前会再次全选替换并校验。`;
        }
      }
      return {
        ok: true,
        alreadyFresh: true,
        via: 'already-empty',
        draftBackedUp: !!recoveredDraft,
        draftLength: recoveredDraft?.length || 0,
        details: `当前页面没有对话轮容器、没有消息工具按钮、URL 也没有会话标识，判定为可直接使用的空白会话，未点击任何按钮。${describeConversationState(before)}。${clearNote ? ` ${clearNote}` : ''}`
      };
    }

    // For an existing conversation, preserve the unsent draft locally and navigate away;
    // don't block new-task isolation because the old conversation's composer refuses to clear.
    // The new conversation is validated below, and the send path overwrites its composer.
    const target = before.candidate;
    if (!target) throw new Error(`当前不是空白会话（${describeConversationState(before)}；路径 ${urlPathOf(before.url)}），且未找到可靠的新建对话按钮。未修改当前会话。请手动新建对话后重试，或取消“每次新任务新建对话”。候选按钮：${JSON.stringify(before.candidates||[]).slice(0,700)}`);
    if (!(target.x >= 0 && target.y >= 0)) throw new Error('新建对话按钮坐标无效，未修改当前会话。');
    await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
    await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    const deadline = Date.now() + 10000;
    let state = null;
    let stableEmptySince = 0;
    let lastObserved = '';
    while (Date.now() < deadline) {
      await sleep(300);
      state = await readState();
      if (!state) continue;
      const urlChanged = state.url !== before.url;
      const sessionCleared = !!before.sessionKey && !state.sessionKey;
      const turnsCleared = Number(before.messageCount || 0) > 0 && Number(state.messageCount || 0) === 0;
      const switched = urlChanged || sessionCleared || turnsCleared;
      if (!isEmptiedConversation(state)) {
        stableEmptySince = 0;
        lastObserved = describeConversationState(state);
        continue;
      }
      // 幂等路径：站点本来就停在空白起始页时，点击「新建对话」不会产生任何可观察切换
      // （URL 不变、轮容器仍为 0、主区域文本长度不变）。隔离目标已经达成，不能判失败。
      if (!switched) {
        if (!stableEmptySince) {
          stableEmptySince = Date.now();
          lastObserved = `已看到空白状态，等待稳定确认：${describeConversationState(state)}`;
          continue;
        }
        if (Date.now() - stableEmptySince < 520) continue;
        const stableConfirm = (await readState()) || state;
        if (isBlankSession(stableConfirm, provider)) {
          return { ok: true, alreadyFresh: true, via: 'stable-empty', draftBackedUp: !!recoveredDraft, draftLength: recoveredDraft?.length || 0, details: `点击 ${target.label || '新建对话'} 后页面没有发生切换，但当前已是稳定的空白会话（${describeConversationState(stableConfirm)}）。当前路径 ${urlPathOf(stableConfirm.url)}；旧会话标识 ${before.sessionKey || '无'}。${recoveredDraft ? ` 旧网页未发送内容已备份到扩展本机恢复区（${recoveredDraft.length} 字符），未上传。` : ''}` };
        }
        stableEmptySince = 0;
        continue;
      }
      if (switched) {
        await sleep(250);
        let confirm = await readState();
        if (confirm && isEmptiedConversation(confirm)) {
          // A new conversation is defined by its empty transcript, not by a perfectly empty
          // editor. Some frontends keep a ghost/one-character editor value across navigation.
          // Back up that value if it differs from the old draft. cdpSend() replaces the whole
          // editor and verifies the exact new prompt before sending, so don't fail isolation
          // solely because composerLength is 1.
          const newDraft = String(confirm.composerDraft || '');
          if (newDraft.length > 0 && newDraft !== composerDraft && Number(confirm.composerMeaningfulLength ?? newDraft.replace(/[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\u2800\u115F\u1160\u3164\uFFA0]/gu, '').length) > 0) {
            recoveredDraft = await saveRecoveredComposerDraft(provider, tabId, confirm.url, newDraft);
          }
          const residualMeaningful = Number(confirm.composerMeaningfulLength ?? confirm.composerLength ?? 0);
          if (residualMeaningful > 0) {
            try { await cdpClearComposer(debuggee, provider); await sleep(120); confirm = await readState() || confirm; } catch {}
          }
          if (confirm && isEmptiedConversation(confirm)) {
            return { ok: true, alreadyFresh: false, via: 'clicked', draftBackedUp: !!recoveredDraft, draftLength: recoveredDraft?.length || 0, details: `已点击 ${target.label || '新建对话'}；URL 变化=${urlChanged ? '是' : '否'}；会话标识 ${before.sessionKey || '无'}→${confirm.sessionKey || '无'}；${describeConversationState(confirm)}；新会话输入框有效字符数=${confirm.composerMeaningfulLength ?? confirm.composerLength ?? '未知'}。${recoveredDraft ? ` 旧网页未发送内容已备份到扩展本机恢复区（${recoveredDraft.length} 字符），未上传；下一轮发送会全选替换输入框。` : ''}` };
          }
        }
      }
    }
    // 兜底：部分站点的侧边栏「新对话」控件用 CDP 鼠标事件点不动。v0.8.8 实测日志：
    // 点击前后 DeepSeek 的轮容器 2→2、会话标识不变、主区域文本 1035→1035、URL 未变化。
    // 这种情况下直接导航回站点首页——首页本身就是空白新会话，这是「新建对话」最可靠的
    // 等价实现；旧草稿已在本机恢复区备份，导航不会丢失它。
    if (!state || !isEmptiedConversation(state)) {
      let origin = '';
      try { origin = new URL(before.url).origin + '/'; } catch { origin = ''; }
      if (origin) {
        let navState = null;
        try {
          await cdp(debuggee, 'Page.navigate', { url: origin });
          const navDeadline = Date.now() + 15000;
          while (Date.now() < navDeadline) {
            await sleep(400);
            try { navState = await readState(); } catch { navState = null; }
            if (navState && isEmptiedConversation(navState) && !String(navState.sessionKey || '')) {
              return {
                ok: true,
                alreadyFresh: true,
                via: 'navigated',
                draftBackedUp: !!recoveredDraft,
                draftLength: recoveredDraft?.length || 0,
                details: `新建对话按钮点击后页面没有切换（${describeConversationState(state || {})}），已改为导航到 ${origin} 建立空白会话：${describeConversationState(navState)}。${recoveredDraft ? ` 旧网页未发送内容已备份到扩展本机恢复区（${recoveredDraft.length} 字符），未上传。` : ''}`
              };
            }
          }
        } catch (navError) {
          state = state || {};
          state.navError = String(navError?.message || navError).slice(0, 160);
        }
      }
    }
    throw new Error(`点击“新建对话”后，未能确认页面切换到空白会话。点击前：${describeConversationState(before)}（路径 ${urlPathOf(before.url)}）。点击后：${state ? describeConversationState(state) : '无法读取页面状态'}${state ? `（路径 ${urlPathOf(state.url)}）` : ''}。URL ${state && state.url !== before.url ? '已变化' : '未变化'}；会话标识 ${before.sessionKey || '无'}→${state ? (state.sessionKey || '无') : '未知'}。候选按钮：${String(target.label || '(无标签)').slice(0, 80)}（候选数 ${Array.isArray(before.candidates) ? before.candidates.length : 0}）。本轮未发送主题。${state && state.navError ? ` 导航兜底失败：${state.navError}；` : ''}${lastObserved ? ` 最后观察：${lastObserved}。` : ''}`);
  } finally {
    if (attached) await detach(debuggee);
  }
}

// 对话容器定位器（注入到页面执行的公共片段）。
// v0.8.5 的真实诊断显示：ChatGPT 页面上确实新增了用户消息，但基于 <main> 的 transcript
// 长度在 24 秒里始终是 1959→1959，用户消息节点新增 0，提示词尾部签名计数 0。也就是说
// 对话内容并不在 <main> 里，于是「发送确认」永远为假，安全重发又把同一条提示词再提交一次，
// 页面上就出现了多份相同内容。这里改为从消息节点反推最近公共祖先容器，找不到才退回 main / body。
// 计算对话文本前先把输入框子树标记出来，克隆后整段移除。
// 否则「刚写进编辑器的提示词」会被当成页面上的消息，让发送确认误判成功。
const TRANSCRIPT_COMPOSER_EXCLUDE = "if(composer){try{composer.setAttribute('data-duolab-exclude','1');}catch{}}";
const TRANSCRIPT_ROOT_HELPER = 'const transcriptRoot=()=>{return document.body;};const describeRootNode=r=>r===document.body?\'body\':(r&&r.tagName?r.tagName.toLowerCase()+(r.id?\'#\'+r.id:\'\'):\'none\');';

// DeepSeek in a background tab can keep the text in its composer while ignoring
// synthetic pointer/keyboard submission. Retry only when there is strong evidence
// the exact prompt is still unsent; never foreground-retry after a user message appears.
function shouldForegroundRetryDeepSeek(url, state) {
  const isDeepSeek = /deepseek/i.test(String(url || ''));
  return !!(
    isDeepSeek && state &&
    !state.submitted &&
    state.composerHasPrompt &&
    !state.generating &&
    !state.matchingNewUser &&
    Number(state.newUserCount || 0) === 0
  );
}

// Strong negative submission evidence. A small body/transcript length increase on DeepSeek
// can be unrelated UI text (for example, composer/status chrome). For DeepSeek, do not let
// that alone suppress the one-time safe retry when both prompt anchors, new-user evidence,
// and generation state are all absent. ChatGPT retains the stricter no-transcript-growth rule.
// ChatGPT can clear its composer before the newly submitted user turn is observable in the DOM.
// Foreground once and re-observe; this is read-only confirmation and never authorizes resend.
function shouldForegroundRecheckUnconfirmedSubmit(url, state) {
  if (/deepseek/i.test(String(url || '')) || !state || state.submitted) return false;
  return !state.composerHasPrompt && !state.matchingNewUser && !state.generating &&
    Number(state.newUserCount || 0) === 0 &&
    Number(state.prefixDelta || 0) === 0 && Number(state.markerDelta || 0) === 0;
}

function hasStrongNoSubmitEvidence(url, state) {
  if (!state || state.submitted || state.generating || state.composerHasPrompt || state.matchingNewUser) return false;
  if (Number(state.newUserCount || 0) !== 0 || Number(state.prefixDelta || 0) !== 0 || Number(state.markerDelta || 0) !== 0) return false;
  if (/deepseek/i.test(String(url || ''))) {
    const delta = Number(state.transcriptLength) - Number(state.priorTranscriptLength);
    // Ignore only small UI noise (the observed failure grew by 14 chars); a large or
    // unexplained transcript change is not strong enough evidence for automatic resend.
    return Number.isFinite(delta) && Math.abs(delta) <= 160;
  }
  return !state.transcriptGrew && Number(state.transcriptLength) === Number(state.priorTranscriptLength);
}

async function cdpSend(tabId, prompt) {
  const debuggee = { tabId };
  let attached = false;
  const safePrompt = String(prompt || '');
  const normalizedPrompt = safePrompt.replace(/\s+/g, ' ').trim();
  const promptSig = normalizedPrompt.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  // Legacy marker support remains for compatibility with older callers. v0.7.7 no longer
  // inserts model-visible transport markers; baseline-checked prompt signatures are used instead.
  const turnMarkerMatch = safePrompt.match(/DUOLABTURN[A-Z0-9]+/i);
  const turnMarker = turnMarkerMatch ? turnMarkerMatch[0] : '';
  const turnMarkerSig = turnMarker.toLowerCase();
  const promptPrefixSig = promptSig.slice(0, Math.min(56, promptSig.length));
  const markerSig = turnMarkerSig || promptSig.slice(-Math.min(72, promptSig.length));
  const marker = normalizedPrompt.slice(-Math.min(90, normalizedPrompt.length));
  try {
    // Run through the extension service worker without activating the tab.
    // This avoids stealing focus and allows a background relay to start even
    // when the target site's content-script task is throttled.
    const targetTab = await callChrome(chrome.tabs, 'get', tabId);
    if (!isSupportedAiUrl(targetTab?.url)) throw new Error('目标标签页不是受支持的 ChatGPT/DeepSeek HTTPS 页面。');
    await attach(debuggee);
    attached = true;

    // Pick a visible composer on the actual destination site. DeepSeek's current
    // web UI can use #chat-input / a contenteditable editor, so don't assume only
    // generic textarea selectors.
    const found = await cdp(debuggee, 'Runtime.evaluate', {
      expression: `(() => {
        const visible = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
        const deepseek = location.hostname.toLowerCase().includes('deepseek');
        const selectors = deepseek
          ? ['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea[placeholder*="DeepSeek"]','textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]','main [contenteditable="true"]']
          : ['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[data-testid="composer-text-input"]','main form [contenteditable="true"][role="textbox"]','main textarea','main [contenteditable="true"][role="textbox"]'];
        let composer = null;
        for (const selector of selectors) {
          const matches = [...document.querySelectorAll(selector)].filter(visible);
          if (matches.length) { composer = matches[matches.length - 1]; break; }
        }
        if (!composer) return {ok:false,error:'找不到输入框'};
        const value = e => ('value' in e ? e.value : (e.innerText || e.textContent || ''));
        ${TRANSCRIPT_ROOT_HELPER}
        const root = transcriptRoot();
        ${TRANSCRIPT_COMPOSER_EXCLUDE}
        const clone = root.cloneNode(true);
        clone.querySelectorAll('textarea,input,select,form,[contenteditable="true"],[role="textbox"],[data-duolab-exclude],nav,aside,header,footer,[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"]').forEach(e => e.remove());
        if (composer) { try { composer.removeAttribute('data-duolab-exclude'); } catch {} }
        const text = String(clone.innerText || clone.textContent || '').replace(/\\s+/g,' ').trim();
        const sigOfText = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const textSig = sigOfText(text);
        const markSig = ${JSON.stringify(markerSig)};
        const prefixSig = ${JSON.stringify(promptPrefixSig)};
        const countOccurrences = (haystack, needle) => { if (!needle) return 0; let count=0, at=0; while ((at=haystack.indexOf(needle, at)) !== -1) { count++; at += Math.max(1, needle.length); } return count; };
        const priorMarkerCount = countOccurrences(textSig, markSig);
        const priorPrefixCount = countOccurrences(textSig, prefixSig);
        const scope = root;
        const priorUsers = [...scope.querySelectorAll('[data-message-author-role=\"user\"],[data-testid=\"user-message\"]')].filter(e => String(e.innerText || e.textContent || '').trim()).length;
        const genSelectors = ['button[data-testid=\"stop-button\"]','[data-testid*=\"stop-button\"]','button[aria-label*=\"Stop generating\" i]','[aria-label*=\"停止生成\"]','[title*=\"停止生成\"]'];
        const beforeGenerating = genSelectors.some(selector => { try { return [...document.querySelectorAll(selector)].some(visible); } catch { return false; } });
        const tiers = deepseek
          ? [['.ds-markdown'], ['[class*="markdown"]'], ['[data-message-author-role="assistant"]'], ['[data-testid*="assistant"]','[class*="assistant-message"]','[class*="answer-content"]','[data-testid*="message-content"]','[class*="message-content"]'], ['[class*="prose"]'], ['[class*="agent-turn"]'], ['[data-testid*="conversation-turn"] [class*="text-base"]'], ['[data-message-id]']]
          : [['[data-message-author-role="assistant"]'], ['[data-testid*="assistant"]','[class*="assistant-message"]','[class*="answer-content"]','[data-testid*="message-content"]','[class*="message-content"]'], ['[class*="markdown"]'], ['[class*="prose"]'], ['[class*="agent-turn"]'], ['[data-testid*="conversation-turn"] [class*="text-base"]'], ['[data-message-id]']];
        let assistantNodes = [];
        for (const tier of tiers) {
          const foundNodes = new Set();
          for (const selector of tier) for (const node of scope.querySelectorAll(selector)) {
            if (!visible(node) || node.closest('form,textarea,[contenteditable=\\"true\\"]') || node.querySelector('textarea,[contenteditable=\\"true\\"]')) continue;
            if (String(node.innerText || node.textContent || '').trim()) foundNodes.add(node);
          }
          if (foundNodes.size) {
            const all = [...foundNodes];
            assistantNodes = all.filter(node => !all.some(other => other !== node && other.contains(node)));
            break;
          }
        }
        const assistantTexts = assistantNodes.map(node => String(node.innerText || node.textContent || '').trim()).filter(Boolean);
        composer.focus();
        return {ok:true, tag:composer.tagName, editable:!!composer.isContentEditable, priorMarkerCount, priorPrefixCount, priorUserCount:priorUsers, priorRoot:describeRootNode(root),priorBodyLength:String(document.body.innerText||document.body.textContent||'').length, priorTranscriptLength:text.length, beforeSig:textSig, beforeGenerating, beforeText:assistantTexts.length ? assistantTexts[assistantTexts.length-1] : '', beforeAssistantTexts:assistantTexts.slice(-40).map(value => String(value || '').slice(-12000)).filter(Boolean), valueLength:String(value(composer)).length};
      })()`,
      returnByValue: true,
      awaitPromise: true
    });
    const info = found?.result?.value;
    if (!info?.ok) throw new Error(info?.error || '无法定位输入框');
    if (info.beforeGenerating) {
      throw new Error('目标网页仍显示上一条回答正在生成；已阻止写入新提示词，避免把上一轮回答误当成本轮结果。请等待网页真正结束后重试。');
    }

    // Use browser input events so the site's controlled editor receives the text.
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 });
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft' });
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await sleep(120);

    const inspectInputExpr = `(() => {
      const visible=e=>!!e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
      const deepseek=location.hostname.toLowerCase().includes('deepseek');
      const selectors=deepseek?['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]','main [contenteditable="true"]']:['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[data-testid="composer-text-input"]','main form [contenteditable="true"][role="textbox"]','main textarea','main [contenteditable="true"][role="textbox"]'];
      for(const selector of selectors){const a=[...document.querySelectorAll(selector)].filter(visible);if(a.length){const e=a[a.length-1];const raw=String(('value' in e?e.value:(e.innerText||e.textContent||'')));const v=raw.replace(/[\\p{White_Space}\\p{Default_Ignorable_Code_Point}\\p{Cf}\\u2800\\u115F\\u1160\\u3164\\uFFA0]/gu,' ').replace(/\\s+/g,' ').trim();const sig=v.toLowerCase().replace(/[^\\p{L}\\p{N}]/gu,'');const meaningfulLength=raw.replace(/[\\p{White_Space}\\p{Default_Ignorable_Code_Point}\\p{Cf}\\u2800\\u115F\\u1160\\u3164\\uFFA0]/gu,'').length;const points=raw.length<=8?[...raw].map(ch=>'U+'+ch.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')):[];return {length:raw.length,meaningfulLength,sig,start:v.slice(0,60),end:v.slice(-90),tag:e.tagName,contenteditable:!!e.isContentEditable,placeholder:e.getAttribute('placeholder')||'',id:e.id||'',testid:e.getAttribute('data-testid')||'',codePoints:points};}}
      return {length:0,start:'',end:'',tag:'none'};
    })()`;
    const readComposerAfterClear = async () => {
      const result = await cdp(debuggee, 'Runtime.evaluate', { expression: inspectInputExpr, returnByValue: true });
      return result?.result?.value || null;
    };
    let clearedInput = await readComposerAfterClear();
    const meaningfulFromStart = value => Number(value?.meaningfulLength ?? String(value?.start || '').replace(/[\s\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/g, '').length);
    if (!clearedInput || clearedInput.tag === 'none' || meaningfulFromStart(clearedInput) > 0) {
      // Retry the same provider-specific native setter + keyboard fallback before inserting
      // the next prompt. This ensures an old draft/stray character cannot prefix the new task.
      const providerKey = String(targetTab.url || '').toLowerCase().includes('deepseek') ? 'deepseek' : 'chatgpt';
      await cdpClearComposer(debuggee, providerKey);
      await sleep(160);
      clearedInput = await readComposerAfterClear();
    }
    if (!clearedInput || clearedInput.tag === 'none' || meaningfulFromStart(clearedInput) > 0) {
      throw new Error(`输入框清空确认失败：原始字符=${clearedInput?.length ?? '未知'}，有效字符=${clearedInput?.meaningfulLength ?? '未知'}，码点=${(clearedInput?.codePoints||[]).join(',')||'未记录'}，控件=${clearedInput?.tag||'未知'}#${clearedInput?.id||''}[${clearedInput?.testid||''}]；旧草稿已备份，未插入或发送新提示词。`);
    }

    await cdp(debuggee, 'Input.insertText', { text: safePrompt });
    await sleep(500);
    const inspectTyped = async () => {
      const response = await cdp(debuggee, 'Runtime.evaluate', { expression: inspectInputExpr, returnByValue: true });
      return response?.result?.value || null;
    };
    let typed = await inspectTyped();
    // Compare the full normalized signature, not only the first 12 characters.
    if (!typed || typed.sig !== promptSig) {
      await cdpClearComposer(debuggee, String(targetTab.url || '').toLowerCase().includes('deepseek') ? 'deepseek' : 'chatgpt').catch(() => null);
      await sleep(150);
      const clearedAgain = await inspectTyped();
      if (!clearedAgain || Number(clearedAgain.meaningfulLength || 0) > 0) {
        throw new Error(`输入校验失败且无法重新清空：控件=${typed?.tag||'未知'}#${typed?.id||''}[${typed?.testid||''}]；原始字符=${typed?.length??'未知'}，有效字符=${typed?.meaningfulLength??'未知'}，码点=${(typed?.codePoints||[]).join(',')||'未记录'}；未点击发送。`);
      }
      await cdp(debuggee, 'Input.insertText', { text: safePrompt });
      await sleep(400);
      typed = await inspectTyped();
    }
    if (!typed || typed.sig !== promptSig) {
      throw new Error(`输入校验失败：完整提示词签名不匹配，预期长度=${promptSig.length}，实际长度=${typed?.sig?.length??'未知'}；控件=${typed?.tag||'未知'}#${typed?.id||''}[${typed?.testid||''}]；有效字符=${typed?.meaningfulLength??'未知'}；码点=${(typed?.codePoints||[]).join(',')||'未记录'}；已取消发送。`);
    }

    // Find the site's real send control. DeepSeek often uses div[role=button]
    // / .ds-icon-button rather than a <button aria-label="Send" />.
    const locateSendExpr = `(() => {
      const visible=e=>!!e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
      const disabled=e=>!!e.disabled||e.getAttribute('aria-disabled')==='true'||e.getAttribute('disabled')!==null;
      const deepseek=location.hostname.toLowerCase().includes('deepseek');
      const selectors=deepseek?['[data-testid="send-button"]','[data-test-id="send-button"]','button[aria-label*="发送"]','[role="button"][aria-label*="发送"]','button[aria-label*="Send" i]','[role="button"][aria-label*="send" i]','button[type="submit"]','.ds-icon-button','.ds-button--circle','.ds-button']:['#composer-submit-button','button[data-testid="send-button"]','button[aria-label*="Send" i]','button[aria-label*="发送"]','button[type="submit"]'];
      const composerSelectors=deepseek?['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]','main [contenteditable="true"]']:['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[data-testid="composer-text-input"]','main form [contenteditable="true"][role="textbox"]','main textarea','main [contenteditable="true"][role="textbox"]'];
      let composer=null;
      for(const selector of composerSelectors){const a=[...document.querySelectorAll(selector)].filter(visible);if(a.length){composer=a[a.length-1];break;}}
      if(!composer)return {ok:false,reason:'找不到当前输入框'};
      const er=composer.getBoundingClientRect();
      const label=e=>[e.getAttribute('aria-label'),e.getAttribute('title'),e.getAttribute('data-testid'),e.getAttribute('data-test-id'),typeof e.className==='string'?e.className:'',e.innerText,e.textContent].filter(Boolean).join(' ').toLowerCase();
      const bad=/stop|停止|cancel|中止|上传|附件|attach|upload|search|搜索|设置|setting|模型|model|联网|深度思考/;
      const roots=[];let ancestor=composer;
      for(let i=0;ancestor&&i<9;i++,ancestor=ancestor.parentElement)roots.push({node:ancestor,depth:i});
      roots.push({node:document,depth:10});
      const candidates=new Map();
      for(const root of roots){
        let nodes=[];try{nodes=root.node.querySelectorAll('button,[role="button"],.ds-icon-button,.ds-button,[data-testid*="send"],[data-test-id*="send"]');}catch{}
        for(const e of nodes){if(!visible(e)||disabled(e))continue;const t=label(e);if(bad.test(t))continue;if(!candidates.has(e))candidates.set(e,root.depth);}
      }
      const ranked=[];
      for(const [e,depth] of candidates){const r=e.getBoundingClientRect();const t=label(e);let score=0;
        if(/send|发送|提交/.test(t))score+=220;
        if(/data-testid.{0,20}send|data-test-id.{0,20}send/.test(t))score+=180;
        if(e.classList?.contains('ds-icon-button'))score+=85;
        if(e.classList?.contains('ds-button--primary')&&e.classList?.contains('ds-button--filled')&&e.classList?.contains('ds-button--circle'))score+=155;
        if(e.classList?.contains('ds-button--circle'))score+=60;
        if(e.matches('button,[role="button"]'))score+=20;
        if(r.width>=18&&r.width<=90&&r.height>=18&&r.height<=90)score+=35;
        if(r.left+r.width/2>er.left+er.width*0.45)score+=40;
        if(r.top+r.height/2>=er.top-40&&r.top+r.height/2<=er.bottom+110)score+=35;
        score+=Math.max(0,35-depth*4);
        if(r.width<1||r.height<1)score-=100;
        ranked.push({e,score,r,t,depth});
      }
      ranked.sort((a,b)=>b.score-a.score);
      const best=ranked[0];
      if(!best||best.score<70)return {ok:false,reason:'没有找到可信的发送按钮',candidates:ranked.slice(0,5).map(x=>({label:x.t.slice(0,70),score:x.score,depth:x.depth}))};
      return {ok:true,x:best.r.left+best.r.width/2,y:best.r.top+best.r.height/2,label:best.t.slice(0,90),score:best.score,depth:best.depth};
    })()`;

    const sendButton = await cdp(debuggee, 'Runtime.evaluate', { expression: locateSendExpr, returnByValue: true });
    const target = sendButton?.result?.value;
    let method = 'DeepSeek/网页发送按钮';
    if (target?.ok) {
      // A CDP mouse event reaches the element as an actual browser pointer input;
      // this is more reliable for controls that don't respond to HTMLElement.click().
      await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
      await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
      await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
      method = `发送按钮真实鼠标点击（${target.label || '已定位按钮'}）`;
    } else {
      method = `未识别到发送按钮（${target?.reason || '未知原因'}），改试表单/Enter`;
    }

    const readSubmitState = async () => {
      const expr = `(() => {
        const norm=s=>String(s||'').replace(/\\s+/g,' ').trim();
        const sigOfText=value=>String(value||'').toLowerCase().replace(/[^\\p{L}\\p{N}]/gu,'');
        const countOccurrences=(haystack,needle)=>{if(!needle)return 0;let count=0,at=0;while((at=haystack.indexOf(needle,at))!==-1){count++;at+=Math.max(1,needle.length);}return count;};
        const visible=e=>!!e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
        const deepseek=location.hostname.toLowerCase().includes('deepseek');
        const selectors=deepseek?['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]','main [contenteditable="true"]']:['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[data-testid="composer-text-input"]','main textarea','main [contenteditable="true"][role="textbox"]'];
        let composer=null;for(const selector of selectors){const a=[...document.querySelectorAll(selector)].filter(visible);if(a.length){composer=a[a.length-1];break;}}
      const val = composer ? String(('value' in composer) ? composer.value : (composer.innerText || composer.textContent || '')) : '';
        const valSig=sigOfText(val);
        ${TRANSCRIPT_ROOT_HELPER}
        const root=transcriptRoot();
        ${TRANSCRIPT_COMPOSER_EXCLUDE}
        const clone=root.cloneNode(true);clone.querySelectorAll('textarea,input,select,form,[contenteditable="true"],[role="textbox"],[data-duolab-exclude],nav,aside,header,footer,[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"]').forEach(e=>e.remove());
        if(composer){try{composer.removeAttribute('data-duolab-exclude');}catch{}}
        const transcript=norm(clone.innerText||clone.textContent||'');
        const transcriptSig=sigOfText(transcript);
        const transcriptLength=transcript.length;
        const priorTranscriptLength=${Number(info.priorTranscriptLength)||0};
        const markSig=${JSON.stringify(markerSig)};
        const prefixSig=${JSON.stringify(promptPrefixSig)};
        const promptSig=${JSON.stringify(promptSig)};
        const turnMarkerSig=${JSON.stringify(turnMarkerSig)};
        const priorMarkerCount=${Number(info.priorMarkerCount)||0};
        const priorPrefixCount=${Number(info.priorPrefixCount)||0};
        const priorUserCount=${Number(info.priorUserCount)||0};
        const users=[...root.querySelectorAll('[data-message-author-role="user"],[data-testid="user-message"]')].map(e=>norm(e.textContent||e.innerText)).filter(Boolean);
        const newUsers=users.slice(priorUserCount);
        const matchingNewUser=newUsers.some(t=>{const sig=sigOfText(t);return (turnMarkerSig&&sig.includes(turnMarkerSig))||(prefixSig.length>=20&&sig.includes(prefixSig))||(!turnMarkerSig&&((markSig.length>=18&&sig.includes(markSig))||(promptSig.length<18&&sig.includes(promptSig))));});
        const markerCount=countOccurrences(transcriptSig,markSig);
        const prefixCount=countOccurrences(transcriptSig,prefixSig);
        const freshMarker=!!turnMarkerSig&&markSig.length>=12&&markerCount>priorMarkerCount;
        const freshSuffix=!turnMarkerSig&&markSig.length>=12&&markerCount>priorMarkerCount;
        const freshPrefix=prefixSig.length>=20&&prefixCount>priorPrefixCount;
        const genSelectors=['button[data-testid="stop-button"]','[data-testid*="stop-button"]','button[aria-label*="Stop generating" i]','[aria-label*="Stop generating" i]','[aria-label*="停止生成"]','[title*="停止生成"]'];
        const generating=genSelectors.some(selector=>{try{return [...document.querySelectorAll(selector)].some(visible);}catch{return false;}});
        const transcriptGrew=transcriptLength>priorTranscriptLength+12;
        // Count meaningful editor characters separately from raw DOM characters:
        // React/contenteditable editors can retain a single newline/zero-width placeholder.
        const composerMeaningfulLength=val.replace(/[\\p{White_Space}\\p{Default_Ignorable_Code_Point}\\p{Cf}\\u2800\\u115F\\u1160\\u3164\\uFFA0]/gu,'').length;
        const composerClearedAfterVerifiedInput=composerMeaningfulLength===0&&${safePrompt.length}>0;
        const composerHasPrompt=turnMarkerSig ? (valSig.includes(turnMarkerSig)||(prefixSig.length>=20&&valSig.includes(prefixSig))) : ((prefixSig.length>=12&&valSig.includes(prefixSig))||(markSig.length>=18&&valSig.includes(markSig))||(promptSig.length<18&&valSig.includes(promptSig)));
        // Strong fallback: both the beginning and ending anchors of the exact current
        // prompt appeared in the transcript after the pre-send baseline. This remains
        // valid even if SPA navigation keeps transcript length constant or the editor
        // retains one non-meaningful placeholder character. Do not rely on length growth.
        const dualAnchorConfirmed=!turnMarkerSig&&freshPrefix&&freshSuffix&&composerClearedAfterVerifiedInput;
        const markerDelta=markerCount-priorMarkerCount;
        const prefixDelta=prefixCount-priorPrefixCount;
        const freshPromptConfirmed=freshMarker||matchingNewUser||dualAnchorConfirmed||(freshPrefix&&composerClearedAfterVerifiedInput)||(freshSuffix&&composerClearedAfterVerifiedInput&&transcriptGrew);
        const submitted=freshPromptConfirmed;
        const composerCodePoints=val.length<=8?[...val].map(ch=>'U+'+ch.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')):[];
        return {submitted,freshPromptConfirmed,matchingNewUser,dualAnchorConfirmed,composerClearedAfterVerifiedInput,composerMeaningfulLength,transcriptGrew,transcriptLength,priorTranscriptLength,generating,composerLength:val.length,composerCodePoints,composerHasPrompt,composerNonEmpty:!!val,composerTag:composer?.tagName||'none',composerId:composer?.id||'',composerTestId:composer?.getAttribute('data-testid')||'',composerPlaceholder:composer?.getAttribute('placeholder')||'',markerCount,prefixCount,priorMarkerCount,priorPrefixCount,markerDelta,prefixDelta,freshMarker,freshSuffix,freshPrefix,userCount:users.length,newUserCount:newUsers.length,buttonCount:document.querySelectorAll('button,[role="button"],.ds-icon-button,.ds-button').length,rootLabel:describeRootNode(root),bodyLength:String(document.body.innerText||document.body.textContent||'').length};
      })()`;
      const r=await cdp(debuggee,'Runtime.evaluate',{expression:expr,returnByValue:true});
      return r?.result?.value||{};
    };

    async function waitForSubmitEvidence(ms = 6500) {
      const deadline = Date.now() + ms;
      let current = await readSubmitState();
      while (Date.now() < deadline && !current.submitted) {
        await sleep(250);
        current = await readSubmitState();
      }
      return current;
    }

    await sleep(target?.ok ? 500 : 250);
    let state = await waitForSubmitEvidence(6500);

    // Retry via the site's form only while the prompt is still confirmed in the composer.
    if (!state.submitted && state.composerHasPrompt && !state.generating) {
      const formResult = await cdp(debuggee, 'Runtime.evaluate', {
        expression: `(() => {const deepseek=location.hostname.toLowerCase().includes('deepseek');const selectors=deepseek?['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]','main [contenteditable="true"]']:['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[data-testid="composer-text-input"]','main textarea','main [contenteditable="true"][role="textbox"]'];let e=null;for(const s of selectors){const a=[...document.querySelectorAll(s)].filter(x=>!!(x.offsetWidth||x.offsetHeight||x.getClientRects().length));if(a.length){e=a[a.length-1];break;}}const f=e?.closest('form');if(f&&typeof f.requestSubmit==='function'){f.requestSubmit();return {called:true};}return {called:false};})()`,
        returnByValue: true
      });
      if (formResult?.result?.value?.called) method += '；尝试 form.requestSubmit';
      state = await waitForSubmitEvidence(4200);
    }

    // Enter fallback only when the same prompt is still visibly unsent in the composer.
    if (!state.submitted && state.composerHasPrompt && !state.generating) {
      method += '；尝试 Enter';
      await cdp(debuggee, 'Runtime.evaluate', { expression: `(() => {const deepseek=location.hostname.toLowerCase().includes('deepseek');const selectors=deepseek?['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]','main [contenteditable="true"]']:['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[data-testid="composer-text-input"]','main textarea','main [contenteditable="true"][role="textbox"]'];for(const s of selectors){const a=[...document.querySelectorAll(s)].filter(e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length));if(a.length){a[a.length-1].focus();return true;}}return false;})()`, returnByValue: true });
      await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      state = await waitForSubmitEvidence(4200);
    }


    // DeepSeek-specific foreground retry. The previous attempts can populate the
    // textarea successfully but fail to activate the site's submit handler while its
    // tab is in the background. Only do this after the prompt is still in the editor,
    // no new user message exists, and generation has not started.
    let deepseekRetryAttempted = false;
    let deepseekTabActivated = false;
    if (shouldForegroundRetryDeepSeek(targetTab.url, state)) {
      deepseekRetryAttempted = true;
      try {
        const liveTab = await callChrome(chrome.tabs, 'get', tabId);
        if (!liveTab?.active) {
          await callChrome(chrome.tabs, 'update', tabId, { active: true });
          deepseekTabActivated = true;
          method += '；DeepSeek 后台提交未生效，已激活目标标签页重试';
          await sleep(500);
        } else {
          method += '；DeepSeek 前台提交重试';
        }

        state = await readSubmitState();
        if (shouldForegroundRetryDeepSeek(targetTab.url, state)) {
          const refreshedButton = await cdp(debuggee, 'Runtime.evaluate', { expression: locateSendExpr, returnByValue: true });
          const refreshedTarget = refreshedButton?.result?.value;
          if (refreshedTarget?.ok) {
            await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: refreshedTarget.x, y: refreshedTarget.y });
            await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: refreshedTarget.x, y: refreshedTarget.y, button: 'left', clickCount: 1 });
            await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: refreshedTarget.x, y: refreshedTarget.y, button: 'left', clickCount: 1 });
            method += '；激活后重新定位并点击发送按钮';
            state = await waitForSubmitEvidence(5500);
          }
        }

        // If a trusted pointer click still did not submit, call click() only on the
        // strongly-scoped primary filled circle button associated with this composer.
        // Re-check state immediately before this fallback to avoid duplicate sends.
        if (shouldForegroundRetryDeepSeek(targetTab.url, state)) {
          const directClick = await cdp(debuggee, 'Runtime.evaluate', {
            expression: `(() => {
              const visible=e=>!!e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
              const disabled=e=>!!e.disabled||e.getAttribute('aria-disabled')==='true'||e.hasAttribute('disabled');
              const ss=['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]','main [contenteditable="true"]'];
              let composer=null;for(const s of ss){const a=[...document.querySelectorAll(s)].filter(visible);if(a.length){composer=a[a.length-1];break;}}
              if(!composer)return {ok:false,reason:'composer-missing'};
              const cr=composer.getBoundingClientRect();let candidates=[];let root=composer;
              for(let depth=0;root&&depth<9;depth++,root=root.parentElement){
                for(const e of root.querySelectorAll('button.ds-button--primary.ds-button--filled.ds-button--circle,[role="button"].ds-button--primary.ds-button--filled.ds-button--circle')){
                  if(!visible(e)||disabled(e))continue;const r=e.getBoundingClientRect();
                  const nearX=r.left+r.width/2>=cr.left+cr.width*0.35&&r.left+r.width/2<=cr.right+80;
                  const nearY=r.top+r.height/2>=cr.top-40&&r.top+r.height/2<=cr.bottom+140;
                  if(!nearX||!nearY)continue;
                  candidates.push({e,r,depth,score:(r.left+r.width/2-cr.left)+Math.max(0,50-depth*5)-Math.abs((r.top+r.height/2)-(cr.bottom+20))});
                }
              }
              candidates.sort((a,b)=>b.score-a.score);const best=candidates[0];
              if(!best)return {ok:false,reason:'primary-circle-submit-not-found'};
              best.e.click();return {ok:true,tag:best.e.tagName,classes:String(best.e.className||'').slice(0,120),score:best.score};
            })()`,
            returnByValue: true
          });
          const directInfo = directClick?.result?.value;
          if (directInfo?.ok) {
            method += `；DeepSeek 关联主发送按钮 DOM click（${directInfo.tag} ${directInfo.classes}）`;
            state = await waitForSubmitEvidence(4500);
          } else {
            method += `；DeepSeek DOM click 未执行（${directInfo?.reason || 'unknown'}）`;
          }
        }

        // One final focused Enter path. Use keyDown/ keyUp because textarea handlers
        // generally bind keydown; preserve the prompt and do not retry if state changed.
        if (shouldForegroundRetryDeepSeek(targetTab.url, state)) {
          await cdp(debuggee, 'Runtime.evaluate', {
            expression: `(() => {const ss=['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]','main [contenteditable="true"]'];for(const s of ss){const a=[...document.querySelectorAll(s)].filter(e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length));if(a.length){a[a.length-1].focus();return true;}}return false;})()`,
            returnByValue: true
          });
          await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
          await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
          method += '；激活后的 keyDown/Enter 最终重试';
          state = await waitForSubmitEvidence(5000);
        }
      } catch (retryError) {
        method += `；DeepSeek 前台重试异常：${String(retryError?.message || retryError).slice(0, 180)}`;
      }
    }

    let foregroundRecheckAttempted = false;
    let foregroundTabActivated = false;
    // ChatGPT may clear the composer before the new user message becomes observable.
    // Activate and re-read once before deciding whether the state is safe to retry.
    // Ambiguous state remains a hard stop; no blind resend is permitted.
    if (shouldForegroundRecheckUnconfirmedSubmit(targetTab.url, state)) {
      foregroundRecheckAttempted = true;
      try {
        const liveTab = await callChrome(chrome.tabs, 'get', tabId);
        if (!liveTab?.active) {
          await callChrome(chrome.tabs, 'update', tabId, { active: true });
          foregroundTabActivated = true;
          method += '；ChatGPT 输入框已清空但未见本轮消息，已激活标签页复核';
          await sleep(450);
        } else {
          method += '；ChatGPT 输入框已清空但未见本轮消息，已在前台复核';
        }
        const foregroundObserved = await waitForSubmitEvidence(3500);
        state = foregroundObserved.submitted ? foregroundObserved : await readSubmitState();
        if (state.submitted) method += '；ChatGPT 前台复核确认本轮消息已提交';
        else if (!hasStrongNoSubmitEvidence(targetTab.url, state)) {
          method += '；ChatGPT 前台复核后状态仍不明确，禁止安全重发';
        }
      } catch (reconcileError) {
        method += `；ChatGPT 前台复核失败，禁止安全重发：${String(reconcileError?.message || reconcileError).slice(0, 160)}`;
      }
    }

    let safeResendAttempted = false;
    if (!state.submitted && hasStrongNoSubmitEvidence(targetTab.url, state)) {
      // Let a late-rendering user message or generation indicator surface before considering retry.
      await sleep(650);
      let settledState = await readSubmitState();
      state = settledState;
      if (hasStrongNoSubmitEvidence(targetTab.url, settledState)) {
        const isDeepSeekTarget = /deepseek/i.test(String(targetTab.url || ''));
        let foregroundRecheckAllowed = true;
        if (isDeepSeekTarget) {
          // The known failure pattern is an empty DeepSeek composer in a background tab,
          // with no prompt anchors. Activate the tab and observe again before re-entering
          // anything; if state becomes ambiguous, never resend.
          deepseekRetryAttempted = true;
          try {
            const liveTab = await callChrome(chrome.tabs, 'get', tabId);
            if (!liveTab?.active) {
              await callChrome(chrome.tabs, 'update', tabId, { active: true });
              deepseekTabActivated = true;
              method += '；输入框已清空但未见提交证据，已激活 DeepSeek 标签页复核';
              await sleep(450);
            } else {
              method += '；输入框已清空但未见提交证据，已在前台复核';
            }
            const foregroundObserved = await waitForSubmitEvidence(3000);
            settledState = foregroundObserved.submitted ? foregroundObserved : await readSubmitState();
            state = settledState;
            if (settledState.submitted) method += '；前台复核确认本轮消息已提交';
            else if (!hasStrongNoSubmitEvidence(targetTab.url, settledState)) {
              foregroundRecheckAllowed = false;
              method += '；前台复核后状态发生变化，结果仍不明确，禁止安全重发';
            }
          } catch (reconcileError) {
            foregroundRecheckAllowed = false;
            method += `；DeepSeek 前台复核失败，禁止安全重发：${String(reconcileError?.message || reconcileError).slice(0, 160)}`;
          }
        }

        if (settledState.submitted) {
          state = settledState;
        } else if (foregroundRecheckAllowed && hasStrongNoSubmitEvidence(targetTab.url, settledState)) {
          safeResendAttempted = true;
          method += isDeepSeekTarget
            ? '；两次无提交证据且前台复核后，安全重新输入并提交一次'
            : '；连续两次确认没有本轮消息，安全重新输入并提交一次';
          const providerKey = String(targetTab.url || '').toLowerCase().includes('deepseek') ? 'deepseek' : 'chatgpt';
          await cdpClearComposer(debuggee, providerKey);
          await sleep(180);
          let retryInputResp = await cdp(debuggee, 'Runtime.evaluate', { expression: inspectInputExpr, returnByValue: true });
          let retryTyped = retryInputResp?.result?.value || null;
          if (!retryTyped || Number(retryTyped.meaningfulLength ?? 0) > 0) {
            throw new Error(`安全重试前无法清空输入框：有效字符=${retryTyped?.meaningfulLength ?? '未知'}；原始字符=${retryTyped?.length ?? '未知'}；码点=${(retryTyped?.codePoints||[]).join(',')||'未记录'}；控件=${retryTyped?.tag||'未知'}#${retryTyped?.id||''}[${retryTyped?.testid||''}]。未重发。`);
          }
          await cdp(debuggee, 'Input.insertText', { text: safePrompt });
          await sleep(450);
          retryInputResp = await cdp(debuggee, 'Runtime.evaluate', { expression: inspectInputExpr, returnByValue: true });
          retryTyped = retryInputResp?.result?.value || null;
          if (!retryTyped || retryTyped.sig !== promptSig) {
            throw new Error(`安全重试输入校验失败：预期签名长度=${promptSig.length}，实际=${retryTyped?.sig?.length ?? '未知'}；控件=${retryTyped?.tag||'未知'}#${retryTyped?.id||''}[${retryTyped?.testid||''}]；有效字符=${retryTyped?.meaningfulLength ?? '未知'}；码点=${(retryTyped?.codePoints||[]).join(',')||'未记录'}。未点击发送。`);
          }
          const secondButton = await cdp(debuggee, 'Runtime.evaluate', { expression: locateSendExpr, returnByValue: true });
          const secondTarget = secondButton?.result?.value;
          if (secondTarget?.ok) {
            await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: secondTarget.x, y: secondTarget.y });
            await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: secondTarget.x, y: secondTarget.y, button: 'left', clickCount: 1 });
            await cdp(debuggee, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: secondTarget.x, y: secondTarget.y, button: 'left', clickCount: 1 });
            method += '；二次点击发送按钮';
          } else {
            const formResult = await cdp(debuggee, 'Runtime.evaluate', { expression: `(() => {const deepseek=location.hostname.toLowerCase().includes('deepseek');const ss=deepseek?['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]','main [contenteditable="true"]']:['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[data-testid="composer-text-input"]','main form [contenteditable="true"][role="textbox"]','main textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]'];let e=null;for(const q of ss){const a=[...document.querySelectorAll(q)].filter(x=>!!(x.offsetWidth||x.offsetHeight||x.getClientRects().length));if(a.length){e=a[a.length-1];break;}}const f=e?.closest('form');if(f&&typeof f.requestSubmit==='function'){f.requestSubmit();return true;}return false;})()`, returnByValue: true });
            if (!formResult?.result?.value) throw new Error('安全重试找不到发送按钮或可提交的表单；未宣称发送成功。');
            method += '；表单提交重试';
          }
          state = await waitForSubmitEvidence(8500);
          if (!state.submitted && state.composerHasPrompt && !state.generating &&
              !state.matchingNewUser && Number(state.newUserCount || 0) === 0 &&
              Number(state.prefixDelta || 0) === 0 && Number(state.markerDelta || 0) === 0) {
            method += '；最后尝试 Enter（复核仍无消息证据）';
            await cdp(debuggee, 'Runtime.evaluate', { expression: `(() => {const deepseek=location.hostname.toLowerCase().includes('deepseek');const ss=deepseek?['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]','main [contenteditable="true"]']:['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[data-testid="composer-text-input"]','main form [contenteditable="true"][role="textbox"]','main textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]'];for(const q of ss){const a=[...document.querySelectorAll(q)].filter(x=>!!(x.offsetWidth||x.offsetHeight||x.getClientRects().length));if(a.length){a[a.length-1].focus();return true;}}return false;})()`, returnByValue: true });
            await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
            await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
            await cdp(debuggee, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
            state = await waitForSubmitEvidence(4200);
          }
        } else {
          state = settledState;
        }
      }
    }

    if (!state.submitted) {
      const reason = state.composerHasPrompt
        ? '提示词仍留在输入框中，页面未确认出现本轮用户消息；已阻止读取旧回答。'
        : '输入框内容已变化或清空，但页面未确认出现本轮用户消息；为避免把旧回答当成本轮结果或重复发送，已停止。';
      throw new Error(`后台发送未获本轮消息确认：${reason} 按钮识别：${target?.ok ? target.label : (target?.reason || '未找到')}；输入框原始字符=${state.composerLength}，有效字符=${state.composerMeaningfulLength ?? '未知'}，码点=${(state.composerCodePoints||[]).join(',')||'未记录'}，控件=${state.composerTag||'未知'}#${state.composerId||''}[${state.composerTestId||''}]，placeholder=${String(state.composerPlaceholder||'').slice(0,60)}；对话容器=${state.rootLabel||'未知'}；页面 body 文本=${state.bodyLength??'未知'}（发送前 ${state.priorTranscriptLength??'未知'}）；新用户消息节点匹配=${state.matchingNewUser ? '是' : '否'}（新增节点=${state.newUserCount??'未知'}）；页面文本增长=${state.transcriptGrew ? '是' : '否'}；页面文本长度=${state.transcriptLength}/${state.priorTranscriptLength}；本轮提示词确认=${state.freshPromptConfirmed ? '是' : '否'}；前缀总数/基线/新增=${Number(state.prefixCount)||0}/${Number(state.priorPrefixCount)||0}/${Number(state.prefixDelta)||0}；${turnMarkerSig ? `唯一标记总数/基线/新增=${Number(state.markerCount)||0}/${Number(state.priorMarkerCount)||0}/${Number(state.markerDelta)||0}` : `尾部签名总数/基线/新增=${Number(state.markerCount)||0}/${Number(state.priorMarkerCount)||0}/${Number(state.markerDelta)||0}`}；前后锚点同时新增=${state.dualAnchorConfirmed ? '是' : '否'}；生成中=${state.generating ? '是' : '否'}；安全重新发送已尝试=${safeResendAttempted?'是':'否'}；DeepSeek 专项重试=${deepseekRetryAttempted?'是':'否'}；目标标签页已激活=${deepseekTabActivated?'是':'否'}；方法=${method}。`);
    }

    const evidenceKind = turnMarkerSig && state.freshMarker
      ? 'unique-turn-marker-confirmed'
      : state.matchingNewUser ? 'new-user-message-confirmed'
      : 'new-prompt-anchor-confirmed';
    // 把证据数值写进成功日志：误判（前端文本命中但页面其实没新增消息）必须可追溯。
    const evidence = `${evidenceKind}；前缀基线/新增=${Number(state.priorPrefixCount)||0}/${Number(state.prefixDelta)||0}；尾部基线/新增=${Number(state.priorMarkerCount)||0}/${Number(state.markerDelta)||0}；输入框已清空=${state.composerClearedAfterVerifiedInput?'是':'否'}；新增用户节点=${Number(state.newUserCount)||0}；页面文本=${Number(state.priorTranscriptLength)||0}→${Number(state.transcriptLength)||0}；容器=${state.rootLabel||'未知'}`;
    return { ok: true, method, submitted: true, evidence, evidenceKind, safeResendAttempted, deepseekRetryAttempted, deepseekTabActivated, baseline: { beforeSig: info.beforeSig || '', beforeText: info.beforeText || '', beforeAssistantTexts: Array.isArray(info.beforeAssistantTexts) ? info.beforeAssistantTexts : [], capturedAt: Date.now(), beforeGenerating: !!info.beforeGenerating, priorUserCount: Number(info.priorUserCount)||0, turnMarker: turnMarker || '', evidence, submittedVia: method } };
  } catch (error) {
    const message = error?.message || String(error);
    if (/Another debugger is already attached|Debugger is already attach/i.test(message)) {
      throw new Error('目标标签页已有开发者工具或其他调试器连接。请关闭该网页的 DevTools 后重试。');
    }
    throw new Error(`浏览器输入/发送失败：${message}`);
  } finally {
    if (attached) await detach(debuggee);
  }
}

function isSupportedAiUrl(url = '') {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (
      host === 'chatgpt.com' || host.endsWith('.chatgpt.com') ||
      host === 'chat.openai.com' || host.endsWith('.openai.com') ||
      host === 'chat.deepseek.com' || host === 'deepseek.com' || host.endsWith('.deepseek.com')
    );
  } catch { return false; }
}

function cdpFileInputSelectionExpression(files, provider = '') {
  return `(() => {
    const files = ${JSON.stringify(files)};
    const provider = ${JSON.stringify(provider)} || (location.hostname.toLowerCase().includes('deepseek') ? 'deepseek' : 'chatgpt');
    const deepseek = provider === 'deepseek';
    const visible = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
    const textOf = e => { try { return String(e?.innerText || e?.textContent || '').replace(/\\s+/g, ' ').trim(); } catch { return ''; } };
    const selectors = deepseek
      ? ['#chat-input','textarea#chat-input','textarea[data-testid="chat-input"]','main textarea','textarea[placeholder*="DeepSeek"]','textarea','main [contenteditable="true"][role="textbox"]','[contenteditable="true"][role="textbox"]','main [contenteditable="true"]']
      : ['#prompt-textarea','textarea[data-testid="prompt-textarea"]','[data-testid="composer-text-input"]','main form [contenteditable="true"][role="textbox"]','main textarea','main [contenteditable="true"][role="textbox"]'];
    let composer = null;
    for (const selector of selectors) {
      const found = [...document.querySelectorAll(selector)].filter(visible);
      if (found.length) { composer = found[found.length - 1]; break; }
    }
    if (!composer) return { ok:false, reason:'找不到当前消息输入框', inputs:[], provider };

    // The HTML accept attribute only filters the native picker UI; CDP can set
    // files regardless. Treat accept as a preference/diagnostic, never as proof
    // that the website refuses the type. Let the site's actual upload response decide.
    const acceptMatches = (file, acceptValue) => {
      const accept = String(acceptValue || '').trim().toLowerCase();
      if (!accept || accept === '*/*') return true;
      const name = String(file.name || '').toLowerCase();
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot) : '';
      const mime = String(file.mimeType || '').toLowerCase();
      return accept.split(',').map(x => x.trim()).filter(Boolean).some(token => {
        if (token === '*/*') return true;
        if (token.startsWith('.')) return !!ext && ext === token;
        if (token.endsWith('/*')) return !!mime && mime.startsWith(token.slice(0, -1));
        if (token.includes('/')) return !!mime && mime === token;
        return false;
      });
    };
    const composerAncestors = [];
    for (let node = composer, depth = 0; node && depth < 10; node = node.parentElement, depth++) {
      composerAncestors.push({ node, depth });
      if (node === document.body || node.tagName === 'MAIN' || node.getAttribute?.('role') === 'main') break;
    }
    const composerForm = composer.closest('form');
    const uploadWord = /(?:attach|upload|file|document|paperclip|clip|附件|上传|文件|添加材料|添加文件)/i;
    const uploadButtons = [...document.querySelectorAll('button,[role="button"],label,[aria-label]')]
      .filter(visible)
      .map(el => ({ el, description:[el.innerText,el.textContent,el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('data-testid'),el.getAttribute('class')].filter(Boolean).join(' ').replace(/\\s+/g,' ').trim() }))
      .filter(item => uploadWord.test(item.description) && !/(?:send|发送|submit|停止|stop|cancel|取消)/i.test(item.description));
    const localButtonRelation = input => {
      for (const { el:button, description } of uploadButtons) {
        if (button === input || button.contains?.(input) || input.contains?.(button)) return { related:true, score:60, description };
        let parent = input.parentElement;
        for (let depth=0; parent && depth<7; depth++, parent=parent.parentElement) {
          if (parent === document.body || parent.tagName === 'MAIN' || parent.getAttribute?.('role') === 'main') break;
          if (parent.contains?.(button)) return { related:true, score:Math.max(28,52-depth*4), description };
        }
      }
      return { related:false, score:0, description:'' };
    };
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    const enabledCount = inputs.filter(el => !el.disabled).length;
    const nonVisualFilesBatch = files.some(file => {
      const mime = String(file.mimeType || '').toLowerCase();
      const name = String(file.name || '').toLowerCase();
      return !(mime.startsWith('image/') || mime.startsWith('video/') || /\\.(png|jpe?g|gif|webp|bmp|tiff?|avif|heic|mp4|mov|webm|mkv)$/i.test(name));
    });
    const items = inputs.map((el, index) => {
      const accept = String(el.accept || '');
      const acceptMatch = files.every(file => acceptMatches(file, accept));
      // The browser input's multiple property is a real picker constraint. File
      // type mismatches are advisory only and are not used to reject a candidate.
      const compatible = !el.disabled && (files.length <= 1 || !!el.multiple);
      let score = 0, proximity = 0, nearComposer = false;
      if (accept) score += acceptMatch ? 16 : -3;
      else score += 3;
      if (el.multiple || files.length === 1) score += 5;
      if (composerForm && el.closest('form') === composerForm) { score += 90; nearComposer = true; }
      for (const { node:ancestor, depth } of composerAncestors) {
        if (ancestor === el || ancestor.contains?.(el)) {
          const value = Math.max(0, 72 - depth * 8);
          proximity = Math.max(proximity, value);
          if (depth <= 5) nearComposer = true;
        }
        if (el.contains?.(ancestor)) { proximity = Math.max(proximity, 24); nearComposer = true; }
      }
      score += proximity;
      const labels = [...(el.labels || [])].map(label => [label.innerText,label.textContent,label.getAttribute('aria-label'),label.title].filter(Boolean).join(' ')).join(' ');
      const nearbyText = [el.parentElement?.getAttribute('aria-label'), el.parentElement?.getAttribute('title')].filter(Boolean).join(' ');
      const descriptor = [el.id,el.name,el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('data-testid'),el.getAttribute('data-test-id'),el.getAttribute('class'),labels,nearbyText,el.parentElement?.getAttribute('class')].filter(Boolean).join(' ');
      const descriptorRelated = uploadWord.test(descriptor);
      if (descriptorRelated) score += 28;
      const buttonRelation = localButtonRelation(el);
      if (buttonRelation.related) score += buttonRelation.score;
      if (visible(el)) score += 1;
      const visualInputHint = /(?:\\bcamera\\b|拍照|摄像头|(?:附加|添加|上传)?照片或视频|(?:仅|只)(?:接受|支持)?(?:照片|图片|视频)|photo(?:s)?\\s*(?:\\/|or)\\s*video|images?\\s+only|videos?\\s+only)/i.test(descriptor);
      if (visualInputHint && nonVisualFilesBatch) score -= 180;
      // A candidate must have a real association with the composer/upload button
      // (or be the only enabled input). Previous !deepseek shortcut marked every
      // ChatGPT camera/photo input as related, even when proximity was exactly zero.
      const related = nearComposer || descriptorRelated || buttonRelation.related || enabledCount === 1;
      const visualOnlyForThisBatch = visualInputHint && nonVisualFilesBatch;
      return { index, accept, acceptMatch, multiple:!!el.multiple, disabled:!!el.disabled, compatible, related, visualOnlyForThisBatch, score, proximity, descriptor:descriptor.slice(0,220), uploadButtonHint:buttonRelation.description.slice(0,100) };
    });
    // Do not inject a spreadsheet/PDF into a file input explicitly identified as
    // camera/photo/video-only. accept alone is advisory because some sites use
    // a narrow hint while their generic attachment input supports more formats.
    const ranked = items.filter(item => item.compatible && item.related && !item.visualOnlyForThisBatch).sort((a,b) => b.score - a.score);
    const unsupportedFiles = false;
    let reason = '';
    if (!ranked.length) {
      const enabled = items.filter(item => !item.disabled);
      if (nonVisualFilesBatch && items.some(item => item.compatible && item.related && item.visualOnlyForThisBatch)) {
        reason = '检测到的输入控件标识为拍照/照片/视频用途，不会把 TXT、PDF、DOCX 或 XLSX 强行注入这些控件。请在网页附件菜单中选择通用“添加文件”入口；扩展会保持主题发送暂停。';
      } else if (enabled.length && files.length > 1 && enabled.every(item => !item.multiple)) {
        reason = '找到网页文件控件，但它当前不声明支持一次选择多个文件；请分批选择，或在网页中手动逐个添加。';
      } else {
        reason = '没有找到与当前聊天输入区关联的可用文件上传控件。accept 属性仅作控件选择线索，不会单独据此断言网站不支持文件格式。';
      }
    }
    return { ok:!!ranked.length, chosen:ranked[0] || null,
      inputs:items.map(({index,accept,acceptMatch,multiple,disabled,compatible,related,visualOnlyForThisBatch,score,proximity,descriptor,uploadButtonHint})=>({index,accept,acceptMatch,multiple,disabled,compatible,related,visualOnlyForThisBatch,score,proximity,descriptor,uploadButtonHint})),
      composerFound:true, provider, unsupportedFiles, reason };
  })()`;
}
async function cdpProbeFileSupport(tabId, provider, filesMeta) {
  const debuggee = { tabId: Number(tabId) };
  const providerKey = String(provider || '').toLowerCase();
  const files = Array.isArray(filesMeta) ? filesMeta : [];
  if (!Number.isInteger(debuggee.tabId) || debuggee.tabId <= 0) throw new Error('格式预检没有有效的目标标签页 ID。');
  if (!['chatgpt', 'deepseek'].includes(providerKey)) throw new Error('格式预检没有有效的 AI 网页适配器。');
  if (!files.length || files.some(file => !file?.name)) throw new Error('格式预检缺少文件元数据。');
  const tab = await callChrome(chrome.tabs, 'get', debuggee.tabId);
  if (!isSupportedAiUrl(tab?.url)) throw new Error('格式预检目标不是受支持的 ChatGPT/DeepSeek HTTPS 网页。');
  const detectedProvider = String(tab.url).toLowerCase().includes('deepseek') ? 'deepseek' : 'chatgpt';
  if (detectedProvider !== providerKey) throw new Error(`格式预检标签页与 ${providerKey} 适配器不匹配；已阻止开始。`);
  let attached = false;
  try {
    await attach(debuggee); attached = true;
    await cdp(debuggee, 'Runtime.enable');
    const response = await cdp(debuggee, 'Runtime.evaluate', {
      expression: cdpFileInputSelectionExpression(files.map(file => ({ name: file.name, mimeType: file.mimeType || '' })), providerKey),
      returnByValue: true, awaitPromise: true
    });
    const choice = response?.result?.value;
    const details = JSON.stringify(choice?.inputs || []).slice(0, 1800);
    if (!choice?.ok || !choice?.chosen) {
      return { ok: false, confirmed: false, provider: providerKey, unsupportedType: !!choice?.unsupportedFiles,
        error: choice?.reason || '当前网页没有找到与聊天输入区关联的可用文件控件。', inputDiagnostics: choice?.inputs || [], details };
    }
    return { ok: true, confirmed: true, provider: providerKey, chosen: choice.chosen,
      inputDiagnostics: choice.inputs || [], note: '此预检仅确认找到候选网页文件控件；accept 只作选择提示，网站是否接受该文件仍需看实际投递结果。' };
  } finally { if (attached) await detach(debuggee); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'DUO_CDP_PROBE_FILES') {
    if (sender?.id !== chrome.runtime.id || !String(sender?.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
      sendResponse({ ok:false, confirmed:false, error:'附件格式预检请求不是来自本扩展侧边栏，已拒绝。' });
      return;
    }
    cdpProbeFileSupport(Number(message.tabId), String(message.provider || ''), message.files)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok:false, confirmed:false, error:error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'DUO_NEW_CHAT') {
    const fromExtensionUi = sender?.id === chrome.runtime.id && String(sender?.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
    if (!fromExtensionUi) { sendResponse({ ok: false, error: '新建对话请求不是来自本扩展侧边栏，已拒绝。' }); return; }
    cdpNewChat(Number(message.tabId), String(message.provider || ''))
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === 'DUO_CDP_SEND') {
    const fromExtensionUi = sender?.id === chrome.runtime.id && String(sender?.url || '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
    const tabId = fromExtensionUi ? Number(message.tabId) : sender?.tab?.id;
    if (!Number.isInteger(tabId) || tabId <= 0) { sendResponse({ok:false, error:'无法确定有效的目标网页标签页'}); return; }
    if (!fromExtensionUi && sender?.tab?.id !== tabId) { sendResponse({ok:false, error:'网页脚本只能向自己的标签页发送，已拒绝。'}); return; }
    cdpSend(tabId, String(message.prompt || ''))
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ok:false, error:error?.message || String(error)}));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});
chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel?.open && tab?.windowId !== undefined) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});
