// Two interchangeable backends with the same methods:
//  - HttpBackend talks to the Quire Worker (the real thing).
//  - DemoBackend runs the whole "server" inside the browser, so the app can be previewed anywhere.
//    Two tabs of the demo behave like two devices.
import { sampleProject } from './sample-novel.js';
import { importTree } from './format.js';

class Offline extends Error { constructor(m) { super(m); this.offline = true; } }

export class HttpBackend {
  constructor(base = '/api') { this.base = base; this.kind = 'live'; }
  async req(path, opts = {}) {
    let r;
    try { r = await fetch(this.base + path, { ...opts, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }); }
    catch (e) { throw new Offline('No connection'); }
    if (r.status === 401 || r.status === 403 || r.redirected) throw new Error('Signed out. Reload the page to sign in again.');
    const j = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
    if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
    return j;
  }
  me() { return this.req('/me'); }
  books() { return this.req('/books'); }
  createBook(slug, title) { return this.req('/books', { method: 'POST', body: JSON.stringify({ slug, title }) }); }
  state(slug, since) { return this.req(`/book/${slug}/state?since=${since}`); }
  ops(slug, body) { return this.req(`/book/${slug}/ops`, { method: 'POST', body: JSON.stringify(body) }); }
  importRepo(slug, o) { return this.req(`/book/${slug}/import`, { method: 'POST', body: JSON.stringify(o) }); }
  config(slug, o) { return this.req(`/book/${slug}/config`, { method: 'POST', body: JSON.stringify(o) }); }
  snapshot(slug) { return this.req(`/book/${slug}/snapshot`, { method: 'POST' }); }
  history(slug, kind, key) { return this.req(`/book/${slug}/history?kind=${encodeURIComponent(kind)}&key=${encodeURIComponent(key)}`); }
  historyItem(slug, id) { return this.req(`/book/${slug}/history/item?id=${encodeURIComponent(id)}`); }
  subscribe(slug, cb) {
    let ws, stopped = false, delay = 1000, ping, first = true;
    const connect = () => {
      if (stopped) return;
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${this.base}/book/${slug}/ws`);
      ws.onopen = () => { delay = 1000; if (!first) cb({ type: 'reconnected' }); first = false; ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25000); };
      ws.onmessage = e => { if (e.data !== 'pong') try { cb(JSON.parse(e.data)); } catch {} };
      ws.onclose = () => { clearInterval(ping); if (!stopped) setTimeout(connect, delay = Math.min(delay * 2, 30000)); };
    };
    connect();
    const wake = () => { if (document.visibilityState === 'visible' && ws?.readyState > 1) { delay = 1000; connect(); } };
    document.addEventListener('visibilitychange', wake);
    return () => { stopped = true; ws?.close(); document.removeEventListener('visibilitychange', wake); };
  }
}

// ---------------- demo ----------------
const KEY = 'quire-demo-server-v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class DemoBackend {
  constructor() {
    this.kind = 'demo'; this.offline = false;
    this.chan = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('quire-demo') : null;
    this.subs = new Set();
    this.chan && (this.chan.onmessage = e => this.subs.forEach(cb => cb(e.data)));
    this.load();
  }
  load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY)); } catch {}
    this.s = s || { seq: 0, books: {}, list: [] };
    if (!this.s.list.length) this.seed('keeper', sampleProject());
  }
  persist() { try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch {} }
  reset() { try { localStorage.removeItem(KEY); } catch {} this.s = null; this.load(); this.send({ type: 'reset', seq: this.book('keeper').seq }); }
  book(slug) { return this.s.books[slug] || (this.s.books[slug] = { seq: 0, title: '', beats: {}, files: {}, board: null, boardRev: 0, boardSeq: 0, snapshot: null, target: null, source: null }); }
  seed(slug, p) {
    const b = this.book(slug); b.seq++;
    b.beats = {}; b.files = {};
    for (const x of p.beats) b.beats[x.id] = { ...x, rev: 1, seq: b.seq, updated: Date.now(), by: 'import' };
    for (const [k, v] of Object.entries(p.files)) b.files[k] = { path: k, content: v, deleted: false, rev: 1, seq: b.seq };
    b.board = p.board; b.boardRev++; b.boardSeq = b.seq; b.title = p.title;
    b.target = { owner: 'you', repo: 'keepers-ledger', branch: 'main', path: '' };
    if (!this.s.list.find(x => x.slug === slug)) this.s.list.push({ slug, title: p.title });
    this.persist();
  }
  send(msg) { this.subs.forEach(cb => cb(msg)); this.chan?.postMessage(msg); }
  async net() { await sleep(120 + Math.random() * 150); if (this.offline) throw new Offline('Offline (demo)'); try { const s = JSON.parse(localStorage.getItem(KEY)); if (s) this.s = s; } catch {} }
  meta(b) { return { seq: b.seq, title: b.title, source: b.source, target: b.target, snapshot: b.snapshot, dirty: b.seq > (b.snapSeq || 0), empty: !Object.keys(b.beats).length }; }

  async me() { await this.net(); return { email: 'demo@quire.app', demo: true, snapshotMinutes: 30 }; }
  async books() { await this.net(); return this.s.list; }
  async createBook(slug, title) { await this.net(); if (!this.s.list.find(x => x.slug === slug)) this.s.list.push({ slug, title }); this.book(slug).title = title; this.persist(); return this.s.list; }
  async state(slug, since) {
    await this.net(); const b = this.book(slug);
    return {
      ...this.meta(b), full: since === 0,
      beats: Object.values(b.beats).filter(x => x.seq > since),
      files: Object.values(b.files).filter(x => x.seq > since),
      board: b.boardSeq > since ? { data: b.board, rev: b.boardRev } : null,
    };
  }
  async ops(slug, { ops, client }) {
    await this.net(); const b = this.book(slug); const results = [];
    for (const op of ops) {
      if (op.type === 'beat') {
        const cur = b.beats[op.id];
        if (cur && cur.rev !== op.baseRev) { results.push({ conflict: true, current: cur }); continue; }
        b.beats[op.id] = { ...(cur || {}), ...op.fields, id: op.id, rev: (cur?.rev || 0) + 1, seq: ++b.seq, updated: Date.now(), by: client };
        results.push({ ok: true, rev: b.beats[op.id].rev });
      } else if (op.type === 'file') {
        const cur = b.files[op.path];
        if (cur && cur.rev !== op.baseRev) { results.push({ conflict: true, current: cur }); continue; }
        b.files[op.path] = { path: op.path, content: op.content, deleted: !!op.deleted, rev: (cur?.rev || 0) + 1, seq: ++b.seq };
        results.push({ ok: true, rev: b.files[op.path].rev });
      } else if (op.type === 'board') {
        if (b.boardRev !== op.baseRev) { results.push({ conflict: true, current: { data: b.board, rev: b.boardRev } }); continue; }
        b.board = op.board; b.boardRev++; b.boardSeq = ++b.seq;
        results.push({ ok: true, rev: b.boardRev });
      }
    }
    this.persist();
    this.send({ type: 'changed', seq: b.seq, client, slug });
    return { results, seq: b.seq };
  }
  async importRepo(slug, o) {
    await this.net(); await sleep(600);
    const b = this.book(slug);
    if (Object.keys(b.beats).length && !o.force) throw new Error('This book already has content. Tick "Replace" to overwrite it.');
    let p;
    if (o.tree) p = importTree(o.tree, { title: o.title });
    else { p = sampleProject(); }
    if (o.title) p.title = o.title;
    this.seed(slug, p);
    b.source = { owner: o.owner || 'you', repo: o.repo || 'demo', branch: o.branch || 'main', path: o.path || '', layout: p.layout || 'quire', at: Date.now() };
    const li = this.s.list.find(x => x.slug === slug); if (li) li.title = p.title;
    this.persist(); this.send({ type: 'reset', seq: b.seq, slug });
    return { ...this.meta(b), beats: p.beats.length, files: Object.keys(p.files).length, layout: p.layout || 'quire' };
  }
  async config(slug, o) { await this.net(); const b = this.book(slug); if (o.title) b.title = o.title; if (o.target !== undefined) b.target = o.target; b.seq++; this.persist(); this.send({ type: 'changed', seq: b.seq, slug }); return this.meta(b); }
  async snapshot(slug) {
    await this.net(); await sleep(500); const b = this.book(slug);
    const files = Object.values(b.beats).filter(x => x.seq > (b.snapSeq || 0)).length;
    b.snapSeq = b.seq; b.snapshot = { at: Date.now(), sha: Math.random().toString(16).slice(2, 9), files, error: null };
    this.persist(); this.send({ type: 'meta', meta: this.meta(b), slug });
    return { sha: b.snapshot.sha, files };
  }
  async history() { await this.net(); return []; }
  async historyItem() { return { error: 'Version history needs the live app.' }; }
  subscribe(slug, cb) { const f = m => (!m.slug || m.slug === slug) && cb(m); this.subs.add(f); return () => this.subs.delete(f); }

  // Demo helper: pretend your Mac edited a beat.
  async remoteEdit(slug, id, fn) {
    const b = this.book(slug), cur = b.beats[id]; if (!cur) return;
    b.beats[id] = { ...cur, ...fn(cur), rev: cur.rev + 1, seq: ++b.seq, updated: Date.now(), by: 'mac' };
    this.persist(); this.send({ type: 'changed', seq: b.seq, client: 'mac', slug });
  }
}

export async function pickBackend() {
  const demo = new URLSearchParams(location.search).has('demo');
  let wasLive = false;
  try { wasLive = localStorage.getItem('quire-mode') === 'live'; } catch {}
  if (!demo) {
    try {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) {
        try { localStorage.setItem('quire-mode', 'live'); } catch {}
        return { backend: new HttpBackend(), me: await r.json() };
      }
    } catch {}
    // Opened offline on a device that has used the real app before: stay live and work from the phone's copy.
    if (wasLive) return { backend: new HttpBackend(), me: { offline: true } };
  }
  const d = new DemoBackend();
  return { backend: d, me: await d.me() };
}
