'use strict';

/* ============================================================
   我们的日记 —— 纯静态前端，数据存私有 GitHub 仓库的 diary.json
   ============================================================ */

const LS_CFG   = 'ourdiary.cfg';      // { owner, repo, token }
const LS_ME    = 'ourdiary.me';       // 'a' | 'b'
const LS_CACHE = 'ourdiary.cache';    // 最近一次已知状态，用于秒开
const SS_UNLOCK = 'ourdiary.unlock';  // 本次会话已解锁的密码指纹（sessionStorage：关掉重开就要重输）
const LS_SEEN  = 'ourdiary.seen';    // 上次已读到的时间戳（ISO），用于更新提醒

const DATA_PATH = 'diary.json';
const POLL_MS   = 30000;

const $ = (sel) => document.querySelector(sel);

let cfg = null;            // { owner, repo, token }
let me = localStorage.getItem(LS_ME) || 'a';
let state = null;          // 当前已知状态
let remoteSha = null;      // 远端文件 sha，用于乐观并发
let remoteEtag = null;
let pushing = false;
let viewMode = 'day';      // 'day' | 'all'
let selectedDate = todayKey();
let calYear, calMonth;     // 日历当前显示的年月
let editingId = null;
let composeAuthor = me;
let pendingMedia = [];
let pollTimer = null;
let mediaIO = null;        // 照片懒加载用的单个 IntersectionObserver
let seenSeededThisBoot = false;

/* ---------------- 更新提醒 ---------------- */
// 首次启动时把"已读位置"设成当前时间，这样现存的日记和留言不会全部变成未读。
// 只在键不存在时播种；同一次启动内只播一次，connect 成功后也补播一次。
function seedSeen() {
  if (!localStorage.getItem(LS_SEEN)) {
    localStorage.setItem(LS_SEEN, new Date().toISOString());
    seenSeededThisBoot = true;
  }
}
function seenStamp() {
  try { return localStorage.getItem(LS_SEEN) || ''; } catch (e) { return ''; }
}
function bumpSeen() {
  try { localStorage.setItem(LS_SEEN, new Date().toISOString()); } catch (e) { /* ignore */ }
  paintBadge(0);
}
function paintBadge(n) {
  const dot = $('#notifDot');
  if (!dot) return;
  if (n > 0) { dot.textContent = n > 99 ? '99+' : String(n); dot.classList.remove('hidden'); }
  else { dot.classList.add('hidden'); }
}
// 收集 since 之后的对方事件：新日记、新留言、新照片。
// 折叠规则：若某篇日记本身已触发 'entry' 事件，它下面的照片事件就并进后缀（"含 N 张照片"），
// 否则一篇带 3 张图的新日记会炸出 4 条提醒。
function collectEvents(since) {
  if (!since || !state) return [];
  const events = [];
  for (const e of liveEntries()) {
    if (e.createdAt <= since || e.author === me) continue;
    events.push({ kind: 'entry', entryId: e.id, date: e.date, author: e.author, createdAt: e.createdAt, title: e.title, photoCount: 0 });
  }
  for (const e of liveEntries()) {
    for (const c of (e.comments || [])) {
      if (c.deleted || c.createdAt <= since || c.author === me) continue;
      events.push({ kind: 'comment', entryId: e.id, date: e.date, author: c.author, createdAt: c.createdAt, text: c.text, para: c.para });
    }
    const liveMedia = (e.media || []).filter(m => !m.deleted);
    for (const m of liveMedia) {
      if (m.createdAt <= since || m.author === me) continue;
      events.push({ kind: 'photo', entryId: e.id, date: e.date, author: m.author, createdAt: m.createdAt });
    }
  }
  // 折叠：把照片事件并到同一篇日记的 entry 事件里
  const entryIds = new Set(events.filter(ev => ev.kind === 'entry').map(ev => ev.entryId));
  const folded = events.filter(ev => {
    if (ev.kind !== 'photo') return true;
    if (entryIds.has(ev.entryId)) return false;
    return true;
  });
  // 给 entry 事件附上照片计数
  for (const ev of folded) {
    if (ev.kind === 'entry') {
      ev.photoCount = events.filter(p => p.kind === 'photo' && p.entryId === ev.entryId).length;
    }
  }
  folded.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return folded.slice(0, 50);
}

/* ---------------- 日期工具 ---------------- */
function pad(n) { return String(n).padStart(2, '0'); }
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function keyOf(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
function prettyDate(k) {
  const d = fromKey(k);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · 星期${WEEK_CN[d.getDay()]}`;
}
function relLabel(k) {
  const t = todayKey();
  if (k === t) return '今天';
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (k === keyOf(y)) return '昨天';
  const n = new Date(); n.setDate(n.getDate() + 1);
  if (k === keyOf(n)) return '明天';
  return '';
}
function clockTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------- base64 (UTF-8 安全) ---------------- */
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------------- 二进制与媒体 ---------------- */
function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
function b64ToBuf(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function blobToBuf(blob) {
  return new Promise(function (resolve, reject) {
    const r = new FileReader();
    r.onload = function () { resolve(r.result); };
    r.onerror = function () { reject(r.error || new Error('FileReader 失败')); };
    r.readAsArrayBuffer(blob);
  });
}
function canvasToBlob(canvas, type, quality) {
  return new Promise(function (resolve, reject) {
    canvas.toBlob(function (b) {
      if (b) resolve(b); else reject(new Error('toBlob 返回空'));
    }, type, quality);
  });
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file).then(function (bmp) {
      return { bmp: bmp, w: bmp.width, h: bmp.height };
    });
  }
  return new Promise(function (resolve, reject) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      resolve({ bmp: img, w: img.naturalWidth, h: img.naturalHeight, revoke: function () { URL.revokeObjectURL(url); } });
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    if (img.decode) { img.src = url; img.decode().catch(function () {}); }
    else { img.src = url; }
  });
}

async function compressPhoto(file, longEdge, quality) {
  const dec = await decodeImage(file);
  const bmp = dec.bmp;
  const w = dec.w, h = dec.h;
  const s = Math.min(1, longEdge / Math.max(w, h));
  const tw = Math.round(w * s), th = Math.round(h * s);
  const cvs = document.createElement('canvas');
  cvs.width = tw; cvs.height = th;
  const ctx = cvs.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, tw, th);
  ctx.drawImage(bmp, 0, 0, tw, th);
  if (dec.revoke) dec.revoke();
  if (typeof bmp.close === 'function') bmp.close();
  return { canvas: cvs, w: tw, h: th, origW: w, origH: h };
}

async function compressToBlob(file, longEdge, quality) {
  const r = await compressPhoto(file, longEdge, quality);
  let blob = await canvasToBlob(r.canvas, 'image/jpeg', quality);
  if (blob.size > 2560000) {
    for (const q of [0.8, 0.7, 0.6]) {
      blob = await canvasToBlob(r.canvas, 'image/jpeg', q);
      if (blob.size <= 2560000) break;
    }
  }
  if (blob.size > 2560000) {
    for (const le of [2048, 1600]) {
      const r2 = await compressPhoto(file, le, 0.7);
      blob = await canvasToBlob(r2.canvas, 'image/jpeg', 0.7);
      if (blob.size <= 2560000) { r.w = r2.w; r.h = r2.h; r.origW = r2.origW; r.origH = r2.origH; break; }
    }
  }
  return { blob: blob, w: r.origW, h: r.origH };
}

async function compressThumb(file) {
  const r = await compressPhoto(file, 320, 0.72);
  const blob = await canvasToBlob(r.canvas, 'image/jpeg', 0.72);
  return { blob: blob, w: r.w, h: r.h };
}

async function putMediaOne(file) {
  const id = newId();
  const isGif = file.type === 'image/gif';
  let fullBlob, fullW, fullH, thumbBlob;

  if (isGif) {
    if (file.size > 4194304) throw new Error('GIF 文件超过 4MB，请压缩后再上传');
    fullBlob = file;
    fullW = 0; fullH = 0;
    try {
      const th = await compressThumb(file);
      thumbBlob = th.blob;
    } catch (e) {
      thumbBlob = file;
    }
  } else {
    if (file.size > 12582912) throw new Error('「' + file.name + '」超过 12MB，请先压缩');
    try {
      const full = await compressToBlob(file, 2560, 0.9);
      fullBlob = full.blob; fullW = full.w; fullH = full.h;
    } catch (e) {
      const msg = '「' + (file.name || '图片') + '」读不出来';
      if (/heic/i.test(file.name) || /heic/i.test(file.type)) {
        throw new Error(msg + '（可能是 HEIC 格式）。请到 iPhone「设置 › 相机 › 格式」改为「兼容性优先」，或先转成 JPG。');
      }
      throw new Error(msg + '（格式不支持）');
    }
    try {
      const th = await compressThumb(file);
      thumbBlob = th.blob;
    } catch (e) {
      thumbBlob = fullBlob;
    }
  }

  const thumbBuf = await blobToBuf(thumbBlob);
  const fullBuf = await blobToBuf(fullBlob);
  const thumbB64 = bufToB64(thumbBuf);
  const fullB64 = bufToB64(fullBuf);

  const tPath = 'media/' + id + '_t.jpg';
  const fPath = 'media/' + id + '.jpg';

  const tRes = await api('repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + tPath, {
    method: 'PUT',
    body: JSON.stringify({ message: '添加缩略图 ' + id, content: thumbB64 })
  });
  if (!tRes.ok) throw new Error('上传缩略图失败：' + githubMsg(tRes));
  const thumbSha = tRes.json && tRes.json.content ? tRes.json.content.sha : '';

  const fRes = await api('repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + fPath, {
    method: 'PUT',
    body: JSON.stringify({ message: '添加照片 ' + id, content: fullB64 })
  });
  if (!fRes.ok) throw new Error('上传照片失败：' + githubMsg(fRes));
  const fullSha = fRes.json && fRes.json.content ? fRes.json.content.sha : '';

  const mime = isGif ? 'gif' : 'jpeg';
  return normMedia({
    id: id,
    kind: 'photo',
    thumbSha: thumbSha,
    fullSha: fullSha,
    mime: mime,
    bytes: fullBlob.size,
    thumbBytes: thumbBlob.size,
    w: fullW,
    h: fullH,
    author: me,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

async function putMediaFiles(fileList) {
  const files = Array.from(fileList);
  const results = [];
  const errors = [];
  for (const f of files) {
    try {
      const m = await putMediaOne(f);
      results.push(m);
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { items: results, errors: errors };
}

/* ---------------- IndexedDB 媒体缓存 ---------------- */
const IDB_NAME = 'ourdiary-media';
const IDB_STORE = 'blobs';
const IDB_MAX_ENTRIES = 400;
const IDB_MAX_BYTES = 150 * 1024 * 1024;
const URL_MAX = 60;

let idb = null;
let idbDisabled = false;
const idbL1 = new Map();
const urlCache = new Map();

function openIdb() {
  if (idbDisabled) return Promise.resolve(null);
  if (idb) return Promise.resolve(idb);
  return new Promise(function (resolve) {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { idb = req.result; resolve(idb); };
      req.onerror = function () { idbDisabled = true; resolve(null); };
    } catch (e) { idbDisabled = true; resolve(null); }
  });
}

function idbPut(key, buf, mime, bytes) {
  return openIdb().then(function (db) {
    if (!db) return;
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ key: key, buf: buf, mime: mime, bytes: bytes, at: Date.now() });
    idbL1.set(key, { buf: buf, mime: mime, bytes: bytes });
    return new Promise(function (resolve) {
      tx.oncomplete = function () { idbEvict().then(resolve, resolve); };
      tx.onerror = function () { resolve(); };
    });
  });
}

function idbGet(key) {
  const hit = idbL1.get(key);
  if (hit) return Promise.resolve(hit);
  return openIdb().then(function (db) {
    if (!db) return null;
    return new Promise(function (resolve) {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = function () {
        const r = req.result;
        if (r) { idbL1.set(key, { buf: r.buf, mime: r.mime, bytes: r.bytes }); resolve({ buf: r.buf, mime: r.mime, bytes: r.bytes }); }
        else resolve(null);
      };
      req.onerror = function () { resolve(null); };
    });
  });
}

function idbEvict() {
  return openIdb().then(function (db) {
    if (!db) return;
    return new Promise(function (resolve) {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const all = [];
      store.openCursor().onsuccess = function (ev) {
        const cursor = ev.target.result;
        if (cursor) { all.push(cursor.value); cursor.continue(); }
        else {
          all.sort(function (a, b) { return a.at - b.at; });
          let totalBytes = all.reduce(function (s, r) { return s + (r.bytes || 0); }, 0);
          let toDelete = [];
          while (all.length > IDB_MAX_ENTRIES || totalBytes > IDB_MAX_BYTES) {
            const old = all.shift();
            toDelete.push(old.key);
            totalBytes -= (old.bytes || 0);
            idbL1.delete(old.key);
          }
          for (const k of toDelete) store.delete(k);
        }
      };
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  });
}

function getObjectUrl(key, buf, mime) {
  if (urlCache.has(key)) return urlCache.get(key);
  const url = URL.createObjectURL(new Blob([buf], { type: 'image/' + mime }));
  urlCache.set(key, url);
  if (urlCache.size > URL_MAX) {
    const oldest = urlCache.keys().next().value;
    URL.revokeObjectURL(urlCache.get(oldest));
    urlCache.delete(oldest);
  }
  return url;
}

const SEMAPHORE_MAX = 3;
let semActive = 0;
const semQueue = [];
function semAcquire() {
  return new Promise(function (resolve) {
    if (semActive < SEMAPHORE_MAX) { semActive++; resolve(); }
    else semQueue.push(resolve);
  });
}
function semRelease() {
  if (semQueue.length) { const next = semQueue.shift(); next(); }
  else semActive--;
}

async function getMediaBuf(item, variant) {
  const sha = variant === 't' ? item.thumbSha : item.fullSha;
  const mime = item.mime || 'jpeg';
  const suffix = variant === 't' ? '_t' : '';
  const key = sha || ('p:media/' + item.id + suffix + '.jpg');

  const cached = await idbGet(key);
  if (cached) return cached.buf;

  await semAcquire();
  try {
    if (!cfg || !sha) throw new Error('未连接或缺少 sha');
    const res = await fetch('https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo + '/git/blobs/' + sha, {
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Accept': 'application/vnd.github.raw'
      }
    });
    if (!res.ok) throw new Error('媒体读取失败：' + res.status);
    const raw = await res.arrayBuffer();
    await idbPut(key, raw, mime, raw.byteLength);
    return raw;
  } finally {
    semRelease();
  }
}

/* ---------------- 状态与合并 ---------------- */
const DEF_AUTHORS = {
  a: { name: '小满', color: '#d97757' },
  b: { name: '小谷', color: '#4a7fa5' }
};
function defaultState() {
  return {
    version: 1,
    // 空字符串：刚开机的设备对昵称没有任何主张，不能压过对方设置好的名字
    authorsRev: '',
    authorsTouched: false,
    authors: { a: Object.assign({}, DEF_AUTHORS.a), b: Object.assign({}, DEF_AUTHORS.b) },
    entries: []
  };
}
function isDefaultAuthors(a) {
  return ['a', 'b'].every(k => {
    const s = (a || {})[k] || {};
    return s.name === DEF_AUTHORS[k].name && s.color === DEF_AUTHORS[k].color;
  });
}
// 该采信哪一方的昵称：手动改过的压过从没改过的；改过的之间再比时间。
// 关键是"没人动过的默认名"永远不能覆盖对方真正设置的名字。
function pickAuthorsSide(x, y) {
  const xt = !!x.authorsTouched, yt = !!y.authorsTouched;
  if (xt !== yt) return yt ? y : x;
  const xd = isDefaultAuthors(x.authors), yd = isDefaultAuthors(y.authors);
  if (xd !== yd) return yd ? x : y;
  return (y.authorsRev || '') >= (x.authorsRev || '') ? y : x;
}
function normAuthors(a) {
  const d = defaultState().authors;
  const out = {};
  for (const k of ['a', 'b']) {
    const src = (a && a[k]) || {};
    out[k] = {
      name: (typeof src.name === 'string' && src.name.trim()) ? src.name.trim().slice(0, 24) : d[k].name,
      color: (typeof src.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(src.color)) ? src.color : d[k].color
    };
  }
  return out;
}
function normEntry(e) {
  return {
    id: String(e.id || ''),
    date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : todayKey(),
    author: e.author === 'b' ? 'b' : 'a',
    title: String(e.title || '').slice(0, 120),
    content: String(e.content || '').slice(0, 20000),
    createdAt: String(e.createdAt || new Date().toISOString()),
    updatedAt: String(e.updatedAt || e.createdAt || new Date().toISOString()),
    edited: !!e.edited,
    deleted: !!e.deleted,
    media: Array.isArray(e.media) ? e.media.map(normMedia).filter(Boolean) : [],
    comments: Array.isArray(e.comments) ? e.comments.map(normComment) : []
  };
}
function normComment(c) {
  c = c || {};
  const para = Math.max(0, parseInt(c.para, 10) || 0);
  const author = c.author === 'b' ? 'b' : 'a';
  const text = String(c.text || '').slice(0, 500);
  const createdAt = String(c.createdAt || new Date().toISOString());
  return {
    id: String(c.id || stableCommentId({ para: para, author: author, createdAt: c.createdAt, text: c.text })),
    para: para,
    author: author,
    text: text,
    createdAt: createdAt,
    updatedAt: String(c.updatedAt || ''),
    edited: !!c.edited,
    deleted: !!c.deleted,
    deletedAt: String(c.deletedAt || ''),
    media: Array.isArray(c.media) ? c.media.map(normMedia).filter(Boolean) : []
  };
}
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
// 没有 id 的留言（旧数据）只能用"确定性"的 id：随机 id 会让同一条留言每次 merge 都复制一份。
// 只吃原始字段，绝不吃兜底的 now() —— 两台设备时间不同，兜底值参与计算就失去确定性了。
function stableCommentId(c) {
  const key = [c.para, c.author, c.createdAt || '', c.text || ''].join('|');
  return 'c' + fnv1a(key, 0x811c9dc5) + fnv1a(key, 0x9e3779b1);
}
const MEDIA_MIMES = ['jpeg', 'png', 'webp', 'gif'];
function normMedia(m) {
  m = m || {};
  const id = String(m.id || '');
  if (!id) return null;
  const sha = (v) => (/^[0-9a-f]{40}$/.test(String(v || '')) ? String(v) : '');
  return {
    id: id,
    kind: 'photo',
    thumbSha: sha(m.thumbSha),
    fullSha: sha(m.fullSha),
    mime: MEDIA_MIMES.indexOf(m.mime) >= 0 ? m.mime : 'jpeg',
    bytes: Math.max(0, parseInt(m.bytes, 10) || 0),
    thumbBytes: Math.max(0, parseInt(m.thumbBytes, 10) || 0),
    w: Math.max(0, parseInt(m.w, 10) || 0),
    h: Math.max(0, parseInt(m.h, 10) || 0),
    author: m.author === 'b' ? 'b' : 'a',
    createdAt: String(m.createdAt || ''),
    updatedAt: String(m.updatedAt || ''),
    deleted: !!m.deleted,
    deletedAt: String(m.deletedAt || '')
  };
}
// 留言和照片都按"最后写入者胜"合并：谁的时间新谁说了算。
// 编辑和删除都会刷新 updatedAt，所以墓碑能像日记那样赢得竞争，不需要特例。
// >= 让平局归后遍历的那一侧（本地），乐观渲染出来的内容才不会被自己这次合并换掉。
function lwwMerge(x, y, norm, score) {
  const m = new Map();
  for (const raw of [...(x || []), ...(y || [])]) {
    const n = norm(raw);
    if (!n) continue;
    const prev = m.get(n.id);
    if (!prev || score(n) >= score(prev)) m.set(n.id, n);
  }
  return [...m.values()].sort((p, q) =>
    (p.createdAt || '').localeCompare(q.createdAt || '') || p.id.localeCompare(q.id));
}
const byStamp = (o) => String(o.updatedAt || o.createdAt || '');
function mergeComments(x, y) { return lwwMerge(x, y, normComment, byStamp); }
function mergeMedia(x, y) { return lwwMerge(x, y, normMedia, byStamp); }
function sortEntries(list) {
  return list.slice().sort((p, q) =>
    (q.date || '').localeCompare(p.date || '') ||
    (q.createdAt || '').localeCompare(p.createdAt || ''));
}
function mergeStates(x, y) {
  x = x || defaultState(); y = y || defaultState();
  const byId = new Map();
  for (const e of [...(x.entries || []), ...(y.entries || [])].map(normEntry)) {
    if (!e.id) continue;
    const prev = byId.get(e.id);
    if (!prev) { byId.set(e.id, e); continue; }
    // body 整体二选一，所以 comments 和 media 必须各自再合并一次：
    // 否则"一方加照片、另一方之后改文字"时，照片会跟着落败的 body 一起消失。
    const base = (e.updatedAt || '') > (prev.updatedAt || '') ? e : prev;
    base.comments = mergeComments(prev.comments, e.comments);
    base.media = mergeMedia(prev.media, e.media);
    byId.set(e.id, base);
  }
  const win = pickAuthorsSide(x, y);
  const lock = mergeLock(x, y);
  const out = {
    version: 1,
    authorsRev: win.authorsRev || '',
    authorsTouched: !!(x.authorsTouched || y.authorsTouched),
    authors: normAuthors(win.authors),
    entries: sortEntries([...byId.values()])
  };
  if (lock) out.lock = lock;
  return out;
}
function liveEntries() {
  return (state.entries || []).filter(e => !e.deleted);
}
function pruneTombstones() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  // 时间戳解析不出来就留着：宁可占点空间，也不能把还能救的数据扔掉。
  const expired = (iso) => { const t = Date.parse(iso); return !isNaN(t) && t <= cutoff; };
  const pruneList = (list) => (list || []).filter(o => !(o.deleted && expired(o.deletedAt || o.updatedAt)));
  state.entries = pruneList(state.entries);
  for (const e of state.entries) {
    e.media = pruneList(e.media);
    e.comments = pruneList(e.comments);
    for (const c of e.comments) c.media = pruneList(c.media);
  }
}
// 本地是否真有内容（日记，或改过的作者名/颜色）。
// 只有为 true 时才允许在远端没有数据文件的情况下创建它。
function hasOwnContent() {
  const s = state || {};
  if ((s.entries || []).length) return true;
  if (normLock(s.lock)) return true;
  return !!s.authorsTouched || !isDefaultAuthors(s.authors);
}

/* ---------------- 密码锁 ---------------- */
// 密码只以"加盐 SHA-256"的形式存在私有数据仓库里，公开的网页源码中没有密码。
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function newSalt() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hashPassword(salt, pass) { return sha256Hex(`${salt}:${pass}`); }
function normLock(l) {
  if (!l || typeof l !== 'object') return null;
  const hash = String(l.hash || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  return { salt: String(l.salt || ''), hash, rev: String(l.rev || '') };
}
function mergeLock(x, y) {
  const a = normLock(x && x.lock), b = normLock(y && y.lock);
  if (!a) return b;
  if (!b) return a;
  return (b.rev || '') >= (a.rev || '') ? b : a;
}
function lockFingerprint() {
  const l = normLock(state && state.lock);
  return l ? l.hash : '';
}
function isSessionUnlocked() {
  const fp = lockFingerprint();
  if (!fp) return true;
  try { return sessionStorage.getItem(SS_UNLOCK) === fp; } catch (e) { return false; }
}
function markUnlocked() {
  const fp = lockFingerprint();
  if (!fp) return;
  try { sessionStorage.setItem(SS_UNLOCK, fp); } catch (e) { /* 隐私模式写不进，那就每次都问 */ }
}
function needLock() {
  return !!normLock(state && state.lock) && !isSessionUnlocked();
}

function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}
function showLock() {
  $('#setup').classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#lockError').classList.add('hidden');
  // 上锁时清掉已经渲染出来的内容，别留在页面里
  $('#entryList').innerHTML = '';
  $('#listHead').innerHTML = '';
  $('#calGrid').innerHTML = '';
  $('#lock').classList.remove('hidden');
  const i = $('#lkPass');
  i.value = '';
  setTimeout(() => i.focus(), 60);
}
async function enterApp() {
  $('#lock').classList.add('hidden');
  showApp();
  render();
  startPolling();
  try {
    await pull();
    hideConnBanner();
    render();
    // 解锁后刷一次红点，但不弹 toast、不推进 seen——每次开页面都弹是噪音
    const since = seenStamp();
    if (since) {
      const events = collectEvents(since);
      paintBadge(events.length);
    }
  } catch (e) {
    showConnBanner('同步失败：' + e.message + '（显示的是本机缓存）');
  }
}
async function tryUnlock() {
  const lock = normLock(state && state.lock);
  if (!lock) { await enterApp(); return; }
  const errBox = $('#lockError');
  const pass = $('#lkPass').value;
  const btn = $('#lkUnlock');
  const fail = (msg) => {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
    shake($('#lock'));
    $('#lkPass').value = '';
    $('#lkPass').focus();
  };
  if (!crypto.subtle) { fail('当前浏览器不支持加密校验，请用 https 打开本页。'); return; }
  if (!pass) { shake($('#lock')); return; }
  btn.disabled = true; btn.textContent = '校验中…';
  try {
    let ok = await hashPassword(lock.salt, pass) === lock.hash;
    if (!ok) {
      // 本机缓存的密码可能已被对方改掉：联网再确认一次；读不到就按缓存判定
      try {
        remoteEtag = null;
        const got = await loadRemote({ fresh: true });
        if (!got.missing && !got.unchanged) {
          state = mergeStates(got.state, state);
          saveCache();
          const fresh = normLock(state.lock);
          if (fresh) ok = await hashPassword(fresh.salt, pass) === fresh.hash;
        }
      } catch (e) { /* 离线时用本机缓存判定 */ }
    }
    if (ok) { markUnlocked(); await enterApp(); return; }
    fail('密码不对。');
  } finally {
    btn.disabled = false; btn.textContent = '打开';
  }
}
async function saveLock() {
  const p1 = $('#lkNew').value;
  const p2 = $('#lkNew2').value;
  if (!p1) { showToast('先输入新密码'); return; }
  if (p1.length < 4) { showToast('密码至少 4 位'); return; }
  if (p1 !== p2) { showToast('两次输入的密码不一样'); return; }
  if (!crypto.subtle) { showToast('当前浏览器不支持加密，请用 https 打开本页'); return; }
  const salt = newSalt();
  state.lock = { salt, hash: await hashPassword(salt, p1), rev: new Date().toISOString() };
  $('#lkNew').value = ''; $('#lkNew2').value = '';
  markUnlocked();
  renderSettingsInfo();
  try {
    await push('更新打开密码');
    markUnlocked();
    showToast('密码已保存，两台设备同时生效');
  } catch (e) { showConnBanner('保存失败：' + e.message); }
}

/* ---------------- GitHub API ---------------- */
async function api(path, opts = {}) {
  const headers = Object.assign({
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${cfg.token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  }, opts.headers || {});
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(`https://api.github.com/${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body || undefined
  });
  let json = null;
  const text = await res.text();
  if (text) { try { json = JSON.parse(text); } catch (e) { /* ignore */ } }
  return { ok: res.ok, status: res.status, json, etag: res.headers.get('ETag') };
}

async function loadRemote(opts = {}) {
  const headers = {};
  if (remoteEtag && !opts.fresh) headers['If-None-Match'] = remoteEtag;
  const res = await api(`repos/${cfg.owner}/${cfg.repo}/contents/${DATA_PATH}`, { headers });
  if (res.status === 304) return { unchanged: true };
  if (res.status === 404) {
    // 404 有两种可能：文件确实不存在，或令牌根本看不到这个仓库。
    // 必须区分开，否则会把"读不到"当成"空的"，进而覆盖线上数据。
    const repo = await api(`repos/${cfg.owner}/${cfg.repo}`);
    if (!repo.ok) throw new Error(githubMsg(repo));
    return { missing: true };
  }
  if (!res.ok) throw new Error(githubMsg(res));
  remoteEtag = res.etag || remoteEtag;
  remoteSha = res.json.sha;
  // >1MB 的文件 GitHub 返回 encoding:"none" 且 content 为空，JSON.parse('') 会抛错，
  // 必须在这里拦住，否则同步全废且报错信息是天书。
  if (res.json.encoding === 'none' || !res.json.content) {
    throw new Error('数据文件已超过 GitHub 单文件读取上限，无法继续同步。请清理旧内容后重试。');
  }
  const parsed = JSON.parse(b64decodeUtf8(res.json.content));
  return { state: parsed, sha: res.json.sha };
}

function githubMsg(res) {
  const m = res.json && res.json.message;
  if (res.status === 401) return '令牌无效或已过期（401）。请到设置里重新连接。';
  if (res.status === 403) return `没有权限（403）。${m || '请确认令牌对该仓库有 Contents 读写权限。'}`;
  if (res.status === 404) return `找不到仓库（404）。请确认仓库名与用户名，且令牌能访问它。`;
  if (res.status === 409 || res.status === 422) return '保存冲突，正在重试…';
  return `GitHub 返回 ${res.status}：${m || '未知错误'}`;
}

/* ---------------- 读取 / 写入 ---------------- */
async function pull(opts = {}) {
  const got = await loadRemote(opts);
  if (got.unchanged) return false;
  if (got.missing) {
    // 远端确实没有数据文件。只有本地真有内容时才创建，
    // 否则一次误判就会把线上日记覆盖成空的。
    if (!hasOwnContent()) return false;
    await push('初始化日记本');
    return true;
  }
  remoteSha = got.sha;
  const merged = mergeStates(got.state, state);
  const changed = JSON.stringify(merged) !== JSON.stringify(state);
  // 内容没变时不要替换 state：mergeStates 造的是全新对象，而 silentSync 只在 changed
  // 时才重绘，换了对象就等于让页面上每张卡片都持有失效引用。
  if (changed) { state = merged; saveCache(); }
  return changed;
}

async function push(message) {
  pushing = true;
  setSyncing(true);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      let sha = null;
      try {
        // 强制绕开 ETag：拿不到最新 sha 就写入，等于盲覆盖对方的日记
        const got = await loadRemote({ fresh: true });
        if (got.missing) {
          if (!hasOwnContent()) return false;
        } else {
          state = mergeStates(got.state, state);
          sha = got.sha;
        }
      } catch (e) {
        if (attempt === 3) throw e;
        remoteEtag = null;
        continue;
      }
      pruneTombstones();
      const jsonStr = JSON.stringify(state, null, 2);
      // 850KB 闸门：base64 膨胀 33% 后约 1.13MB，超过 GitHub 1MB 限制就读不回来了。
      // 必须在这里拦住，绝不能写出一个下次读不回来的文件。
      if (jsonStr.length > 850000) {
        showConnBanner('数据文件已接近 GitHub 单文件上限（' + Math.round(jsonStr.length / 1024) + 'KB），请先清理旧内容再写入。');
        throw new Error('数据文件过大，拒绝写入');
      }
      const payload = {
        message,
        content: b64encodeUtf8(jsonStr)
      };
      if (sha) payload.sha = sha;
      const res = await api(`repos/${cfg.owner}/${cfg.repo}/contents/${DATA_PATH}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        remoteSha = res.json && res.json.content ? res.json.content.sha : null;
        remoteEtag = null;
        saveCache();
        return true;
      }
      if (res.status === 409 || res.status === 422) {
        remoteEtag = null;
        continue;
      }
      throw new Error(githubMsg(res));
    }
    throw new Error('多人同时修改导致多次冲突，请稍后再试一次。');
  } finally {
    pushing = false;
    setSyncing(false);
  }
}

function saveCache() {
  try { localStorage.setItem(LS_CACHE, JSON.stringify({ state, sha: remoteSha })); } catch (e) { /* ignore */ }
}
function loadCache() {
  try {
    const raw = localStorage.getItem(LS_CACHE);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.state ? o : null;
  } catch (e) { return null; }
}

/* ---------------- 轮询同步 ---------------- */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => { silentSync(); }, POLL_MS);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function silentSync() {
  if (pushing || !cfg) return;
  const since = seenStamp();
  try {
    const changed = await pull();
    hideConnBanner();
    if (changed) {
      render();
      // 首次播种的这次启动不计算事件、不亮红点——否则现存内容全变成未读
      if (since && !seenSeededThisBoot) {
        const events = collectEvents(since);
        paintBadge(events.length);
        if (events.length) {
          const first = events[0];
          const who = state.authors[first.author].name;
          const labels = { entry: '写了新日记', comment: '留了言', photo: '发了照片' };
          showToast(`「${who}」${labels[first.kind] || '更新了'}`);
        }
      }
    }
  } catch (e) {
    showConnBanner('同步失败：' + e.message);
  }
}

/* ---------------- 跳转到某篇日记 ---------------- */
function gotoEntry(entryId) {
  const e = liveEntry(entryId);
  if (!e) return;
  const d = fromKey(e.date);
  calYear = d.getFullYear();
  calMonth = d.getMonth();
  selectedDate = e.date;
  viewMode = 'day';
  render();
  // 等 DOM 重建完再滚动和高亮
  requestAnimationFrame(() => {
    const card = document.querySelector(`.entry[data-id="${entryId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1200);
  });
}

/* ---------------- 更新提醒面板 ---------------- */
function openNotifSheet() {
  const since = seenStamp();
  const events = since ? collectEvents(since) : [];
  const list = $('#notifList');
  list.innerHTML = '';
  for (const ev of events) {
    const who = state.authors[ev.author].name;
    const au = state.authors[ev.author];
    let icon = '📝', text = '';
    if (ev.kind === 'entry') {
      icon = '📖';
      text = `「${who}」写了新日记${ev.title ? `《${ev.title}》` : ''}${ev.photoCount ? `（含 ${ev.photoCount} 张照片）` : ''}`;
    } else if (ev.kind === 'comment') {
      icon = '💬';
      const brief = ev.text.length > 30 ? ev.text.slice(0, 30) + '…' : ev.text;
      text = `「${who}」留言：${brief}`;
    } else if (ev.kind === 'photo') {
      icon = '📷';
      text = `「${who}」发了照片`;
    }
    const item = document.createElement('div');
    item.className = 'notif-item';
    item.innerHTML = `<div class="notif-icon" style="background:${esc(au.color)}20;color:${esc(au.color)}">${icon}</div>
      <div class="notif-body">
        <div class="notif-text">${esc(text)}</div>
        <div class="notif-time">${esc(fmtStamp(ev.createdAt))}</div>
      </div>`;
    item.addEventListener('click', () => {
      bumpSeen();
      $('#notifSheet').classList.add('hidden');
      gotoEntry(ev.entryId);
    });
    list.appendChild(item);
  }
  $('#notifSheet').classList.remove('hidden');
}

/* ---------------- 渲染 ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------------- 照片懒加载 ---------------- */
function setupMediaObserver() {
  if (mediaIO) mediaIO.disconnect();
  mediaIO = new IntersectionObserver((entries) => {
    for (const io of entries) {
      if (!io.isIntersecting) continue;
      const el = io.target;
      mediaIO.unobserve(el);
      loadMediaThumb(el);
    }
  }, { rootMargin: '300px' });

  document.querySelectorAll('.media-placeholder[data-media-id]').forEach(el => mediaIO.observe(el));
}

async function loadMediaThumb(el) {
  const mid = el.dataset.mediaId;
  const item = findMediaItem(mid);
  if (!item) return;
  try {
    const buf = await getMediaBuf(item.m, 't');
    const url = getObjectUrl(mid + ':t', buf, item.m.mime);
    el.classList.remove('media-placeholder');
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    if (item.m.w && item.m.h) {
      const ratio = item.m.h / item.m.w;
      img.style.aspectRatio = `1 / ${Math.min(ratio, 1.5)}`;
    }
    el.appendChild(img);
    el.dataset.loaded = '1';
  } catch (e) {
    el.textContent = '…';
  }
}

function findMediaItem(mid) {
  for (const e of liveEntries()) {
    for (const m of (e.media || [])) {
      if (m.id === mid && !m.deleted) return { m, entryId: e.id, date: e.date, author: m.author || e.author };
    }
    for (const c of (e.comments || [])) {
      if (c.deleted) continue;
      for (const m of (c.media || [])) {
        if (m.id === mid && !m.deleted) return { m, entryId: e.id, commentId: c.id, date: c.createdAt, author: m.author || c.author };
      }
    }
  }
  return null;
}

/* ---------------- 相册（派生视图） ---------------- */
let albumFilter = 'all';

function albumItems() {
  const items = [];
  for (const e of liveEntries()) {
    for (const m of (e.media || [])) {
      if (m.deleted) continue;
      items.push({ m, entryId: e.id, date: e.date, author: m.author || e.author, source: 'entry', title: e.title });
    }
    for (const c of (e.comments || [])) {
      if (c.deleted) continue;
      for (const m of (c.media || [])) {
        if (m.deleted) continue;
        items.push({ m, entryId: e.id, commentId: c.id, date: c.createdAt || e.date, author: m.author || c.author, source: 'comment' });
      }
    }
  }
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return items;
}

function renderAlbumWindow() {
  const win = $('#albumWindow');
  const grid = $('#albumWinGrid');
  const all = albumItems();
  if (!all.length) { win.classList.add('hidden'); return; }
  win.classList.remove('hidden');
  grid.innerHTML = '';
  const recent = all.slice(0, 6);
  for (let i = 0; i < recent.length; i++) {
    const it = recent[i];
    const div = document.createElement('div');
    div.className = 'aw-thumb media-placeholder';
    div.dataset.mediaId = it.m.id;
    div.dataset.albumIdx = String(i);
    div.addEventListener('click', () => openAlbumViewer(recent, i));
    grid.appendChild(div);
  }
  setupMediaObserver();
}

function renderAlbum() {
  const grid = $('#albumGrid');
  grid.innerHTML = '';
  const filters = $('#albumFilters');
  if (filters) {
    const a = state.authors.a, b = state.authors.b;
    filters.querySelector('[data-filter="a"]').textContent = a.name;
    filters.querySelector('[data-filter="b"]').textContent = b.name;
    filters.querySelectorAll('.chip-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.filter === albumFilter);
    });
  }
  let items = albumItems();
  if (albumFilter !== 'all') items = items.filter(it => it.author === albumFilter);
  if (!items.length) {
    grid.innerHTML = '<div style="text-align:center;color:var(--ink-soft);padding:40px 0">暂无照片</div>';
    return;
  }
  // 按 YYYY-MM 分组
  const groups = new Map();
  for (const it of items) {
    const key = (it.date || '').slice(0, 7) || '未知';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  let globalIdx = 0;
  for (const [month, list] of groups) {
    const label = document.createElement('div');
    label.className = 'album-month';
    const [y, m] = month.split('-');
    label.textContent = `${y}年${parseInt(m)}月`;
    grid.appendChild(label);
    for (const it of list) {
      const cell = document.createElement('div');
      cell.className = 'album-cell media-placeholder';
      cell.dataset.mediaId = it.m.id;
      cell.dataset.albumIdx = String(globalIdx);
      const idx = globalIdx;
      cell.addEventListener('click', () => openAlbumViewer(items, idx));
      grid.appendChild(cell);
      globalIdx++;
    }
  }
  setupMediaObserver();
}

function openAlbum() {
  renderAlbum();
  $('#albumView').classList.remove('hidden');
}
function closeAlbum() {
  $('#albumView').classList.add('hidden');
}

let viewerItems = [];
let viewerIndex = 0;

function openAlbumViewer(items, idx) {
  viewerItems = items;
  viewerIndex = idx;
  showViewerItem();
  $('#photoViewer').classList.remove('hidden');
}

async function showViewerItem() {
  const it = viewerItems[viewerIndex];
  if (!it) return;
  const au = state.authors[it.author] || state.authors.a;
  const info = $('#pvInfo');
  info.innerHTML = `<span style="background:${esc(au.color)};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">${esc(au.name)}</span>
    <span style="font-size:12px;color:var(--ink-soft);margin-left:6px">${esc(fmtStamp(it.m.createdAt || it.date))}</span>`;

  const caption = $('#pvCaption');
  if (it.source === 'entry') {
    const entry = liveEntry(it.entryId);
    caption.innerHTML = entry ? `来自日记《<a href="#" id="pvGoto" style="color:${esc(au.color)}">${esc(entry.title || entry.date)}</a>》` : '';
  } else {
    caption.textContent = '来自留言';
  }
  const goto = $('#pvGoto');
  if (goto) goto.addEventListener('click', (ev) => { ev.preventDefault(); closeViewer(); closeAlbum(); gotoEntry(it.entryId); });

  const img = $('#pvImg');
  img.src = '';
  img.alt = '';
  try {
    const buf = await getMediaBuf(it.m, 'f');
    img.src = getObjectUrl(it.m.id + ':f', buf, it.m.mime);
  } catch (e) {
    img.alt = '加载失败';
  }
}

function closeViewer() {
  $('#photoViewer').classList.add('hidden');
  viewerItems = [];
}

async function removeMedia() {
  const it = viewerItems[viewerIndex];
  if (!it) return;
  const au = state.authors[it.author] || state.authors.a;
  if (!confirm(`删除这张照片？\n\n${au.name} · ${fmtStamp(it.m.createdAt || it.date)}\n\n照片文件仍保留在仓库中，不会回收空间。`)) return;
  const now = new Date().toISOString();
  const entry = liveEntry(it.entryId);
  if (!entry) { showToast('日记已不存在'); closeViewer(); return; }
  if (it.commentId) {
    const c = findComment(it.entryId, it.commentId);
    if (c) {
      const m = (c.media || []).find(x => x.id === it.m.id);
      if (m) { m.deleted = true; m.deletedAt = now; m.updatedAt = now; }
    }
  } else {
    const m = (entry.media || []).find(x => x.id === it.m.id);
    if (m) { m.deleted = true; m.deletedAt = now; m.updatedAt = now; }
  }
  entry.updatedAt = now;
  closeViewer();
  render();
  try {
    await push('删除了一张照片');
    showToast('照片已删除');
  } catch (e) {
    showConnBanner('删除失败：' + e.message);
  }
}

function render() {
  if (!state) return;
  renderIdentity();
  renderCalendar();
  renderList();
  renderAlbumWindow();
  renderSettingsInfo();
  setupMediaObserver();
}

function renderIdentity() {
  const chip = $('#identityChip');
  const a = state.authors[me];
  chip.textContent = a.name;
  chip.style.background = a.color;
}

function entriesByDate() {
  const map = new Map();
  for (const e of liveEntries()) {
    if (!map.has(e.date)) map.set(e.date, []);
    map.get(e.date).push(e);
  }
  return map;
}

function renderCalendar() {
  $('#calTitle').textContent = `${calYear}年${calMonth + 1}月`;
  const grid = $('#calGrid');
  grid.innerHTML = '';
  const byDate = entriesByDate();

  const first = new Date(calYear, calMonth, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrev = new Date(calYear, calMonth, 0).getDate();
  const tKey = todayKey();

  const cells = [];
  for (let i = startDow - 1; i >= 0; i--) cells.push({ day: daysInPrev - i, other: -1 });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, other: 0 });
  while (cells.length % 7 !== 0 || cells.length < 35) cells.push({ day: cells.length - (startDow + daysInMonth) + 1, other: 1 });

  for (const c of cells) {
    const btn = document.createElement('button');
    btn.className = 'cal-day' + (c.other ? ' other' : '');
    let key = null;
    if (!c.other) {
      key = `${calYear}-${pad(calMonth + 1)}-${pad(c.day)}`;
      if (key === tKey) btn.classList.add('today');
      if (key === selectedDate && viewMode === 'day') btn.classList.add('selected');
    }
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = c.day;
    btn.appendChild(num);

    const dots = document.createElement('span');
    dots.className = 'dots';
    if (key && byDate.has(key)) {
      const authors = [...new Set(byDate.get(key).map(e => e.author))];
      for (const au of authors.slice(0, 3)) {
        const i = document.createElement('i');
        i.style.background = state.authors[au].color;
        dots.appendChild(i);
      }
    }
    btn.appendChild(dots);

    if (key) {
      btn.addEventListener('click', () => {
        selectedDate = key;
        viewMode = 'day';
        render();
      });
    } else {
      btn.disabled = true;
      btn.style.cursor = 'default';
    }
    grid.appendChild(btn);
  }

  $('#allBtn').classList.toggle('active', viewMode === 'all');
}

function renderList() {
  const list = $('#entryList');
  const head = $('#listHead');
  list.innerHTML = '';

  let items;
  if (viewMode === 'all') {
    items = liveEntries();
    head.innerHTML = `<span class="lh-date">全部日记</span><span class="lh-count">共 ${items.length} 篇</span>`;
  } else {
    items = liveEntries().filter(e => e.date === selectedDate);
    const rel = relLabel(selectedDate);
    head.innerHTML = `<span class="lh-date">${esc(prettyDate(selectedDate))}${rel ? ` · ${rel}` : ''}</span><span class="lh-count">${items.length} 篇</span>`;
  }

  $('#emptyState').classList.toggle('hidden', items.length > 0);

  for (const e of items) list.appendChild(entryCard(e));
}

/* ---------------- 照片条（懒加载占位） ---------------- */
function mediaStripHtml(media, parentId, parentType) {
  if (!media || !media.length) return '';
  const cls = parentType === 'entry' ? 'e-media-strip' : 'c-media';
  return `<div class="${cls}">${media.map((m, i) =>
    `<div class="strip-thumb media-placeholder" data-media-id="${esc(m.id)}" data-parent="${esc(parentId)}" data-parent-type="${parentType}" data-idx="${i}"></div>`
  ).join('')}</div>`;
}

function entryCard(e) {
  const au = state.authors[e.author];
  const card = document.createElement('article');
  card.className = 'entry';
  card.dataset.id = e.id;   // 更新提醒要按 id 跳到某一篇，没这个就无从定位
  card.style.borderLeftColor = au.color;

  const rel = relLabel(e.date);
  const paras = String(e.content || '').split('\n');
  const parasHtml = paras.map((p, i) => {
    const comments = (e.comments || []).filter(c => c.para === i && !c.deleted);
    return `<div class="para" data-para="${i}">
      <div class="para-text">${esc(p) || '&nbsp;'}</div>
      <div class="para-actions">
        <button class="para-comment-btn" data-para="${i}">留言${comments.length ? ` ${comments.length}` : ''}</button>
      </div>
      <div class="para-comments">${comments.map(c => commentHtml(c)).join('')}</div>
      <div class="para-input hidden" data-input="${i}">
        <textarea rows="1" maxlength="500" placeholder="对这段话留言…"></textarea>
        <button class="send" data-para="${i}">发送</button>
      </div>
    </div>`;
  }).join('');

  card.innerHTML = `
    <div class="e-top">
      <span class="e-author" style="background:${esc(au.color)}">${esc(au.name)}</span>
      <span class="e-date">${esc(prettyDate(e.date))}</span>
      ${rel ? `<span class="e-rel">${esc(rel)}</span>` : ''}
    </div>
    ${e.title ? `<div class="e-title" style="color:${esc(au.color)}">${esc(e.title)}</div>` : ''}
    <div class="e-content" style="color:${esc(au.color)}">${parasHtml}</div>
    ${mediaStripHtml((e.media || []).filter(m => !m.deleted), e.id, 'entry')}
    <div class="e-meta">
      <span>${esc(clockTime(e.createdAt))} 写下${e.edited ? ` · ${esc(clockTime(e.updatedAt))} 编辑过` : ''}</span>
      <span class="spacer"></span>
      <button class="e-act" data-act="edit">编辑</button>
      <button class="e-act del" data-act="del">删除</button>
    </div>`;

  card.querySelector('[data-act="edit"]').addEventListener('click', () => openCompose(e));
  card.querySelector('[data-act="del"]').addEventListener('click', () => removeEntry(e));

  card.querySelectorAll('.comment [data-cact]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cid = btn.closest('.comment').dataset.cid;
      if (btn.dataset.cact === 'del') removeComment(e.id, cid);
      else beginEditComment(card, e.id, cid);
    });
  });

  card.querySelectorAll('.para-comment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = card.querySelector(`.para-input[data-input="${btn.dataset.para}"]`);
      row.classList.toggle('hidden');
      if (!row.classList.contains('hidden')) {
        const ta = row.querySelector('textarea');
        autoGrow(ta);
        ta.focus();
      }
    });
  });
  card.querySelectorAll('.para-input .send').forEach(btn => {
    const submit = async () => {
      const row = btn.closest('.para-input');
      const ta = row.querySelector('textarea');
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      await addComment(e, parseInt(btn.dataset.para, 10), text);
    };
    btn.addEventListener('click', submit);
    btn.parentElement.querySelector('textarea').addEventListener('keydown', (ev) => {
      // 中文输入法按 Enter 是在选字（isComposing / keyCode 229），不拦住就会把半句话发出去。
      if (ev.isComposing || ev.keyCode === 229) return;
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(); }
    });
    btn.parentElement.querySelector('textarea').addEventListener('input', (ev) => autoGrow(ev.target));
  });

  card.querySelectorAll('.strip-thumb[data-media-id]').forEach(thumb => {
    thumb.addEventListener('click', () => {
      const allMedia = (e.media || []).filter(m => !m.deleted);
      const items = allMedia.map((m, i) => ({ m, entryId: e.id, date: e.date, author: m.author || e.author, source: 'entry' }));
      const idx = items.findIndex(it => it.m.id === thumb.dataset.mediaId);
      if (idx >= 0) openAlbumViewer(items, idx);
    });
  });

  return card;
}

function commentHtml(c) {
  const au = state.authors[c.author];
  // 只有作者本人能改自己的留言：留言是对方写给我的话，我无权代改。
  const mine = c.author === me;
  return `<div class="comment" data-cid="${esc(c.id)}" style="border-left-color:${esc(au.color)}">
    <div class="c-head">
      <span class="c-author" style="color:${esc(au.color)}">${esc(au.name)}</span>
      <span class="c-time">${esc(fmtStamp(c.createdAt))}${c.edited ? ' · 已编辑' : ''}</span>
      ${mine ? `<span class="spacer"></span>
      <button class="c-act" data-cact="edit">编辑</button>
      <button class="c-act del" data-cact="del">删除</button>` : ''}
    </div>
    <div class="c-text">${esc(c.text)}</div>
    ${mediaStripHtml((c.media || []).filter(m => !m.deleted), c.id, 'comment')}
  </div>`;
}

function fmtStamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const day = keyOf(d);
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (day === todayKey()) return `今天 ${t}`;
  const rel = relLabel(day);
  if (rel) return `${rel} ${t}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${t}`;
}

async function addComment(e, paraIdx, text) {
  // 卡片闭包里的 e 可能已经被一次同步换成了新对象，必须按 id 取回 state 里的那一条，
  // 否则留言写进了游离对象，push 上去的数据里根本没有它。
  const target = liveEntry(e.id);
  if (!target) { showToast('这篇日记刚刚被改动了，请再试一次'); render(); return; }
  const now = new Date().toISOString();
  target.comments = mergeComments(target.comments, [normComment({
    id: newId(), para: paraIdx, author: me, text: text, createdAt: now
  })]);
  target.updatedAt = now;
  state.entries = sortEntries(state.entries);
  render();
  openParaInput(target.id, paraIdx);
  try {
    await push(`留言于 ${target.date} 的日记`);
    showToast('留言已发送');
    render();
    openParaInput(target.id, paraIdx);
  } catch (err) {
    showConnBanner('留言失败：' + err.message);
  }
}

/* ---------------- 留言编辑 / 删除 ---------------- */
// 下面每一个改动都先按 id 从 state 里重取对象，绝不碰卡片闭包里的引用 ——
// 一次静默同步就可能把它换成游离对象，写进去等于没写（这个坑已经踩过一次）。
function liveEntry(id) {
  return (state && state.entries || []).find(x => x.id === id) || null;
}
function findComment(entryId, cid) {
  const t = liveEntry(entryId);
  if (!t) return null;
  return (t.comments || []).find(c => c.id === cid) || null;
}
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}
function openParaInput(entryId, para, focus) {
  const row = document.querySelector(`.entry[data-id="${entryId}"] .para-input[data-input="${para}"]`);
  if (!row) return;
  row.classList.remove('hidden');
  const ta = row.querySelector('textarea');
  autoGrow(ta);
  // focus 只在用户主动点「留言」时为真：发完之后强行拉起手机键盘反而烦人。
  if (focus) ta.focus();
}

function beginEditComment(card, entryId, cid) {
  const c = findComment(entryId, cid);
  if (!c) { render(); return; }
  // 用遍历而不是 CSS 选择器定位：id 内容不必假设对选择器安全。
  const node = [...card.querySelectorAll('.comment')].find(n => n.dataset.cid === cid);
  if (!node || node.querySelector('textarea')) return;

  const ta = document.createElement('textarea');
  ta.className = 'c-edit';
  ta.maxLength = 500;
  ta.value = c.text;
  const row = document.createElement('div');
  row.className = 'c-edit-act';
  row.innerHTML = `<button class="c-act" data-save>保存</button><button class="c-act" data-cancel>取消</button>`;
  node.querySelector('.c-text').replaceWith(ta);
  node.appendChild(row);
  node.querySelectorAll('[data-cact]').forEach(b => { b.disabled = true; });
  autoGrow(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const save = () => saveCommentEdit(entryId, cid, ta.value);
  const cancel = () => render();
  row.querySelector('[data-save]').addEventListener('click', save);
  row.querySelector('[data-cancel]').addEventListener('click', cancel);
  ta.addEventListener('input', () => autoGrow(ta));
  ta.addEventListener('keydown', (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); save(); }
    else if (ev.key === 'Escape') cancel();
  });
}

async function saveCommentEdit(entryId, cid, text) {
  text = String(text || '').trim();
  const c = findComment(entryId, cid);
  const target = liveEntry(entryId);
  if (!c || !target) { showToast('这条留言刚刚被改动了，请再试一次'); render(); return; }
  if (!text) { showToast('留言不能是空的'); return; }
  if (text === c.text) { render(); return; }
  const now = new Date().toISOString();
  c.text = text.slice(0, 500);
  c.edited = true;
  c.updatedAt = now;          // LWW 靠这个时间戳决定谁的版本活下来
  target.updatedAt = now;
  render();
  openParaInput(target.id, c.para);
  try {
    await push(`编辑了 ${target.date} 日记里的一条留言`);
    showToast('留言已更新');
    render();
    openParaInput(target.id, c.para);
  } catch (err) {
    showConnBanner('保存失败：' + err.message);
  }
}

async function removeComment(entryId, cid) {
  const c = findComment(entryId, cid);
  const target = liveEntry(entryId);
  if (!c || !target) { render(); return; }
  const who = state.authors[c.author].name;
  const brief = c.text.length > 40 ? c.text.slice(0, 40) + '…' : c.text;
  if (!confirm(`删除这条留言？\n\n${who}：${brief}`)) return;
  const now = new Date().toISOString();
  // 只打墓碑，不真删：对方设备上的旧副本要靠它来判负，硬删会让留言在下次合并时复活。
  c.deleted = true;
  c.deletedAt = now;
  c.updatedAt = now;
  target.updatedAt = now;
  state.entries = sortEntries(state.entries);
  render();
  try {
    await push(`删除了 ${target.date} 日记里的一条留言`);
    showToast('留言已删除');
    render();
  } catch (err) {
    showConnBanner('删除失败：' + err.message);
  }
}

function renderSettingsInfo() {
  if (!state) return;
  $('#nameA').value = state.authors.a.name;
  $('#nameB').value = state.authors.b.name;
  $('#nameAColor').value = state.authors.a.color;
  $('#nameBColor').value = state.authors.b.color;

  const live = liveEntries();
  const total = live.length;
  const ca = live.filter(e => e.author === 'a').length;
  const cb = total - ca;
  $('#statsBox').innerHTML = `
    <div>共 <b>${total}</b> 篇日记</div>
    <div><span style="color:${esc(state.authors.a.color)}">●</span> ${esc(state.authors.a.name)}：${ca} 篇</div>
    <div><span style="color:${esc(state.authors.b.color)}">●</span> ${esc(state.authors.b.name)}：${cb} 篇</div>`;

  $('#connInfo').textContent = cfg ? `${cfg.owner}/${cfg.repo} · ${DATA_PATH}` : '';

  $('#lockState').textContent = normLock(state.lock)
    ? '已设置：每次打开都要输密码，两台设备共用同一个密码。'
    : '未设置：连上数据仓库的设备可以直接看到日记。';

  paintAuthorOpts();
}

function paintAuthorOpts() {
  for (const k of ['a', 'b']) {
    const au = state.authors[k];
    const pick = $(k === 'a' ? '#pickA' : '#pickB');
    const setAs = $(k === 'a' ? '#setAsA' : '#setAsB');
    for (const el of [pick, setAs]) {
      el.textContent = `${au.name}${me === k ? '（我）' : ''}`;
      el.style.background = au.color;
    }
    pick.classList.toggle('active', composeAuthor === k);
    setAs.classList.toggle('active', me === k);
  }
}

/* ---------------- 交互：写 / 编辑 / 删 ---------------- */
function openCompose(entry) {
  editingId = entry ? entry.id : null;
  composeAuthor = entry ? entry.author : me;
  pendingMedia = [];
  $('#composeHeading').textContent = entry ? '编辑日记' : '写日记';
  $('#fDate').value = entry ? entry.date : (viewMode === 'day' ? selectedDate : todayKey());
  $('#fTitle').value = entry ? entry.title : '';
  $('#fContent').value = entry ? entry.content : '';
  $('#fMedia').value = '';
  paintComposePending();
  hideUploadStatus();
  paintAuthorOpts();
  $('#composeSheet').classList.remove('hidden');
  setTimeout(() => $('#fContent').focus(), 60);
}
function closeCompose() {
  for (const pm of pendingMedia) { if (pm.preview) URL.revokeObjectURL(pm.preview); }
  pendingMedia = [];
  $('#composeSheet').classList.add('hidden');
}

function paintComposePending() {
  const box = $('#composePending');
  box.innerHTML = '';
  for (let i = 0; i < pendingMedia.length; i++) {
    const pm = pendingMedia[i];
    const div = document.createElement('div');
    div.className = 'pending-thumb';
    const img = document.createElement('img');
    img.src = pm.preview;
    div.appendChild(img);
    const rm = document.createElement('button');
    rm.className = 'pending-rm';
    rm.textContent = '✕';
    rm.addEventListener('click', () => { if (pm.preview) URL.revokeObjectURL(pm.preview); pendingMedia.splice(i, 1); paintComposePending(); });
    div.appendChild(rm);
    box.appendChild(div);
  }
}
function showUploadStatus(text, isError) {
  const el = $('#composeUploadStatus');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  el.classList.remove('hidden');
}
function hideUploadStatus() { $('#composeUploadStatus').classList.add('hidden'); }

async function saveCompose() {
  const content = $('#fContent').value.trim();
  if (!content && !pendingMedia.length && !(editingId && liveEntry(editingId) && (liveEntry(editingId).media || []).filter(m => !m.deleted).length)) {
    showToast('正文不能为空，或至少添加一张照片'); return;
  }
  const date = $('#fDate').value || todayKey();
  const title = $('#fTitle').value.trim();
  const now = new Date().toISOString();

  let newMediaItems = [];
  if (pendingMedia.length) {
    showUploadStatus('正在上传 ' + pendingMedia.length + ' 张照片…');
    const result = await putMediaFiles(pendingMedia.map(p => p.file));
    newMediaItems = result.items;
    if (result.errors.length) {
      showUploadStatus('部分照片上传失败：' + result.errors.join('；'), true);
      if (!newMediaItems.length) return;
    }
  }

  if (editingId) {
    const e = liveEntry(editingId);
    if (!e) { showToast('这篇日记已不存在'); closeCompose(); return; }
    e.date = date; e.title = title; e.content = content;
    e.author = composeAuthor;
    e.updatedAt = now; e.edited = true;
    if (newMediaItems.length) {
      e.media = mergeMedia(e.media || [], newMediaItems);
    }
  } else {
    const entry = normEntry({
      id: newId(), date, title, content, author: composeAuthor,
      createdAt: now, updatedAt: now, edited: false,
      media: newMediaItems
    });
    state.entries = sortEntries([...(state.entries || []), entry]);
  }
  state.entries = sortEntries(state.entries);
  hideUploadStatus();
  closeCompose();
  render();
  try {
    await push(editingId ? `编辑 ${date} 的日记` : `新增 ${date} 的日记`);
    showToast('已保存');
    render();
  } catch (e) {
    showConnBanner('保存失败：' + e.message);
  }
}

async function removeEntry(e) {
  if (!confirm(`删除 ${prettyDate(e.date)} 的这篇日记？此操作会同步到对方。`)) return;
  const target = (state.entries || []).find(x => x.id === e.id);
  if (!target) return;
  target.deleted = true;
  target.updatedAt = new Date().toISOString();
  state.entries = sortEntries(state.entries);
  render();
  try {
    await push(`删除 ${e.date} 的一篇日记`);
    showToast('已删除');
    render();
  } catch (err) {
    showConnBanner('删除失败：' + err.message);
  }
}

function newId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ---------------- 设置 ---------------- */
async function saveNames() {
  state.authors = normAuthors({
    a: { name: $('#nameA').value, color: $('#nameAColor').value },
    b: { name: $('#nameB').value, color: $('#nameBColor').value }
  });
  state.authorsRev = new Date().toISOString();
  state.authorsTouched = true;
  render();
  try {
    await push('更新作者昵称');
    showToast('已保存');
  } catch (e) { showConnBanner('保存失败：' + e.message); }
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `diary-backup-${todayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  showToast('已导出');
}

async function importJson(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { showToast('文件不是有效的 JSON'); return; }
  const incoming = Array.isArray(data) ? data : (data.entries || []);
  if (!incoming.length) { showToast('备份里没有日记'); return; }
  const before = (state.entries || []).length;
  state = mergeStates(state, { entries: incoming, authors: data.authors, authorsRev: data.authorsRev || '', authorsTouched: !!data.authorsTouched });
  render();
  try {
    await push(`导入备份（${incoming.length} 篇）`);
    showToast(`导入完成，现有 ${state.entries.length} 篇（原有 ${before} 篇）`);
  } catch (e) { showConnBanner('导入失败：' + e.message); }
}

function resetConn() {
  if (!confirm('清除这台设备上的令牌与缓存？日记数据仍在 GitHub 仓库里。')) return;
  localStorage.removeItem(LS_CFG);
  localStorage.removeItem(LS_CACHE);
  localStorage.removeItem(LS_SEEN);
  try { sessionStorage.removeItem(SS_UNLOCK); } catch (e) { /* ignore */ }
  location.reload();
}

/* ---------------- 提示 ---------------- */
let toastTimer = null;
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
function showConnBanner(msg) {
  const b = $('#connBanner');
  b.textContent = msg;
  b.classList.remove('hidden');
}
function hideConnBanner() { $('#connBanner').classList.add('hidden'); }
function setSyncing(on) {
  $('#syncBtn').classList.toggle('spinning', on);
}

/* ---------------- 启动 ---------------- */
function showApp() {
  $('#setup').classList.add('hidden');
  $('#lock').classList.add('hidden');
  $('#app').classList.remove('hidden');
}
function showSetup() {
  $('#app').classList.add('hidden');
  $('#setup').classList.remove('hidden');
}

async function connect(owner, repo, token) {
  cfg = { owner, repo, token };
  const repoRes = await api(`repos/${owner}/${repo}`);
  if (!repoRes.ok) throw new Error(githubMsg(repoRes));

  const got = await loadRemote({ fresh: true });
  if (got.missing) {
    // 空仓库：不急着创建文件，等第一次真正写下内容时再建
    state = defaultState();
  } else {
    state = mergeStates(got.state, null);
    remoteSha = got.sha;
  }
  localStorage.setItem(LS_CFG, JSON.stringify(cfg));
  saveCache();
  seedSeen();
}

async function boot() {
  const now = new Date();
  calYear = now.getFullYear(); calMonth = now.getMonth();

  const cached = loadCache();
  try { cfg = JSON.parse(localStorage.getItem(LS_CFG) || 'null'); } catch (e) { cfg = null; }

  if (!(cfg && cfg.token)) { showSetup(); return; }

  seedSeen();
  state = cached ? cached.state : defaultState();
  if (cached) remoteSha = cached.sha;

  // 本机已知设了密码：先挡住界面，密码对了才显示日记
  if (needLock()) { showLock(); return; }

  if (cached) { showApp(); render(); }

  try {
    const changed = await pull();
    hideConnBanner();
    // 同步后才发现对方设了密码：立刻挡住
    if (needLock()) { showLock(); return; }
    showApp();
    render();
    startPolling();
    if (changed && !cached) showToast('已连接');
    // 启动后刷一次红点，但不弹 toast、不推进 seen
    if (changed) {
      const since = seenStamp();
      if (since && !seenSeededThisBoot) {
        const events = collectEvents(since);
        paintBadge(events.length);
      }
    }
  } catch (e) {
    if (cached) {
      showConnBanner('连接失败：' + e.message + '（显示的是本机缓存）');
      showApp(); render(); startPolling();
    } else {
      showConnBanner('连接失败：' + e.message);
      showSetup();
    }
  }
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $('#sConnect').addEventListener('click', async () => {
    const owner = $('#sOwner').value.trim();
    const repo = $('#sRepo').value.trim();
    const token = $('#sToken').value.trim();
    const errBox = $('#setupError');
    errBox.classList.add('hidden');
    if (!owner || !repo || !token) {
      errBox.textContent = '三项都要填写。';
      errBox.classList.remove('hidden');
      return;
    }
    const btn = $('#sConnect');
    btn.disabled = true; btn.textContent = '连接中…';
    try {
      await connect(owner, repo, token);
      const now = new Date();
      calYear = now.getFullYear(); calMonth = now.getMonth();
      showToast('连接成功');
      if (needLock()) showLock();
      else { showApp(); render(); startPolling(); }
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false; btn.textContent = '连接';
    }
  });

  $('#identityChip').addEventListener('click', () => {
    me = me === 'a' ? 'b' : 'a';
    localStorage.setItem(LS_ME, me);
    render();
    showToast(`切换为「${state.authors[me].name}」`);
  });

  $('#prevMonth').addEventListener('click', () => {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar();
  });
  $('#nextMonth').addEventListener('click', () => {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar();
  });
  $('#todayBtn').addEventListener('click', () => {
    const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth();
    selectedDate = todayKey(); viewMode = 'day'; render();
  });
  $('#allBtn').addEventListener('click', () => { viewMode = 'all'; render(); });

  $('#composeFab').addEventListener('click', () => openCompose(null));
  $('#emptyWrite').addEventListener('click', () => openCompose(null));
  $('#cancelCompose').addEventListener('click', closeCompose);
  $('#saveCompose').addEventListener('click', saveCompose);
  $('#composeSheet').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) closeCompose(); });

  $('#pickA').addEventListener('click', () => { composeAuthor = 'a'; paintAuthorOpts(); });
  $('#pickB').addEventListener('click', () => { composeAuthor = 'b'; paintAuthorOpts(); });

  $('#fMedia').addEventListener('change', (ev) => {
    const files = ev.target.files;
    if (!files || !files.length) return;
    for (const f of files) {
      pendingMedia.push({ file: f, preview: URL.createObjectURL(f) });
    }
    ev.target.value = '';
    paintComposePending();
  });

  $('#settingsBtn').addEventListener('click', () => { renderSettingsInfo(); $('#settingsSheet').classList.remove('hidden'); });
  $('#closeSettings').addEventListener('click', () => $('#settingsSheet').classList.add('hidden'));
  $('#settingsSheet').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) $('#settingsSheet').classList.add('hidden'); });

  $('#notifBtn').addEventListener('click', () => openNotifSheet());
  $('#closeNotif').addEventListener('click', () => $('#notifSheet').classList.add('hidden'));
  $('#notifSheet').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) $('#notifSheet').classList.add('hidden'); });

  $('#albumBtn').addEventListener('click', openAlbum);
  $('#closeAlbum').addEventListener('click', closeAlbum);
  $('#albumWinAll').addEventListener('click', openAlbum);
  $('#albumFilters').addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-filter]');
    if (!btn) return;
    albumFilter = btn.dataset.filter;
    renderAlbum();
  });

  $('#closeViewer').addEventListener('click', closeViewer);
  $('#pvDelete').addEventListener('click', removeMedia);
  $('#photoViewer').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget || ev.target.id === 'pvBody') closeViewer(); });

  // 滑动切换照片：pointerdown/pointerup 水平阈值 40px
  let pvSwipeX = null;
  $('#pvBody').addEventListener('pointerdown', (ev) => { pvSwipeX = ev.clientX; });
  $('#pvBody').addEventListener('pointerup', (ev) => {
    if (pvSwipeX == null) return;
    const dx = ev.clientX - pvSwipeX;
    pvSwipeX = null;
    if (Math.abs(dx) < 40) return;
    if (dx < 0 && viewerIndex < viewerItems.length - 1) { viewerIndex++; showViewerItem(); }
    else if (dx > 0 && viewerIndex > 0) { viewerIndex--; showViewerItem(); }
  });

  $('#saveNames').addEventListener('click', saveNames);
  $('#setAsA').addEventListener('click', () => { me = 'a'; localStorage.setItem(LS_ME, me); render(); });
  $('#setAsB').addEventListener('click', () => { me = 'b'; localStorage.setItem(LS_ME, me); render(); });

  $('#exportBtn').addEventListener('click', exportJson);
  $('#importFile').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) importJson(f);
    ev.target.value = '';
  });
  $('#resetConn').addEventListener('click', resetConn);

  $('#lkUnlock').addEventListener('click', tryUnlock);
  $('#lkPass').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') tryUnlock(); });
  $('#saveLock').addEventListener('click', saveLock);

  $('#syncBtn').addEventListener('click', async () => {
    setSyncing(true);
    try {
      const changed = await pull();
      hideConnBanner();
      render();
      showToast(changed ? '已同步到最新' : '已是最新');
    } catch (e) {
      showConnBanner('同步失败：' + e.message);
    } finally {
      setSyncing(false);
    }
  });

  const wakeSync = () => {
    remoteEtag = null;
    silentSync();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wakeSync();
  });
  window.addEventListener('focus', wakeSync);
  window.addEventListener('pageshow', wakeSync);
}

bind();
boot();

// 测试暴露：只在模拟环境（_mock.js 已加载）下把内部函数挂到 window，供 evaluate_script 验证。
if (window.__mock) {
  window.__test = {
    normEntry, normComment, normMedia,
    mergeComments, mergeMedia, mergeStates,
    stableCommentId, fnv1a, lwwMerge,
    pruneTombstones,
    liveEntries, liveEntry, findComment,
    collectEvents, seenStamp, paintBadge,
    bufToB64, b64ToBuf, fmtBytes,
    compressPhoto, compressToBlob, compressThumb,
    putMediaOne, putMediaFiles,
    getMediaBuf, idbPut, idbGet, getObjectUrl,
    semAcquire, semRelease,
    albumItems, findMediaItem, mediaStripHtml,
    renderAlbum, renderAlbumWindow, openAlbum, closeAlbum,
    openAlbumViewer, closeViewer, removeMedia, setupMediaObserver,
    getState: function () { return state; },
    setState: function (s) { state = s; },
    getCfg: function () { return cfg; },
    setCfg: function (c) { cfg = c; },
    getMe: function () { return me; },
    setMe: function (m) { me = m; }
  };
}
