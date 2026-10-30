// Quire Worker: serves the app and routes /api/* to the right book's Durable Object.
import { checkAccess } from './auth.js';
export { Project, Registry } from './project.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    let user;
    try { user = await checkAccess(request, env); } catch (r) { return r instanceof Response ? r : json({ error: String(r) }, 401); }

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
