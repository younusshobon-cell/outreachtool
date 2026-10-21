import {tenant} from './tenant.js';
import {digest,randomToken} from './accounts.js';
import {json,bad,isEmail,escapeHtml} from './util.js';
export async function suppressed(env,email){return !!await env.DB.prepare('SELECT 1 FROM suppressions WHERE tenant_id=? AND email=?').bind(tenant(env),email.trim().toLowerCase()).first();}
export async function suppress(env,email,reason='unsubscribed'){
 email=email.trim().toLowerCase();if(!isEmail(email))throw Error('Enter a valid email');
 await env.DB.batch([
 env.DB.prepare('INSERT INTO suppressions VALUES(?,?,?,?) ON CONFLICT(tenant_id,email) DO UPDATE SET reason=excluded.reason').bind(tenant(env),email,reason,Date.now()),
 env.DB.prepare("UPDATE businesses SET status='unsubscribed' WHERE tenant_id=? AND lower(trim(email))=?").bind(tenant(env),email),
 env.DB.prepare("UPDATE mails SET status='cancelled',error='Recipient suppressed' WHERE tenant_id=? AND lower(trim(to_email))=? AND status='queued'").bind(tenant(env),email)]);
}
export async function unsubscribeLink(env,email){
 const origin=env.APP_ORIGIN||(await env.DB.prepare("SELECT value FROM settings WHERE tenant_id=? AND key='app_origin'").bind(tenant(env)).first())?.value;
 if(!origin)throw Error('Open your campaign in Dispatch before sending to configure unsubscribe links.');
 const token=randomToken();await env.DB.prepare('INSERT INTO unsubscribe_tokens VALUES(?,?,?,?)').bind(await digest(token),tenant(env),email.toLowerCase(),Date.now()).run();return origin+'/unsubscribe/'+token;
}
export async function unsubscribe(request,env,url){
 const token=url.pathname.split('/').pop();if(!/^[a-f0-9]{64}$/.test(token))return bad('Invalid unsubscribe link',404);
 const row=await env.DB.prepare('SELECT tenant_id,email FROM unsubscribe_tokens WHERE token_hash=?').bind(await digest(token)).first();if(!row)return bad('This unsubscribe link is unavailable',404);
 if(request.method==='POST'){
  if(request.headers.get('origin')&&request.headers.get('origin')!==url.origin)return bad('Invalid origin',403);
  await suppress({...env,TENANT_ID:row.tenant_id},row.email);
 }else if(request.method!=='GET')return bad('Method not allowed',405);
 const done=request.method==='POST';
 return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dispatch · Email preferences</title><link rel="stylesheet" href="/styles.css"><body><main class="panel" style="max-width:480px;margin:80px auto;padding:32px"><h1>${done?'You are unsubscribed':'Stop receiving these emails'}</h1><p>${done?'You will no longer receive campaigns from this workspace.':'Confirm below to stop campaigns and follow-ups from this sender.'}</p>${done?'':`<form method="post" action="${escapeHtml(url.pathname)}"><button class="btn primary" type="submit">Unsubscribe</button></form>`}</main></body></html>`,{headers:{'content-type':'text/html;charset=utf-8'}});
}
export async function suppressionApi(request,env){
 if(request.method==='GET')return json((await env.DB.prepare('SELECT email,reason,created_at FROM suppressions WHERE tenant_id=? ORDER BY created_at DESC LIMIT 1000').bind(tenant(env)).all()).results);
 const b=await request.json();if(request.method==='POST'){try{await suppress(env,b.email,String(b.reason||'manual').slice(0,200));return json({ok:true});}catch(e){return bad(e.message);}}
 if(request.method==='DELETE'){await env.DB.prepare('DELETE FROM suppressions WHERE tenant_id=? AND email=?').bind(tenant(env),String(b.email||'').toLowerCase().trim()).run();return json({ok:true});}
 return bad('Method not allowed',405);
}
