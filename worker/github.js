// GitHub access for Quire: read a whole repo as one tarball (one subrequest), and write a
// snapshot as a single commit through the Git Data API (five subrequests).

const api = env => (env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');

function headers(env, extra = {}) {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set. Run: npx wrangler secret put GITHUB_TOKEN');
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'quire-app',
    ...extra,
  };
}

// GitHub reports when a fine-grained token expires on every API response; remember it so Quire can warn early.
let expiry = null;
export const tokenExpiry = () => expiry;

async function gh(env, method, path, body) {
  const r = await fetch(api(env) + path, {
    method, headers: headers(env, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const exp = r.headers.get('github-authentication-token-expiration');
  if (exp) { const t = Date.parse(exp.replace(' UTC', 'Z').replace(' ', 'T')); if (t) expiry = t; }
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GitHub ${method} ${path} failed (${r.status}): ${t.slice(0, 300)}`);
  }
  return r.json();
}

const enc = s => s.split('/').map(encodeURIComponent).join('/');

// Returns {tree: {path: text}, sha} for the repo at ref, limited to `sub` (a folder) if given.
export async function readRepo(env, { owner, repo, branch, path: sub = '' }) {
  const ref = branch || (await gh(env, 'GET', `/repos/${owner}/${repo}`)).default_branch;
  const head = await gh(env, 'GET', `/repos/${owner}/${repo}/commits/${enc(ref)}`);
  const r = await fetch(`${api(env)}/repos/${owner}/${repo}/tarball/${head.sha}`, { headers: headers(env) });
  if (!r.ok) throw new Error(`GitHub tarball failed (${r.status})`);
  const tar = new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const prefix = sub ? sub.replace(/^\/|\/$/g, '') + '/' : '';
  const tree = {};
  for (const { name, data } of untar(tar)) {
    const rel = name.split('/').slice(1).join('/'); // drop "owner-repo-sha/"
    if (!rel || (prefix && !rel.startsWith(prefix))) continue;
    const p = rel.slice(prefix.length);
    if (!/\.(md|txt|json)$/i.test(p) || data.length > 2_000_000) continue;
    tree[p] = new TextDecoder().decode(data);
  }
  return { tree, sha: head.sha, branch: ref };
}

function* untar(buf) {
  const td = new TextDecoder();
  const str = (o, n) => td.decode(buf.subarray(o, o + n)).replace(/\0.*$/s, '');
  let off = 0, paxPath = null;
  while (off + 512 <= buf.length) {
    if (buf[off] === 0) break;
    const name = str(off, 100), prefix = str(off + 345, 155);
    const size = parseInt(str(off + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(td.decode(data));
      if (m) paxPath = m[1];
      continue;
    }
    if (type === 'g') continue;
    const full = paxPath || (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    if (type === '0' || type === '\0') yield { name: full, data };
  }
}

// Writes `changes` ({path: text|null}, null = delete) as one commit. Returns the new commit sha.
export async function writeCommit(env, { owner, repo, branch, path: sub = '' }, changes, message) {
  const prefix = sub ? sub.replace(/^\/|\/$/g, '') + '/' : '';
  const base = `/repos/${owner}/${repo}`;
  const ref = await gh(env, 'GET', `${base}/git/ref/heads/${enc(branch)}`);
  const parent = await gh(env, 'GET', `${base}/git/commits/${ref.object.sha}`);
  const entries = Object.entries(changes).map(([p, t]) => t === null
    ? { path: prefix + p, mode: '100644', type: 'blob', sha: null }
    : { path: prefix + p, mode: '100644', type: 'blob', content: t });
  let tree;
  try { tree = await gh(env, 'POST', `${base}/git/trees`, { base_tree: parent.tree.sha, tree: entries }); }
  catch (e) {
    // A file we meant to delete may already be gone (removed by hand). Retry without deletions.
    if (!entries.some(x => x.sha === null)) throw e;
    tree = await gh(env, 'POST', `${base}/git/trees`, { base_tree: parent.tree.sha, tree: entries.filter(x => x.sha !== null) });
  }
  const commit = await gh(env, 'POST', `${base}/git/commits`, { message, tree: tree.sha, parents: [ref.object.sha] });
  await gh(env, 'PATCH', `${base}/git/refs/heads/${enc(branch)}`, { sha: commit.sha });
  return commit.sha;
}
