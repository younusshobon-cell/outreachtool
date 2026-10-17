// Google OAuth: the consent dance, plus a token refresher that every
// Gmail call goes through.

import { now, log } from './util.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// gmail.send alone cannot read replies, so we also ask for readonly.
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

export function redirectUri(url) {
  return `${url.origin}/auth/google/callback`;
}

export function consentUrl(env, url, state) {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(url),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent', // forces a refresh_token every time
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params}`;
}

export async function exchangeCode(env, url, code) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(url),
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'token exchange failed');
  return data; // { access_token, refresh_token, expires_in, scope }
}

export async function saveAccount(env, tokens) {
  // Who did we just connect as?
  let email = '';
  try {
    const who = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (who.ok) email = (await who.json()).email || '';
  } catch { /* not fatal */ }

  const existing = await env.DB.prepare('SELECT refresh_token FROM google_account WHERE id = 1').first();
  const refresh = tokens.refresh_token || existing?.refresh_token || null;

  await env.DB.prepare(
    `INSERT INTO google_account (id, email, access_token, refresh_token, expires_at, scope, connected_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       email = excluded.email,
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, google_account.refresh_token),
       expires_at = excluded.expires_at,
       scope = excluded.scope`,
  )
    .bind(email, tokens.access_token, refresh, now() + (tokens.expires_in || 3600) * 1000 - 60000, tokens.scope || '', now())
    .run();

  return email;
}

export async function getAccount(env) {
  return env.DB.prepare('SELECT * FROM google_account WHERE id = 1').first();
}

/** Returns a live access token, refreshing it when it has gone stale. */
export async function accessToken(env) {
  const acct = await getAccount(env);
  if (!acct) throw new Error('Gmail is not connected yet');
  if (acct.access_token && acct.expires_at > now()) return acct.access_token;
  if (!acct.refresh_token) throw new Error('No refresh token — reconnect Gmail');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: acct.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    await log(env, 'error', `token refresh failed: ${data.error_description || data.error}`);
    throw new Error(data.error_description || data.error || 'token refresh failed');
  }

  await env.DB.prepare('UPDATE google_account SET access_token = ?, expires_at = ? WHERE id = 1')
    .bind(data.access_token, now() + (data.expires_in || 3600) * 1000 - 60000)
    .run();

  return data.access_token;
}

export async function disconnect(env) {
  await env.DB.prepare('DELETE FROM google_account WHERE id = 1').run();
}
