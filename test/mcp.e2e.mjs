// End-to-end: OAuth (discovery, registration, approve, PKCE exchange, refresh) and MCP tools, against `wrangler dev`.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const B = process.argv[2] || 'http://127.0.0.1:8787', MCP = process.argv[3] ?? '/mcp';
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
// 1. unauthenticated MCP -> 401 with resource metadata
let r = await fetch(B + MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(r.status, 401); const wa = r.headers.get('www-authenticate'); assert.match(wa, /resource_metadata=/);
const prm = await j(await fetch(wa.match(/"(.+)"/)[1])); const as = await j(await fetch(prm.authorization_servers[0] + '/.well-known/oauth-authorization-server'));
// 2. register
const reg = await j(await fetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) }));
assert.ok(reg.client_id);
// 3. authorize -> approve page -> allow
const verifier = crypto.randomBytes(32).toString('base64url'), challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const au = new URL(as.authorization_endpoint); Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'quire' }).forEach(([k, v]) => au.searchParams.set(k, v));
r = await fetch(au, { redirect: 'manual' }); assert.equal(r.status, 302); const approve = r.headers.get('location');
const html = await (await fetch(approve)).text(); assert.match(html, /Connect to Quire\?/);
const req = new URL(approve).searchParams.get('req');
r = await fetch(approve, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `req=${req}&action=allow` });
const back = new URL(r.headers.get('location')); assert.equal(back.searchParams.get('state'), 'xyz'); const code = back.searchParams.get('code');
// bad verifier fails, then good one works, then code can't be reused
let t = await j(await fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'wrong', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }) }));
assert.equal(t.error, 'invalid_grant');
// the code is single-use, so start over for the real exchange
r = await fetch(au, { redirect: 'manual' }); const ap2 = r.headers.get('location'); const req2 = new URL(ap2).searchParams.get('req');
r = await fetch(ap2, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `req=${req2}&action=allow` });
const code2 = new URL(r.headers.get('location')).searchParams.get('code');
t = await j(await fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback' }) }));
assert.ok(t.access_token && t.refresh_token);
const t2 = await j(await fetch(as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: reg.client_id }) }));
assert.ok(t2.access_token); const tok = t2.access_token;
console.log('oauth ok');
// 4. MCP
let id = 0;
const rpc = async (method, params) => { const res = await j(await fetch(B + MCP, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok, accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })); if (res.error) throw new Error(JSON.stringify(res.error)); return res.result; };
const call = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); const txt = r.content[0].text; if (r.isError) return { error: txt }; try { return JSON.parse(txt); } catch { return txt; } };
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
assert.equal(init.protocolVersion, '2025-06-18'); assert.match(init.instructions, /get_instructions/);
const tools = (await rpc('tools/list')).tools.map(t => t.name); console.log('tools:', tools.join(', '));
const ins = await call('get_instructions'); console.log('book:', ins.book, '| beats', ins.beats, '| words', ins.words, '| adjusts waiting', ins.waiting_adjusts.length, '| rules chars', ins.book_rules.length);
const all = await call('list_beats'); assert.ok(all.length > 2, 'list_beats');
const act = all[0].act, inAct = await call('list_beats', { act }); assert.ok(inAct.length >= 1 && inAct.every(b => b.act === act), 'filter by act');
const A = all[1].title, B2 = all[2].title;
const g = await call('get_beat', { beat: A }); assert.equal(g.title, A); assert.ok(typeof g.rev === 'number');
const miss = await call('get_beat', { beat: 'zzzz no such beat' }); assert.ok(miss.error, 'unknown beat is an error');
const word = (g.synopsis.match(/[A-Za-z]{5,}/) || ['the'])[0];
const found = await call('search', { query: word }); assert.ok(Array.isArray(found) && found.length, 'search finds');
await call('list_adjusts'); await call('list_critical'); await call('list_notes');
r = await call('append_to_beat_notes', { beat: A, text: 'Connector test: a cork float on the key.' }); assert.equal(r.saved, true);
r = await call('mark_critical', { beat: A, phrase: 'a cork float on the key' }); assert.equal(r.saved, true);
r = await call('add_adjust', { beat: A, text: 'Tighten the opening.' }); assert.equal(r.saved, true);
r = await call('finish_adjust', { beat: A }); assert.equal(r.saved, true);
const g2 = await call('get_beat', { beat: A });
assert.ok(g2.notes.includes('==a cork float on the key==') && /Claude adjust \(done \d{4}-\d\d-\d\d\):\n\nTighten the opening\./.test(g2.notes) && !g2.adjust.trim(), 'notes, critical, finished adjust');
assert.ok((await call('update_beat', { beat: A, rev: g.rev, synopsis: 'x' })).error, 'stale rev refused');
r = await call('update_beat', { beat: B2, rev: (await call('get_beat', { beat: B2 })).rev, notes: 'See [[' + A + ']].' }); assert.equal(r.saved, true);
r = await call('update_beat', { beat: A, rev: g2.rev, title: A + ' (renamed)' }); assert.equal(r.saved, true); assert.ok(r.links_updated >= 1, 'rename updates links');
assert.ok((await call('get_beat', { beat: B2 })).notes.includes(`[[${A} (renamed)]]`));
const nb = await call('create_beat', { title: 'Connector test beat', synopsis: 'A test.', after: B2 }); assert.equal(nb.saved, true);
r = await call('append_to_note', { note: 'Claude changelog', text: 'Connector test entry.', dated: true }); assert.equal(r.saved, true);
const vs = await call('list_versions', { beat: A + ' (renamed)' }); assert.ok(vs.versions.length >= 2, 'versions recorded');
r = await call('restore_version', { beat: A + ' (renamed)', version: vs.versions[vs.versions.length - 1].version }); assert.equal(r.restored, true);
assert.equal((await call('get_beat', { beat: A })).title, A, 'restored to the original');
const ins2 = await call('get_instructions'); assert.ok(ins2.backup, 'backup status reported');
console.log('mcp ok');
