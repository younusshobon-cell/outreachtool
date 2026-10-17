import { validateMailbox, smtpSession } from './smtp.js';
import { id, now } from './util.js';
async function key(env) {
  if (!env.MAILBOX_SECRET) throw Error('Mailbox encryption key is not configured');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.MAILBOX_SECRET));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt','decrypt']);
}
export async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, await key(env), new TextEncoder().encode(value));
  return JSON.stringify({ iv:Array.from(iv), data:Array.from(new Uint8Array(bytes)) });
}
export async function unseal(env, value) {
  const v=JSON.parse(value);
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(v.iv)},await key(env),new Uint8Array(v.data)));
}
export async function listMailboxes(env) {
  return (await env.DB.prepare('SELECT id,email,name,host,port,username,active,verified_at,created_at FROM mailboxes ORDER BY created_at').all()).results || [];
}
export async function activeMailbox(env, mailboxId) {
  return mailboxId ? env.DB.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(mailboxId).first() : env.DB.prepare('SELECT * FROM mailboxes WHERE active = 1 LIMIT 1').first();
}
export async function saveMailbox(env, input) {
  const clean = validateMailbox(input);
  if (!input.password || String(input.password).length > 2048) throw Error('Enter a password or app password');
  if ((await listMailboxes(env)).length >= 20) throw Error('Maximum 20 mailboxes');
  const mailboxId=id('mb');
  await env.DB.prepare('INSERT INTO mailboxes (id,email,name,host,port,username,password_enc,active,created_at) VALUES (?,?,?,?,?,?,?,0,?)')
    .bind(mailboxId,clean.email,clean.name,clean.host,clean.port,clean.username,await seal(env,String(input.password)),now()).run();
  return { id:mailboxId };
}
export async function testMailbox(env, mailboxId) {
  const m=await activeMailbox(env,mailboxId); if(!m) throw Error('Mailbox not found');
  await smtpSession(m,await unseal(env,m.password_enc));
  await env.DB.prepare('UPDATE mailboxes SET verified_at = ? WHERE id = ?').bind(now(),mailboxId).run();
  return {ok:true};
}
export async function selectMailbox(env, mailboxId) {
  const m=await activeMailbox(env,mailboxId);if(!m?.verified_at)throw Error('Test the connection before selecting this mailbox');
  await env.DB.batch([env.DB.prepare('UPDATE mailboxes SET active = 0'),env.DB.prepare('UPDATE mailboxes SET active = 1 WHERE id = ?').bind(mailboxId)]);
  return {ok:true};
}
export async function sendSmtp(env, mailbox, message) {
  if(message.mode==='draft')throw Error('SMTP cannot save Gmail drafts. Choose Send for real in Setup when ready.');
  return smtpSession(mailbox,await unseal(env,mailbox.password_enc),message);
}
