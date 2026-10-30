// A tiny fake GitHub API for local testing: serves one repo folder as a tarball and records commits.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [, , dir, port = 8799] = process.argv;
const commits = [];
let head = 'c0ffee0', tree = 't0';
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  const u = req.url;
  if (req.headers.authorization !== 'Bearer test-token') return send(res, 401, { message: 'Bad credentials' });
  if (u === '/__commits') return send(res, 200, commits);
  let m;
  if ((m = /^\/repos\/[^/]+\/[^/]+$/.exec(u))) return send(res, 200, { default_branch: 'main' });
  if (/\/commits\/[^/]+$/.test(u) && !u.includes('/git/')) return send(res, 200, { sha: head });
  if (/\/tarball\//.test(u)) {
    const tmp = '/tmp/mockgh-tar'; fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
    fs.cpSync(dir, path.join(tmp, `owner-repo-${head}`), { recursive: true });
    const tgz = execFileSync('tar', ['czf', '-', '--format=pax', '-C', tmp, `owner-repo-${head}`]);
    return send(res, 200, tgz, 'application/gzip');
  }
  if (/\/git\/ref\/heads\//.test(u)) return send(res, 200, { object: { sha: head } });
  if (/\/git\/commits\/[^/]+$/.test(u)) return send(res, 200, { tree: { sha: tree } });
  if (u.endsWith('/git/trees') && req.method === 'POST') { const b = JSON.parse(body); commits.push({ entries: b.tree }); tree = 't' + commits.length; return send(res, 201, { sha: tree }); }
  if (u.endsWith('/git/commits') && req.method === 'POST') { const b = JSON.parse(body); commits[commits.length - 1].message = b.message; return send(res, 201, { sha: 'c' + commits.length }); }
  if (/\/git\/refs\/heads\//.test(u) && req.method === 'PATCH') { head = JSON.parse(body).sha; return send(res, 200, {}); }
  send(res, 404, { message: 'mock: not found ' + u });
}).listen(port, () => console.log('mock github on', port));
