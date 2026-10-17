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
      const queued = await env.DB.prepare("SELECT COUNT(*) AS n FROM mails WHERE mailbox_id = ? AND status IN ('queued','sending')").bind(seg[1]).first();
      if (queued.n) return bad('Cancel this mailbox’s queued mail before removing it', 409);
      await env.DB.prepare('DELETE FROM mailboxes WHERE id = ?').bind(seg[1]).run();
      return json({ok:true});
    }
  }

  // ---------- state ----------
  if (seg[0] === 'state' && method === 'GET') {
    const s = await getSettings(env);
    const acct = await activeMailbox(env) || await getAccount(env);
    const counts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM businesses)                                    AS businesses,
        (SELECT COUNT(*) FROM templates)                                     AS templates,
        (SELECT COUNT(*) FROM campaigns WHERE status = 'active')             AS campaigns,
        (SELECT COUNT(*) FROM mails WHERE status = 'queued')                 AS queued,
        (SELECT COUNT(*) FROM mails WHERE status IN ('sent','drafted'))      AS sent,
        (SELECT COUNT(*) FROM mails WHERE status = 'failed')                 AS failed,
        (SELECT COUNT(*) FROM replies WHERE seen = 0)                        AS unread`,
    ).first();
    const nextRow = await env.DB.prepare(
      "SELECT MIN(scheduled_at) AS t FROM mails WHERE status = 'queued'",
    ).first();
    return json({
      settings: s,
      mailboxes: await listMailboxes(env),
      smtpActive: !!acct?.host,
      account: acct ? { email: acct.email, connectedAt: acct.connected_at } : null,
      counts,
      nextDueAt: nextRow?.t || null,
      inWindow: insideWindow(now(), s),
      serverTime: now(),
    });
  }

  if (seg[0] === 'settings' && method === 'POST') {
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
        ? env.DB.prepare('SELECT * FROM businesses WHERE name LIKE ?1 OR email LIKE ?1 OR city LIKE ?1 ORDER BY created_at DESC').bind(`%${q}%`)
        : env.DB.prepare('SELECT * FROM businesses ORDER BY created_at DESC LIMIT 1000');
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
        const exists = await env.DB.prepare('SELECT id FROM businesses WHERE lower(email) = lower(?)').bind(email).first();
        if (exists) { skipped++; continue; }
        await env.DB.prepare(
          'INSERT INTO businesses (id, name, owner, email, website, city, notes, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
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
      const dup = await env.DB.prepare('SELECT id FROM businesses WHERE lower(email) = lower(?)').bind(body.email).first();
      if (dup) return bad('that email is already on the list');
      const bid = id('b');
      await env.DB.prepare(
        'INSERT INTO businesses (id, name, owner, email, website, city, notes, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).bind(bid, body.name || '', body.owner || '', body.email.trim(), body.website || '', body.city || '', body.notes || '', 'new', now()).run();
      return json({ id: bid });
    }
    if (method === 'PUT' && seg[1]) {
      await env.DB.prepare(
        'UPDATE businesses SET name=?, owner=?, email=?, website=?, city=?, notes=?, status=? WHERE id=?',
      ).bind(body.name || '', body.owner || '', body.email || '', body.website || '', body.city || '', body.notes || '', body.status || 'new', seg[1]).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && seg[1]) {
      await env.DB.prepare('DELETE FROM businesses WHERE id = ?').bind(seg[1]).run();
      await env.DB.prepare("DELETE FROM mails WHERE business_id = ? AND status = 'queued'").bind(seg[1]).run();
      return json({ ok: true });
    }
  }

  // ---------- templates ----------
  if (seg[0] === 'templates') {
    if (method === 'GET') return json((await env.DB.prepare('SELECT * FROM templates ORDER BY created_at DESC').all()).results || []);
    if (method === 'POST' && !seg[1]) {
      const tid = id('t');
      await env.DB.prepare(
        'INSERT INTO templates (id, name, subject, body, followup_subject, followup_body, followup_days, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).bind(tid, body.name || 'Untitled', body.subject || '', body.body || '', body.followup_subject || '', body.followup_body || '', Number(body.followup_days || 0), now()).run();
      return json({ id: tid });
    }
    if (method === 'PUT' && seg[1]) {
      await env.DB.prepare(
        'UPDATE templates SET name=?, subject=?, body=?, followup_subject=?, followup_body=?, followup_days=? WHERE id=?',
      ).bind(body.name || '', body.subject || '', body.body || '', body.followup_subject || '', body.followup_body || '', Number(body.followup_days || 0), seg[1]).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && seg[1]) {
      await env.DB.prepare('DELETE FROM templates WHERE id = ?').bind(seg[1]).run();
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
                (SELECT COUNT(*) FROM mails m WHERE m.campaign_id = c.id) AS total,
                (SELECT COUNT(*) FROM mails m WHERE m.campaign_id = c.id AND m.status IN ('sent','drafted')) AS sent,
                (SELECT COUNT(*) FROM mails m WHERE m.campaign_id = c.id AND m.status = 'queued') AS queued,
                (SELECT COUNT(*) FROM mails m WHERE m.campaign_id = c.id AND m.status = 'failed') AS failed,
                (SELECT COUNT(*) FROM replies r JOIN mails m ON m.id = r.mail_id WHERE m.campaign_id = c.id) AS replies
           FROM campaigns c LEFT JOIN templates t ON t.id = c.template_id
          ORDER BY c.created_at DESC`,
      ).all();
      return json(rows.results || []);
    }
    if (method === 'POST' && !seg[1]) {
      const { name, templateId, businessIds = [], startAt, gapMinutes = 12, dailyCap = 25 } = body;
      if (!templateId) return bad('pick a template');
      if (!businessIds.length) return bad('pick at least one business');
      const tpl = await env.DB.prepare('SELECT * FROM templates WHERE id = ?').bind(templateId).first();
      if (!tpl) return bad('template not found');

      const cid = id('c');
      const begin = Number(startAt) || now();
      await env.DB.prepare(
        'INSERT INTO campaigns (id, name, template_id, status, start_at, gap_minutes, daily_cap, created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).bind(cid, name || 'Untitled campaign', templateId, 'active', begin, Number(gapMinutes), Number(dailyCap), now()).run();

      const gapMs = Math.max(1, Number(gapMinutes)) * 60000;
      const stmts = [];
      let slot = 0;
      for (const bid of businessIds) {
        const biz = await env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(bid).first();
        if (!biz || !isEmail(biz.email)) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO mails (id, campaign_id, business_id, to_email, to_name, subject, body, step, scheduled_at, status, created_at)
             VALUES (?,?,?,?,?,?,?,1,?, 'queued', ?)`,
          ).bind(id('m'), cid, biz.id, biz.email, biz.owner || '', tpl.subject, tpl.body, begin + slot * gapMs, now()),
        );
        stmts.push(env.DB.prepare("UPDATE businesses SET status = 'queued' WHERE id = ? AND status = 'new'").bind(biz.id));
        slot++;
      }
      if (stmts.length) await env.DB.batch(stmts);
      return json({ id: cid, queued: slot });
    }
    if (method === 'POST' && seg[1] && seg[2] === 'status') {
      await env.DB.prepare('UPDATE campaigns SET status = ? WHERE id = ?').bind(body.status || 'active', seg[1]).run();
      if (body.status === 'paused') {
        await env.DB.prepare("UPDATE mails SET status = 'cancelled' WHERE campaign_id = ? AND status = 'queued'").bind(seg[1]).run();
      }
      return json({ ok: true });
    }
    if (method === 'DELETE' && seg[1]) {
      await env.DB.prepare("DELETE FROM mails WHERE campaign_id = ? AND status IN ('queued','cancelled')").bind(seg[1]).run();
      await env.DB.prepare('DELETE FROM campaigns WHERE id = ?').bind(seg[1]).run();
      return json({ ok: true });
    }
  }

  // ---------- mails ----------
  if (seg[0] === 'mails') {
    if (method === 'GET' && !seg[1]) {
      const status = url.searchParams.get('status');
      const campaign = url.searchParams.get('campaign');
      let sql = `SELECT m.*, b.name AS biz_name, b.city FROM mails m LEFT JOIN businesses b ON b.id = m.business_id WHERE 1=1`;
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
      await env.DB.prepare("UPDATE mails SET scheduled_at = ?, status = 'queued', error = NULL WHERE id = ?").bind(now(), seg[1]).run();
      return json(await tick(env, { force: true }));
    }
    if (method === 'DELETE' && seg[1]) {
      await env.DB.prepare("UPDATE mails SET status = 'cancelled' WHERE id = ? AND status IN ('queued','failed')").bind(seg[1]).run();
      return json({ ok: true });
    }
  }

  // ---------- replies ----------
  if (seg[0] === 'replies') {
    if (method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT r.*, b.name AS biz_name FROM replies r LEFT JOIN businesses b ON b.id = r.business_id
          ORDER BY r.received_at DESC LIMIT 200`,
      ).all();
      return json(rows.results || []);
    }
    if (method === 'POST' && seg[1] === 'poll') return json({ found: await pollReplies(env) });
    if (method === 'POST' && seg[1] && seg[2] === 'seen') {
      await env.DB.prepare('UPDATE replies SET seen = 1 WHERE id = ?').bind(seg[1]).run();
      return json({ ok: true });
    }
  }

  // ---------- misc ----------
  if (seg[0] === 'tick' && method === 'POST') return json(await tick(env, { force: !!body.force }));

  if (seg[0] === 'logs' && method === 'GET') {
    const rows = await env.DB.prepare('SELECT * FROM logs ORDER BY at DESC LIMIT 100').all();
    return json(rows.results || []);
  }

  if (seg[0] === 'disconnect' && method === 'POST') {
    await disconnect(env);
    return json({ ok: true });
  }

  return bad('unknown endpoint', 404);
}
