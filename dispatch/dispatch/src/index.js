// Dispatch — Worker entry point.
//   fetch()     serves the UI, the login, the OAuth dance and the JSON API
//   scheduled() is the cron trigger that sends mail while you are asleep

import { json, bad, log } from './util.js';
import { isLoggedIn, makeSession, sessionCookie, clearCookie } from './auth.js';
import { consentUrl, exchangeCode, saveAccount } from './google.js';
import { handleApi } from './api.js';
import { tick } from './scheduler.js';

const LOGIN_PAGE = (error = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dispatch</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F6F7FA;color:#1B2036;
       font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
  @media (prefers-color-scheme:dark){body{background:#0E1220;color:#E7EAF3}}
  form{background:#fff;padding:28px;border-radius:12px;width:min(340px,92vw);
       box-shadow:0 1px 2px rgba(27,32,54,.05),0 10px 30px -14px rgba(27,32,54,.22)}
  @media (prefers-color-scheme:dark){form{background:#161B2C}}
  h1{margin:0 0 4px;font-size:19px;display:flex;align-items:center;gap:9px}
  .mk{width:22px;height:22px;border-radius:6px;background:#5B4BE0;display:grid;place-items:center;font-size:12px}
  p{margin:0 0 18px;color:#5B6178;font-size:13px}
  input{width:100%;box-sizing:border-box;font:inherit;padding:9px 11px;border:1px solid #E5E7F0;
        border-radius:7px;background:#F6F7FA;color:inherit;margin-bottom:12px}
  @media (prefers-color-scheme:dark){input{background:#0E1220;border-color:#272E44}}
  button{width:100%;font:inherit;font-weight:500;padding:9px;border:0;border-radius:7px;background:#5B4BE0;color:#fff;cursor:pointer}
  .err{color:#C2402C;font-size:12.5px;margin:-6px 0 12px}
</style></head>
<body><form method="POST" action="/login">
  <h1><span class="mk">✉</span> Dispatch</h1>
  <p>Outreach mail, on a clock.</p>
  ${error ? `<div class="err">${error}</div>` : ''}
  <input type="password" name="password" placeholder="App password" autofocus required>
  <button type="submit">Open</button>
</form></body></html>`;

function notice(title, message, href = '/') {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>${title}</title>
     <body style="font:14px/1.6 system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#F6F7FA;color:#1B2036">
     <div style="max-width:440px;padding:28px;background:#fff;border-radius:12px">
       <h2 style="margin:0 0 8px;font-size:18px">${title}</h2>
       <p style="margin:0 0 18px;color:#5B6178">${message}</p>
       <a href="${href}" style="color:#5B4BE0">← back to Dispatch</a>
     </div></body>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    // --- external cron hook, for cron-job.org and friends ---
    if (p === '/cron') {
      if (!env.CRON_SECRET || url.searchParams.get('key') !== env.CRON_SECRET) return bad('forbidden', 403);
      const result = await tick(env);
      return json({ ok: true, ...result });
    }

    // --- health ---
    if (p === '/healthz') return json({ ok: true, time: Date.now() });

    // --- login ---
    if (p === '/login') {
      if (request.method === 'POST') {
        const form = await request.formData();
        const given = String(form.get('password') || '');
        if (!env.APP_PASSWORD) return notice('Not configured', 'Set the APP_PASSWORD secret first — see the README.');
        if (given !== env.APP_PASSWORD) {
          return new Response(LOGIN_PAGE('Wrong password.'), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
        }
        const token = await makeSession(env);
        return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': sessionCookie(token, url) } });
      }
      return new Response(LOGIN_PAGE(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    if (p === '/logout') {
      return new Response(null, { status: 302, headers: { location: '/login', 'set-cookie': clearCookie(url) } });
    }

    const authed = await isLoggedIn(request, env);

    // --- Google OAuth ---
    if (p === '/auth/google') {
      if (!authed) return Response.redirect(`${url.origin}/login`, 302);
      if (!env.GOOGLE_CLIENT_ID) return notice('Missing credentials', 'GOOGLE_CLIENT_ID is not set — see the README.');
      const state = crypto.randomUUID();
      return new Response(null, {
        status: 302,
        headers: {
          location: consentUrl(env, url, state),
          'set-cookie': `oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${url.protocol === 'https:' ? '; Secure' : ''}`,
        },
      });
    }

    if (p === '/auth/google/callback') {
      if (!authed) return Response.redirect(`${url.origin}/login`, 302);
      const err = url.searchParams.get('error');
      if (err) return notice('Google said no', `Consent was not granted (${err}).`);
      const code = url.searchParams.get('code');
      if (!code) return notice('Nothing came back', 'Google did not return an authorisation code.');
      try {
        const tokens = await exchangeCode(env, url, code);
        const email = await saveAccount(env, tokens);
        await log(env, 'info', `Gmail connected as ${email}`);
        return Response.redirect(`${url.origin}/?connected=1`, 302);
      } catch (e) {
        return notice('Could not connect Gmail', String(e.message));
      }
    }

    // --- API ---
    if (p.startsWith('/api/')) {
      if (!authed) return bad('not signed in', 401);
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        await log(env, 'error', `api ${p}: ${e.message}`);
        return bad(e.message || 'something went wrong', 500);
      }
    }

    // --- static UI ---
    if (!authed) return Response.redirect(`${url.origin}/login`, 302);
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      tick(env)
        .then((r) => log(env, 'info', `cron: sent ${r.sent}, replies ${r.replies}${r.skipped.length ? `, skipped ${r.skipped.join('/')}` : ''}`))
        .catch((e) => log(env, 'error', `cron failed: ${e.message}`)),
    );
  },
};
