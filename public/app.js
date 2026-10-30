// Quire app UI. Plain DOM, no build step.
import { pickBackend } from './backend.js';
import { Book } from './sync.js';
import { actOf, laneOf, CARD, manuscript, wordCount, exportTree } from './format.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const ago = t => { if (!t) return 'never'; const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };

const S = { view: ls.get('quire-view', 'book'), openId: null, openFile: null, tab: 'beat', filter: 'all', q: '', zoom: ls.get('quire-zoom', innerWidth < 700 ? 0.5 : innerWidth < 1200 ? 0.7 : 0.85), slug: ls.get('quire-book', null) };
let book, backend, me;
window.quire = { S, get book() { return book; }, get backend() { return backend; } }; // for debugging from the console

// ---------------- boot ----------------
(async function boot() {
  ({ backend, me } = await pickBackend());
  document.body.classList.toggle('demo', backend.kind === 'demo');
  let books = [];
  try { books = await backend.books(); ls.set('quire-books', books); } catch { books = ls.get('quire-books', []); }
  if (!S.slug || !books.find(b => b.slug === S.slug)) S.slug = books[0]?.slug || null;
  if (!S.slug) { S.slug = 'my-novel'; try { await backend.createBook('my-novel', 'My novel'); } catch {} S.view = 'settings'; }
  await openBook(S.slug);
  if ('serviceWorker' in navigator && backend.kind === 'live') navigator.serviceWorker.register('sw.js').catch(() => {});
  setInterval(watchdog, 30000);
})();

async function openBook(slug) {
  book?.close();
  S.slug = slug; ls.set('quire-book', slug); S.openId = null; closeEditor();
  book = new Book(slug, backend);
  let t;
  book.addEventListener('change', e => {
    syncEditor(e.detail);
    clearTimeout(t); t = setTimeout(renderMain, e.detail.local ? 400 : 30);
  });
  book.addEventListener('status', renderStatus);
  await book.open();
  if (book.meta.empty && !book.beats.size) S.view = 'settings';
  setView(S.view);
}

// ---------------- chrome ----------------
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });
$('#bookBtn').addEventListener('click', bookMenu);
$('#status').addEventListener('click', statusSheet);

function setView(v) {
  S.view = v; ls.set('quire-view', v);
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.view === v);
  document.body.dataset.view = v;
  $('#main').scrollTop = 0;
  renderMain(true);
}

function renderMain(fresh) {
  if (!book) return;
  $('#bookTitle').textContent = book.title();
  document.title = `${book.title()} · Quire`;
  const main = $('#main');
  if (S.view === 'book') renderBook(main, fresh);
  else if (S.view === 'board') renderBoard(main, fresh);
  else if (S.view === 'notes') renderNotes(main);
  else if (S.view === 'settings' && (fresh || !main.querySelector('.settings'))) renderSettings(main);
  renderStatus();
}

function renderStatus() {
  if (!book) return;
  const el = $('#status'), n = book.pending(), c = book.conflicts().length;
  let s = book.status, label = { loading: 'Loading', synced: 'Synced', saving: 'Saving', offline: 'Offline', error: 'Not synced', conflict: 'Needs your choice' }[s] || s;
  if (c) { s = 'conflict'; label = 'Needs your choice'; }
  if ((s === 'offline' || s === 'error') && n) label += ` · ${n} waiting`;
  el.dataset.s = s; $('span', el).textContent = label;
}

let unsyncedSince = null;
function watchdog() {
  if (!book) return;
  if (book.pending() && navigator.onLine !== false) {
    unsyncedSince ??= Date.now();
    if (Date.now() - unsyncedSince > 10 * 60_000) { toast('Some edits haven’t reached the server for 10 minutes. They are safe on this device. Tap the status to retry.', 8000); unsyncedSince = Date.now(); }
    book.kick();
  } else unsyncedSince = null;
}

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms);
}

function sheet(html, bind) {
  const el = $('#sheet');
  el.innerHTML = `<div class="scrim"></div><div class="panel" role="dialog">${html}</div>`;
  el.hidden = false;
  const close = () => { el.hidden = true; el.innerHTML = ''; };
  el.querySelector('.scrim').onclick = close;
  el.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  bind?.(el, close);
  return close;
}

function statusSheet() {
  const n = book.pending(), snap = book.meta.snapshot;
  sheet(`<h3>Sync</h3>
    <p class="big">${{ synced: 'Everything is saved on the server.', saving: 'Saving…', offline: 'You’re offline. Edits are saved on this device and will sync when you’re back.', error: 'Couldn’t reach the server. Edits are safe on this device.', conflict: 'Some beats need your choice.', loading: 'Loading…' }[book.status]}</p>
    ${book.lastError ? `<p class="muted">${esc(book.lastError)}</p>` : ''}
    <dl class="kv"><dt>Waiting to sync</dt><dd>${n} item${n === 1 ? '' : 's'}</dd>
    <dt>GitHub archive</dt><dd>${book.meta.target ? `${esc(book.meta.target.owner)}/${esc(book.meta.target.repo)} · ${snap?.at ? 'last snapshot ' + ago(snap.at) : 'no snapshot yet'}${snap?.error ? ' · <b class="bad">last attempt failed</b>' : ''}` : 'not set up'}</dd>
    <dt>Mode</dt><dd>${backend.kind === 'demo' ? 'Demo (everything stays in this browser)' : 'Live'}</dd></dl>
    ${book.conflicts().length ? `<p>Beats needing a choice: ${book.conflicts().map(id => `<a href="#" data-open="${id}">${esc(book.beat(id).title)}</a>`).join(', ')}</p>` : ''}
    <div class="row-btns"><button class="btn primary" id="syncNow">Sync now</button><button class="btn" data-close>Close</button></div>`,
    (el, close) => {
      $('#syncNow', el).onclick = async () => { await book.pull(); book.kick(); close(); };
      el.querySelectorAll('[data-open]').forEach(a => a.onclick = e => { e.preventDefault(); close(); openBeat(a.dataset.open); });
    });
}

async function bookMenu() {
  let books = ls.get('quire-books', []);
  try { books = await backend.books(); ls.set('quire-books', books); } catch {}
  sheet(`<h3>Books</h3><div class="list">${books.map(b => `<button class="item ${b.slug === S.slug ? 'on' : ''}" data-slug="${esc(b.slug)}">${esc(b.title || b.slug)}</button>`).join('')}</div>
    <form class="inline" id="nb"><input name="title" placeholder="New book title" required><button class="btn">Add</button></form>`,
    (el, close) => {
      el.querySelectorAll('[data-slug]').forEach(b => b.onclick = () => { close(); openBook(b.dataset.slug); });
      $('#nb', el).onsubmit = async e => {
        e.preventDefault(); const title = e.target.title.value.trim();
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'book';
        await backend.createBook(slug, title); await backend.config(slug, { title }).catch(() => {});
        close(); S.view = 'settings'; openBook(slug);
      };
    });
}

// ---------------- keyboard (desktop and tablets with keyboards) ----------------
addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (!$('#sheet').hidden) { $('#sheet').hidden = true; return; } if (!$('#editor').hidden) { closeEditor(); return; } }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !book) return;
  const views = ['book', 'board', 'notes', 'settings'];
  if (/^[1-4]$/.test(e.key)) { setView(views[e.key - 1]); e.preventDefault(); }
  else if (e.key === 'n' || e.key === 'N') { setView('book'); openBeat(book.createBeat({}, S.openId), true); e.preventDefault(); }
  else if (e.key === '/') { setView('book'); $('#q')?.focus(); e.preventDefault(); }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') && S.view === 'book') {
    const rows = [...document.querySelectorAll('#list .beatrow')]; if (!rows.length) return;
    const i = rows.findIndex(r => r.dataset.id === S.openId), d = e.key === 'ArrowDown' || e.key === 'j' ? 1 : -1;
    const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + d))];
    openBeat(next.dataset.id); next.scrollIntoView({ block: 'nearest' }); e.preventDefault();
  } else if (e.key === 'Enter' && S.openId) { $('#editor textarea:not([hidden])')?.focus(); e.preventDefault(); }
});

// ---------------- book (list) view ----------------
function laneColor(board, pos) { return pos ? laneOf(board, pos)?.color || '#888' : '#bbb'; }

function renderBook(main, fresh) {
  const board = book.boardData();
  let wrap = $('.bookview', main);
  if (!wrap || fresh) {
    main.innerHTML = `<div class="bookview">
      <div class="searchbar"><input type="search" id="q" placeholder="Search beats" value="${esc(S.q)}"></div>
      <div class="chips" id="filters">${[['all', 'All'], ['adjust', 'Claude adjust'], ['empty', 'Empty'], ['unsynced', 'Not synced'], ['retired', 'Retired']].map(([k, l]) => `<button data-f="${k}" class="${S.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div id="list"></div></div>
      <button class="fab" id="newBeat" aria-label="New beat"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>`;
    wrap = $('.bookview', main);
    $('#q', main).oninput = e => { S.q = e.target.value; renderList(); };
    $('#filters', main).onclick = e => { const b = e.target.closest('[data-f]'); if (!b) return; S.filter = b.dataset.f; main.querySelectorAll('#filters button').forEach(x => x.classList.toggle('on', x === b)); renderList(); };
    $('#newBeat', main).onclick = () => { const id = book.createBeat({}, S.openId); openBeat(id, true); };
  }
  renderList();

  function renderList() {
    const list = $('#list', main); if (!list) return;
    const q = S.q.trim().toLowerCase();
    let beats = S.filter === 'retired' ? book.allBeats().filter(b => b.deleted).sort((a, b) => a.title.localeCompare(b.title)) : book.order();
    if (S.filter === 'adjust') beats = beats.filter(b => b.adjust.trim());
    if (S.filter === 'empty') beats = beats.filter(b => !b.beat.trim());
    if (S.filter === 'unsynced') beats = beats.filter(b => b.dirty);
    if (q) beats = beats.filter(b => (b.title + '\n' + b.synopsis + '\n' + b.beat + '\n' + b.notes).toLowerCase().includes(q));
    const topics = new Map((board.topics || []).map(t => [t.id, t]));
    let html = '', lastAct = null, totalWords = 0;
    for (const b of beats) {
      const pos = board.beats?.[b.id] || board.trash?.[b.id];
      const act = pos && !b.deleted ? actOf(board, pos) : null;
      if (S.filter !== 'retired' && act && act.id !== lastAct) { html += `<h2 class="act"><span>${esc(act.name)}</span>${act.sub ? `<small>${esc(act.sub)}</small>` : ''}</h2>`; lastAct = act.id; }
      const words = wordCount(b.beat); totalWords += words;
      const tags = (pos?.tags || []).map(t => topics.get(t)).filter(Boolean);
      html += `<button class="beatrow ${S.openId === b.id ? 'on' : ''}" data-id="${b.id}" style="--lane:${laneColor(board, pos)}">
        <div class="t">${esc(b.title)}${b.conflict ? '<em class="badge bad">Needs choice</em>' : ''}${b.adjust.trim() ? '<em class="badge adj">Adjust</em>' : ''}${b.dirty ? '<i class="dot" title="Not synced yet"></i>' : ''}</div>
        ${b.synopsis ? `<div class="s">${esc(b.synopsis)}</div>` : ''}
        <div class="m">${pos ? esc(laneOf(board, pos)?.name || '') : ''}${tags.map(t => ` · <span style="color:${t.color}">${esc(t.name)}</span>`).join('')}${words ? ` · ${words.toLocaleString()} words` : ' · <span class="muted">empty</span>'}</div>
      </button>`;
    }
    if (!beats.length) html = `<div class="empty"><img src="icons/logo.svg" width="56" alt=""><p>${S.q || S.filter !== 'all' ? 'No beats match.' : 'No beats yet. Import a repo from Settings, or tap + to start.'}</p></div>`;
    else html += `<p class="foot muted">${beats.length} beats · ${totalWords.toLocaleString()} words</p>`;
    list.innerHTML = html;
    list.onclick = e => { const r = e.target.closest('.beatrow'); if (r) openBeat(r.dataset.id); };
  }
}

// ---------------- editor ----------------
const TABS = [['beat', 'Beat'], ['synopsis', 'Synopsis'], ['adjust', 'Claude adjust'], ['notes', 'Notes']];

function openBeat(id, focusTitle = false) {
  const b = book.beat(id); if (!b) return;
  S.openId = id; S.openFile = null;
  const ed = $('#editor'), wasOpen = !ed.hidden; ed.hidden = false; ed.dataset.kind = 'beat';
  document.body.classList.add('editing');
  const board = book.boardData(), pos = board.beats?.[id];
  ed.innerHTML = `
    <div class="edhead">
      <button class="icon" id="edBack" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>
      <input class="title" id="edTitle" value="${esc(b.title)}" aria-label="Title" spellcheck="true">
      <button class="icon" id="edMore" aria-label="More"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>
    </div>
    <div class="edmeta" id="edMeta"></div>
    <div class="conflict" id="edConflict" hidden></div>
    <div class="edtabs" id="edTabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''} ${k === 'adjust' ? 'adj' : ''}">${l}<i></i></button>`).join('')}</div>
    <div class="edbody">${TABS.map(([k]) => `<textarea data-field="${k}" class="${k === 'beat' ? 'prose' : ''} ${k === 'adjust' ? 'adjust' : ''}" ${S.tab === k ? '' : 'hidden'} spellcheck="true" placeholder="${{ beat: 'Write the beat…', synopsis: 'One or two sentences. The first works alone as a one-liner.', adjust: 'Instructions for Claude (optional)', notes: 'Notes, earlier versions, finished adjusts…' }[k]}"></textarea>`).join('')}</div>
    <div class="edfoot"><span id="edWords"></span><span id="edSaved"></span></div>`;
  for (const ta of ed.querySelectorAll('textarea')) {
    ta.value = b[ta.dataset.field] || '';
    ta.addEventListener('input', () => { book.edit(id, { [ta.dataset.field]: ta.value }); footer(); });
  }
  $('#edTitle').addEventListener('input', e => book.edit(id, { title: e.target.value }));
  $('#edBack').onclick = closeEditor;
  $('#edMore').onclick = () => beatMenu(id);
  $('#edTabs').onclick = e => { const t = e.target.closest('[data-tab]'); if (!t) return; S.tab = t.dataset.tab; ed.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === t)); ed.querySelectorAll('textarea').forEach(x => x.hidden = x.dataset.field !== S.tab); footer(); };
  editorMeta(); footer(); conflictBanner();
  if (focusTitle) { const t = $('#edTitle'); t.focus(); t.select(); }
  renderMain();
  history[wasOpen ? 'replaceState' : 'pushState']({ beat: id }, '');
}

addEventListener('popstate', () => { if (!$('#editor').hidden) closeEditor(true); });

function closeEditor(fromPop) {
  const ed = $('#editor'); if (ed.hidden) return;
  ed.hidden = true; ed.innerHTML = ''; document.body.classList.remove('editing');
  S.openId = null; S.openFile = null;
  book?.pushNow();
  renderMain();
  if (!fromPop && history.state?.beat) history.back();
}

function editorMeta() {
  const id = S.openId, board = book.boardData(), pos = board.beats?.[id], b = book.beat(id);
  const el = $('#edMeta'); if (!el) return;
  if (b.deleted) { el.innerHTML = `<span class="badge bad">Retired</span> <button class="link" id="restore">Restore</button>`; $('#restore').onclick = () => { book.retire(id, false); editorMeta(); }; return; }
  const act = pos && actOf(board, pos), lane = pos && laneOf(board, pos);
  const topics = new Map((board.topics || []).map(t => [t.id, t]));
  el.innerHTML = `${act ? esc(act.name) : ''}${lane ? ` · <span style="color:${lane.color}">●</span> ${esc(lane.name)}` : ''}${(pos?.tags || []).map(t => topics.get(t)).filter(Boolean).map(t => ` <span class="tag" style="--c:${t.color}">${esc(t.name)}</span>`).join('')}`;
}

function footer() {
  const b = book.beat(S.openId); if (!b) return;
  const words = $('#edWords'), saved = $('#edSaved');
  if (words) words.textContent = `${wordCount(b.beat).toLocaleString()} words`;
  if (saved) saved.textContent = b.dirty ? (book.status === 'offline' ? 'Saved on this device' : 'Saving…') : 'Synced';
  $('#editor')?.querySelectorAll('[data-tab]').forEach(t => t.classList.toggle('has', !!(b[t.dataset.tab] || '').trim()));
}

function conflictBanner() {
  const b = book.beat(S.openId), el = $('#edConflict'); if (!el || !b) return;
  if (!b.conflict) { el.hidden = true; return; }
  const [field, c] = Object.entries(b.conflict)[0];
  el.hidden = false;
  el.innerHTML = `<b>Needs your choice:</b> this beat’s ${TABS.find(t => t[0] === field)?.[1].toLowerCase() || field} was changed on another device while you edited it here.
    <details><summary>Compare</summary><div class="cmp"><div><h4>This device</h4><pre>${esc(c.mine)}</pre></div><div><h4>Other device</h4><pre>${esc(c.theirs)}</pre></div></div></details>
    <div class="row-btns"><button class="btn" data-c="mine">Keep mine</button><button class="btn" data-c="theirs">Take theirs</button><button class="btn" data-c="both">Keep both</button></div>`;
  el.querySelectorAll('[data-c]').forEach(x => x.onclick = () => { book.resolve(S.openId, field, x.dataset.c); syncEditor({}); conflictBanner(); });
}

// Bring remote changes into the open editor without losing the caret.
function syncEditor(detail) {
  const ed = $('#editor'); if (ed.hidden) return;
  if (ed.dataset.kind === 'file') {
    const f = book.file(S.openFile), ta = $('textarea', ed);
    if (f && ta && ta.value !== f.content) setKeepingCaret(ta, f.content || '');
    return;
  }
  const b = book.beat(S.openId); if (!b) return;
  for (const ta of ed.querySelectorAll('textarea')) {
    const v = b[ta.dataset.field] || '';
    if (ta.value !== v) setKeepingCaret(ta, v);
  }
  const t = $('#edTitle');
  if (t && t.value !== b.title && document.activeElement !== t) t.value = b.title;
  if (detail.remote?.includes(S.openId)) { ed.classList.remove('flash'); void ed.offsetWidth; ed.classList.add('flash'); }
  if (detail.board) editorMeta();
  footer(); conflictBanner();
}
function setKeepingCaret(ta, v) {
  const old = ta.value, s = ta.selectionStart, e = ta.selectionEnd, top = ta.scrollTop;
  let p = 0; while (p < old.length && p < v.length && old[p] === v[p]) p++;
  const d = v.length - old.length;
  ta.value = v;
  if (document.activeElement === ta) ta.setSelectionRange(s > p ? s + d : s, e > p ? e + d : e);
  ta.scrollTop = top;
}

function beatMenu(id) {
  const board = book.boardData(), b = book.beat(id);
  sheet(`<h3>${esc(b.title)}</h3><div class="list">
    <button class="item" data-a="earlier">Move earlier in the book</button>
    <button class="item" data-a="later">Move later in the book</button>
    <button class="item" data-a="lane">Move to stream…</button>
    <button class="item" data-a="tags">Tags…</button>
    <button class="item" data-a="insert">New beat after this one</button>
    <button class="item danger" data-a="retire">${b.deleted ? 'Restore beat' : 'Retire beat'}</button></div>
    <button class="btn" data-close>Close</button>`, (el, close) => {
    el.querySelectorAll('[data-a]').forEach(x => x.onclick = () => {
      const a = x.dataset.a; close();
      if (a === 'earlier' || a === 'later') moveBeat(id, a === 'earlier' ? -1 : 1);
      if (a === 'lane') pickLane(id);
      if (a === 'tags') pickTags(id);
      if (a === 'insert') openBeat(book.createBeat({}, id), true);
      if (a === 'retire') { book.retire(id, !b.deleted); if (!b.deleted) { toast('Beat retired. Find it under the Retired filter.'); closeEditor(); } else editorMeta(); }
    });
  });
}

function moveBeat(id, dir) {
  const order = book.order(), i = order.findIndex(b => b.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return toast(dir < 0 ? 'Already first.' : 'Already last.');
  const other = order[j].id;
  book.editBoard(bd => {
    const a = bd.beats[id], o = bd.beats[other];
    if (actOf(bd, a)?.id === actOf(bd, o)?.id) [a.x, o.x] = [o.x, a.x];
    else { a.x = o.x + (dir < 0 ? -1 : 1); }
    if (a.x === o.x) a.x += dir;
  });
  editorMeta(); toast(dir < 0 ? 'Moved earlier' : 'Moved later', 1200);
}

function pickLane(id) {
  const board = book.boardData();
  sheet(`<h3>Stream</h3><div class="list">${(board.lanes || []).map((l, n) => `<button class="item" data-n="${n}"><span style="color:${l.color}">●</span> ${esc(l.name)}</button>`).join('')}</div><button class="btn" data-close>Close</button>`,
    (el, close) => el.querySelectorAll('[data-n]').forEach(x => x.onclick = () => {
      book.editBoard(bd => { bd.beats[id].y = CARD.laneTop + Number(x.dataset.n) * CARD.laneH + 45; });
      close(); editorMeta();
    }));
}

function pickTags(id) {
  const board = book.boardData(), cur = new Set(board.beats?.[id]?.tags || []);
  sheet(`<h3>Tags</h3><div class="list">${(board.topics || []).map(t => `<label class="item"><input type="checkbox" value="${esc(t.id)}" ${cur.has(t.id) ? 'checked' : ''}> <span style="color:${t.color}">●</span> ${esc(t.name)}</label>`).join('') || '<p class="muted">No tags yet.</p>'}</div>
    <form class="inline" id="nt"><input name="name" placeholder="New tag"><button class="btn">Add</button></form><button class="btn primary" data-close>Done</button>`,
    (el) => {
      el.querySelectorAll('input[type=checkbox]').forEach(c => c.onchange = () => {
        book.editBoard(bd => { const t = new Set(bd.beats[id].tags || []); c.checked ? t.add(c.value) : t.delete(c.value); bd.beats[id].tags = [...t]; }); editorMeta();
      });
      $('#nt', el).onsubmit = e => {
        e.preventDefault(); const name = e.target.name.value.trim(); if (!name) return;
        const tid = 't' + Date.now().toString(36), colors = ['#C9822B', '#3E9A7E', '#B5523B', '#5B7DB1', '#8A6BB0', '#9A8A3E'];
        book.editBoard(bd => { bd.topics = [...(bd.topics || []), { id: tid, name, color: colors[(bd.topics || []).length % colors.length] }]; bd.beats[id].tags = [...(bd.beats[id].tags || []), tid]; });
        $('#sheet').hidden = true; pickTags(id); editorMeta();
      };
    });
}

// ---------------- board view ----------------
function renderBoard(main, fresh) {
  const board = book.boardData(), beats = book.allBeats().filter(b => !b.deleted);
  const lanes = board.lanes || [], z = S.zoom;
  let maxX = 0; for (const p of Object.values(board.beats || {})) maxX = Math.max(maxX, p.x);
  for (const a of board.acts || []) maxX = Math.max(maxX, a.x);
  const W = maxX + CARD.w + 300, H = CARD.laneTop + Math.max(1, lanes.length) * CARD.laneH + 60;
  const keepScroll = !fresh && $('.boardwrap', main) ? [$('.boardwrap', main).scrollLeft, $('.boardwrap', main).scrollTop] : null;
  const topics = new Map((board.topics || []).map(t => [t.id, t]));
  const center = id => { const p = board.beats[id]; return p && [p.x + CARD.w / 2, p.y + CARD.h / 2]; };
  main.innerHTML = `<div class="boardtools"><button class="btn" data-z="-">−</button><button class="btn" data-z="+">+</button><button class="btn" data-z="fit">Whole book</button><span class="muted hint">Drag cards to move · tap to open</span></div>
  <div class="boardwrap"><div class="sizer" style="width:${W * z}px;height:${H * z}px"><div class="canvas" style="width:${W}px;height:${H}px;transform:scale(${z})">
    ${lanes.map((l, n) => `<div class="lane" style="top:${CARD.laneTop + n * CARD.laneH}px;height:${CARD.laneH}px;--c:${l.color}"><span>${esc(l.name)}</span></div>`).join('')}
    ${(board.acts || []).map(a => `<div class="actline" style="left:${Math.max(0, a.x - 16)}px"><b>${esc(a.name)}</b><small>${esc(a.sub || '')}</small></div>`).join('')}
    ${(board.days || []).map(d => `<div class="dayline" style="left:${d.x - 8}px"><span>${esc(d.date || (d.days != null ? `+${d.days} days` : ''))}</span></div>`).join('')}
    ${(board.notes || []).map(n => `<div class="sticky" style="left:${n.x}px;top:${n.y}px;background:${n.color || '#F6E7A6'}">${esc(n.text)}</div>`).join('')}
    <svg class="links" width="${W}" height="${H}">${(board.links || []).map(l => { const a = center(l.from), b = center(l.to); return a && b ? `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" marker-end="url(#ah)"/>` : ''; }).join('')}<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z"/></marker></defs></svg>
    ${beats.map(b => { const p = board.beats?.[b.id]; if (!p) return ''; const lane = laneOf(board, p);
      return `<div class="card ${b.dirty ? 'dirty' : ''} ${S.openId === b.id ? 'on' : ''}" data-id="${b.id}" style="left:${p.x}px;top:${p.y}px;--lane:${lane?.color || '#888'}">
        <div class="ct">${esc(b.title)}</div><div class="cs">${esc(b.synopsis || b.beat.slice(0, 200))}</div>
        <div class="cm">${(p.tags || []).map(t => topics.get(t)).filter(Boolean).map(t => `<i style="background:${t.color}"></i>`).join('')}${b.adjust.trim() ? '<em>Adjust</em>' : ''}</div></div>`; }).join('')}
  </div></div></div>`;
  const wrap = $('.boardwrap', main);
  if (keepScroll) [wrap.scrollLeft, wrap.scrollTop] = keepScroll;
  main.querySelectorAll('[data-z]').forEach(b => b.onclick = () => {
    const k = b.dataset.z;
    S.zoom = k === 'fit' ? Math.max(0.15, Math.min(1, (wrap.clientWidth - 20) / W)) : Math.max(0.15, Math.min(1.4, S.zoom * (k === '+' ? 1.25 : 0.8)));
    ls.set('quire-zoom', S.zoom); renderBoard(main, true);
  });
  dragCards(wrap, z);
  wrap.addEventListener('wheel', e => {
    if (!e.ctrlKey) return; e.preventDefault();
    const r = wrap.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const wx = (wrap.scrollLeft + mx) / S.zoom, wy = (wrap.scrollTop + my) / S.zoom;
    S.zoom = Math.max(0.15, Math.min(1.4, S.zoom * Math.exp(-e.deltaY * 0.01)));
    const sizer = $('.sizer', wrap), canvas = $('.canvas', wrap);
    sizer.style.width = W * S.zoom + 'px'; sizer.style.height = H * S.zoom + 'px'; canvas.style.transform = `scale(${S.zoom})`;
    wrap.scrollLeft = wx * S.zoom - mx; wrap.scrollTop = wy * S.zoom - my;
    clearTimeout(renderBoard.t); renderBoard.t = setTimeout(() => { ls.set('quire-zoom', S.zoom); renderBoard(main); }, 250);
  }, { passive: false });
}

function dragCards(wrap, z) {
  let drag = null;
  wrap.addEventListener('pointerdown', e => {
    const card = e.target.closest('.card'); if (!card) return;
    const touch = e.pointerType === 'touch';
    drag = { card, id: card.dataset.id, sx: e.clientX, sy: e.clientY, x0: parseFloat(card.style.left), y0: parseFloat(card.style.top), live: false, pid: e.pointerId };
    if (touch) drag.timer = setTimeout(() => { if (drag) { drag.live = true; card.classList.add('lift'); navigator.vibrate?.(10); } }, 350);
  });
  wrap.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / z, dy = (e.clientY - drag.sy) / z;
    if (!drag.live) {
      if (Math.hypot(dx * z, dy * z) > 6) { if (e.pointerType === 'touch') { clearTimeout(drag.timer); drag = null; return; } drag.live = true; drag.card.classList.add('lift'); }
      else return;
    }
    e.preventDefault();
    try { drag.card.setPointerCapture(drag.pid); } catch {}
    drag.card.style.left = drag.x0 + dx + 'px'; drag.card.style.top = drag.y0 + dy + 'px';
  });
  wrap.addEventListener('touchmove', e => { if (drag?.live) e.preventDefault(); }, { passive: false });
  const end = e => {
    if (!drag) return;
    clearTimeout(drag.timer);
    const { card, id, live } = drag; drag = null;
    card.classList.remove('lift');
    if (!live) { if (e.type === 'pointerup') openBeat(id); return; }
    const x = Math.round(parseFloat(card.style.left)), y = parseFloat(card.style.top);
    const n = Math.max(0, Math.floor((y + CARD.h / 2 - CARD.laneTop) / CARD.laneH));
    book.editBoard(bd => { bd.beats[id] = { ...bd.beats[id], x: Math.max(0, x), y: CARD.laneTop + Math.min(n, (bd.lanes || [1]).length - 1) * CARD.laneH + 45 }; });
  };
  wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);
}

// ---------------- notes view ----------------
function renderNotes(main) {
  const files = book.allFiles();
  const groups = {};
  for (const f of files) { const g = f.path.includes('/') ? f.path.split('/')[0] : 'other'; (groups[g] ||= []).push(f); }
  const order = ['notes', 'claude', 'chats', ...Object.keys(groups).filter(g => !['notes', 'claude', 'chats'].includes(g))];
  main.innerHTML = `<div class="notesview">${order.filter(g => groups[g]).map(g => `<h2 class="act"><span>${esc({ notes: 'Notes', claude: 'Claude instructions', chats: 'Claude chats', other: 'Other files' }[g] || g)}</span></h2>
    ${groups[g].map(f => `<button class="beatrow" data-path="${esc(f.path)}" style="--lane:#9aa"><div class="t">${esc(f.path.split('/').slice(1).join('/') || f.path)}${f.dirty ? '<i class="dot"></i>' : ''}</div><div class="s">${esc((f.content || '').slice(0, 140))}</div></button>`).join('')}`).join('') || '<div class="empty"><p>No notes yet.</p></div>'}</div>
    <button class="fab" id="newNote" aria-label="New note"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>`;
  main.querySelectorAll('[data-path]').forEach(b => b.onclick = () => openFile(b.dataset.path));
  $('#newNote', main).onclick = () => sheet(`<h3>New note</h3><form class="inline" id="nn"><input name="n" placeholder="Name, e.g. Timeline" required autofocus><button class="btn primary">Create</button></form>`, (el, close) => {
    $('#nn', el).onsubmit = e => { e.preventDefault(); const p = `notes/${e.target.n.value.trim().replace(/[\/\\:*?"<>|]/g, ' ')}.md`; book.editFile(p, ''); close(); openFile(p); };
  });
}

function openFile(path) {
  const f = book.file(path); if (!f) return;
  S.openFile = path; S.openId = null;
  const ed = $('#editor'), wasOpen = !ed.hidden; ed.hidden = false; ed.dataset.kind = 'file'; document.body.classList.add('editing');
  ed.innerHTML = `<div class="edhead"><button class="icon" id="edBack" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button><div class="title static">${esc(path)}</div><button class="icon" id="edDel" aria-label="Delete note"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg></button></div>
    <div class="edbody"><textarea class="prose" spellcheck="true"></textarea></div><div class="edfoot"><span></span><span id="edSaved"></span></div>`;
  const ta = $('textarea', ed); ta.value = f.content || '';
  ta.oninput = () => book.editFile(path, ta.value);
  $('#edBack').onclick = closeEditor;
  $('#edDel').onclick = () => { if (confirmTwice($('#edDel'))) { book.editFile(path, f.content || '', true); closeEditor(); toast('Note removed. It stays in the GitHub history.'); } };
  history[wasOpen ? 'replaceState' : 'pushState']({ beat: path }, '');
}
function confirmTwice(btn) { if (btn.dataset.armed) return true; btn.dataset.armed = 1; btn.classList.add('armed'); toast('Tap again to confirm'); setTimeout(() => { delete btn.dataset.armed; btn.classList.remove('armed'); }, 3000); return false; }

// ---------------- settings ----------------
function renderSettings(main) {
  const m = book.meta, t = m.target || {}, src = m.source, snap = m.snapshot;
  const beats = book.allBeats().filter(b => !b.deleted);
  const ios = /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone;
  main.innerHTML = `<div class="settings">
    ${backend.kind === 'demo' ? `<section class="card demo"><h3>Demo mode</h3><p>Everything here runs in your browser, with a sample novel. Open this page in a second tab to see two “devices” sync live.</p>
      <div class="row-btns"><button class="btn" id="dEdit">Simulate an edit from your Mac</button><button class="btn" id="dOff">${backend.offline ? 'Go back online' : 'Go offline'}</button><button class="btn" id="dReset">Reset demo</button></div></section>` : ''}
    ${ios ? `<section class="card"><h3>Install on your iPhone</h3><p>In Safari tap <b>Share</b> → <b>Add to Home Screen</b>. Quire then opens full-screen and works offline.</p></section>` : ''}
    <section class="card"><h3>This book</h3>
      <form class="stack" id="fTitle"><label>Title<input name="title" value="${esc(book.title())}"></label><button class="btn">Save title</button></form>
      <p class="muted">${beats.length} beats · ${beats.reduce((n, b) => n + wordCount(b.beat), 0).toLocaleString()} words${src ? ` · imported from ${esc(src.owner)}/${esc(src.repo)} (${esc(src.layout)}) ${ago(src.at)}` : ''}</p></section>
    <section class="card"><h3>GitHub archive</h3>
      <p class="muted">Quire snapshots the book into this repo every ${(m => m === 1 ? 'minute' : m + ' minutes')(me.snapshotMinutes || 30)} while you write, and a couple of minutes after you stop. ${snap?.at ? `Last snapshot ${ago(snap.at)}${snap.files ? ` (${snap.files} file${snap.files === 1 ? '' : 's'})` : ''}.` : 'No snapshot yet.'}${snap?.error ? ` <b class="bad">Last attempt failed: ${esc(snap.error)}</b>` : ''}</p>
      <form class="grid" id="fTarget">
        <label>Owner<input name="owner" value="${esc(t.owner || '')}" placeholder="JesseTNRoberts" autocapitalize="off"></label>
        <label>Repo<input name="repo" value="${esc(t.repo || '')}" placeholder="gale-house" autocapitalize="off"></label>
        <label>Branch<input name="branch" value="${esc(t.branch || 'main')}" autocapitalize="off"></label>
        <label>Folder (optional)<input name="path" value="${esc(t.path || '')}" autocapitalize="off"></label>
        <div class="row-btns span2"><button class="btn">Save</button><button class="btn primary" type="button" id="snapNow" ${t.repo ? '' : 'disabled'}>Snapshot now</button></div></form></section>
    <section class="card"><h3>Import a beat-novel repo</h3>
      <p class="muted">Pulls a whole repo into this book. Works with Quire repos (<code>beats/</code>) and Scrivener sync folders like Gale House (<code>Draft/</code>, <code>Notes/</code>, <code>*board.json</code>) pushed to GitHub.</p>
      <form class="grid" id="fImport">
        <label>Owner<input name="owner" required autocapitalize="off"></label>
        <label>Repo<input name="repo" required autocapitalize="off"></label>
        <label>Branch<input name="branch" placeholder="default" autocapitalize="off"></label>
        <label>Folder (optional)<input name="path" autocapitalize="off"></label>
        <label class="span2">Book title (optional)<input name="title"></label>
        <label class="check span2"><input type="checkbox" name="force"> Replace this book’s current content</label>
        <div class="row-btns span2"><button class="btn primary">Import</button></div></form>
      ${backend.kind === 'demo' ? '<p class="muted">In the demo, importing loads the sample novel again, or pick a folder from your computer: <input type="file" id="dFolder" webkitdirectory multiple></p>' : ''}</section>
    <section class="card"><h3>Export</h3>
      <div class="row-btns"><button class="btn" id="exMs">Manuscript (.md)</button><button class="btn" id="exOut">Outline of synopses (.md)</button><button class="btn" id="exZip">Whole book as repo (.zip)</button></div>
      <p class="muted">For Word or EPUB, run the <b>Compile manuscript</b> action in the GitHub repo.</p></section>
    <section class="card"><h3>About</h3><p class="muted">Quire 0.1 · ${backend.kind === 'demo' ? 'demo' : 'signed in as ' + esc(me.email || 'you')} · book id <code>${esc(S.slug)}</code></p></section>
  </div>`;
  const busy = async (btn, fn) => { const l = btn.textContent; btn.disabled = true; btn.textContent = 'Working…'; try { await fn(); } catch (e) { toast(e.message, 6000); } finally { btn.disabled = false; btn.textContent = l; } };
  $('#fTitle').onsubmit = e => { e.preventDefault(); busy(e.submitter || $('#fTitle button'), async () => { const title = e.target.title.value.trim(); await backend.config(S.slug, { title }); await backend.createBook(S.slug, title); book.meta.title = title; renderMain(); toast('Saved'); }); };
  $('#fTarget').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); busy($('#fTarget button'), async () => { const target = f.get('repo') ? Object.fromEntries(f) : null; await backend.config(S.slug, { target }); await book.pull(); renderSettings(main); toast('Archive repo saved'); }); };
  $('#snapNow').onclick = e => busy(e.target, async () => { await book.pushNow(); const r = await backend.snapshot(S.slug); await book.pull(); renderSettings(main); toast(r.skipped || (r.files ? `Snapshot committed: ${r.files} file${r.files > 1 ? 's' : ''}` : 'Nothing new to snapshot')); });
  $('#fImport').onsubmit = e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); f.force = !!f.force; busy($('#fImport .primary'), async () => { const r = await backend.importRepo(S.slug, f); await book.pull(true); setView('book'); toast(`Imported ${r.beats} beats and ${r.files} files (${r.layout})`, 4000); }); };
  $('#exMs').onclick = () => download(`${book.title()}.md`, manuscript(project()));
  $('#exOut').onclick = () => download(`${book.title()} outline.md`, manuscript(project(), { include: 'synopsis' }));
  $('#exZip').onclick = () => download(`${book.title()}.zip`, zip(exportTree(project())), 'application/zip');
  if (backend.kind === 'demo') {
    $('#dEdit').onclick = () => {
      const target = S.openId || book.order()[0]?.id;
      backend.remoteEdit(S.slug, target, cur => ({ notes: (cur.notes ? cur.notes + '\n\n' : '') + `Author's notes, ${new Date().toISOString().slice(0, 10)}:\n\nAdded from the Mac at ${new Date().toLocaleTimeString()}.` }));
      toast(`Your “Mac” added a note to “${book.beat(target).title}”`);
    };
    $('#dOff').onclick = () => { backend.offline = !backend.offline; if (!backend.offline) { book.pull(); book.kick(); } else book.setStatus('offline'); renderSettings(main); };
    $('#dReset').onclick = async e => { if (!confirmTwice(e.target)) return; backend.reset(); await book.pull(true); setView('book'); };
    $('#dFolder').onchange = async e => {
      const tree = {};
      for (const file of e.target.files) { const p = file.webkitRelativePath.split('/').slice(1).join('/'); if (/\.(md|txt|json)$/i.test(p)) tree[p] = await file.text(); }
      try { const r = await backend.importRepo(S.slug, { tree, force: true, title: e.target.files[0]?.webkitRelativePath.split('/')[0] }); await book.pull(true); setView('book'); toast(`Imported ${r.beats} beats (${r.layout})`); } catch (err) { toast(err.message, 6000); }
    };
  }
}

function project() {
  const files = Object.fromEntries(book.allFiles().map(f => [f.path, f.content || '']));
  return { title: book.title(), beats: book.allBeats(), board: book.boardData(), files };
}
function download(name, data, type = 'text/markdown') {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Minimal ZIP writer (stored, no compression) for the offline backup download.
function zip(tree) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = d => { let c = ~0; for (const b of d) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return ~c >>> 0; };
  const u16 = n => [n & 255, n >> 8 & 255], u32 = n => [n & 255, n >> 8 & 255, n >> 16 & 255, n >>> 24];
  for (const [p, t] of Object.entries(tree)) {
    const name = enc.encode(p), data = enc.encode(t), c = crc(data);
    const head = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(c), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    parts.push(new Uint8Array([...u32(0x04034b50), ...head]), name, data);
    central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...head, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), name);
    off += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0), n = Object.keys(tree).length;
  return new Blob([...parts, ...central, new Uint8Array([...u32(0x06054b50), 0, 0, 0, 0, ...u16(n), ...u16(n), ...u32(cdSize), ...u32(off), 0, 0])]);
}
