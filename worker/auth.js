// Verifies the Cloudflare Access JWT on every API request. Access sits in front of the whole site;
// this check makes sure requests really came through it (and works for Access service tokens too).

let jwks = null, jwksAt = 0;

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));

export async function checkAccess(request, env) {
  if (env.DEV_NO_AUTH === '1') return { email: 'dev@localhost' };
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Response('Quire is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.toml', { status: 500 });
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new Response('Not signed in', { status: 401 });
  const [h, p, s] = token.split('.');
  const header = JSON.parse(new TextDecoder().decode(b64url(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  const team = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
  if (!jwks || Date.now() - jwksAt > 3600_000) {
    jwks = (await (await fetch(`${team}/cdn-cgi/access/certs`)).json()).keys;
    jwksAt = Date.now();
  }
  const jwk = jwks.find(k => k.kid === header.kid);
  if (!jwk) throw new Response('Unknown signing key', { status: 401 });
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!ok || !aud.includes(env.ACCESS_AUD) || payload.iss !== team || payload.exp * 1000 < Date.now())
    throw new Response('Invalid sign-in', { status: 401 });
  return { email: payload.email || payload.common_name || 'service-token' };
}
