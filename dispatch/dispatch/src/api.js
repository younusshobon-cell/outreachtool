import { connectorStatus } from './saas.js';
import { tenant } from './tenant.js';
import { workflowApi, createCampaign, campaignPace } from './workflows.js';
import { listMailboxes, activeMailbox, saveMailbox, testMailbox, selectMailbox } from './mailboxes.js';
// REST API consumed by public/app.js

import { json, bad, id, now, personalise, isEmail } from './util.js';
import { getSettings, setSetting, tick, pollReplies, insideWindow } from './scheduler.js';
import { getAccount, disconnect } from './google.js';

const SETTING_KEYS = [
  'running', 'mode', 'daily_cap', 'gap_minutes', 'window_start', 'window_end',
  'tz_offset', 'weekdays_only', 'sender_name', 'signature', 'poll_replies',
];

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

export async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, '');
  const seg = path.split('/').filter(Boolean);
  const method = request.method;
  const body = ['POST', 'PUT', 'PATCH'].includes(method)
    ? await request.json().catch(() => ({}))
    : {};

  if (seg[0] === 'mailboxes') {
    if (method === 'GET' && !seg[1]) return json(await listMailboxes(env));
    if (method === 'POST' && !seg[1]) {
      try { return json(await saveMailbox(env, body), 201); } catch(e) { return bad(e.message, 400); }
    }
    if (method === 'POST' && seg[2] === 'test') {
      try { return json(await testMailbox(env, seg[1])); } catch(e) { return bad(e.message, 400); }
    }
    if (method === 'POST' && seg[2] === 'activate') {
      try { return json(await selectMailbox(env, seg[1])); } catch(e) { return bad(e.message, 400); }
    }
    if (method === 'DELETE' && seg[1]) {
      const queued = await env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') mails WHERE mailbox_id = ? AND status IN ('queued','sending')`).bind(seg[1]).first();
      if (queued.n) return bad('Cancel this mailbox’s queued mail before removing it', 409);
      await env.DB.prepare(`DELETE FROM mailboxes WHERE tenant_id = '${tenant(env)}' AND (id = ?) `).bind(seg[1]).run();
      return json({ok:true});
    }
  }

  const extension = await workflowApi(request, env, url, seg, body);
  if (extension) return extension;

  // ---------- state ----------
  if (seg[0] === 'state' && method === 'GET') {
    const s = await getSettings(env);
    const acct = await activeMailbox(env) || await getAccount(env);
    const counts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM (SELECT * FROM businesses WHERE tenant_id = '${tenant(env)}') businesses)                                    AS businesses,
        (SELECT COUNT(*) FROM (SELECT * FROM templates WHERE tenant_id = '${tenant(env)}') templates)                                     AS templates,
        (SELECT COUNT(*) FROM (SELECT * FROM campaigns WHERE tenant_id = '${tenant(env)}') campaigns WHERE status = 'active')             AS campaigns,
        (SELECT COUNT(*) FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') mails WHERE status = 'queued')                 AS queued,
        (SELECT COUNT(*) FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') mails WHERE status IN ('sent','drafted'))      AS sent,
        (SELECT COUNT(*) FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') mails WHERE status = 'failed')                 AS failed,
        (SELECT COUNT(*) FROM (SELECT * FROM replies WHERE tenant_id = '${tenant(env)}') replies WHERE seen = 0)                        AS unread`,
    ).first();
    const nextRow = await env.DB.prepare(
      `SELECT MIN(scheduled_at) AS t FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') mails WHERE status = 'queued'`,
    ).first();
    return json({
      settings: s,
      user: {id:env.USER.id,email:env.USER.email,name:env.USER.name},
      connectors: await connectorStatus(env),
      mailboxes: await listMailboxes(env),
      smtpActive: !!acct?.host,
      account: acct ? { email: acct.email, connectedAt: acct.connected_at } : null,
      counts,
      sentToday: Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') mails WHERE status IN ('sent','drafted') AND sent_at >= ?`).bind(new Date(new Date(now()+s.tzOffset*60000).toISOString().slice(0,10)+'T00:00:00Z').getTime()-s.tzOffset*60000).first()).n),
      nextDueAt: nextRow?.t || null,
      inWindow: insideWindow(now(), s),
      serverTime: now(),
    });
  }

  if (seg[0] === 'settings' && method === 'POST') {
    if('mode' in body && !['draft','send'].includes(body.mode))return bad('Invalid sending mode');
    const ranges={daily_cap:[1,100],gap_minutes:[1,1440],window_start:[0,23],window_end:[0,23],tz_offset:[-720,840]};
    for(const [key,[min,max]] of Object.entries(ranges))if(key in body&&(!Number.isInteger(Number(body[key]))||Number(body[key])<min||Number(body[key])>max))return bad(key+' is outside the allowed range');
    for(const key of ['running','weekdays_only','poll_replies'])if(key in body&&typeof body[key]!=='boolean')return bad(key+' must be true or false');

    for (const k of SETTING_KEYS) {
      if (k in body) await setSetting(env, k, body[k]);
    }
    return json({ ok: true, settings: await getSettings(env) });
  }

  // ---------- businesses ----------
  if (seg[0] === 'businesses') {
    if (method === 'GET' && !seg[1]) {
      const q = url.searchParams.get('q');
      const stmt = q
        ? env.DB.prepare(`SELECT * FROM (SELECT * FROM businesses WHERE tenant_id = '${tenant(env)}') businesses WHERE name LIKE ?1 OR email LIKE ?1 OR city LIKE ?1 ORDER BY created_at DESC`).bind(`%${q}%`)
        : env.DB.prepare(`SELECT * FROM (SELECT * FROM businesses WHERE tenant_id = '${tenant(env)}') businesses ORDER BY created_at DESC LIMIT 1000`);
      return json((await stmt.all()).results || []);
    }
    if (method === 'POST' && seg[1] === 'import') {
      const rows = parseCsv(String(body.csv || ''));
      if (!rows.length) return bad('nothing to import');
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const pick = (r, ...names) => {
        for (const n of names) {
          const i = header.indexOf(n);
          if (i >= 0 && r[i]) return String(r[i]).trim();
        }
        return '';
      };
      let added = 0, skipped = 0;
      for (const r of rows.slice(1)) {
        const email = pick(r, 'email', 'mail', 'e-mail', 'official mail', 'contact email');
        if (!isEmail(email)) { skipped++; continue; }
        const exists = await env.DB.prepare(`SELECT id FROM (SELECT * FROM businesses WHERE tenant_id = '${tenant(env)}') businesses WHERE lower(email) = lower(?)`).bind(email).first();
        if (exists) { skipped++; continue; }
        await env.DB.prepare(
          `INSERT INTO businesses (tenant_id, id, name, owner, email, website, city, notes, status, created_at) VALUES ('${tenant(env)}', ?,?,?,?,?,?,?,?,?)`,
        ).bind(
          id('b'),
          pick(r, 'business', 'business name', 'company', 'name') || email.split('@')[1],
          pick(r, 'owner', 'owner name', 'contact', 'contact name', 'first name'),
          email,
          pick(r, 'website', 'site', 'url', 'domain'),
          pick(r, 'city', 'location', 'town'),
          pick(r, 'notes', 'note'),
          'new', now(),
        ).run();
        added++;
      }
      return json({ added, skipped });
    }
    if (method === 'POST' && !seg[1]) {
      if (!isEmail(body.email)) return bad('a valid email is required');
      const dup = await env.DB.prepare(`SELECT id FROM (SELECT * FROM businesses WHERE tenant_id = '${tenant(env)}') businesses WHERE lower(email) = lower(?)`).bind(body.email).first();
      if (dup) return bad('that email is already on the list');
      const bid = id('b');
      await env.DB.prepare(
        `INSERT INTO businesses (tenant_id, id, name, owner, email, website, city, notes, status, created_at) VALUES ('${tenant(env)}', ?,?,?,?,?,?,?,?,?)`,
      ).bind(bid, body.name || '', body.owner || '', body.email.trim(), body.website || '', body.city || '', body.notes || '', 'new', now()).run();
      return json({ id: bid });
    }
    if (method === 'PUT' && seg[1]) {
      await env.DB.prepare(
        `UPDATE businesses SET name=?, owner=?, email=?, website=?, city=?, notes=?, status=? WHERE tenant_id = '${tenant(env)}' AND (id=?) `,
      ).bind(body.name || '', body.owner || '', body.email || '', body.website || '', body.city || '', body.notes || '', body.status || 'new', seg[1]).run();
      if (['replied','bounced','unsubscribed'].includes(body.status)) await env.DB.prepare(`UPDATE mails SET status='cancelled',error=? WHERE tenant_id = '${tenant(env)}' AND (business_id=? AND status='queued') `).bind('Stopped: '+body.status,seg[1]).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && seg[1]) {
      await env.DB.prepare(`DELETE FROM businesses WHERE tenant_id = '${tenant(env)}' AND (id = ?) `).bind(seg[1]).run();
      await env.DB.prepare(`DELETE FROM mails WHERE tenant_id = '${tenant(env)}' AND (business_id = ? AND status = 'queued') `).bind(seg[1]).run();
      return json({ ok: true });
    }
  }

  // ---------- templates ----------
  if (seg[0] === 'templates') {
    if (method === 'GET') return json((await env.DB.prepare(`SELECT * FROM (SELECT * FROM templates WHERE tenant_id = '${tenant(env)}') templates ORDER BY created_at DESC`).all()).results || []);
    if (method === 'POST' && !seg[1]) {
      const tid = id('t');
      await env.DB.prepare(
        `INSERT INTO templates (tenant_id, id, name, subject, body, followup_subject, followup_body, followup_days, created_at) VALUES ('${tenant(env)}', ?,?,?,?,?,?,?,?)`,
      ).bind(tid, body.name || 'Untitled', body.subject || '', body.body || '', body.followup_subject || '', body.followup_body || '', Number(body.followup_days || 0), now()).run();
      return json({ id: tid });
    }
    if (method === 'PUT' && seg[1]) {
      await env.DB.prepare(
        `UPDATE templates SET name=?, subject=?, body=?, followup_subject=?, followup_body=?, followup_days=? WHERE tenant_id = '${tenant(env)}' AND (id=?) `,
      ).bind(body.name || '', body.subject || '', body.body || '', body.followup_subject || '', body.followup_body || '', Number(body.followup_days || 0), seg[1]).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && seg[1]) {
      await env.DB.prepare(`DELETE FROM templates WHERE tenant_id = '${tenant(env)}' AND (id = ?) `).bind(seg[1]).run();
      return json({ ok: true });
    }
  }

  // ---------- preview ----------
  if (seg[0] === 'preview' && method === 'POST') {
    const biz = body.business || {};
    const s = await getSettings(env);
    const acct = await activeMailbox(env) || await getAccount(env);
    const extra = { sender: acct?.email || '', sender_name: s.senderName, signature: s.signature };
    return json({
      subject: personalise(body.subject || '', biz, extra),
      body: personalise(body.body || '', biz, extra),
    });
  }

  // ---------- campaigns ----------
  if (seg[0] === 'campaigns') {
    if (method === 'GET' && !seg[1]) {
      const rows = await env.DB.prepare(
        `SELECT c.*, t.name AS template_name,
                (SELECT COUNT(*) FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') m WHERE m.campaign_id = c.id) AS total,
                (SELECT COUNT(*) FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') m WHERE m.campaign_id = c.id AND m.status IN ('sent','drafted')) AS sent,
                (SELECT COUNT(*) FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') m WHERE m.campaign_id = c.id AND m.status = 'queued') AS queued,
                (SELECT COUNT(*) FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') m WHERE m.campaign_id = c.id AND m.status = 'failed') AS failed,
                (SELECT COUNT(*) FROM (SELECT * FROM replies WHERE tenant_id = '${tenant(env)}') r JOIN (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') m ON m.id = r.mail_id WHERE m.campaign_id = c.id) AS replies
           FROM (SELECT * FROM campaigns WHERE tenant_id = '${tenant(env)}') c LEFT JOIN (SELECT * FROM templates WHERE tenant_id = '${tenant(env)}') t ON t.id = c.template_id
          ORDER BY c.created_at DESC`,
      ).all();
      return json(rows.results || []);
    }
    if (method === 'POST' && !seg[1]) {
      try { return json(await createCampaign(env, body)); } catch(e) { return bad(e.message, 400); }
    }
    if (method === 'POST' && seg[1] && seg[2] === 'status') {
      if (!['active','paused','stopped'].includes(body.status)) return bad('Invalid campaign status');
      await env.DB.prepare(`UPDATE campaigns SET status = ? WHERE tenant_id = '${tenant(env)}' AND (id = ?) `).bind(body.status, seg[1]).run();
      if (body.status === 'stopped') await env.DB.prepare(`UPDATE mails SET status='cancelled',error='Campaign stopped' WHERE tenant_id = '${tenant(env)}' AND (campaign_id=? AND status='queued') `).bind(seg[1]).run();
      return json({ ok: true });
    }
    if (method === 'PUT' && seg[1]) {
      try { const {gap,cap}=campaignPace(body.gapMinutes,body.dailyCap);
        await env.DB.prepare(`UPDATE campaigns SET gap_minutes=?,daily_cap=? WHERE tenant_id = '${tenant(env)}' AND (id=?) `).bind(gap,cap,seg[1]).run();
        return json({ok:true});
      }catch(e){return bad(e.message);}
    }
    if (method === 'DELETE' && seg[1]) {
      await env.DB.prepare(`DELETE FROM mails WHERE tenant_id = '${tenant(env)}' AND (campaign_id = ? AND status IN ('queued','cancelled')) `).bind(seg[1]).run();
      await env.DB.prepare(`DELETE FROM campaigns WHERE tenant_id = '${tenant(env)}' AND (id = ?) `).bind(seg[1]).run();
      return json({ ok: true });
    }
  }

  // ---------- mails ----------
  if (seg[0] === 'mails') {
    if (method === 'GET' && !seg[1]) {
      const status = url.searchParams.get('status');
      const campaign = url.searchParams.get('campaign');
      let sql = `SELECT m.*, b.name AS biz_name, b.city FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') m LEFT JOIN (SELECT * FROM businesses WHERE tenant_id = '${tenant(env)}') b ON b.id = m.business_id WHERE 1=1`;
      const binds = [];
      if (status && status !== 'all') {
        if (status === 'sent') sql += " AND m.status IN ('sent','drafted')";
        else { sql += ' AND m.status = ?'; binds.push(status); }
      }
      if (campaign) { sql += ' AND m.campaign_id = ?'; binds.push(campaign); }
      sql += ' ORDER BY COALESCE(m.sent_at, m.scheduled_at) DESC LIMIT 300';
      const rows = await env.DB.prepare(sql).bind(...binds).all();
      return json(rows.results || []);
    }
    if (method === 'POST' && seg[1] && seg[2] === 'now') {
      await env.DB.prepare(`UPDATE mails SET scheduled_at = ?, status = 'queued', error = NULL WHERE tenant_id = '${tenant(env)}' AND (id = ?) `).bind(now(), seg[1]).run();
      return json(await tick(env, { force: true }));
    }
    if (method === 'DELETE' && seg[1]) {
      await env.DB.prepare(`UPDATE mails SET status = 'cancelled' WHERE tenant_id = '${tenant(env)}' AND (id = ? AND status IN ('queued','failed')) `).bind(seg[1]).run();
      return json({ ok: true });
    }
  }

  // ---------- replies ----------
  if (seg[0] === 'replies') {
    if (method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT r.*, b.name AS biz_name FROM (SELECT * FROM replies WHERE tenant_id = '${tenant(env)}') r LEFT JOIN (SELECT * FROM businesses WHERE tenant_id = '${tenant(env)}') b ON b.id = r.business_id
          ORDER BY r.received_at DESC LIMIT 200`,
      ).all();
      return json(rows.results || []);
    }
    if (method === 'POST' && seg[1] === 'poll') return json({ found: await pollReplies(env) });
    if (method === 'POST' && seg[1] && seg[2] === 'seen') {
      await env.DB.prepare(`UPDATE replies SET seen = 1 WHERE tenant_id = '${tenant(env)}' AND (id = ?) `).bind(seg[1]).run();
      return json({ ok: true });
    }
  }

  // ---------- misc ----------
  if (seg[0] === 'tick' && method === 'POST') return json(await tick(env, { force: !!body.force }));

  if (seg[0] === 'logs' && method === 'GET') {
    const rows = await env.DB.prepare(`SELECT * FROM (SELECT * FROM logs WHERE tenant_id = '${tenant(env)}') logs ORDER BY at DESC LIMIT 100`).all();
    return json(rows.results || []);
  }

  if (seg[0] === 'disconnect' && method === 'POST') {
    return bad('Use Connections to disconnect a mailbox',400);
    return json({ ok: true });
  }

  return bad('unknown endpoint', 404);
}
