// OAuth 2.1 for the Quire connector (what claude.ai expects of a remote MCP server):
// discovery documents, dynamic client registration, authorization code + PKCE (S256), refresh tokens.
//
// Who may approve? Only Jesse: /oauth/authorize (on the connector worker) sends the browser to
// /api/oauth/approve on the main Quire app, which sits behind Cloudflare Access. That page asks
// "Allow Claude to use Quire?" and, on Allow, issues the code. Tokens are stored hashed.
import { DurableObject } from 'cloudflare:workers';

const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n = 32) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64u(a); };
const sha = async s => b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id' };
export const json = (d, status = 200, h = {}) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...h } });
export const cors = () => new Response(null, { status: 204, headers: CORS });

const ACCESS_TTL = 24 * 3600, REFRESH_TTL = 180 * 24 * 3600, CODE_TTL = 300, REQUEST_TTL = 900;

export class AuthStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT, redirect_uris TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, client_id TEXT, redirect_uri TEXT, state TEXT, challenge TEXT, scope TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, client_id TEXT, redirect_uri TEXT, challenge TEXT, who TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, kind TEXT, client_id TEXT, who TEXT, expires INTEGER, created INTEGER);`);
  }
  now() { return Math.floor(Date.now() / 1000); }
  cleanup() {
    const t = this.now();
    this.sql.exec('DELETE FROM requests WHERE created < ?', t - REQUEST_TTL);
    this.sql.exec('DELETE FROM codes WHERE created < ?', t - CODE_TTL);
    this.sql.exec('DELETE FROM tokens WHERE expires < ?', t);
  }

  register(name, redirectUris) {
    const id = 'quire-' + rand(12);
    this.sql.exec('INSERT INTO clients (id, name, redirect_uris, created) VALUES (?,?,?,?)', id, String(name || 'Claude').slice(0, 100), JSON.stringify(redirectUris), this.now());
    return id;
  }
  client(id) {
    const r = this.sql.exec('SELECT * FROM clients WHERE id = ?', id).toArray()[0];
    return r ? { id: r.id, name: r.name, redirect_uris: JSON.parse(r.redirect_uris) } : null;
  }
  startRequest(p) {
    this.cleanup();
    const id = rand(18);
    this.sql.exec('INSERT INTO requests (id, client_id, redirect_uri, state, challenge, scope, created) VALUES (?,?,?,?,?,?,?)', id, p.client_id, p.redirect_uri, p.state || '', p.challenge, p.scope || '', this.now());
    return id;
  }
  request(id) {
    this.cleanup();
    const r = this.sql.exec('SELECT * FROM requests WHERE id = ?', id).toArray()[0];
    if (!r) return null;
    return { ...r, client: this.client(r.client_id) };
  }
  // Jesse approved: turn the pending request into a one-time code. Returns the redirect URL.
  async approve(reqId, who, allow) {
    const r = this.request(reqId); if (!r) return null;
    this.sql.exec('DELETE FROM requests WHERE id = ?', reqId);
    const u = new URL(r.redirect_uri);
    if (!allow) { u.searchParams.set('error', 'access_denied'); if (r.state) u.searchParams.set('state', r.state); return u.toString(); }
    const code = rand(32);
    this.sql.exec('INSERT INTO codes (hash, client_id, redirect_uri, challenge, who, created) VALUES (?,?,?,?,?,?)', await sha(code), r.client_id, r.redirect_uri, r.challenge, who, this.now());
    u.searchParams.set('code', code); if (r.state) u.searchParams.set('state', r.state);
    return u.toString();
  }
  async issue(clientId, who) {
    const access = rand(32), refresh = rand(32), t = this.now();
    this.sql.exec('INSERT INTO tokens (hash, kind, client_id, who, expires, created) VALUES (?,?,?,?,?,?)', await sha(access), 'access', clientId, who, t + ACCESS_TTL, t);
    this.sql.exec('INSERT INTO tokens (hash, kind, client_id, who, expires, created) VALUES (?,?,?,?,?,?)', await sha(refresh), 'refresh', clientId, who, t + REFRESH_TTL, t);
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: 'quire' };
  }
  async exchangeCode(code, verifier, clientId, redirectUri) {
    this.cleanup();
    const h = await sha(code || '');
    const r = this.sql.exec('SELECT * FROM codes WHERE hash = ?', h).toArray()[0];
    if (!r) return { error: 'invalid_grant', error_description: 'Unknown or expired code' };
    this.sql.exec('DELETE FROM codes WHERE hash = ?', h);   // one use only
    if (clientId && r.client_id !== clientId) return { error: 'invalid_grant', error_description: 'Client mismatch' };
    if (redirectUri && r.redirect_uri !== redirectUri) return { error: 'invalid_grant', error_description: 'redirect_uri mismatch' };
    if (!verifier || await sha(verifier) !== r.challenge) return { error: 'invalid_grant', error_description: 'PKCE verification failed' };
    return this.issue(r.client_id, r.who);
  }
  async refresh(token, clientId) {
    this.cleanup();
    const h = await sha(token || '');
    const r = this.sql.exec("SELECT * FROM tokens WHERE hash = ? AND kind = 'refresh'", h).toArray()[0];
    if (!r || (clientId && r.client_id !== clientId)) return { error: 'invalid_grant', error_description: 'Unknown or expired refresh token' };
    this.sql.exec('DELETE FROM tokens WHERE hash = ?', h);   // rotate
    return this.issue(r.client_id, r.who);
  }
  async check(token) {
    const r = this.sql.exec("SELECT who, expires FROM tokens WHERE hash = ? AND kind = 'access'", await sha(token || '')).toArray()[0];
    return r && r.expires > this.now() ? r.who : null;
  }
  revokeAll() { this.sql.exec('DELETE FROM tokens'); this.sql.exec('DELETE FROM codes'); return true; }
}

export const authStore = env => env.AUTH.get(env.AUTH.idFromName('auth'));

const okRedirect = u => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname)); } catch { return false; } };

async function body(request) {
  const ct = request.headers.get('content-type') || '';
  if (ct.includes('application/json')) return request.json().catch(() => ({}));
  const t = await request.text();
  return Object.fromEntries(new URLSearchParams(t));
}

// Handles the connector's OAuth endpoints. Returns a Response, or null if the path isn't ours.
export async function handleOAuth(request, env, origin) {
  const url = new URL(request.url), p = url.pathname;
  if (request.method === 'OPTIONS' && (p.startsWith('/oauth/') || p.startsWith('/.well-known/'))) return cors();

  if (p.startsWith('/.well-known/oauth-protected-resource'))
    return json({ resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'], scopes_supported: ['quire'], resource_name: 'Quire' });
  if (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration'))
    return json({
      issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`, response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'], scopes_supported: ['quire'],
    });

  const store = authStore(env);
  if (p === '/oauth/register' && request.method === 'POST') {
    const b = await body(request);
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length || !uris.every(okRedirect)) return json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https (or http://localhost)' }, 400);
    const id = await store.register(b.client_name, uris);
    return json({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: b.client_name || 'Claude', redirect_uris: uris,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201);
  }

  if (p === '/oauth/authorize' && request.method === 'GET') {
    const q = Object.fromEntries(url.searchParams);
    const client = q.client_id && await store.client(q.client_id);
    if (!client) return page('Unknown app', 'This app has not registered with Quire. Remove the connector in Claude and add it again.', 400);
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) return page('Wrong return address', 'The app asked to return somewhere it did not register.', 400);
    const back = (error, d) => { const u = new URL(q.redirect_uri); u.searchParams.set('error', error); if (d) u.searchParams.set('error_description', d); if (q.state) u.searchParams.set('state', q.state); return Response.redirect(u.toString(), 302); };
    if (q.response_type !== 'code') return back('unsupported_response_type');
    if (!q.code_challenge || (q.code_challenge_method || 'plain') !== 'S256') return back('invalid_request', 'PKCE with S256 is required');
    const id = await store.startRequest({ client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state, challenge: q.code_challenge, scope: q.scope });
    const app = (env.APP_ORIGIN || origin).replace(/\/$/, '');
    return Response.redirect(`${app}/api/oauth/approve?req=${encodeURIComponent(id)}`, 302);
  }

  if (p === '/oauth/token' && request.method === 'POST') {
    const b = await body(request);
    let clientId = b.client_id;
    const basic = request.headers.get('authorization');
    if (!clientId && basic?.startsWith('Basic ')) clientId = atob(basic.slice(6)).split(':')[0];
    let r;
    if (b.grant_type === 'authorization_code') r = await store.exchangeCode(b.code, b.code_verifier, clientId, b.redirect_uri);
    else if (b.grant_type === 'refresh_token') r = await store.refresh(b.refresh_token, clientId);
    else r = { error: 'unsupported_grant_type' };
    return json(r, r.error ? 400 : 200);
  }
  return null;
}

// The approval page, served by the main app (behind Cloudflare Access).
export async function handleApprove(request, env, user, origin) {
  if (user.kind === 'service-token') return page('Not here', 'A service token cannot approve connectors. Open this page in your browser.', 403);
  const url = new URL(request.url), store = authStore(env);
  if (request.method === 'POST') {
    const f = Object.fromEntries(new URLSearchParams(await request.text()));
    const o = request.headers.get('origin');
    if (o && o !== origin) return page('Blocked', 'That approval came from another site.', 403);
    const to = await store.approve(f.req, user.email, f.action === 'allow');
    if (!to) return page('Expired', 'This request has expired. Go back to Claude and connect again.', 400);
    return Response.redirect(to, 302);
  }
  const r = await store.request(url.searchParams.get('req') || '');
  if (!r) return page('Expired', 'This request has expired. Go back to Claude and connect again.', 400);
  const host = new URL(r.redirect_uri).host;
  return page('Connect to Quire?', `<p><b>${esc(r.client?.name || 'Claude')}</b> (returning to <code>${esc(host)}</code>) wants to read and edit your books in Quire.</p>
    <p class="muted">Signed in as ${esc(user.email)}. Claude follows your book's Claude instructions and asks before changing anything. You can disconnect it any time in Claude's connector settings.</p>
    <form method="post"><input type="hidden" name="req" value="${esc(url.searchParams.get('req'))}">
    <button name="action" value="allow" class="primary">Allow</button> <button name="action" value="deny">Deny</button></form>`, 200, true);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function page(title, html, status = 200, raw = false) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Quire</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;background:#F7F2E8;color:#1F2A44;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
main{max-width:440px;background:#FFFDF8;border:1px solid #E4DCCB;border-radius:18px;padding:28px}h1{font-size:22px;margin:12px 0}.muted{color:#7A7F8C;font-size:15px}
button{font:inherit;font-weight:650;padding:11px 22px;border-radius:12px;border:1px solid #E4DCCB;background:#fff;margin-right:8px;cursor:pointer}.primary{background:#1F2A44;color:#F7F2E8;border-color:#1F2A44}
code{background:#eee6d6;padding:1px 6px;border-radius:5px;font-size:.9em}</style>
<main><img src="/icons/logo.svg" width="48" height="48" alt=""><h1>${esc(title)}</h1>${raw ? html : `<p>${esc(html)}</p>`}</main>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } });
}
