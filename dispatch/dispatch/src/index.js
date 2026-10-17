// Dispatch — Worker entry point.
//   fetch()     serves the UI, the login, the OAuth dance and the JSON API
//   scheduled() is the cron trigger that sends mail while you are asleep

import { json, bad, log } from './util.js';
import { consentUrl, exchangeCode, saveAccount } from './google.js';
import { handleApi } from './api.js';
import { tick } from './scheduler.js';

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
    if (['POST','PUT','PATCH','DELETE'].includes(request.method)) {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return bad('Cross-origin request rejected', 403);
    }

    // --- external cron hook, for cron-job.org and friends ---
    if (p === '/cron') {
      if (!env.CRON_SECRET || url.searchParams.get('key') !== env.CRON_SECRET) return bad('forbidden', 403);
      const result = await tick(env);
      return json({ ok: true, ...result });
    }

    // --- health ---
    if (p === '/healthz') return json({ ok: true, time: Date.now() });

    if (p === '/login' || p === '/logout') return Response.redirect(`${url.origin}/`, 302);
    const authed = true; // Shared workspace, explicitly configured for public access.

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
      const expected = request.headers.get('cookie')?.match(/(?:^|;\s*)oauth_state=([^;]+)/)?.[1];
      if (!expected || expected !== url.searchParams.get('state')) return bad('OAuth state mismatch. Start Connect Gmail again.', 400);
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
