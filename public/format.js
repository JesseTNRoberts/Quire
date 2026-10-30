// Quire shared format library. Used by the app, the Worker and the scripts.
// No dependencies; runs in browsers, Cloudflare Workers and Node.

export const FORMAT = 'quire-1';
export const NOTES_MARK = '=== Notes ===';
export const FIELDS = ['title', 'synopsis', 'adjust', 'beat', 'notes', 'deleted'];

// ---------- beat text <-> fields ----------

// Layout (identical to the Gale House Storyboard):
// Synopsis: <syn>\n\nClaude adjust:\n\n<adjust>\n\n---\n\n<beat>\n\n=== Notes ===\n\n<notes>
export function splitBeat(text) {
  text = String(text ?? '').replace(/\r\n?/g, '\n');
  const out = { synopsis: '', adjust: '', beat: '', notes: '' };
  let rest = text;
  const dash = /(^|\n)---(\n|$)/.exec(text);
  if (text.startsWith('Synopsis:') && dash) {
    const header = text.slice(0, dash.index);
    rest = text.slice(dash.index + dash[0].length);
    if (rest.startsWith('\n')) rest = rest.slice(1);
    const adj = /(^|\n)Claude adjust:(\n|$)/.exec(header);
    const synPart = adj ? header.slice(0, adj.index) : header;
    out.synopsis = synPart.replace(/^Synopsis: ?/, '').replace(/\n+$/, '');
    if (adj) out.adjust = header.slice(adj.index + adj[0].length).replace(/^\n/, '').replace(/\n+$/, '');
  }
  const nm = /(^|\n)=== Notes ===(\n|$)/.exec(rest);
  if (nm) {
    let b = rest.slice(0, nm.index);
    if (b.endsWith('\n')) b = b.slice(0, -1);
    out.beat = b;
    let n = rest.slice(nm.index + nm[0].length);
    if (n.startsWith('\n')) n = n.slice(1);
    out.notes = n;
  } else out.beat = rest;
  return out;
}

export function joinBeat({ synopsis = '', adjust = '', beat = '', notes = '' }) {
  let s = `Synopsis: ${synopsis}\n\nClaude adjust:\n\n`;
  if (adjust) s += adjust + '\n\n';
  s += '---\n\n' + beat;
  if (notes) s += (beat ? '\n\n' : '') + NOTES_MARK + '\n\n' + notes;
  return s;
}

// ---------- ids and file names ----------

const ALPH = '23456789abcdefghjkmnpqrstuvwxyz';
export function newId(n = 6) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map(x => ALPH[x % ALPH.length]).join('');
}

export function safeTitle(t) {
  return String(t || 'Untitled').replace(/[\/\\:*?"<>|\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}

export function beatPath(b) {
  return `beats/${b.deleted ? '_retired/' : ''}${safeTitle(b.title)} ~${b.id}.md`;
}

// "beats/The Driftwood ~k3f9a2.md" -> {id, title, deleted}
export function parseBeatPath(p) {
  const m = /^beats\/(_retired\/)?(.*) ~([a-z0-9-]+)\.md$/.exec(p);
  return m ? { id: m[3], title: m[2], deleted: !!m[1] } : null;
}

// ---------- book order ----------

export const CARD = { w: 230, h: 150, step: 262, laneTop: 120, laneH: 240 };

export function actOf(board, pos) {
  const acts = [...(board.acts || [])].sort((a, b) => a.x - b.x);
  let act = acts[0];
  for (const a of acts) if (a.x <= pos.x + CARD.w / 2) act = a;
  return act;
}
// Streams can have their own heights (lane.h, default 240). Returns [{top, h}] per stream.
export const MIN_LANE_H = 180;
export function laneGeom(board) {
  let top = CARD.laneTop;
  return (board.lanes || []).map(l => { const h = Math.max(MIN_LANE_H, l.h || CARD.laneH); const g = { top, h }; top += h; return g; });
}
export function laneIndexAt(board, y) {
  const g = laneGeom(board);
  for (let i = 0; i < g.length; i++) if (y < g[i].top + g[i].h) return i;
  return Math.max(0, g.length - 1);
}
// Keep a card inside its stream: snapped near the top when the stream is one card tall, free when it is taller.
export function fitInLane(board, n, y) {
  const g = laneGeom(board)[n] || { top: CARD.laneTop, h: CARD.laneH };
  return Math.round(Math.max(g.top + 45, Math.min(y, g.top + g.h - CARD.h - 20)));
}
export function laneOf(board, pos) {
  return (board.lanes || [])[laneIndexAt(board, pos.y + CARD.h / 2)];
}

// Returns live beats in book order: by act, then x, then y.
export function bookOrder(board, beats) {
  const acts = [...(board.acts || [])].sort((a, b) => a.x - b.x);
  const actIndex = new Map(acts.map((a, i) => [a.id, i]));
  const live = beats.filter(b => !b.deleted);
  const pos = b => board.beats?.[b.id] || { x: 1e9, y: 0 };
  return live.sort((a, b) => {
    const pa = pos(a), pb = pos(b);
    const aa = actIndex.get(actOf(board, pa)?.id) ?? 0, ab = actIndex.get(actOf(board, pb)?.id) ?? 0;
    return aa - ab || pa.x - pb.x || pa.y - pb.y || a.title.localeCompare(b.title);
  });
}

// Place a beat with no board position at the right end of the first stream.
export function placeNew(board, id, after) {
  board.beats = board.beats || {};
  if (after && board.beats[after]) {
    const p = board.beats[after];
    shiftRight(board, p.x + 1, CARD.step);
    board.beats[id] = { x: p.x + CARD.step, y: p.y, tags: [] };
    return;
  }
  let maxX = 40 - CARD.step;
  for (const p of Object.values(board.beats)) maxX = Math.max(maxX, p.x);
  board.beats[id] = { x: maxX + CARD.step, y: (laneGeom(board)[0]?.top ?? CARD.laneTop) + 45, tags: [] };
}

export function shiftRight(board, fromX, dx) {
  for (const p of Object.values(board.beats || {})) if (p.x >= fromX) p.x += dx;
  for (const p of Object.values(board.trash || {})) if (p.x >= fromX) p.x += dx;
  for (const a of board.acts || []) if (a.x >= fromX) a.x += dx;
  for (const n of board.notes || []) if (n.x >= fromX) n.x += dx;
  for (const d of board.days || []) if (d.x >= fromX) d.x += dx;
}

export function emptyBoard(title) {
  return {
    version: 1, textScale: 1,
    acts: [{ id: 'a1', name: 'Act One', sub: '', x: 0 }],
    lanes: [{ id: 'l1', name: 'Main', color: '#5B7DB1' }],
    topics: [], beats: {}, notes: [], links: [], days: [], actNotes: {}, trash: {},
  };
}

// ---------- repo tree <-> project ----------
// A "tree" is {path: text}. A "project" is {title, beats: [...], board, files: {path: text}, layout}.

const SKIP = [
  /^Backups\//, /(^|\/)\.DS_Store$/, /^gale-house-digest\.md$/, /^Claude adjusts\.md$/,
  /^claude-reload\.txt$/, /^\./, /\/\./, /^storyboard-open\.json$/, /\.html$/, /^\.git\//,
];

export function detectLayout(tree) {
  const paths = Object.keys(tree);
  if (paths.includes('quire.json') || paths.some(p => p.startsWith('beats/'))) return 'quire';
  if (paths.some(p => /^Draft\/.*\.txt$/.test(p))) return 'scrivener-sync';
  return null;
}

// Scrivener sync file name: "025 The Driftwood [6].txt", "The Driftwood.txt", "NN TO DELETE - Title [id].txt"
export function parseScrivName(name) {
  let base = name.replace(/\.(txt|md|rtf)$/i, '');
  let sid = null;
  const idm = / ?\[(\d+)\]$/.exec(base);
  if (idm) { sid = idm[1]; base = base.slice(0, idm.index); }
  base = base.replace(/^\d+\s+/, '');
  let deleted = false;
  const del = /^TO DELETE - /.exec(base);
  if (del) { deleted = true; base = base.slice(del[0].length); }
  return { title: base.trim() || 'Untitled', sid, deleted };
}

export function importTree(tree, opts = {}) {
  tree = Object.fromEntries(Object.entries(tree).filter(([p]) => !SKIP.some(r => r.test(p))));
  const layout = detectLayout(tree);
  if (layout === 'quire') return importQuire(tree);
  if (layout === 'scrivener-sync') return importScrivener(tree, opts);
  throw new Error('This does not look like a beat-novel repo: expected beats/ (Quire) or Draft/*.txt (Scrivener sync folder).');
}

function importQuire(tree) {
  const manifest = safeJSON(tree['quire.json'], {});
  const board = safeJSON(tree['board.json'], emptyBoard());
  const beats = [], files = {};
  for (const [p, text] of Object.entries(tree)) {
    const bp = parseBeatPath(p);
    if (bp) beats.push({ id: bp.id, title: bp.title, deleted: bp.deleted, ...splitBeat(text) });
    else if (p !== 'quire.json' && p !== 'board.json') files[p] = text;
  }
  // Prefer exact titles from the manifest (file names lose characters like ':' and '?').
  for (const b of beats) if (manifest.titles?.[b.id]) b.title = manifest.titles[b.id];
  return { title: manifest.title || 'Untitled novel', beats, board, files, layout: 'quire' };
}

function importScrivener(tree, opts) {
  const boardPath = Object.keys(tree).find(p => !p.includes('/') && /board\.json$/i.test(p));
  const old = boardPath ? safeJSON(tree[boardPath], emptyBoard()) : emptyBoard();
  const beats = [], files = {}, keyMap = new Map(), used = new Set();
  for (const [p, text] of Object.entries(tree)) {
    if (/^Draft\/[^/]+\.txt$/.test(p)) {
      const { title, sid, deleted } = parseScrivName(p.slice(6));
      let id = sid ? `s${sid}` : newId();
      while (used.has(id)) id = newId();
      used.add(id);
      beats.push({ id, title, deleted, ...splitBeat(text) });
      if (sid) keyMap.set(`id:${sid}`, id);
      keyMap.set(`t:${title}`, id);
    } else if (/^Notes\//.test(p)) {
      const sub = p.slice(6);
      const dir = sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/') + 1) : '';
      let { title, deleted } = parseScrivName(sub.slice(dir.length));
      if (deleted) title = 'TO DELETE - ' + title;
      // Scrivener allows several notes with the same title; keep each one.
      let np = `notes/${dir}${safeTitle(title)}.md`, n = 2;
      while (np in files) np = `notes/${dir}${safeTitle(title)} (${n++}).md`;
      files[np] = text;
    } else if (/^Claude chats\//.test(p)) files['chats/' + p.slice(13)] = text;
    else if (/^Claude\//.test(p)) files['claude/' + p.slice(7)] = text;
    else if (p !== boardPath && /\.(md|txt|json)$/i.test(p)) files['extra/' + p] = text;
  }
  const remap = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [keyMap.get(k) || k, v]));
  const board = { ...emptyBoard(), ...old, beats: remap(old.beats), trash: remap(old.trash) };
  board.links = (old.links || []).map(l => ({ ...l, from: keyMap.get(l.from) || l.from, to: keyMap.get(l.to) || l.to }));
  board.actNotes = old.actNotes || {};
  // Retired beats keep their position in trash so they can be restored.
  for (const b of beats) if (b.deleted && board.beats[b.id]) { board.trash[b.id] = board.beats[b.id]; delete board.beats[b.id]; }
  for (const b of beats) if (!b.deleted && !board.beats[b.id]) placeNew(board, b.id);
  return { title: opts.title || 'Imported novel', beats, board, files, layout: 'scrivener-sync' };
}

export function exportTree(project) {
  const tree = {};
  const titles = {};
  for (const b of project.beats) {
    tree[beatPath(b)] = joinBeat(b);
    if (safeTitle(b.title) !== b.title) titles[b.id] = b.title;
  }
  tree['quire.json'] = JSON.stringify({ format: FORMAT, title: project.title, titles }, null, 2) + '\n';
  tree['board.json'] = JSON.stringify(project.board, null, 2) + '\n';
  for (const [p, t] of Object.entries(project.files || {})) if (!p.startsWith('beats/')) tree[p] = t;
  return tree;
}

function safeJSON(s, d) { try { return s ? JSON.parse(s) : d; } catch { return d; } }

// ---------- manuscript ----------

export function manuscript(project, { include = 'beat', headings = true } = {}) {
  const order = bookOrder(project.board, project.beats);
  let out = `# ${project.title}\n\n`, lastAct = null;
  for (const b of order) {
    const act = actOf(project.board, project.board.beats[b.id] || { x: 0 });
    if (headings && act && act.id !== lastAct) { out += `## ${act.name}\n\n`; lastAct = act.id; }
    const text = include === 'synopsis' ? b.synopsis : b.beat;
    if (headings) out += `### ${b.title}\n\n`;
    if ((text || '').trim()) out += plainText(text).trim() + '\n\n';
  }
  return out;
}

export function wordCount(s) { return (String(s || '').match(/\S+/g) || []).length; }

// ---------- three-way merge (line based) ----------

function lcsMatch(a, b) {
  // Returns array m where m[i] = index in b matched to a[i], or -1.
  const n = a.length, k = b.length;
  // Trim common prefix/suffix to keep the table small.
  let s = 0; while (s < n && s < k && a[s] === b[s]) s++;
  let e = 0; while (e < n - s && e < k - s && a[n - 1 - e] === b[k - 1 - e]) e++;
  const m = new Array(n).fill(-1);
  for (let i = 0; i < s; i++) m[i] = i;
  for (let i = 0; i < e; i++) m[n - 1 - i] = k - 1 - i;
  const A = a.slice(s, n - e), B = b.slice(s, k - e);
  if (A.length && B.length) {
    if (A.length * B.length > 4e6) return m; // too big; treat middle as changed
    const W = B.length + 1, t = new Uint32Array((A.length + 1) * W);
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
      t[i * W + j] = A[i] === B[j] ? t[(i + 1) * W + j + 1] + 1 : Math.max(t[(i + 1) * W + j], t[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      if (A[i] === B[j]) { m[s + i] = s + j; i++; j++; }
      else if (t[(i + 1) * W + j] >= t[i * W + j + 1]) i++; else j++;
    }
  }
  return m;
}

// Returns {text, conflict, mine, theirs}. On conflict, text keeps both sides' clean merges and
// the local side of conflicting chunks; mine/theirs are the full alternatives for the user to choose.
export function merge3(base, local, remote) {
  base = base ?? ''; local = local ?? ''; remote = remote ?? '';
  if (local === remote) return { text: local, conflict: false };
  if (local === base) return { text: remote, conflict: false };
  if (remote === base) return { text: local, conflict: false };
  const B = base.split('\n'), L = local.split('\n'), R = remote.split('\n');
  const ml = lcsMatch(B, L), mr = lcsMatch(B, R);
  const out = []; let conflict = false;
  let i = 0, j = 0, k = 0;
  const chunk = (bi, lj, rk) => {
    const b = B.slice(i, bi), l = L.slice(j, lj), r = R.slice(k, rk);
    const eq = (x, y) => x.length === y.length && x.every((v, n) => v === y[n]);
    if (eq(l, b)) out.push(...r);
    else if (eq(r, b) || eq(l, r)) out.push(...l);
    else { conflict = true; out.push(...l); }
  };
  for (let b = 0; b < B.length; b++) {
    if (ml[b] >= j && mr[b] >= k) {
      chunk(b, ml[b], mr[b]);
      out.push(B[b]);
      i = b + 1; j = ml[b] + 1; k = mr[b] + 1;
    }
  }
  chunk(B.length, L.length, R.length);
  const text = out.join('\n');
  return conflict ? { text, conflict: true, mine: local, theirs: remote } : { text, conflict: false };
}

// Merge a beat's fields. Returns {fields, conflicts: {field: {mine, theirs}}}.
export function mergeBeat(base = {}, local = {}, remote = {}) {
  const fields = {}, conflicts = {};
  for (const f of FIELDS) {
    if (f === 'deleted') { fields[f] = local[f] !== base[f] ? local[f] : remote[f]; continue; }
    const r = merge3(base[f], local[f], remote[f]);
    fields[f] = r.text;
    if (r.conflict) conflicts[f] = { mine: r.mine, theirs: r.theirs };
  }
  return { fields, conflicts };
}

// Card-level board merge: local changes win per card/item; everything else follows remote.
export function mergeBoard(base = {}, local = {}, remote = {}) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const out = { ...remote };
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const b = base[key], l = local[key], r = remote[key];
    if (Array.isArray(l) || Array.isArray(r)) {
      const byId = arr => new Map((arr || []).map(x => [x.id, x]));
      const bm = byId(b), lm = byId(l), rm = byId(r);
      const ids = [...new Set([...rm.keys(), ...lm.keys()])];
      out[key] = ids.map(id => {
        const lb = bm.get(id), ll = lm.get(id), rr = rm.get(id);
        return same(ll, lb) ? rr : ll;
      }).filter(Boolean);
    } else if (l && typeof l === 'object' && (key === 'beats' || key === 'trash' || key === 'actNotes')) {
      const o = {};
      for (const id of new Set([...Object.keys(l || {}), ...Object.keys(r || {})])) {
        const v = same(l?.[id], b?.[id]) ? r?.[id] : l?.[id];
        if (v !== undefined) o[id] = v;
      }
      out[key] = o;
    } else out[key] = same(l, b) ? r : l;
  }
  return out;
}

// ---------- wikilinks and critical details ----------
// [[Target]] or [[Target|shown text]] links to a beat (by title) or a note (by name).
// ==text== marks a critical detail (one paragraph at most).

export const LINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;
export const CRIT_RE = /==([^\s=](?:[^\n]*?[^\s=])?)==/g;

export function parseLink(inner) {
  const [t, alias] = inner.split('|');
  return { target: t.split('#')[0].trim(), alias: alias?.trim() || null };
}
export function findLinks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(LINK_RE)) out.push({ ...parseLink(m[1]), index: m.index, length: m[0].length });
  return out;
}
export function findCritical(text) {
  const out = [];
  for (const m of String(text || '').matchAll(CRIT_RE)) out.push({ text: m[1], index: m.index, length: m[0].length, links: findLinks(m[1]).map(l => l.target) });
  return out;
}
// Rewrites links to `from` so they point to `to`, keeping any alias or #section. Case-insensitive.
export function renameLinks(text, from, to) {
  const f = from.trim().toLowerCase();
  return String(text || '').replace(LINK_RE, (all, inner) => {
    const bar = inner.indexOf('|'), head = bar < 0 ? inner : inner.slice(0, bar), rest = bar < 0 ? '' : inner.slice(bar);
    const hash = head.indexOf('#'), name = hash < 0 ? head : head.slice(0, hash), sec = hash < 0 ? '' : head.slice(hash);
    return name.trim().toLowerCase() === f ? `[[${to}${sec}${rest}]]` : all;
  });
}
// Text for readers: links become their words, highlights become plain.
export function plainText(s) {
  return String(s || '').replace(LINK_RE, (_, inner) => { const l = parseLink(inner); return l.alias || l.target; }).replace(CRIT_RE, '$1');
}
// Short display name for a note file: "notes/Abby Orne.md" -> "Abby Orne".
export function fileName(path) { return path.split('/').pop().replace(/\.(md|txt)$/i, ''); }
