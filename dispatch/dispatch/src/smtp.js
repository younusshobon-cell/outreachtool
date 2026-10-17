import { connect } from 'cloudflare:sockets';
import { encodeHeader } from './util.js';

const enc = new TextEncoder();
const b64 = s => btoa(String.fromCharCode(...enc.encode(s)));
export function validateMailbox(input) {
  const email = String(input.email || '').trim();
  const host = String(input.host || '').trim().toLowerCase();
  const port = Number(input.port);
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) throw Error('Enter a valid email address');
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes('.') || /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(host) || /^[\d.]+$/.test(host)) throw Error('Use your provider’s public SMTP hostname');
  if (![465, 587].includes(port)) throw Error('SMTP must use TLS on port 465 or STARTTLS on 587');
  const username = String(input.username || email).trim();
  const name = String(input.name || '').trim();
  if ([email, username, name].some(v => /[\r\n\x00]/.test(v))) throw Error('Invalid mailbox details');
  return { email, host, port, username, name };
}
export async function smtpSession(mailbox, password, message) {
  let socket, reader, writer, buffer = '';
  const decoder = new TextDecoder();
  const timer = setTimeout(() => { if (socket) void socket.close().catch(() => {}); }, 20000);
  function streams() { reader = socket.readable.getReader(); writer = socket.writable.getWriter(); buffer = ''; }
  async function response(expected) {
    let count = 0;
    while (true) {
      const newline = buffer.indexOf('\r\n');
      if (newline < 0) {
        const r = await reader.read();
        if (r.done) throw Error('SMTP connection closed');
        buffer += decoder.decode(r.value, { stream: true });
        if (buffer.length > 65536) throw Error('SMTP response too large');
        continue;
      }
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 2);
      if (++count > 100) throw Error('SMTP response too long');
      if (!/^\d{3}[ -]/.test(line)) throw Error('Invalid SMTP response');
      if (line[3] === '-') continue;
      const code = Number(line.slice(0, 3));
      if (!expected.includes(code)) {
        const e = Error(`SMTP ${code}: ${code === 535 ? 'Authentication failed — check username and app password' : 'Provider rejected the request'}`);
        // Never automatically retry after DATA: delivery may already have happened.
        e.retriable = false; throw e;
      }
      return line;
    }
  }
  async function command(text, codes) { await writer.write(enc.encode(text + '\r\n')); return response(codes); }
  try {
    socket = connect({ hostname: mailbox.host, port: mailbox.port }, { secureTransport: mailbox.port === 465 ? 'on' : 'starttls' });
    socket.closed.catch(() => {}); streams();
    await socket.opened; await response([220]); await command('EHLO dispatch.local', [250]);
    if (mailbox.port === 587) {
      await command('STARTTLS', [220]); reader.releaseLock(); writer.releaseLock();
      socket = socket.startTls(); socket.closed.catch(() => {}); streams(); await socket.opened;
      await command('EHLO dispatch.local', [250]);
    }
    await command('AUTH LOGIN', [334]);
    await command(b64(mailbox.username), [334]); await command(b64(password), [235]);
    if (!message) { await command('QUIT', [221]); return { ok: true }; }
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(message.to) || /[\r\n]/.test(message.subject || '')) throw Error('Invalid recipient or subject');
    await command(`MAIL FROM:<${mailbox.email}>`, [250]); await command(`RCPT TO:<${message.to}>`, [250,251]); await command('DATA', [354]);
    const mid = `<${crypto.randomUUID()}@${mailbox.email.split('@')[1]}>`;
    const body = b64(message.body || '').match(/.{1,76}/g)?.join('\r\n') || '';
    const data = [`From: ${mailbox.name ? encodeHeader(mailbox.name)+' ' : ''}<${mailbox.email}>`, `To: <${message.to}>`, `Subject: ${encodeHeader(message.subject || '')}`, `Date: ${new Date().toUTCString()}`, `Message-ID: ${mid}`, 'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',body].join('\r\n');
    await command(data + '\r\n.', [250]);
    // Delivery is accepted; a failure during QUIT must not mark it as failed.
    try { await command('QUIT', [221]); } catch {}
    return { id: mid, threadId: null };
  } catch(e) { e.retriable = false; throw e; }
  finally { clearTimeout(timer); if (socket) await socket.close().catch(() => {}); }
}
