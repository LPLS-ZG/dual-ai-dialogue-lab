/*
 * Dual AI Lab v0.6.9: original-file library; transfers bytes in memory without temporary Downloads copies.
 * Files are kept as raw bytes in IndexedDB. No local OCR or extracted-text
 * pipeline is used for discussion; original files are sent to the selected
 * AI webpages only after an explicit user consent checkbox is checked.
 */
(() => {
  const DB_NAME = 'duoLabMaterialsDB';
  const DB_VERSION = 1; // Keep the same database/store so existing files survive upgrade.
  const STORE = 'materials';
  const MAX_FILE_BYTES = 64 * 1024 * 1024;
  const MAX_SELECTED_UPLOAD_BYTES = 64 * 1024 * 1024;
  const MAX_SELECTED_FILES = 30;
  let dbPromise;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开本地资料库'));
    });
    return dbPromise;
  }

  function storeRequest(mode, action) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let request;
      try { request = action(tx.objectStore(STORE)); }
      catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(request?.result ?? request);
      tx.onerror = () => reject(tx.error || new Error('本地资料库操作失败'));
      tx.onabort = () => reject(tx.error || new Error('本地资料库操作已取消'));
    }));
  }

  async function getAll() {
    const db = await openDB();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error || new Error('读取资料列表失败'));
    });

    // Safe migration from v0.5.x: keep the original bytes, but deselect every
    // old record because v0.6.2 uploads original files externally rather than text snippets.
    const migrated = [];
    for (const item of rows) {
      if (item.storageMode !== 'raw-file-upload-v060') {
        item.selected = false;
        item.storageMode = 'raw-file-upload-v060';
        delete item.text;
        delete item.charCount;
        delete item.warning;
        delete item.requiresReview;
        delete item.requiresOCR;
        delete item.ocrAlternatives;
        delete item.ocrPageDiagnostics;
        item.migrationNote = '已从旧版迁移：仅保留原始文件和基本元数据；旧版本地提取文本/ OCR 候选已清除。';
        migrated.push(item);
      }
    }
    for (const item of migrated) await put(item);
    return rows.sort((a, b) => Number(a.addedAt || 0) - Number(b.addedAt || 0));
  }

  async function get(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('读取资料失败'));
    });
  }

  async function put(item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(item);
      tx.oncomplete = () => resolve(item);
      tx.onerror = () => reject(tx.error || new Error('保存资料失败'));
      tx.onabort = () => reject(tx.error || new Error('保存资料已取消'));
    });
  }

  async function remove(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('删除资料失败'));
    });
  }

  function extensionOf(name) {
    const parts = String(name || '').split('.');
    return (parts.length > 1 ? parts.pop() : '').toLowerCase();
  }

  function mimeFor(file) {
    if (file.type) return file.type;
    const ext = extensionOf(file.name);
    const known = {
      pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
      json: 'application/json', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
      svg: 'image/svg+xml', zip: 'application/zip'
    };
    return known[ext] || 'application/octet-stream';
  }

  function mimeForName(name) { return mimeFor({ name, type: '' }); }

  function toArrayBuffer(raw) {
    if (raw instanceof ArrayBuffer) return raw;
    if (ArrayBuffer.isView(raw)) return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    if (raw instanceof Blob) return raw.arrayBuffer();
    throw new Error('本地资料库中没有可读取的原始文件字节；请重新导入该文件。');
  }

  async function addFile(file) {
    if (!(file instanceof Blob) || !file.name) throw new Error('未收到有效文件');
    if (file.size <= 0) throw new Error('空文件无法投递');
    if (file.size > MAX_FILE_BYTES) throw new Error(`单个文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB；请先压缩或拆分文件`);
    const raw = await file.arrayBuffer();
    const id = `${file.name}:${file.size}:${file.lastModified}`;
    const old = await get(id);
    const item = {
      id,
      name: file.name,
      size: file.size,
      type: extensionOf(file.name) || 'file',
      mimeType: mimeFor(file),
      lastModified: file.lastModified || 0,
      addedAt: old?.addedAt || Date.now(),
      raw,
      selected: false,
      storageMode: 'raw-file-upload-v060',
      warning: '',
      uploadState: { chatgpt: '未投递', deepseek: '未投递' }
    };
    await put(item);
    return item;
  }

  window.DuoMaterials = {
    getAll, get, put, remove, addFile, toArrayBuffer, mimeForName,
    MAX_FILE_BYTES, MAX_SELECTED_UPLOAD_BYTES, MAX_SELECTED_FILES
  };
})();
