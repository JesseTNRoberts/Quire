// The Quire connector: a remote MCP server (Streamable HTTP, JSON responses) for claude.ai chats and voice.
// Tools read and edit the live book through the same Durable Object the app uses, so edits appear on
// Jesse's devices within seconds. Rules travel with the connector (INSTRUCTIONS), because voice mode
// and plain chats don't load skills.
import { json, cors, authStore } from './oauth.js';
import { bookOrder, actOf, laneOf, findLinks, findCritical, renameLinks, fileName, newId, placeNew, laneIndexAt, fitInLane, laneGeom, CARD } from '../public/format.js';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Quire holds Jesse Roberts's novel (Gale House) as beats on a board, plus notes. You are his writing partner: talk warmly and plainly, explain your thinking, ask when unsure.
Rules (the book's own Claude instructions, returned by get_instructions, take precedence):
1. Call get_instructions once at the start of any conversation about the book, before other tools, and follow what it returns.
2. Keep Jesse's words. Fix spelling only; never reword, stitch or abridge his text, and never rewrite drafted prose unless he asks.
3. Discuss before acting. Before ANY write, say exactly what you will change and wait for a clear yes. In voice, read the change back briefly first.
4. Your own suggestions go in the conversation, clearly marked; into the book only when agreed, labelled "Claude's suggestion (requested)" or [Proposed].
5. ==text== marks a critical detail; [[Title|words]] links words to a beat or note (shown as the words plus a link mark; a bare [[Title]] shows only the mark, so prefer the |words form when adding a link inside prose). Preserve this markup exactly. Never change, weaken or drop a critical detail without flagging it first.
6. Processing a Claude adjust: give feedback and a plan, wait for agreement, execute, then use finish_adjust (it moves the adjust into the beat's notes and clears it), update affected synopses, and add a line to the changelog with append_to_note("Claude changelog").
7. Never delete or retire anything unless Jesse explicitly asks.
8. Writes can conflict with Jesse typing at the same time; on a conflict, re-read and redo the change, never overwrite.`;

// ---------------- book access ----------------
async function books(env) { return (await env.REGISTRY.get(env.REGISTRY.idFromName('registry')).fetch('https://r/')).json(); }
async function pickBook(env, slug) {
  const list = await books(env);
  if (slug) { const b = list.find(x => x.slug === slug || x.title.toLowerCase() === String(slug).toLowerCase()); if (!b) throw new Error(`No book "${slug}". Books: ${list.map(x => x.title).join(', ')}`); return b; }
  if (!list.length) throw new Error('Quire has no books yet.');
  return list.find(x => /gale/i.test(x.title)) || list[0];
}
const stubFor = (env, slug) => env.PROJECT.get(env.PROJECT.idFromName(slug));
async function load(env, slug) {
  const st = await (await stubFor(env, slug).fetch('https://book/state?since=0')).json();
  return { slug, meta: st, title: st.title, beats: st.beats, files: st.files.filter(f => !f.deleted), board: st.board?.data || {}, boardRev: st.board?.rev || 0 };
}
async function ops(env, slug, list, checkpoint = false) {
  const r = await (await stubFor(env, slug).fetch('https://book/ops', { method: 'POST', body: JSON.stringify({ client: 'claude-connector', ops: list, checkpoint }) })).json();
  if (r.error) throw new Error(r.error);
  return r.results;
}
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

function targets(b) {
  const byName = new Map(), byPath = new Map();
  for (const f of b.files) { const t = { kind: 'note', id: f.path, label: fileName(f.path) }; byPath.set(f.path.replace(/\.(md|txt)$/i, '').toLowerCase(), t); if (!byName.has(t.label.toLowerCase())) byName.set(t.label.toLowerCase(), t); }
  for (const x of b.beats) if (!x.deleted) byName.set(x.title.trim().toLowerCase(), { kind: 'beat', id: x.id, label: x.title });
  return k => { k = String(k || '').trim().toLowerCase(); return k.includes('/') ? byPath.get(k) : byName.get(k); };
}
function findBeat(b, ref) {
  if (!ref) throw new Error('Say which beat (its title or id).');
  const r = String(ref).trim(), lr = r.toLowerCase();
  const live = b.beats.filter(x => !x.deleted);
  const hit = b.beats.find(x => x.id === r) || live.find(x => x.title.toLowerCase() === lr)
    || (c => c.length === 1 ? c[0] : null)(live.filter(x => x.title.toLowerCase().includes(lr)));
  if (!hit) {
    const near = live.filter(x => lr.split(/\s+/).some(w => w.length > 3 && x.title.toLowerCase().includes(w))).slice(0, 6).map(x => x.title);
    throw new Error(`No single beat matches "${r}".${near.length ? ' Did you mean: ' + near.join('; ') + '?' : ''}`);
  }
  return hit;
}
function findNote(b, ref, create = false) {
  const r = String(ref || '').trim(), lr = r.toLowerCase().replace(/\.(md|txt)$/, '');
  const hit = b.files.find(f => f.path.toLowerCase() === r.toLowerCase()) || b.files.find(f => f.path.toLowerCase().replace(/\.(md|txt)$/, '') === lr)
    || b.files.find(f => fileName(f.path).toLowerCase() === lr) || (c => c.length === 1 ? c[0] : null)(b.files.filter(f => fileName(f.path).toLowerCase().includes(lr)));
  if (hit) return hit;
  if (create) return { path: r.includes('/') ? (r.match(/\.(md|txt)$/) ? r : r + '.md') : `notes/${r.replace(/[\/\\:*?"<>|]/g, ' ')}.md`, content: '', rev: 0, created: true };
  throw new Error(`No note matches "${r}".`);
}
function where(b, beat) {
  const p = b.board.beats?.[beat.id] || b.board.trash?.[beat.id];
  return { act: p ? actOf(b.board, p)?.name : null, stream: p ? laneOf(b.board, p)?.name : null, tags: (p?.tags || []).map(t => (b.board.topics || []).find(x => x.id === t)?.name).filter(Boolean) };
}
function backlinks(b, kind, id, resolve) {
  const out = new Set();
  for (const x of b.beats) if (!x.deleted) for (const f of ['synopsis', 'beat', 'notes', 'adjust']) for (const l of findLinks(x[f])) { const t = resolve(l.target); if (t && t.kind === kind && t.id === id && x.id !== id) out.add(`beat: ${x.title}`); }
  for (const f of b.files) for (const l of findLinks(f.content)) { const t = resolve(l.target); if (t && t.kind === kind && t.id === id && f.path !== id) out.add(`note: ${fileName(f.path)}`); }
  return [...out];
}
const words = s => (String(s || '').match(/\S+/g) || []).length;
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
function appendBlock(old, heading, text) {
  const block = heading ? `${heading}\n\n${text.trim()}` : text.trim();
  return old && old.trim() ? old.replace(/\s+$/, '') + '\n\n' + block : block;
}
async function writeBeat(env, b, beat, fields) {
  const [r] = await ops(env, b.slug, [{ type: 'beat', id: beat.id, baseRev: beat.rev, fields }]);
  if (r.conflict) throw new Error(`Jesse changed "${beat.title}" a moment ago (now rev ${r.current.rev}). Re-read it with get_beat and redo the change.`);
  return r.rev;
}
async function writeNote(env, b, note, content) {
  const [r] = await ops(env, b.slug, [{ type: 'file', path: note.path, baseRev: note.rev || 0, content }]);
  if (r.conflict) throw new Error(`"${fileName(note.path)}" changed a moment ago. Re-read it with get_note and redo the change.`);
  return r.rev;
}

// ---------------- tools ----------------
const S = (props, required = []) => ({ type: 'object', properties: { book: { type: 'string', description: 'Book title or id. Optional; defaults to Gale House.' }, ...props }, required });
const RO = { readOnlyHint: true, openWorldHint: false }, RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const TOOLS = [
  { name: 'get_instructions', title: 'Read the book’s rules', annotations: RO, description: 'Call first in every conversation about the book. Returns the book’s own Claude instructions and task rules, the latest plot decisions, and an overview (counts, waiting Claude adjusts).', inputSchema: S({}),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug);
      const rules = b.files.filter(f => f.path.startsWith('claude/')).map(f => `===== ${f.path}\n${f.content}`).join('\n\n');
      const spine = b.files.find(f => /plot spine/i.test(f.path));
      const live = b.beats.filter(x => !x.deleted);
      return { book: b.title, beats: live.length, words: live.reduce((n, x) => n + words(x.beat), 0), waiting_adjusts: live.filter(x => x.adjust.trim()).map(x => x.title),
        critical_details: live.reduce((n, x) => n + ['synopsis', 'beat', 'notes'].reduce((k, f) => k + findCritical(x[f]).length, 0), 0),
        backup: (m => ({ github_repo: m.target ? `${m.target.owner}/${m.target.repo}` : 'NOT SET (tell Jesse)', last_snapshot: m.snapshot?.at ? new Date(m.snapshot.at).toISOString() : null,
          problem: m.snapshot?.error && (!m.snapshot.at || m.snapshot.failedAt > m.snapshot.at) ? m.snapshot.error : m.dirtySince && Date.now() - m.dirtySince > 2 * 3600e3 ? 'No GitHub backup for over 2 hours' : null,
          github_key_expires: m.tokenExpires ? new Date(m.tokenExpires).toISOString().slice(0, 10) : null }))(b.meta),
        connector_rules: INSTRUCTIONS, book_rules: rules || '(none in the book; follow connector_rules)', plot_spine_latest: spine ? clip(spine.content, 5000) : null }; } },

  { name: 'list_books', title: 'List books', annotations: RO, description: 'List the books in Quire.', inputSchema: { type: 'object', properties: {} }, run: async env => books(env) },

  { name: 'list_beats', title: 'List beats in book order', annotations: RO, description: 'Beats in book order, grouped by act, with stream, one-line synopsis and flags (★ critical details, adjust waiting, empty). Filter by act, stream, tag or text.', inputSchema: S({ act: { type: 'string' }, stream: { type: 'string' }, tag: { type: 'string' }, query: { type: 'string', description: 'Words to find in titles/synopses' } }),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug);
      const q = a.query?.toLowerCase();
      return bookOrder(b.board, b.beats).map(x => ({ id: x.id, title: x.title, ...where(b, x), synopsis: clip(x.synopsis.split(/(?<=[.!?])\s/)[0], 200),
        critical: ['synopsis', 'beat', 'notes'].reduce((k, f) => k + findCritical(x[f]).length, 0) || undefined, adjust_waiting: !!x.adjust.trim() || undefined, empty: !x.beat.trim() || undefined, words: words(x.beat) || undefined }))
        .filter(x => (!a.act || x.act?.toLowerCase().includes(a.act.toLowerCase())) && (!a.stream || x.stream?.toLowerCase().includes(a.stream.toLowerCase()))
          && (!a.tag || x.tags.some(t => t.toLowerCase().includes(a.tag.toLowerCase()))) && (!q || (x.title + ' ' + x.synopsis).toLowerCase().includes(q))); } },

  { name: 'get_beat', title: 'Read a beat', annotations: RO, description: 'Everything in one beat: title, synopsis, the beat text, Claude adjust, notes, where it sits, its links, what links to it, its critical details, and rev (needed to edit).', inputSchema: S({ beat: { type: 'string', description: 'Beat title (or part of it) or id' } }, ['beat']),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), x = findBeat(b, a.beat), resolve = targets(b);
      const links = [...new Set(['synopsis', 'beat', 'notes', 'adjust'].flatMap(f => findLinks(x[f]).map(l => l.target)))].map(t => ({ link: t, goes_to: resolve(t)?.label || '(nothing by that name)' }));
      return { id: x.id, rev: x.rev, title: x.title, retired: x.deleted || undefined, ...where(b, x), synopsis: x.synopsis, text: x.beat, adjust: x.adjust, notes: x.notes, words: words(x.beat),
        critical_details: ['synopsis', 'beat', 'notes'].flatMap(f => findCritical(x[f]).map(c => ({ in: f === 'beat' ? 'text' : f, detail: c.text }))), links, linked_from: backlinks(b, 'beat', x.id, resolve) }; } },

  { name: 'search', title: 'Search the book', annotations: RO, description: 'Find words or phrases across all beats and notes. Returns where each match is, with a snippet.', inputSchema: S({ query: { type: 'string' } }, ['query']),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), q = a.query.toLowerCase(), out = [];
      const snip = (t, i) => '…' + t.slice(Math.max(0, i - 80), i + q.length + 80).replace(/\s+/g, ' ') + '…';
      for (const x of bookOrder(b.board, b.beats)) for (const f of ['title', 'synopsis', 'beat', 'notes', 'adjust']) { const i = x[f].toLowerCase().indexOf(q); if (i >= 0) out.push({ beat: x.title, field: f === 'beat' ? 'text' : f, snippet: snip(x[f], i) }); }
      for (const f of b.files) { const i = f.content.toLowerCase().indexOf(q); if (i >= 0) out.push({ note: fileName(f.path), path: f.path, snippet: snip(f.content, i) }); }
      return out.length ? out.slice(0, 40) : `Nothing matches "${a.query}".`; } },

  { name: 'list_adjusts', title: 'Waiting Claude adjusts', annotations: RO, description: 'Every beat with a Claude adjust waiting, in book order, with the adjust text and the beat’s critical details.', inputSchema: S({}),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug);
      const list = bookOrder(b.board, b.beats).filter(x => x.adjust.trim()).map(x => ({ beat: x.title, id: x.id, rev: x.rev, adjust: x.adjust, synopsis: x.synopsis, critical_details: ['synopsis', 'beat', 'notes'].flatMap(f => findCritical(x[f]).map(c => c.text)) }));
      return list.length ? list : 'No Claude adjusts are waiting.'; } },

  { name: 'list_critical', title: 'Critical details', annotations: RO, description: 'Every ==critical detail== in book order, with its beat or note and where its links point. Use as a continuity checklist.', inputSchema: S({}),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), resolve = targets(b), out = [];
      for (const x of bookOrder(b.board, b.beats)) for (const f of ['synopsis', 'beat', 'notes']) for (const c of findCritical(x[f])) out.push({ beat: x.title, in: f === 'beat' ? 'text' : f, detail: c.text, points_to: c.links.map(l => resolve(l)?.label).filter(Boolean) });
      for (const f of b.files) for (const c of findCritical(f.content)) out.push({ note: fileName(f.path), detail: c.text, points_to: c.links.map(l => resolve(l)?.label).filter(Boolean) });
      return out.length ? out : 'No critical details are marked yet.'; } },

  { name: 'list_notes', title: 'List notes', annotations: RO, description: 'All notes (characters, places, plot spine, changelog, Claude instructions…) with their paths.', inputSchema: S({}),
    run: async (env, a) => (await load(env, (await pickBook(env, a.book)).slug)).files.map(f => ({ name: fileName(f.path), path: f.path, words: words(f.content) })) },

  { name: 'get_note', title: 'Read a note', annotations: RO, description: 'Read one note by name or path, with rev (needed to edit) and what links to it.', inputSchema: S({ note: { type: 'string' } }, ['note']),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), f = findNote(b, a.note);
      return { path: f.path, rev: f.rev, content: f.content, linked_from: backlinks(b, 'note', f.path, targets(b)) }; } },

  { name: 'update_beat', title: 'Edit a beat', annotations: RW, description: 'Change fields of one beat. Only after Jesse has agreed to the exact change. Pass rev from get_beat. Omitted fields stay as they are. Renaming updates every [[link]] to the beat.', inputSchema: S({ beat: { type: 'string' }, rev: { type: 'number', description: 'rev from get_beat' }, title: { type: 'string' }, synopsis: { type: 'string' }, text: { type: 'string', description: 'The beat itself (Jesse’s text)' }, adjust: { type: 'string' }, notes: { type: 'string' } }, ['beat', 'rev']),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), x = findBeat(b, a.beat);
      if (x.rev !== a.rev) throw new Error(`"${x.title}" has changed since you read it (rev ${a.rev} → ${x.rev}). Re-read it with get_beat and redo the change.`);
      const fields = {}; for (const [k, f] of [['title', 'title'], ['synopsis', 'synopsis'], ['text', 'beat'], ['adjust', 'adjust'], ['notes', 'notes']]) if (a[k] !== undefined) fields[f] = a[k];
      if (!Object.keys(fields).length) throw new Error('Nothing to change.');
      const rev = await writeBeat(env, b, x, fields);
      let relinked = 0;
      if (fields.title && fields.title.trim() !== x.title.trim()) {
        const more = [];
        for (const o of b.beats) { if (o.id === x.id) continue; const ch = {}; for (const f of ['synopsis', 'beat', 'notes', 'adjust']) { const nv = renameLinks(o[f], x.title, fields.title.trim()); if (nv !== o[f]) ch[f] = nv; } if (Object.keys(ch).length) more.push({ type: 'beat', id: o.id, baseRev: o.rev, fields: ch }); }
        for (const f of b.files) { const nv = renameLinks(f.content, x.title, fields.title.trim()); if (nv !== f.content) more.push({ type: 'file', path: f.path, baseRev: f.rev, content: nv }); }
        if (more.length) relinked = (await ops(env, b.slug, more)).filter(r => r.ok).length;
      }
      return { saved: true, beat: fields.title || x.title, rev, changed: Object.keys(fields).map(f => f === 'beat' ? 'text' : f), links_updated: relinked || undefined }; } },

  { name: 'append_to_beat_notes', title: 'Add a note to a beat', annotations: RW, description: 'Append text to a beat’s Notes under a dated heading. Good for capturing Jesse’s thoughts ("Author’s notes, DATE"). Jesse’s words go in unchanged.', inputSchema: S({ beat: { type: 'string' }, text: { type: 'string' }, heading: { type: 'string', enum: ['author_notes', 'earlier_version', 'none'], description: 'author_notes (default): "Author’s notes, DATE:"; earlier_version: "Earlier version (before DATE):"' } }, ['beat', 'text']),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), x = findBeat(b, a.beat);
      const h = a.heading === 'none' ? '' : a.heading === 'earlier_version' ? `Earlier version (before ${today()}):` : `Author's notes, ${today()}:`;
      await writeBeat(env, b, x, { notes: appendBlock(x.notes, h, a.text) }); return { saved: true, beat: x.title, added_under: h || '(no heading)' }; } },

  { name: 'add_adjust', title: 'Add a Claude adjust', annotations: RW, description: 'Add an instruction to a beat’s Claude adjust tab (appended to anything already there). For Jesse to queue work for later.', inputSchema: S({ beat: { type: 'string' }, text: { type: 'string' } }, ['beat', 'text']),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), x = findBeat(b, a.beat);
      await writeBeat(env, b, x, { adjust: appendBlock(x.adjust, '', a.text) }); return { saved: true, beat: x.title }; } },

  { name: 'finish_adjust', title: 'Mark an adjust done', annotations: RW, description: 'After an adjust has been carried out (with Jesse’s agreement): moves the adjust text unchanged into the beat’s Notes as "Claude adjust (done DATE):" and clears the adjust. Optionally updates the synopsis in the same save.', inputSchema: S({ beat: { type: 'string' }, synopsis: { type: 'string', description: 'Updated synopsis, if the beat changed' } }, ['beat']),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), x = findBeat(b, a.beat);
      if (!x.adjust.trim()) throw new Error(`"${x.title}" has no adjust waiting.`);
      const fields = { notes: appendBlock(x.notes, `Claude adjust (done ${today()}):`, x.adjust), adjust: '' }; if (a.synopsis !== undefined) fields.synopsis = a.synopsis;
      await writeBeat(env, b, x, fields); return { saved: true, beat: x.title }; } },

  { name: 'mark_critical', title: 'Mark a critical detail', annotations: RW, description: 'Wrap an exact phrase in a beat (or note) as a ==critical detail==. Only when Jesse asks.', inputSchema: S({ beat: { type: 'string', description: 'Beat title or id (or leave empty and give note)' }, note: { type: 'string' }, phrase: { type: 'string', description: 'The exact words to mark' } }, ['phrase']),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), ph = a.phrase.trim();
      const wrap = t => { let i = t.indexOf(ph); if (i < 0) i = t.toLowerCase().indexOf(ph.toLowerCase()); if (i < 0) return null; const w = t.slice(i, i + ph.length); if (t.slice(i - 2, i) === '==' && t.slice(i + ph.length, i + ph.length + 2) === '==') return t; return t.slice(0, i) + '==' + w + '==' + t.slice(i + ph.length); };
      if (a.note) { const f = findNote(b, a.note), nv = wrap(f.content); if (nv == null) throw new Error(`"${ph}" isn't in ${fileName(f.path)}.`); await writeNote(env, b, f, nv); return { saved: true, note: fileName(f.path) }; }
      const x = findBeat(b, a.beat);
      for (const f of ['beat', 'synopsis', 'notes']) { const nv = wrap(x[f]); if (nv != null) { await writeBeat(env, b, x, { [f]: nv }); return { saved: true, beat: x.title, in: f === 'beat' ? 'text' : f }; } }
      throw new Error(`"${ph}" isn't in "${x.title}". Use the exact words.`); } },

  { name: 'create_beat', title: 'Create a beat', annotations: RW, description: 'Create a new beat, placed after another beat (same stream) or at the end of a stream. Only when Jesse asks.', inputSchema: S({ title: { type: 'string' }, synopsis: { type: 'string' }, text: { type: 'string' }, after: { type: 'string', description: 'Place right after this beat' }, stream: { type: 'string' } }, ['title']),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), id = newId(), board = JSON.parse(JSON.stringify(b.board));
      const after = a.after ? findBeat(b, a.after) : null;
      placeNew(board, id, after?.id);
      if (a.stream) { const n = (board.lanes || []).findIndex(l => l.name.toLowerCase().includes(a.stream.toLowerCase())); if (n < 0) throw new Error(`No stream called "${a.stream}".`); board.beats[id].y = fitInLane(board, n, 0); }
      const res = await ops(env, b.slug, [{ type: 'beat', id, baseRev: 0, fields: { title: a.title, synopsis: a.synopsis || '', beat: a.text || '', adjust: '', notes: '', deleted: false } }, { type: 'board', baseRev: b.boardRev, board }]);
      if (res[1]?.conflict) throw new Error('The board changed at the same moment; the beat was created but placed at the end. Ask Jesse to drag it.');
      return { saved: true, id, title: a.title, ...where({ ...b, board }, { id }) }; } },

  { name: 'update_note', title: 'Rewrite a note', annotations: RW, description: 'Replace a note’s whole content. Only after Jesse has agreed. Pass rev from get_note.', inputSchema: S({ note: { type: 'string' }, rev: { type: 'number' }, content: { type: 'string' } }, ['note', 'rev', 'content']),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), f = findNote(b, a.note);
      if (f.rev !== a.rev) throw new Error(`"${fileName(f.path)}" changed since you read it. Re-read with get_note.`);
      await writeNote(env, b, f, a.content); return { saved: true, note: fileName(f.path) }; } },

  { name: 'append_to_note', title: 'Add to a note', annotations: RW, description: 'Append text to a note (created if it doesn’t exist), e.g. a changelog line to "Claude changelog" or a fact to a character note.', inputSchema: S({ note: { type: 'string' }, text: { type: 'string' }, dated: { type: 'boolean', description: 'Prefix with today’s date heading' } }, ['note', 'text']),
    run: async (env, a) => { const b = await load(env, (await pickBook(env, a.book)).slug), f = findNote(b, a.note, true);
      await writeNote(env, b, f, appendBlock(f.content, a.dated ? `${today()}:` : '', a.text)); return { saved: true, note: fileName(f.path), created: f.created || undefined }; } },

  { name: 'list_versions', title: 'Version history', annotations: RO, description: 'Earlier versions of a beat or note (newest first): when, and by which device or Claude. Use to undo a change.', inputSchema: S({ beat: { type: 'string' }, note: { type: 'string' } }),
    run: async (env, a) => { const slug = (await pickBook(env, a.book)).slug, b = await load(env, slug);
      const [kind, key, label] = a.note ? ['file', findNote(b, a.note).path, a.note] : ['beat', findBeat(b, a.beat).id, findBeat(b, a.beat).title];
      const rows = await (await stubFor(env, slug).fetch(`https://book/history?kind=${kind}&key=${encodeURIComponent(key)}`)).json();
      return { of: label, versions: rows.map((r, i) => ({ version: r.id, when: new Date(r.at).toISOString(), by: r.label, current: i === 0 || undefined })) }; } },

  { name: 'restore_version', title: 'Restore a version', annotations: RW, description: 'Put a beat or note back to an earlier version from list_versions. Only after Jesse agrees. The version it replaces stays in history.', inputSchema: S({ beat: { type: 'string' }, note: { type: 'string' }, version: { type: 'number' } }, ['version']),
    run: async (env, a) => { const slug = (await pickBook(env, a.book)).slug, b = await load(env, slug);
      const v = await (await stubFor(env, slug).fetch(`https://book/history/item?id=${a.version}`)).json();
      if (v.error) throw new Error(v.error);
      if (a.note) { const f = findNote(b, a.note); if (v.kind !== 'file' || v.key !== f.path) throw new Error('That version belongs to something else.');
        const [r] = await ops(env, slug, [{ type: 'file', path: f.path, baseRev: f.rev, content: v.data.content || '' }], true); if (r.conflict) throw new Error('The note changed a moment ago; list versions again.'); return { restored: true, note: fileName(f.path), from: new Date(v.at).toISOString() }; }
      const x = findBeat(b, a.beat); if (v.kind !== 'beat' || v.key !== x.id) throw new Error('That version belongs to a different beat.');
      const { title, synopsis, adjust, beat, notes } = v.data;
      const [r] = await ops(env, slug, [{ type: 'beat', id: x.id, baseRev: x.rev, fields: { title, synopsis, adjust, beat, notes } }], true);
      if (r.conflict) throw new Error('The beat changed a moment ago; list versions again.');
      return { restored: true, beat: title, from: new Date(v.at).toISOString() }; } },

  { name: 'snapshot', title: 'Save to GitHub now', annotations: { ...RW, openWorldHint: true }, description: 'Commit the book to its GitHub archive now (it also happens automatically every ~30 minutes).', inputSchema: S({}),
    run: async (env, a) => (await stubFor(env, (await pickBook(env, a.book)).slug).fetch('https://book/snapshot', { method: 'POST' })).json() },
];

// ---------------- protocol ----------------
export async function handleMcp(request, env, origin, at = '/mcp') {
  if (request.method === 'OPTIONS') return cors();
  const challenge = { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${at}"` };
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const who = token && await authStore(env).check(token);
  if (!who) return json({ error: 'invalid_token', error_description: 'Connect Quire in Claude to sign in.' }, 401, challenge);
  if (request.method === 'GET') return json({ error: 'This server answers POST only (no event stream).' }, 405, { Allow: 'POST, DELETE' });
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let msg; try { msg = await request.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  const batch = Array.isArray(msg), out = [];
  for (const m of batch ? msg : [msg]) { const r = await handle(m, env); if (r) out.push(r); }
  if (!out.length) return new Response(null, { status: 202, headers: { 'Access-Control-Allow-Origin': '*' } });
  return json(batch ? out : out[0]);
}

async function handle(m, env) {
  const reply = result => ({ jsonrpc: '2.0', id: m.id, result }), fail = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  if (m.id === undefined || m.id === null) return null;   // notification
  switch (m.method) {
    case 'initialize': {
      const v = m.params?.protocolVersion;
      return reply({ protocolVersion: PROTOCOLS.includes(v) ? v : PROTOCOLS[0], capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'quire', title: 'Quire', version: '0.3.0' }, instructions: INSTRUCTIONS });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const t = TOOLS.find(x => x.name === m.params?.name);
      if (!t) return fail(-32602, `Unknown tool ${m.params?.name}`);
      try {
        const r = await t.run(env, m.params?.arguments || {});
        return reply({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 1) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default: return fail(-32601, `Method not found: ${m.method}`);
  }
}
