import { activeMailbox } from './mailboxes.js';
// The part that makes this work with your laptop shut: a cron trigger wakes
// the Worker, this runs, due mail goes out, follow-ups get queued.

import { now, log, personalise, id } from './util.js';
import { sendMail, messageIdHeader, findReply } from './gmail.js';
import { getAccount } from './google.js';

export async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows.results || []) s[r.key] = r.value;
  return {
    running: s.running === 'true',
    mode: s.mode || 'draft',
    dailyCap: Number(s.daily_cap || 25),
    gapMinutes: Number(s.gap_minutes || 12),
    windowStart: Number(s.window_start ?? 9),
    windowEnd: Number(s.window_end ?? 18),
    tzOffset: Number(s.tz_offset ?? 0),
    weekdaysOnly: s.weekdays_only === 'true',
    senderName: s.sender_name || '',
    signature: s.signature || '',
    pollReplies: s.poll_replies !== 'false',
  };
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, String(value)).run();
}

/** Local wall clock for the configured timezone offset. */
function local(ts, tzOffsetMinutes) {
  const d = new Date(ts + tzOffsetMinutes * 60000);
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), day: d.getUTCDay(), date: d.toISOString().slice(0, 10) };
}

function startOfLocalDay(ts, tzOffsetMinutes) {
  const d = new Date(ts + tzOffsetMinutes * 60000);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - tzOffsetMinutes * 60000;
}

export function insideWindow(ts, s) {
  const l = local(ts, s.tzOffset);
  if (s.weekdaysOnly && (l.day === 0 || l.day === 6)) return false;
  if (s.windowStart === s.windowEnd) return true; // 24h
  if (s.windowStart < s.windowEnd) return l.hour >= s.windowStart && l.hour < s.windowEnd;
  return l.hour >= s.windowStart || l.hour < s.windowEnd; // window crosses midnight
}

async function sentToday(env, s) {
  const since = startOfLocalDay(now(), s.tzOffset);
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM mails WHERE status IN ('sent','drafted') AND sent_at >= ?",
  ).bind(since).first();
  return Number(row?.n || 0);
}

async function lastSentAt(env) {
  const row = await env.DB.prepare(
    "SELECT MAX(sent_at) AS t FROM mails WHERE status IN ('sent','drafted')",
  ).first();
  return Number(row?.t || 0);
}

/**
 * One pass of the scheduler. Safe to call as often as you like — every guard
 * (window, cap, gap) is re-checked here.
 */
export async function tick(env, options = {}) {
  const token = crypto.randomUUID();
  const lock = await env.DB.prepare("INSERT INTO scheduler_locks (id,token,expires_at) VALUES ('send',?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE expires_at < ? RETURNING token").bind(token,now()+120000,now()).first();
  if (!lock) return {sent:0,replies:0,skipped:['another-run-active']};
  try { return await runTick(env,options); }
  finally { await env.DB.prepare("DELETE FROM scheduler_locks WHERE id='send' AND token=?").bind(token).run(); }
}
async function runTick(env, { force = false } = {}) {
  const s = await getSettings(env);
  const out = { sent: 0, skipped: [], replies: 0 };

  if (!s.running && !force) { out.skipped.push('paused'); return out; }

  const acct = await activeMailbox(env) || await getAccount(env);




  if (s.pollReplies && await getAccount(env)) {
    try { out.replies = await pollReplies(env); } catch (e) { await log(env, 'warn', `reply poll: ${e.message}`); }
  }

  if (!force && !insideWindow(now(), s)) { out.skipped.push('outside-send-window'); return out; }

  let budget = s.dailyCap - (await sentToday(env, s));
  if (budget <= 0) { out.skipped.push('daily-cap-reached'); return out; }

  await env.DB.prepare("UPDATE mails SET status='cancelled',error='Recipient suppressed' WHERE status='queued' AND business_id IN (SELECT id FROM businesses WHERE status IN ('replied','bounced','unsubscribed'))").run();

  // One cron run may send several, as long as the spacing is respected.
  const perRun = 1; // One-minute heartbeat; pacing is enforced per campaign.

  for (let i = 0; i < perRun; i++) {
    if (budget <= 0) break;

    const mail = await env.DB.prepare(
      `SELECT m.*, c.mailbox_id AS campaign_mailbox_id, b.name AS biz_name, b.owner, b.city, b.website, b.email AS biz_email, b.notes
         FROM mails m LEFT JOIN businesses b ON b.id = m.business_id LEFT JOIN campaigns c ON c.id=m.campaign_id
        WHERE m.status = 'queued' AND m.scheduled_at <= ?
          AND (m.campaign_id IS NULL OR c.status='active')
          AND (c.id IS NULL OR (SELECT COUNT(*) FROM mails x WHERE x.campaign_id=c.id AND x.status IN ('sent','drafted') AND x.sent_at>=?) < c.daily_cap)
          AND (c.id IS NULL OR COALESCE((SELECT MAX(x.sent_at) FROM mails x WHERE x.campaign_id=c.id AND x.status IN ('sent','drafted')),0) + c.gap_minutes*60000 <= ?)
        ORDER BY m.scheduled_at ASC LIMIT 1`,
    ).bind(now(),startOfLocalDay(now(),s.tzOffset),now()).first();

    if (!mail) { out.skipped.push('nothing-due'); break; }

    const selectedMailbox = mail.mailbox_id || mail.campaign_mailbox_id;
    const senderAccount = selectedMailbox ? await activeMailbox(env, selectedMailbox) : acct;
    if (!senderAccount) { out.skipped.push('mailbox-not-connected'); break; }
    if (senderAccount.host && s.mode==='draft') { out.skipped.push('smtp-needs-send-mode'); break; }

    // Claim it so a concurrent run cannot grab the same row.
    const claim = await env.DB.prepare(
      "UPDATE mails SET status = 'sending' WHERE id = ? AND status = 'queued'",
    ).bind(mail.id).run();
    if (!claim.meta?.changes) continue;

    try {
      const biz = {
        name: mail.biz_name, owner: mail.owner, city: mail.city,
        website: mail.website, email: mail.biz_email, notes: mail.notes,
      };
      const extra = { sender: senderAccount.email, sender_name: s.senderName, signature: s.signature };
      const subject = personalise(mail.subject, biz, extra);
      let body = personalise(mail.body, biz, extra);
      if (s.signature && !body.includes(s.signature)) body = `${body}\n\n${s.signature}`;

      const res = await sendMail(env, {
        mailboxId: senderAccount.host ? senderAccount.id : undefined,
        to: mail.to_email,
        toName: mail.to_name || mail.owner || '',
        subject,
        body,
        threadId: mail.gmail_thread_id || undefined,
        inReplyTo: mail.parent_id ? await parentMessageId(env, mail.parent_id) : undefined,
        mode: s.mode,
      });

      const stamp = now();
      await env.DB.prepare(
        `UPDATE mails SET status = ?, sent_at = ?, gmail_id = ?, gmail_thread_id = ?, subject = ?, body = ?, mailbox_id = ?, error = NULL
          WHERE id = ?`,
      ).bind(s.mode === 'draft' ? 'drafted' : 'sent', stamp, res.id || null, res.threadId || mail.gmail_thread_id || null, subject, body, senderAccount.host ? senderAccount.id : null, mail.id).run();

      if (mail.business_id) {
        await env.DB.prepare("UPDATE businesses SET status = 'contacted' WHERE id = ? AND status IN ('new','queued')")
          .bind(mail.business_id).run();
      }

      if (s.mode !== 'draft') await queueFollowUp(env, { ...mail, mailbox_id: senderAccount.host ? senderAccount.id : null, gmail_thread_id: res.threadId }, stamp);

      out.sent++;
      budget--;

      await log(env, 'info', `${s.mode === 'draft' ? 'drafted' : 'sent'} → ${mail.to_email}`);
    } catch (e) {
      const retriable = e.retriable !== false && (e.retriable || /429|5\d\d|network|timeout/i.test(e.message || ''));
      await env.DB.prepare('UPDATE mails SET status = ?, error = ?, scheduled_at = ? WHERE id = ?')
        .bind(retriable ? 'queued' : 'failed', String(e.message).slice(0, 400), retriable ? now() + 15 * 60000 : mail.scheduled_at, mail.id)
        .run();
      await log(env, 'error', `${mail.to_email}: ${e.message}`);
      out.skipped.push(`error:${e.message}`);
      break;
    }
  }

  await env.DB.prepare("UPDATE campaigns SET status='done' WHERE status='active' AND EXISTS (SELECT 1 FROM mails m WHERE m.campaign_id=campaigns.id) AND NOT EXISTS (SELECT 1 FROM mails m WHERE m.campaign_id=campaigns.id AND m.status IN ('queued','sending'))").run();
  return out;
}

async function parentMessageId(env, parentId) {
  const row = await env.DB.prepare('SELECT gmail_id FROM mails WHERE id = ?').bind(parentId).first();
  if (!row?.gmail_id) return undefined;
  return (await messageIdHeader(env, row.gmail_id)) || undefined;
}

/** After a first touch goes out, line up the follow-up if the template has one. */
async function queueFollowUp(env, mail, sentAt) {
  if (!mail.campaign_id) return;
  const campaign = await env.DB.prepare('SELECT sequence_json FROM campaigns WHERE id=?').bind(mail.campaign_id).first();
  if (campaign?.sequence_json) {
    const steps=JSON.parse(campaign.sequence_json);
    const step=steps[Number(mail.step || 1)];
    if (!step) return;
    await env.DB.prepare("INSERT INTO mails (id,campaign_id,business_id,to_email,to_name,subject,body,step,parent_id,scheduled_at,status,gmail_thread_id,created_at,mailbox_id) VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)")
      .bind(id('m'),mail.campaign_id,mail.business_id,mail.to_email,mail.to_name||'',step.subject,step.body,Number(mail.step||1)+1,mail.id,sentAt+step.delayDays*86400000,mail.gmail_thread_id||null,now(),mail.mailbox_id||null).run();
    return;
  }
  if (mail.step && mail.step > 1) return;

  const row = await env.DB.prepare(
    `SELECT t.followup_subject, t.followup_body, t.followup_days
       FROM campaigns c JOIN templates t ON t.id = c.template_id
      WHERE c.id = ?`,
  ).bind(mail.campaign_id).first();

  if (!row || !row.followup_days || row.followup_days <= 0 || !row.followup_body) return;

  await env.DB.prepare(
    `INSERT INTO mails (id, campaign_id, business_id, to_email, to_name, subject, body, step, parent_id,
                        scheduled_at, status, gmail_thread_id, created_at, mailbox_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 2, ?, ?, 'queued', ?, ?, ?)`,
  ).bind(
    id('m'), mail.campaign_id, mail.business_id, mail.to_email, mail.to_name || '',
    row.followup_subject || `Re: ${mail.subject}`, row.followup_body,
    mail.id, sentAt + row.followup_days * 86400000, mail.gmail_thread_id || null, now(), mail.mailbox_id || null,
  ).run();
}

/**
 * Check recently sent threads for replies. A reply cancels any pending
 * follow-up — nobody wants a nudge after they already answered.
 */
export async function pollReplies(env) {
  const since = now() - 30 * 86400000;
  const rows = await env.DB.prepare(
    `SELECT id, business_id, gmail_thread_id, sent_at FROM mails
      WHERE status = 'sent' AND mailbox_id IS NULL AND gmail_thread_id IS NOT NULL AND sent_at >= ?
        AND id NOT IN (SELECT mail_id FROM replies WHERE mail_id IS NOT NULL)
      ORDER BY sent_at DESC LIMIT 25`,
  ).bind(since).all();

  let found = 0;
  for (const m of rows.results || []) {
    let reply = null;
    try { reply = await findReply(env, m.gmail_thread_id, m.sent_at); } catch { continue; }
    if (!reply) continue;

    await env.DB.prepare(
      `INSERT INTO replies (id, mail_id, business_id, thread_id, from_email, subject, snippet, body, received_at, seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).bind(id('r'), m.id, m.business_id, m.gmail_thread_id, reply.from, reply.subject, reply.snippet, reply.body, reply.receivedAt).run();

    if (m.business_id) {
      await env.DB.prepare("UPDATE businesses SET status = 'replied' WHERE id = ?").bind(m.business_id).run();
      await env.DB.prepare(
        "UPDATE mails SET status = 'cancelled', error = 'cancelled — they replied' WHERE status = 'queued' AND business_id = ?",
      ).bind(m.business_id).run();
    }
    found++;
  }
  return found;
}
