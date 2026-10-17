import { activeMailbox, sendSmtp } from './mailboxes.js';
// Everything that talks to the Gmail REST API.

import { accessToken, getAccount } from './google.js';
import { b64url, b64urlDecode, encodeHeader } from './util.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function call(env, path, init = {}) {
  const token = await accessToken(env);
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || `Gmail API ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.retriable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return data;
}

/** Build an RFC 5322 message. */
export function buildRaw({ from, fromName, to, toName, subject, body, inReplyTo, references }) {
  const lines = [];
  lines.push(`From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`);
  lines.push(`To: ${toName ? `${encodeHeader(toName)} <${to}>` : to}`);
  lines.push(`Subject: ${encodeHeader(subject || '')}`);
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${references || inReplyTo}`);
  }
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(body || '');
  return b64url(lines.join('\r\n'));
}

/**
 * mode: 'send' pushes it out, 'draft' leaves it in Gmail drafts for you to eyeball.
 * Returns { id, threadId, messageIdHeader }
 */
export async function sendMail(env, { to, toName, subject, body, threadId, inReplyTo, mode = 'send', mailboxId }) {
  const smtp = await activeMailbox(env, mailboxId);
  if (mailboxId && !smtp) throw Error('The sending mailbox was removed');
  if (smtp) return sendSmtp(env, smtp, {to, toName, subject, body, mode});
  const acct = await getAccount(env);
  if (!acct?.email) throw new Error('Gmail is not connected');

  const settings = await env.DB.prepare("SELECT value FROM settings WHERE key = 'sender_name'").first();
  const raw = buildRaw({
    from: acct.email,
    fromName: settings?.value || '',
    to,
    toName,
    subject,
    body,
    inReplyTo,
  });

  if (mode === 'draft') {
    const draft = await call(env, '/drafts', {
      method: 'POST',
      body: JSON.stringify({ message: threadId ? { raw, threadId } : { raw } }),
    });
    return { id: draft.message?.id || draft.id, threadId: draft.message?.threadId || null, draftId: draft.id };
  }

  const sent = await call(env, '/messages/send', {
    method: 'POST',
    body: JSON.stringify(threadId ? { raw, threadId } : { raw }),
  });
  return { id: sent.id, threadId: sent.threadId };
}

/** Pull the Message-ID header of a message we sent, so follow-ups thread properly. */
export async function messageIdHeader(env, messageId) {
  try {
    const msg = await call(env, `/messages/${messageId}?format=metadata&metadataHeaders=Message-ID`);
    const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === 'message-id');
    return h?.value || null;
  } catch {
    return null;
  }
}

function headerOf(payload, name) {
  const h = (payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function plainTextOf(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return b64urlDecode(payload.body.data);
  for (const part of payload.parts || []) {
    const found = plainTextOf(part);
    if (found) return found;
  }
  if (payload.body?.data) {
    try { return b64urlDecode(payload.body.data); } catch { return ''; }
  }
  return '';
}

/**
 * Look at one thread and return any message that is not from us and arrived
 * after we sent. That is a reply.
 */
export async function findReply(env, threadId, sentAt) {
  const acct = await getAccount(env);
  const thread = await call(env, `/threads/${threadId}?format=full`);
  const mine = (acct?.email || '').toLowerCase();

  for (const msg of thread.messages || []) {
    const from = headerOf(msg.payload, 'From').toLowerCase();
    const at = Number(msg.internalDate || 0);
    if (from.includes(mine)) continue;
    if (sentAt && at <= sentAt - 60000) continue;
    return {
      from: headerOf(msg.payload, 'From'),
      subject: headerOf(msg.payload, 'Subject'),
      snippet: msg.snippet || '',
      body: plainTextOf(msg.payload).slice(0, 8000),
      receivedAt: at || Date.now(),
    };
  }
  return null;
}

export async function profile(env) {
  return call(env, '/profile');
}
