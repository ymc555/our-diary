'use strict';

/* ============================================================
   我们的日记 —— 纯静态前端，数据存私有 GitHub 仓库的 diary.json
   ============================================================ */

const LS_CFG   = 'ourdiary.cfg';      // { owner, repo, token }
const LS_ME    = 'ourdiary.me';       // 'a' | 'b'
const LS_CACHE = 'ourdiary.cache';    // 最近一次已知状态，用于秒开

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
let pollTimer = null;

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

/* ---------------- 状态与合并 ---------------- */
function defaultState() {
  return {
    version: 1,
    authorsRev: new Date().toISOString(),
    authors: {
      a: { name: '小满', color: '#d97757' },
      b: { name: '小谷', color: '#4a7fa5' }
    },
    entries: []
  };
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
    comments: Array.isArray(e.comments) ? e.comments.map(normComment) : []
  };
}
function normComment(c) {
  return {
    id: String(c.id || newId()),
    para: Math.max(0, parseInt(c.para, 10) || 0),
    author: c.author === 'b' ? 'b' : 'a',
    text: String(c.text || '').slice(0, 500),
    createdAt: String(c.createdAt || new Date().toISOString())
  };
}
function mergeComments(x, y) {
  const m = new Map();
  for (const c of [...(x || []), ...(y || [])]) {
    const n = normComment(c);
    if (!m.has(n.id)) m.set(n.id, n);
  }
  return [...m.values()].sort((p, q) => (p.createdAt || '').localeCompare(q.createdAt || ''));
}
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
    const base = (e.updatedAt || '') > (prev.updatedAt || '') ? e : prev;
    base.comments = mergeComments(prev.comments, e.comments);
    byId.set(e.id, base);
  }
  const pickY = (y.authorsRev || '') >= (x.authorsRev || '');
  return {
    version: 1,
    authorsRev: (pickY ? y.authorsRev : x.authorsRev) || new Date().toISOString(),
    authors: normAuthors(pickY ? y.authors : x.authors),
    entries: sortEntries([...byId.values()])
  };
}
function liveEntries() {
  return (state.entries || []).filter(e => !e.deleted);
}
function pruneTombstones() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  state.entries = (state.entries || []).filter(e => {
    if (!e.deleted) return true;
    const t = Date.parse(e.updatedAt);
    return isNaN(t) || t > cutoff;
  });
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

async function loadRemote() {
  const headers = {};
  if (remoteEtag) headers['If-None-Match'] = remoteEtag;
  const res = await api(`repos/${cfg.owner}/${cfg.repo}/contents/${DATA_PATH}`, { headers });
  if (res.status === 304) return { unchanged: true };
  if (res.status === 404) return { missing: true };
  if (!res.ok) throw new Error(githubMsg(res));
  remoteEtag = res.etag || remoteEtag;
  remoteSha = res.json.sha;
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
  const got = await loadRemote();
  if (got.unchanged) return false;
  if (got.missing) {
    // 远端还没有数据文件：把本地状态推上去作为种子
    await push('初始化日记本');
    return true;
  }
  remoteSha = got.sha;
  const merged = mergeStates(got.state, state);
  const changed = JSON.stringify(merged) !== JSON.stringify(state);
  state = merged;
  saveCache();
  return changed;
}

async function push(message) {
  pushing = true;
  setSyncing(true);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      let sha = null;
      try {
        const got = await loadRemote();
        if (!got.missing && !got.unchanged) {
          state = mergeStates(got.state, state);
          sha = got.sha;
        } else if (!got.missing) {
          sha = remoteSha;
        }
      } catch (e) {
        if (attempt === 3) throw e;
      }
      pruneTombstones();
      const payload = {
        message,
        content: b64encodeUtf8(JSON.stringify(state, null, 2))
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
  try {
    const before = new Set(liveEntries().map(e => e.id));
    const changed = await pull();
    hideConnBanner();
    if (changed) {
      const added = liveEntries().filter(e => !before.has(e.id));
      render();
      const other = added.filter(e => e.author !== me);
      if (other.length) {
        const who = state.authors[other[0].author].name;
        showToast(`「${who}」写了 ${other.length} 篇新日记`);
      }
    }
  } catch (e) {
    showConnBanner('同步失败：' + e.message);
  }
}

/* ---------------- 渲染 ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function render() {
  if (!state) return;
  renderIdentity();
  renderCalendar();
  renderList();
  renderSettingsInfo();
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

function entryCard(e) {
  const au = state.authors[e.author];
  const card = document.createElement('article');
  card.className = 'entry';
  card.style.borderLeftColor = au.color;

  const rel = relLabel(e.date);
  const paras = String(e.content || '').split('\n');
  const parasHtml = paras.map((p, i) => {
    const comments = (e.comments || []).filter(c => c.para === i);
    return `<div class="para" data-para="${i}">
      <div class="para-text">${esc(p) || '&nbsp;'}</div>
      <div class="para-actions">
        <button class="para-comment-btn" data-para="${i}">留言${comments.length ? ` ${comments.length}` : ''}</button>
      </div>
      <div class="para-comments">${comments.map(c => commentHtml(c)).join('')}</div>
      <div class="para-input hidden" data-input="${i}">
        <input type="text" maxlength="500" placeholder="对这段话留言…">
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
    <div class="e-meta">
      <span>${esc(clockTime(e.createdAt))} 写下${e.edited ? ` · ${esc(clockTime(e.updatedAt))} 编辑过` : ''}</span>
      <span class="spacer"></span>
      <button class="e-act" data-act="edit">编辑</button>
      <button class="e-act del" data-act="del">删除</button>
    </div>`;

  card.querySelector('[data-act="edit"]').addEventListener('click', () => openCompose(e));
  card.querySelector('[data-act="del"]').addEventListener('click', () => removeEntry(e));

  card.querySelectorAll('.para-comment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = card.querySelector(`.para-input[data-input="${btn.dataset.para}"]`);
      row.classList.toggle('hidden');
      if (!row.classList.contains('hidden')) row.querySelector('input').focus();
    });
  });
  card.querySelectorAll('.para-input .send').forEach(btn => {
    const submit = async () => {
      const row = btn.closest('.para-input');
      const input = row.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      await addComment(e, parseInt(btn.dataset.para, 10), text);
    };
    btn.addEventListener('click', submit);
    btn.parentElement.querySelector('input').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });
  });
  return card;
}

function commentHtml(c) {
  const au = state.authors[c.author];
  return `<div class="comment" style="border-left-color:${esc(au.color)}">
    <div class="c-head">
      <span class="c-author" style="color:${esc(au.color)}">${esc(au.name)}</span>
      <span class="c-time">${esc(fmtStamp(c.createdAt))}</span>
    </div>
    <div class="c-text">${esc(c.text)}</div>
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
  e.comments = e.comments || [];
  e.comments.push(normComment({ id: newId(), para: paraIdx, author: me, text, createdAt: new Date().toISOString() }));
  e.comments = mergeComments(e.comments, []);
  e.updatedAt = new Date().toISOString();
  state.entries = sortEntries(state.entries);
  render();
  try {
    await push(`留言于 ${e.date} 的日记`);
    showToast('留言已发送');
    render();
  } catch (err) {
    showConnBanner('留言失败：' + err.message);
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
  $('#composeHeading').textContent = entry ? '编辑日记' : '写日记';
  $('#fDate').value = entry ? entry.date : (viewMode === 'day' ? selectedDate : todayKey());
  $('#fTitle').value = entry ? entry.title : '';
  $('#fContent').value = entry ? entry.content : '';
  paintAuthorOpts();
  $('#composeSheet').classList.remove('hidden');
  setTimeout(() => $('#fContent').focus(), 60);
}
function closeCompose() { $('#composeSheet').classList.add('hidden'); }

async function saveCompose() {
  const content = $('#fContent').value.trim();
  if (!content) { showToast('正文不能为空'); return; }
  const date = $('#fDate').value || todayKey();
  const title = $('#fTitle').value.trim();
  const now = new Date().toISOString();

  if (editingId) {
    const e = (state.entries || []).find(x => x.id === editingId);
    if (!e) { showToast('这篇日记已不存在'); closeCompose(); return; }
    e.date = date; e.title = title; e.content = content;
    e.author = composeAuthor;
    e.updatedAt = now; e.edited = true;
  } else {
    state.entries = sortEntries([...(state.entries || []), normEntry({
      id: newId(), date, title, content, author: composeAuthor,
      createdAt: now, updatedAt: now, edited: false
    })]);
  }
  state.entries = sortEntries(state.entries);
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
  state = mergeStates(state, { entries: incoming, authors: data.authors, authorsRev: '' });
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

  const got = await loadRemote();
  if (got.missing) {
    state = defaultState();
    await push('初始化日记本');
  } else {
    state = mergeStates(got.state, null);
    remoteSha = got.sha;
  }
  localStorage.setItem(LS_CFG, JSON.stringify(cfg));
  saveCache();
}

async function boot() {
  const now = new Date();
  calYear = now.getFullYear(); calMonth = now.getMonth();

  const cached = loadCache();
  try { cfg = JSON.parse(localStorage.getItem(LS_CFG) || 'null'); } catch (e) { cfg = null; }

  if (cfg && cfg.token) {
    if (cached) { state = cached.state; remoteSha = cached.sha; showApp(); render(); }
    else { state = defaultState(); showApp(); }
    try {
      const changed = await pull();
      hideConnBanner();
      render();
      startPolling();
      if (changed && !cached) showToast('已连接');
    } catch (e) {
      showConnBanner('连接失败：' + e.message + '（显示的是本机缓存）');
      if (!cached) showSetup();
    }
    return;
  }
  showSetup();
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
      showApp(); render(); startPolling();
      showToast('连接成功');
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

  $('#settingsBtn').addEventListener('click', () => { renderSettingsInfo(); $('#settingsSheet').classList.remove('hidden'); });
  $('#closeSettings').addEventListener('click', () => $('#settingsSheet').classList.add('hidden'));
  $('#settingsSheet').addEventListener('click', (ev) => { if (ev.target === ev.currentTarget) $('#settingsSheet').classList.add('hidden'); });

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
