// Quire sync engine. Every edit is written to the phone (IndexedDB) immediately, then pushed to the
// live store a moment later. Pushes retry until confirmed; remote changes merge in line by line.
import { mergeBeat, mergeBoard, merge3, newId, placeNew, bookOrder, emptyBoard } from './format.js';

const BEAT_FIELDS = ['title', 'synopsis', 'adjust', 'beat', 'notes', 'deleted'];
const pick = (o, ks) => Object.fromEntries(ks.map(k => [k, o?.[k] ?? (k === 'deleted' ? false : '')]));
const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- IndexedDB (falls back to memory where storage is unavailable) ----------
function openDB() {
  return new Promise(res => {
    try {
      const r = indexedDB.open('quire', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('items', { keyPath: 'key' });
        s.createIndex('slug', 'slug');
        r.result.createObjectStore('books', { keyPath: 'slug' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}
const tx = (db, store, mode, fn) => new Promise((res, rej) => {
  if (!db) return res(null);
  const t = db.transaction(store, mode); const out = fn(t.objectStore(store));
  t.oncomplete = () => res(typeof IDBRequest !== 'undefined' && out instanceof IDBRequest ? out.result : out); t.onerror = () => rej(t.error);
});

export class Book extends EventTarget {
  constructor(slug, backend) {
    super();
    this.slug = slug; this.backend = backend;
    this.client = sessionStorageGet('quire-client') || newId(8);
    sessionStorageSet('quire-client', this.client);
    this.beats = new Map(); this.files = new Map();
    this.board = { server: null, local: null, base: null };
    this.seq = 0; this.meta = {}; this.status = 'loading'; this.lastError = null;
    this.pushTimer = null; this.pushing = false; this.again = false; this.backoff = 2000;
  }

  // ----- lifecycle -----
  async open() {
    this.db = await openDB();
    const items = await tx(this.db, 'items', 'readonly', s => s.index('slug').getAll(this.slug)) || [];
    for (const it of items) {
      if (it.kind === 'beat') this.beats.set(it.id, it);
      else if (it.kind === 'file') this.files.set(it.id, it);
      else if (it.kind === 'board') this.board = it;
    }
    const bk = await tx(this.db, 'books', 'readonly', s => s.get(this.slug));
    if (bk) { this.seq = Number(bk.seq) || 0; this.meta = bk.meta || {}; }
    this.emit();
    this.unsub = this.backend.subscribe(this.slug, msg => this.onMessage(msg));
    addEventListener('online', () => this.kick());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.pushNow(); else this.pull().then(() => this.kick());
    });
    await this.pull();
    this.kick();
  }
  close() { this.unsub?.(); clearTimeout(this.pushTimer); }

  emit(detail = {}) { this.dispatchEvent(new CustomEvent('change', { detail })); }
  setStatus(s, err) { if (this.status !== s || err) { this.status = s; this.lastError = err || null; this.dispatchEvent(new Event('status')); } }
  pending() {
    let n = 0;
    for (const it of this.beats.values()) if (it.local) n++;
    for (const it of this.files.values()) if (it.local) n++;
    if (this.board.local) n++;
    return n;
  }
  conflicts() { return [...this.beats.values()].filter(i => i.conflict).map(i => i.id); }

  save(it) {
    it.key = `${this.slug}|${it.kind}|${it.id}`; it.slug = this.slug;
    return tx(this.db, 'items', 'readwrite', s => s.put(clone(it))).catch(() => {});
  }
  saveMeta() { return tx(this.db, 'books', 'readwrite', s => s.put({ slug: this.slug, seq: this.seq, meta: this.meta })).catch(() => {}); }

  // ----- reading -----
  beat(id) {
    const it = this.beats.get(id); if (!it) return null;
    return { id, ...pick(it.server, BEAT_FIELDS), ...(it.local || {}), rev: it.server?.rev || 0, dirty: !!it.local, conflict: it.conflict || null };
  }
  allBeats() { return [...this.beats.keys()].map(id => this.beat(id)); }
  boardData() { return this.board.local || this.board.server?.data || emptyBoard(); }
  order() { return bookOrder(this.boardData(), this.allBeats()); }
  file(path) { const it = this.files.get(path); if (!it) return null; return { path, ...(it.server || {}), ...(it.local || {}), dirty: !!it.local }; }
  allFiles() { return [...this.files.keys()].map(p => this.file(p)).filter(f => !f.deleted).sort((a, b) => a.path.localeCompare(b.path)); }
  title() { return this.meta.title || 'Untitled'; }

  // ----- editing (instant local save) -----
  edit(id, changes) {
    let it = this.beats.get(id);
    if (!it) { it = { kind: 'beat', id, server: null, local: null, base: null }; this.beats.set(id, it); }
    if (!it.local) { it.local = pick(it.server, BEAT_FIELDS); it.base = it.server ? pick(it.server, BEAT_FIELDS) : null; }
    Object.assign(it.local, changes);
    this.save(it); this.emit({ id, local: true }); this.schedule();
  }
  createBeat(fields = {}, after = null) {
    const id = newId();
    this.edit(id, { title: 'New beat', synopsis: '', adjust: '', beat: '', notes: '', deleted: false, ...fields });
    this.editBoard(b => placeNew(b, id, after));
    return id;
  }
  retire(id, retired = true) {
    this.edit(id, { deleted: retired });
    this.editBoard(b => {
      b.trash = b.trash || {};
      if (retired && b.beats[id]) { b.trash[id] = b.beats[id]; delete b.beats[id]; }
      if (!retired && b.trash[id]) { b.beats[id] = b.trash[id]; delete b.trash[id]; }
      if (!retired && !b.beats[id]) placeNew(b, id);
    });
  }
  editBoard(fn) {
    const data = clone(this.boardData());
    if (!this.board.local) this.board.base = clone(this.board.server?.data || null);
    fn(data);
    this.board = { ...this.board, kind: 'board', id: 'board', local: data };
    this.save(this.board); this.emit({ board: true }); this.schedule();
  }
  editFile(path, content, deleted = false) {
    let it = this.files.get(path);
    if (!it) { it = { kind: 'file', id: path, server: null, local: null, base: null }; this.files.set(path, it); }
    if (!it.local) it.base = it.server ? { content: it.server.content } : null;
    it.local = { content, deleted };
    this.save(it); this.emit({ file: path }); this.schedule();
  }
  resolve(id, field, choice) {
    const it = this.beats.get(id); const c = it?.conflict?.[field]; if (!c) return;
    const v = choice === 'mine' ? c.mine : choice === 'theirs' ? c.theirs : `${c.mine}\n\n${c.theirs}`;
    delete it.conflict[field];
    if (!Object.keys(it.conflict).length) it.conflict = null;
    this.edit(id, { [field]: v });
  }

  // ----- pushing -----
  schedule(ms = 1200) {
    this.setStatus(navigator.onLine === false ? 'offline' : 'saving');
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.pushNow(), ms);
  }
  kick() { if (this.pending()) this.schedule(50); else if (this.status !== 'offline') this.setStatus('synced'); }

  async pushNow() {
    clearTimeout(this.pushTimer);
    if (this.pushing) { this.again = true; return; }
    const ops = [], refs = [];
    for (const it of this.beats.values()) if (it.local && !it.conflict) {
      ops.push({ type: 'beat', id: it.id, baseRev: it.server?.rev || 0, fields: clone(it.local) }); refs.push(it);
    }
    for (const it of this.files.values()) if (it.local) {
      ops.push({ type: 'file', path: it.id, baseRev: it.server?.rev || 0, content: it.local.content, deleted: it.local.deleted }); refs.push(it);
    }
    if (this.board.local) { ops.push({ type: 'board', baseRev: this.board.server?.rev || 0, board: clone(this.board.local) }); refs.push(this.board); }
    if (!ops.length) { this.setStatus(this.conflicts().length ? 'conflict' : 'synced'); return; }
    this.pushing = true; this.setStatus('saving');
    let retry = false;
    try {
      const { results, seq } = await this.backend.ops(this.slug, { ops, client: this.client });
      results.forEach((r, i) => { if (this.applyResult(refs[i], ops[i], r)) retry = true; });
      // Our own writes advance seq; if anything else happened in between, fetch it.
      if (seq === this.seq + results.filter(r => r.ok).length) this.seq = seq; else this.pull();
      this.saveMeta();
      this.backoff = 2000;
      this.setStatus(this.conflicts().length ? 'conflict' : this.pending() ? 'saving' : 'synced');
    } catch (e) {
      this.setStatus(navigator.onLine === false || e.offline ? 'offline' : 'error', e.message);
      this.pushTimer = setTimeout(() => this.pushNow(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60000);
    } finally {
      this.pushing = false;
      this.emit({ pushed: true });
      if (retry || this.again) { this.again = false; this.schedule(retry ? 50 : 800); }
    }
  }

  // Returns true if the item needs another push (after a clean merge).
  applyResult(it, op, r) {
    if (r.ok) {
      if (it.kind === 'beat') it.server = { ...op.fields, rev: r.rev };
      else if (it.kind === 'file') it.server = { content: op.content, deleted: op.deleted, rev: r.rev };
      else it.server = { data: op.board, rev: r.rev };
      const sent = it.kind === 'beat' ? op.fields : it.kind === 'file' ? { content: op.content, deleted: op.deleted } : op.board;
      if (same(it.local, sent)) { it.local = null; it.base = null; }
      else it.base = clone(sent);
      this.save(it);
      return false;
    }
    if (r.conflict) { this.mergeRemote(it, r.current); return !it.conflict; }
    return false;
  }

  // Bring a remote version into an item, merging with local edits if there are any.
  mergeRemote(it, remote) {
    if (it.kind === 'beat') {
      if (it.local) {
        const m = mergeBeat(it.base || {}, it.local, remote);
        it.local = m.fields;
        if (Object.keys(m.conflicts).length) it.conflict = { ...(it.conflict || {}), ...m.conflicts };
        it.base = pick(remote, BEAT_FIELDS);
        if (!it.conflict && same(pick(remote, BEAT_FIELDS), it.local)) { it.local = null; it.base = null; }
      }
      it.server = { ...pick(remote, BEAT_FIELDS), rev: remote.rev, updated: remote.updated, by: remote.by };
    } else if (it.kind === 'file') {
      if (it.local) {
        const m = merge3(it.base?.content || '', it.local.content, remote.content);
        it.local = { content: m.text, deleted: it.local.deleted };
        it.base = { content: remote.content };
      }
      it.server = { content: remote.content, deleted: remote.deleted, rev: remote.rev };
    } else {
      if (it.local) { it.local = mergeBoard(it.base || {}, it.local, remote.data || {}); it.base = clone(remote.data); }
      it.server = { data: remote.data, rev: remote.rev };
    }
    this.save(it);
  }

  // ----- pulling -----
  async pull(full = false) {
    try {
      const st = await this.backend.state(this.slug, full ? 0 : this.seq);
      if (st.full || full) {
        // Full load: anything the server no longer has (and we haven't touched) goes away.
        const ids = new Set(st.beats.map(b => b.id));
        for (const [id, it] of this.beats) if (!ids.has(id) && !it.local) { this.beats.delete(id); tx(this.db, 'items', 'readwrite', s => s.delete(`${this.slug}|beat|${id}`)); }
      }
      const touched = [];
      for (const b of st.beats) {
        let it = this.beats.get(b.id);
        if (!it) { it = { kind: 'beat', id: b.id, server: null, local: null, base: null }; this.beats.set(b.id, it); }
        if (it.server?.rev === b.rev) continue;
        this.mergeRemote(it, b); touched.push(b.id);
      }
      for (const f of st.files) {
        let it = this.files.get(f.path);
        if (!it) { it = { kind: 'file', id: f.path, server: null, local: null, base: null }; this.files.set(f.path, it); }
        if (it.server?.rev !== f.rev) this.mergeRemote(it, f);
      }
      if (st.board && st.board.rev !== this.board.server?.rev) { this.board.kind = 'board'; this.board.id = 'board'; this.mergeRemote(this.board, st.board); }
      this.seq = st.seq;
      this.meta = { title: st.title, source: st.source, target: st.target, snapshot: st.snapshot, dirty: st.dirty, empty: st.empty };
      this.saveMeta();
      this.emit({ remote: touched });
      if (this.status === 'loading' || this.status === 'offline' || this.status === 'error') this.setStatus(this.pending() ? 'saving' : 'synced');
      return touched;
    } catch (e) {
      this.setStatus(navigator.onLine === false || e.offline ? 'offline' : 'error', e.message);
      return [];
    }
  }

  onMessage(msg) {
    if (msg.type === 'changed' && msg.client !== this.client && msg.seq > this.seq) this.pull();
    else if (msg.type === 'reset') this.pull(true);
    else if (msg.type === 'meta') { Object.assign(this.meta, msg.meta); this.emit({ meta: true }); }
    else if (msg.type === 'hello' && msg.seq > this.seq) this.pull();
    else if (msg.type === 'reconnected') { this.pull(); this.kick(); }
  }
}

// Per-tab client id, so two tabs (or two devices) see each other's edits.
function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }
