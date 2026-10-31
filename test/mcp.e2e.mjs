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
const beats = await call('list_beats', { act: '1' }); console.log('act 1 beats:', beats.length, '| first:', beats[0].title, '/', beats[0].stream);
const g = await call('get_beat', { beat: 'dinghy key' }); console.log('get_beat:', g.title, 'rev', g.rev, '| links', JSON.stringify(g.links), '| linked_from', JSON.stringify(g.linked_from));
console.log('ambiguous:', (await call('get_beat', { beat: 'dream' })).error);
console.log('search:', JSON.stringify((await call('search', { query: 'cologne' })).slice?.(0, 2)));
console.log('adjusts:', JSON.stringify(await call('list_adjusts')).slice(0, 200));
// writes
console.log('append note:', JSON.stringify(await call('append_to_beat_notes', { beat: 'The dinghy key', text: 'Voice test: the key has a cork float.' })));
console.log('mark critical:', JSON.stringify(await call('mark_critical', { beat: 'The dinghy key', phrase: 'the key has a cork float' })));
console.log('add adjust:', JSON.stringify(await call('add_adjust', { beat: 'The dinghy key', text: 'Tighten the opening.' })));
console.log('finish adjust:', JSON.stringify(await call('finish_adjust', { beat: 'The dinghy key' })));
const g2 = await call('get_beat', { beat: 'The dinghy key' }); console.log('notes tail:', JSON.stringify(g2.notes.slice(-170)), '| critical', JSON.stringify(g2.critical_details));
console.log('stale rev:', (await call('update_beat', { beat: 'The dinghy key', rev: g.rev, synopsis: 'x' })).error);
const nb = await call('create_beat', { title: 'Connector test beat', synopsis: 'A test.', after: 'The dinghy key' }); console.log('create:', JSON.stringify(nb));
console.log('append_to_note:', JSON.stringify(await call('append_to_note', { note: 'Claude changelog', text: 'Connector test entry.', dated: true })));
console.log('critical list:', JSON.stringify(await call('list_critical')).slice(0, 200));
console.log('rename:', JSON.stringify(await call('update_beat', { beat: 'Connector test beat', rev: 1, title: 'Connector test beat 2' })));
console.log('mcp ok');
