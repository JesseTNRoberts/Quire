// Quire Worker: serves the app and routes /api/* to the right book's Durable Object.
import { checkAccess } from './auth.js';
import { handleOAuth, handleApprove } from './oauth.js';
import { handleMcp } from './mcp.js';
export { Project, Registry } from './project.js';
export { AuthStore } from './oauth.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // The connector (ROLE=mcp, deployed as quire-mcp): OAuth + MCP endpoints only, no Cloudflare Access in front.
    // In local development both roles run in one worker.
    const role = env.ROLE || 'app', mcpOn = role === 'mcp' || env.DEV_NO_AUTH === '1';
    if (mcpOn) {
      // Standard default endpoint names (used by clients that skip discovery) map onto ours.
      const alias = { '/authorize': '/oauth/authorize', '/token': '/oauth/token', '/register': '/oauth/register' }[url.pathname];
      if (alias) { const u = new URL(request.url); u.pathname = alias; request = new Request(u, request); }
      const path = alias || url.pathname;
      if (path === '/mcp') return handleMcp(request, env, url.origin, '/mcp');
      if (path.startsWith('/oauth/') || path.startsWith('/.well-known/')) {
        const r = await handleOAuth(request, env, url.origin); if (r) return r;
      }
      // The connector also answers at its root, in case it was added without /mcp.
      if (role === 'mcp' && path === '/' && !(request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html')))
        return handleMcp(request, env, url.origin, '');
    }
    if (role === 'mcp') {
      if (url.pathname.startsWith('/icons/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('', { status: 404 });
      return new Response('Quire connector. In Claude, add ' + url.origin + '/mcp as a custom connector (no OAuth client ID or secret needed).', { status: url.pathname === '/' ? 200 : 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    let user;
    try { user = await checkAccess(request, env); } catch (r) { return r instanceof Response ? r : json({ error: String(r) }, 401); }

    if (url.pathname === '/api/oauth/approve') return handleApprove(request, env, user, url.origin);
    if (url.pathname === '/api/me') return json({ ...user, snapshotMinutes: Number(env.SNAPSHOT_MINUTES || 30) });

    const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
    if (url.pathname === '/api/books') {
      if (request.method === 'POST') {
        const { slug, title } = await request.json();
        if (!/^[a-z0-9-]{1,40}$/.test(slug || '')) return json({ error: 'Book id must be lowercase letters, numbers and dashes' }, 400);
        return registry.fetch('https://r/', { method: 'POST', body: JSON.stringify({ slug, title }) });
      }
      return registry.fetch('https://r/');
    }

    const m = /^\/api\/book\/([a-z0-9-]{1,40})(\/.*)$/.exec(url.pathname);
    if (!m) return json({ error: 'Not found' }, 404);
    const [, slug, rest] = m;
    const stub = env.PROJECT.get(env.PROJECT.idFromName(slug));
    const inner = new URL(rest + url.search, 'https://book');
    const res = await stub.fetch(new Request(inner, request));
    // Keep the directory's title in step after imports.
    if (rest === '/import' && res.ok) {
      const body = await res.clone().json();
      await registry.fetch('https://r/', { method: 'POST', body: JSON.stringify({ slug, title: body.title }) });
    }
    return res;
  },
};
