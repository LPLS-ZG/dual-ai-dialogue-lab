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
    // report.pdf -> report (4).pdf; A题.pdf -> A题（20261019 044718）.pdf.
    // Accept only a numeric duplicate suffix or YYYYMMDD HHMMSS, before or after
    // the extension. Baseline subtraction still prevents old mentions from passing.
    const filenamePattern = name => {
      const key = norm(name);
      const dot = key.lastIndexOf('.');
      const generatedSuffix = '(?:\\(\\s*(?:\\d{8}\\s+\\d{6}|\\d+)\\s*\\))?';
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
      if (stem.length < 3) return false;
      const pattern = new RegExp(`(?:^|[^a-z0-9._-])${escapeRegex(stem)}(?=$|[^a-z0-9._-]|\\.)`, 'i');
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

