import { tenant } from './tenant.js';
import { json,bad } from './util.js';
import * as google from './google.js';
import * as microsoft from './microsoft.js';
export function configured(env,p){return Boolean(p==='google'?env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET:env.MICROSOFT_CLIENT_ID&&env.MICROSOFT_CLIENT_SECRET);}
import { setSetting } from './scheduler.js';
export async function connectorStatus(env){
 const [g,m,selected]=await Promise.all([google.getAccount(env),microsoft.getAccount(env),env.DB.prepare("SELECT value FROM settings WHERE tenant_id=? AND key='active_provider'").bind(tenant(env)).first()]);
 return {google:{enabled:configured(env,'google'),connected:!!g,email:g?.email||null,autoRefresh:!!g?.refresh_token,expiresAt:g?.expires_at||null},microsoft:{enabled:configured(env,'microsoft'),connected:!!m,email:m?.email||null,autoRefresh:!!m?.refresh_token,expiresAt:m?.expires_at||null},active:selected?.value||'auto'};
}
export async function connectorApi(request,env,url){
 const [, , ,provider,action]=url.pathname.split('/');const adapter={google,microsoft}[provider];
 if(!adapter||request.method!=='POST')return bad('Unknown connection action',404);
 if(action==='activate'){
  if(!await adapter.getAccount(env))return bad('Connect this account first');
  await env.DB.prepare('UPDATE mailboxes SET active=0 WHERE tenant_id=?').bind(tenant(env)).run();
  await setSetting(env,'active_provider',provider);return json({ok:true});
 }
 if(action==='disconnect'){
  const pending=await env.DB.prepare("SELECT COUNT(*) n FROM mails WHERE tenant_id=? AND status IN('queued','sending') AND (mailbox_id=? OR mailbox_id IS NULL)").bind(tenant(env),'oauth:'+provider).first();
  if(pending.n)return bad('Stop or cancel queued mail using this account before disconnecting.',409);
  await adapter.disconnect(env);await env.DB.prepare('DELETE FROM connector_secrets WHERE tenant_id=? AND provider=?').bind(tenant(env),provider).run();return json({ok:true});
 }
 return bad('Unknown connection action',404);
}
export async function accountDataApi(request,env,url){
 if(url.pathname==='/api/workspace/export'&&request.method==='GET'){
  const data={exportedAt:new Date().toISOString(),user:{email:env.USER.email,name:env.USER.name}};
  for(const table of ['delivery_incidents','businesses','templates','campaigns','mails','replies','sequences','settings'])data[table]=(await env.DB.prepare(`SELECT * FROM ${table} WHERE tenant_id=?`).bind(tenant(env)).all()).results;
  return json(data);
 }
 if(url.pathname==='/api/workspace/delete'&&request.method==='POST'){
  const body=await request.json();if(body.confirm!=='DELETE MY ACCOUNT')return bad('Type DELETE MY ACCOUNT to confirm');
  const sending=await env.DB.prepare("SELECT COUNT(*) n FROM mails WHERE tenant_id=? AND status='sending'").bind(tenant(env)).first();
  if(sending.n)return bad('A send is in progress. Pause sending and try again shortly.',409);
  const statements=['delivery_incidents','businesses','templates','campaigns','mails','replies','sequences','settings','mailboxes','google_account','microsoft_account','logs','scheduler_locks','connector_secrets','integration_keys','suppressions','unsubscribe_tokens'].map(t=>env.DB.prepare(`DELETE FROM ${t} WHERE tenant_id=?`).bind(tenant(env)));
  statements.push(env.DB.prepare('DELETE FROM oauth_states WHERE user_id=?').bind(tenant(env)),env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(tenant(env)),env.DB.prepare('DELETE FROM users WHERE id=?').bind(tenant(env)));
  await env.DB.batch(statements);return json({ok:true},200,{'set-cookie':'__Host-dispatch_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'});
 }
 return bad('Unknown workspace action',404);
}
