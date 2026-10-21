import { json,bad,escapeHtml,log } from './util.js';
import { accountApi,sessionUser,digest,randomToken,rateLimit } from './accounts.js';
import { seal,unseal } from './mailboxes.js';
import * as google from './google.js';
import * as microsoft from './microsoft.js';
import { handleApi } from './api.js';
import { tick } from './scheduler.js';
import { connectorApi, connectorStatus, accountDataApi, configured } from './saas.js';

const providers={google,microsoft};
function notice(title,message,status=200){return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Dispatch</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7fa;font:15px/1.7 system-ui;color:#1b2036"><main style="max-width:480px;margin:24px;padding:32px;background:white;border:1px solid #e5e7f0;border-radius:16px"><h1 style="font-size:24px">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a href="/#connectors" style="color:#5b4be0">Back to connections</a></main></body></html>`,{status,headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store'}});}
async function fetchApp(request,env,ctx){
 const url=new URL(request.url),p=url.pathname,mutating=['POST','PUT','PATCH','DELETE'].includes(request.method);
 if(mutating){
  if(request.headers.get('origin')!==url.origin)return bad('Same-origin request required',403);
  if(!request.headers.get('content-type')?.startsWith('application/json'))return bad('JSON request required',415);
  if(Number(request.headers.get('content-length')||0)>2097152)return bad('Request too large',413);
  const bytes=await request.arrayBuffer();if(bytes.byteLength>2097152)return bad('Request too large',413);
  request=new Request(request,{body:bytes});
 }
 if(p==='/healthz')return json({ok:true,version:'saas-beta-1'});
 if(['/login','/signup','/recover'].includes(p))return env.ASSETS.fetch(new Request(url.origin+'/auth.html'));
 if(['/auth.js','/auth.css','/styles.css'].includes(p))return env.ASSETS.fetch(request);
 const user=await sessionUser(request,env);
 if(p.startsWith('/api/account/'))return accountApi(request,env,p.split('/').pop(),user);
 if(!user)return p.startsWith('/api/')?bad('Sign in to access your workspace',401):Response.redirect(url.origin+'/login',302);
 const scoped={...env,TENANT_ID:user.id,USER:user};
 if(p.startsWith('/api/')&&mutating&&!await rateLimit(env,'user:'+user.id,120,60000))return bad('Too many requests. Try again shortly.',429);
 const match=p.match(/^\/auth\/(google|microsoft)(\/callback)?$/);
 if(match){
  if(request.method!=='GET')return bad('Method not allowed',405);
  const provider=match[1],adapter=providers[provider];
  if(!configured(env,provider))return notice('Connection temporarily unavailable','This email provider is not enabled yet. You can connect a custom mailbox using SMTP, or try again after the service owner enables this provider.',503);
  if(!match[2]){
   if(!await rateLimit(env,'oauth:'+user.id,10,60000))return bad('Please wait before connecting again',429);
   const state=randomToken(),verifier=randomToken();
   const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
   const challenge=btoa(String.fromCharCode(...hash)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
   await env.DB.prepare('INSERT INTO oauth_states VALUES(?,?,?,?,?,?)').bind(await digest(state),user.id,user.sessionHash,provider,await seal(scoped,verifier),Date.now()+600000).run();
   return Response.redirect(adapter.consentUrl(scoped,url,state,challenge),302);
  }
  const state=await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=? AND user_id=? AND session_hash=? AND provider=? AND expires_at>? RETURNING verifier_enc').bind(await digest(url.searchParams.get('state')||''),user.id,user.sessionHash,provider,Date.now()).first();
  if(!state)return notice('Connection expired','Start Connect again from your workspace. This connection link is expired or belongs to a different session.',400);
  if(url.searchParams.has('error'))return notice('Connection cancelled','Your mailbox was not connected. Return to Connections and try again when ready.');
  const code=url.searchParams.get('code');if(!code)return notice('Connection incomplete','No authorization code was received. Please try again.',400);
  try{const tokens=await adapter.exchangeCode(scoped,url,code,await unseal(scoped,state.verifier_enc));await adapter.saveAccount(scoped,tokens);return Response.redirect(url.origin+'/?connected='+provider+'#connectors',302);}
  catch(e){return notice('Could not connect',e.message,400);}
 }
 if(p==='/api/connectors'&&request.method==='GET')return json(await connectorStatus(scoped));
 if(p.startsWith('/api/connectors/'))return connectorApi(request,scoped,url);
 if(p.startsWith('/api/workspace/'))return accountDataApi(request,scoped,url);
 if(p.startsWith('/api/'))return handleApi(request,scoped,url);
 return env.ASSETS.fetch(request);
}
export default {
 async fetch(request,env,ctx){
  let response;
  try{response=await fetchApp(request,env,ctx);}catch(e){console.error('request_failed',new URL(request.url).pathname,e?.name);response=bad('Unable to complete the request. Please try again.',500);}
  const h=new Headers(response.headers);h.set('x-content-type-options','nosniff');h.set('referrer-policy','no-referrer');h.set('x-frame-options','DENY');h.set('permissions-policy','camera=(), microphone=(), geolocation=()');h.set('cache-control','no-store');
  h.set('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  return new Response(response.body,{status:response.status,headers:h});
 },
 async scheduled(event,env,ctx){ctx.waitUntil(runScheduler(env));}
};
export async function runScheduler(env){
 const rows=await env.DB.prepare("SELECT s.tenant_id FROM settings s JOIN users u ON u.id=s.tenant_id WHERE s.key='running' AND s.value='true' ORDER BY s.tenant_id").all();
 for(const row of rows.results){const scoped={...env,TENANT_ID:row.tenant_id};try{await tick(scoped);}catch(e){await log(scoped,'error','Scheduled run failed; check sender connection.');}}
 await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(Date.now()),env.DB.prepare('DELETE FROM oauth_states WHERE expires_at<?').bind(Date.now()),env.DB.prepare('DELETE FROM auth_limits WHERE expires_at<?').bind(Date.now())]);
}
