// The app is on a public URL and it can send mail from your Gmail account,
// so everything except the login page sits behind a password.

const COOKIE = 'dispatch_session';
const TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeSession(env) {
  const exp = Date.now() + TTL_MS;
  const payload = `v1.${exp}`;
  const sig = await hmac(env.SESSION_SECRET || env.APP_PASSWORD || 'dev', payload);
  return `${payload}.${sig}`;
}

export async function validSession(env, token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [v, exp, sig] = parts;
  if (v !== 'v1') return false;
  if (Number(exp) < Date.now()) return false;
  const expected = await hmac(env.SESSION_SECRET || env.APP_PASSWORD || 'dev', `${v}.${exp}`);
  return timingSafeEqual(sig, expected);
}

export function readCookie(request, name = COOKIE) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function sessionCookie(token, url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure}`;
}

export function clearCookie(url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export async function isLoggedIn(request, env) {
  return validSession(env, readCookie(request));
}
