import { tenant } from './tenant.js';
import { validateMailbox, smtpSession } from './smtp.js';
import * as google from './google.js';
import * as microsoft from './microsoft.js';
import { id, now } from './util.js';
async function key(env) {
  if (!env.MAILBOX_SECRET) throw Error('Mailbox encryption key is not configured');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.MAILBOX_SECRET));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt','decrypt']);
}
export async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData:new TextEncoder().encode(tenant(env)) }, await key(env), new TextEncoder().encode(value));
  return JSON.stringify({ iv:Array.from(iv), data:Array.from(new Uint8Array(bytes)) });
}
export async function unseal(env, value) {
  const v=JSON.parse(value);
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(v.iv),additionalData:new TextEncoder().encode(tenant(env))},await key(env),new Uint8Array(v.data)));
}
export async function listMailboxes(env) {
  return (await env.DB.prepare(`SELECT id,email,name,host,port,username,active,verified_at,created_at FROM (SELECT * FROM mailboxes WHERE tenant_id = '${tenant(env)}') mailboxes ORDER BY created_at`).all()).results || [];
}
export async function activeMailbox(env, mailboxId) {
  if (mailboxId?.startsWith('oauth:')) {
    const provider=mailboxId.slice(6);const adapter={google,microsoft}[provider];
    const account=adapter?await adapter.getAccount(env):null;
    return account?{...account,id:mailboxId,provider,verified_at:account.connected_at}:null;
  }
  if(mailboxId)return env.DB.prepare('SELECT * FROM mailboxes WHERE tenant_id=? AND id=?').bind(tenant(env),mailboxId).first();
  const choice=await env.DB.prepare("SELECT value FROM settings WHERE tenant_id=? AND key='active_provider'").bind(tenant(env)).first();
  if(choice?.value&&choice.value!=='smtp')return activeMailbox(env,'oauth:'+choice.value);
  return env.DB.prepare('SELECT * FROM mailboxes WHERE tenant_id=? AND active=1 LIMIT 1').bind(tenant(env)).first();
}
export async function saveMailbox(env, input) {
  const clean = validateMailbox(input);
  if (!input.password || String(input.password).length > 2048) throw Error('Enter a password or app password');
  if ((await listMailboxes(env)).length >= 20) throw Error('Maximum 20 mailboxes');
  const mailboxId=id('mb');
  await env.DB.prepare(`INSERT INTO mailboxes (tenant_id, id,email,name,host,port,username,password_enc,active,created_at) VALUES ('${tenant(env)}', ?,?,?,?,?,?,?,0,?)`)
    .bind(mailboxId,clean.email,clean.name,clean.host,clean.port,clean.username,await seal(env,String(input.password)),now()).run();
  return { id:mailboxId };
}
export async function testMailbox(env, mailboxId) {
  const m=await activeMailbox(env,mailboxId); if(!m || !m.host) throw Error('SMTP mailbox not found');
  await smtpSession(m,await unseal(env,m.password_enc));
  await env.DB.prepare(`UPDATE mailboxes SET verified_at = ? WHERE tenant_id = '${tenant(env)}' AND (id = ?) `).bind(now(),mailboxId).run();
  return {ok:true};
}
export async function selectMailbox(env, mailboxId) {
  const m=await activeMailbox(env,mailboxId);if(!m?.host || !m.verified_at)throw Error('Test the connection before selecting this mailbox');
  await env.DB.batch([env.DB.prepare(`UPDATE mailboxes SET active = 0 WHERE tenant_id = '${tenant(env)}' `),env.DB.prepare(`UPDATE mailboxes SET active = 1 WHERE tenant_id = '${tenant(env)}' AND (id = ?) `).bind(mailboxId)]);
  await env.DB.prepare("INSERT INTO settings(tenant_id,key,value) VALUES(?,'active_provider','smtp') ON CONFLICT(tenant_id,key) DO UPDATE SET value='smtp'").bind(tenant(env)).run();
  return {ok:true};
}
export async function sendSmtp(env, mailbox, message) {
  if(message.mode==='draft')throw Error('SMTP cannot save Gmail drafts. Choose Send for real in Setup when ready.');
  return smtpSession(mailbox,await unseal(env,mailbox.password_enc),message);
}
