// Verifies the Cloudflare Access JWT on every API request. Access sits in front of the whole site;
// this check makes sure requests really came through it. It accepts both kinds of Access sign-in:
//   - a person (JWT carries `email`), e.g. Jesse in a browser;
//   - a service token (JWT carries `common_name` = the token's Client ID, no email), e.g. Claude.
// Every refusal says why, in JSON, so problems can be diagnosed without guessing. No secrets are echoed.

let jwks = null, jwksAt = 0;

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const deny = (reason, detail = {}) => new Response(JSON.stringify({ error: 'Not authorized', reason, ...detail }), { status: 401, headers: { 'Content-Type': 'application/json' } });

async function keys(team, force) {
  if (force || !jwks || Date.now() - jwksAt > 3600_000) {
    jwks = (await (await fetch(`${team}/cdn-cgi/access/certs`)).json()).keys || [];
    jwksAt = Date.now();
  }
  return jwks;
}

export async function checkAccess(request, env) {
  if (env.DEV_NO_AUTH === '1') return { email: 'dev@localhost', kind: 'dev' };
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Response('Quire is not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.toml', { status: 500 });
  const team = env.ACCESS_TEAM_DOMAIN.trim().replace(/\/+$/, '');
  // ACCESS_AUD may list several application tags, comma-separated (e.g. one per Access application).
  const allowed = env.ACCESS_AUD.split(',').map(s => s.trim()).filter(Boolean);

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw deny('no-access-token', { hint: 'The request did not come through Cloudflare Access. Check that Access is enabled for this hostname and that a service token is allowed by a Service Auth policy.' });

  let header, payload, h, p, s;
  try {
    [h, p, s] = token.split('.');
    header = JSON.parse(new TextDecoder().decode(b64url(h)));
    payload = JSON.parse(new TextDecoder().decode(b64url(p)));
  } catch { throw deny('malformed-token'); }

  let jwk = (await keys(team)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await keys(team, true)).find(k => k.kid === header.kid); // keys rotate; refetch once
  if (!jwk) throw deny('unknown-signing-key', { iss: payload.iss, expectedIssuer: team });

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw deny('bad-signature');

  const iss = String(payload.iss || '').replace(/\/+$/, '');
  if (iss !== team) throw deny('wrong-issuer', { iss: payload.iss, expectedIssuer: team });

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.some(a => allowed.includes(a))) throw deny('wrong-audience', { aud, hint: 'Add this AUD to ACCESS_AUD in wrangler.toml (comma-separated) if this Access application should be trusted.' });

  if (payload.exp && payload.exp * 1000 < Date.now() - 60_000) throw deny('expired');

  if (payload.email) return { email: payload.email, kind: 'person' };
  if (payload.common_name) return { email: `service:${payload.common_name}`, kind: 'service-token' };
  // Some service-token JWTs carry the identity only in `sub`; any token that passed the checks above came from Access.
  return { email: `service:${payload.sub || 'token'}`, kind: 'service-token' };
}
