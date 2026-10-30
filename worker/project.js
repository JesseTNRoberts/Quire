// One Durable Object per book: the live store. SQLite tables hold beats, other files and the board.
// Every change bumps a sequence number so devices can ask for "everything since N".
import { DurableObject } from 'cloudflare:workers';
import { exportTree, importTree } from '../public/format.js';
import { readRepo, writeCommit } from './github.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const hash = s => { let h = 0x811c9dc5, h2 = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h = Math.imul(h ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519) + 1; } return (h >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36); };

export class Project extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS beats (id TEXT PRIMARY KEY, title TEXT, synopsis TEXT, adjust TEXT, beat TEXT, notes TEXT,
        deleted INTEGER DEFAULT 0, rev INTEGER, seq INTEGER, updated INTEGER, by TEXT);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, content TEXT, deleted INTEGER DEFAULT 0, rev INTEGER, seq INTEGER, updated INTEGER);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE INDEX IF NOT EXISTS beats_seq ON beats(seq);
      CREATE INDEX IF NOT EXISTS files_seq ON files(seq);`);
  }

  get(k, d = null) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]; return r ? JSON.parse(r.v) : d; }
  put(k, v) { this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }
  nextSeq() { const s = this.get('seq', 0) + 1; this.put('seq', s); return s; }

  meta() {
    return {
      seq: this.get('seq', 0), title: this.get('title', ''), source: this.get('source'), target: this.get('target'),
      snapshot: this.get('snapshot', null), dirty: this.get('seq', 0) > this.get('snapshotSeq', 0),
      empty: !this.sql.exec('SELECT 1 FROM beats LIMIT 1').toArray().length && !this.get('board'),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    try {
      if (url.pathname === '/ws') return this.openSocket(request);
      if (route === 'GET /state') return json(this.state(Math.max(0, parseInt(url.searchParams.get('since'), 10) || 0)));
      if (route === 'POST /ops') return json(await this.applyOps(await request.json()));
      if (route === 'POST /import') return json(await this.importRepo(await request.json()));
      if (route === 'POST /config') return json(this.config(await request.json()));
      if (route === 'POST /snapshot') return json(await this.snapshot('Manual snapshot from Quire'));
      if (route === 'POST /load') return json(this.load(await request.json())); // seed from a tree (demo, tests)
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  state(since) {
    const beats = this.sql.exec('SELECT id, title, synopsis, adjust, beat, notes, deleted, rev, updated, by FROM beats WHERE seq > ?', since).toArray()
      .map(b => ({ ...b, deleted: !!b.deleted }));
    const files = this.sql.exec('SELECT path, content, deleted, rev FROM files WHERE seq > ?', since).toArray().map(f => ({ ...f, deleted: !!f.deleted }));
    const boardSeq = this.get('boardSeq', 0);
    return { ...this.meta(), beats, files, board: boardSeq > since ? { data: this.get('board'), rev: this.get('boardRev', 0) } : null, full: since === 0 };
  }

  async applyOps({ ops = [], client = '' }) {
    const results = [];
    const now = Date.now();
    for (const op of ops) {
      if (op.type === 'beat') {
        const cur = this.sql.exec('SELECT * FROM beats WHERE id = ?', op.id).toArray()[0];
        if (cur && cur.rev !== op.baseRev) { results.push({ conflict: true, current: { ...cur, deleted: !!cur.deleted } }); continue; }
        const f = { ...(cur || {}), ...op.fields };
        const rev = (cur?.rev || 0) + 1, seq = this.nextSeq();
        this.sql.exec(`INSERT INTO beats (id, title, synopsis, adjust, beat, notes, deleted, rev, seq, updated, by) VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title, synopsis=excluded.synopsis, adjust=excluded.adjust, beat=excluded.beat,
          notes=excluded.notes, deleted=excluded.deleted, rev=excluded.rev, seq=excluded.seq, updated=excluded.updated, by=excluded.by`,
          op.id, f.title ?? 'Untitled', f.synopsis ?? '', f.adjust ?? '', f.beat ?? '', f.notes ?? '', f.deleted ? 1 : 0, rev, seq, now, client);
        results.push({ ok: true, rev });
      } else if (op.type === 'file') {
        const cur = this.sql.exec('SELECT * FROM files WHERE path = ?', op.path).toArray()[0];
        if (cur && cur.rev !== op.baseRev) { results.push({ conflict: true, current: { ...cur, deleted: !!cur.deleted } }); continue; }
        const rev = (cur?.rev || 0) + 1, seq = this.nextSeq();
        this.sql.exec(`INSERT INTO files (path, content, deleted, rev, seq, updated) VALUES (?,?,?,?,?,?)
          ON CONFLICT(path) DO UPDATE SET content=excluded.content, deleted=excluded.deleted, rev=excluded.rev, seq=excluded.seq, updated=excluded.updated`,
          op.path, op.content ?? '', op.deleted ? 1 : 0, rev, seq, now);
        results.push({ ok: true, rev });
      } else if (op.type === 'board') {
        const rev = this.get('boardRev', 0);
        if (rev !== op.baseRev) { results.push({ conflict: true, current: { data: this.get('board'), rev } }); continue; }
        this.put('board', op.board); this.put('boardRev', rev + 1); this.put('boardSeq', this.nextSeq());
        results.push({ ok: true, rev: rev + 1 });
      } else if (op.type === 'title') {
        this.put('title', String(op.title || '').slice(0, 200)); this.nextSeq();
        results.push({ ok: true });
      } else results.push({ error: 'unknown op' });
    }
    const seq = this.get('seq', 0);
    if (results.some(r => r.ok)) { this.broadcast({ type: 'changed', seq, client }); await this.scheduleSnapshot(false); }
    return { results, seq };
  }

  // ----- live updates -----
  openSocket(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected websocket' }, 426);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: 'hello', seq: this.get('seq', 0) }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(ws, msg) { if (msg === 'ping') ws.send('pong'); }
  async webSocketClose(ws) {
    try { ws.close(); } catch {}
    // Last device left: snapshot soon ("end of session").
    if (this.ctx.getWebSockets().length <= 1) await this.scheduleSnapshot(true);
  }
  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) try { ws.send(s); } catch {}
  }

  // ----- GitHub -----
  config({ target, title }) {
    if (target !== undefined) this.put('target', target && { owner: target.owner, repo: target.repo, branch: target.branch || 'main', path: target.path || '' });
    if (title) this.put('title', title);
    this.nextSeq();
    this.broadcast({ type: 'changed', seq: this.get('seq', 0) });
    return this.meta();
  }

  load(project) {
    // Replace everything with `project` ({title, beats, board, files}).
    this.sql.exec('DELETE FROM beats'); this.sql.exec('DELETE FROM files');
    const seq = this.nextSeq(), now = Date.now();
    for (const b of project.beats) this.sql.exec('INSERT INTO beats (id, title, synopsis, adjust, beat, notes, deleted, rev, seq, updated, by) VALUES (?,?,?,?,?,?,?,1,?,?,?)',
      b.id, b.title, b.synopsis || '', b.adjust || '', b.beat || '', b.notes || '', b.deleted ? 1 : 0, seq, now, 'import');
    for (const [p, t] of Object.entries(project.files || {})) this.sql.exec('INSERT INTO files (path, content, deleted, rev, seq, updated) VALUES (?,?,0,1,?,?)', p, t, seq, now);
    this.put('board', project.board); this.put('boardRev', (this.get('boardRev', 0)) + 1); this.put('boardSeq', seq);
    this.put('title', project.title);
    this.broadcast({ type: 'reset', seq });
    return { ...this.meta(), beats: project.beats.length, files: Object.keys(project.files || {}).length };
  }

  async importRepo({ owner, repo, branch, path, force, title }) {
    if (!owner || !repo) throw new Error('owner and repo are required');
    if (!this.meta().empty && !force) throw new Error('This book already has content. Import again with "replace" ticked to overwrite it (a snapshot is taken first).');
    if (!this.meta().empty && this.get('target')) await this.snapshot('Snapshot before re-import');
    const src = { owner, repo, branch, path: path || '' };
    const { tree, sha, branch: br } = await readRepo(this.env, src);
    src.branch = br;
    const project = importTree(tree, { title: title || repo });
    if (title) project.title = title;
    const res = this.load(project);
    this.put('source', { ...src, sha, layout: project.layout, at: Date.now() });
    if (project.layout === 'quire') {
      // Same repo becomes the snapshot target; remember what it holds so the first snapshot only writes real changes.
      if (!this.get('target')) this.put('target', src);
      const t = this.get('target');
      if (t.owner === owner && t.repo === repo && (t.path || '') === (src.path || '')) {
        this.put('exported', Object.fromEntries(Object.entries(exportTree(project)).map(([p, s]) => [p, tree[p] === s ? hash(s) : '?'])));
      }
    }
    this.put('snapshotSeq', this.get('seq', 0));
    return { ...res, layout: project.layout };
  }

  current() {
    const beats = this.sql.exec('SELECT id, title, synopsis, adjust, beat, notes, deleted FROM beats').toArray().map(b => ({ ...b, deleted: !!b.deleted }));
    const files = Object.fromEntries(this.sql.exec('SELECT path, content FROM files WHERE deleted = 0').toArray().map(f => [f.path, f.content]));
    return { title: this.get('title', 'Untitled'), beats, board: this.get('board') || {}, files };
  }

  async snapshot(message) {
    const target = this.get('target');
    if (!target) return { skipped: 'No GitHub repo set for snapshots' };
    const seq = this.get('seq', 0);
    const tree = exportTree(this.current());
    const old = this.get('exported', {});
    const changes = {};
    for (const [p, s] of Object.entries(tree)) if (old[p] !== hash(s)) changes[p] = s;
    for (const p of Object.keys(old)) if (!(p in tree)) changes[p] = null;
    const n = Object.keys(changes).length;
    let sha = null;
    try {
      if (n) {
        const edited = Object.keys(changes).filter(p => p.startsWith('beats/')).length;
        sha = await writeCommit(this.env, target, changes, `${message}: ${n} file${n > 1 ? 's' : ''} (${edited} beat${edited === 1 ? '' : 's'})`);
        this.put('exported', Object.fromEntries(Object.entries(tree).map(([p, s]) => [p, hash(s)])));
      }
      this.put('snapshotSeq', seq);
      this.put('snapshot', { at: Date.now(), sha, files: n, error: null });
    } catch (e) {
      this.put('snapshot', { ...(this.get('snapshot') || {}), error: e.message, failedAt: Date.now() });
      throw e;
    } finally {
      this.broadcast({ type: 'meta', meta: this.meta() });
    }
    return { sha, files: n };
  }

  async scheduleSnapshot(soon) {
    if (!this.get('target')) return;
    const mins = Number(this.env.SNAPSHOT_MINUTES || 30);
    const at = Date.now() + (soon ? 2 : mins) * 60_000;
    const cur = await this.ctx.storage.getAlarm();
    if (!cur || (soon && at < cur)) await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    if (!this.meta().dirty) return;
    try { await this.snapshot('Quire snapshot'); }
    catch { await this.ctx.storage.setAlarm(Date.now() + 10 * 60_000); } // retry in 10 minutes
  }
}

// A tiny directory of books, so the app can list and switch between them.
export class Registry extends DurableObject {
  async fetch(request) {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS books (slug TEXT PRIMARY KEY, title TEXT, created INTEGER)');
    if (request.method === 'POST') {
      const { slug, title } = await request.json();
      sql.exec('INSERT INTO books (slug, title, created) VALUES (?,?,?) ON CONFLICT(slug) DO UPDATE SET title = excluded.title', slug, title || slug, Date.now());
    }
    return json(sql.exec('SELECT slug, title FROM books ORDER BY created').toArray());
  }
}

