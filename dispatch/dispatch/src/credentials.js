import {tenant} from './tenant.js';
import {seal,unseal} from './mailboxes.js';
import {json,bad,isEmail} from './util.js';
// Only fixed provider endpoints are ever called with a user's credentials.
export async function providerJson(url,options={}){
 let r;try{r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw Error('Provider connection failed or timed out. Try again.');}
 if(!r.ok){await r.body?.cancel();throw Error(`Provider rejected the request (${r.status}). Check credentials, permissions and account limits.`);}
 const reader=r.body.getReader();let size=0,parts=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw Error('Provider response is too large');parts.push(value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
export async function secret(env,provider){const r=await env.DB.prepare('SELECT secret_enc FROM connector_secrets WHERE tenant_id=? AND provider=?').bind(tenant(env),provider).first();return r?JSON.parse(await unseal(env,r.secret_enc)):null;}
export async function saveSecret(env,provider,value,metadata={}){await env.DB.prepare('INSERT INTO connector_secrets VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,provider) DO UPDATE SET secret_enc=excluded.secret_enc,metadata=excluded.metadata,updated_at=excluded.updated_at').bind(tenant(env),provider,await seal(env,JSON.stringify(value)),JSON.stringify(metadata),Date.now()).run();}
export async function credentialEnv(env){const scoped={...env};for(const [p,prefix] of [['google','GOOGLE'],['microsoft','MICROSOFT']]){const c=await secret(env,p);if(c?.clientId){scoped[prefix+'_CLIENT_ID']=c.clientId;scoped[prefix+'_CLIENT_SECRET']=c.clientSecret||'';}}return scoped;}
export async function connectCredentials(request,env,provider){
 try{
 const b=await request.json();for(const k of ['accessToken','refreshToken','clientId','clientSecret'])if(b[k]!=null&&(typeof b[k]!=='string'||b[k].length>16384))return bad('Invalid credential field');
 if(b.mode==='oauth'){
  if(!b.clientId?.trim()||!b.clientSecret?.trim())return bad('Enter your OAuth client ID and client secret');
  const linked=await env.DB.prepare(`SELECT email FROM ${provider==='google'?'google_account':'microsoft_account'} WHERE tenant_id=?`).bind(tenant(env)).first();
  if(linked)return bad('Disconnect this provider before replacing its OAuth app credentials.');
  await saveSecret(env,provider,{clientId:b.clientId.trim(),clientSecret:b.clientSecret.trim()},{mode:'own-app'});
  await env.DB.prepare('DELETE FROM oauth_states WHERE user_id=? AND provider=?').bind(tenant(env),provider).run();
  return json({ok:true,authorize:'/auth/'+provider});
 }
 let t={access_token:b.accessToken?.trim(),expires_in:Math.min(3600,Math.max(60,Number(b.expiresIn)||3600)),refresh_token:null};
 const own={clientId:b.clientId?.trim(),clientSecret:b.clientSecret?.trim()};
 if(b.refreshToken){
  if(!own.clientId||!own.clientSecret)return bad('Automatic refresh requires client ID, client secret and refresh token from the same OAuth app');
  t=await providerJson(provider==='google'?'https://oauth2.googleapis.com/token':'https://login.microsoftonline.com/common/oauth2/v2.0/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:own.clientId,client_secret:own.clientSecret,refresh_token:b.refreshToken,grant_type:'refresh_token',...(provider==='microsoft'?{scope:'offline_access User.Read Mail.Send Mail.ReadWrite'}:{})})});
  t.refresh_token=t.refresh_token||b.refreshToken;
 }
 if(!t.access_token)return bad('Enter an OAuth access token or refresh credentials. A normal API key cannot access your mailbox.');
 let email,scope=t.scope||'';
 if(provider==='google'){
  const info=await providerJson('https://oauth2.googleapis.com/tokeninfo?'+new URLSearchParams({access_token:t.access_token}));scope=info.scope||'';
  const scopes=new Set(scope.split(' '));if(!scopes.has('https://mail.google.com/'))for(const s of ['gmail.send','gmail.compose','gmail.readonly'])if(!scopes.has('https://www.googleapis.com/auth/'+s))throw Error('Token needs gmail.send, gmail.compose and gmail.readonly permissions.');
  t.expires_in=Math.min(t.expires_in,Number(info.expires_in)||0);
  const p=await providerJson('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{authorization:'Bearer '+t.access_token}});email=p.emailAddress;
 }else{
  const p=await providerJson('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',{headers:{authorization:'Bearer '+t.access_token}});email=p.mail||p.userPrincipalName;
  await providerJson('https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=id',{headers:{authorization:'Bearer '+t.access_token}});
  if(t.refresh_token&&!['Mail.Send','Mail.ReadWrite'].every(s=>scope.split(' ').some(x=>x===s||x.endsWith('/'+s))))throw Error('Grant Mail.Send and Mail.ReadWrite to your OAuth app.');
 }
 if(!isEmail(email))throw Error('Provider did not return a valid mailbox address');
 const table=provider==='google'?'google_account':'microsoft_account';
 const old=await env.DB.prepare(`SELECT email FROM ${table} WHERE tenant_id=?`).bind(tenant(env)).first();if(old&&old.email.toLowerCase()!==email.toLowerCase())return bad('Disconnect the existing mailbox before switching to another address');
 const expires=Date.now()+Number(t.expires_in)*1000-30000;if(!Number.isFinite(expires)||expires<Date.now())return bad('Token is expired. Generate a fresh token.');
 const access=await seal(env,t.access_token),refresh=t.refresh_token?await seal(env,t.refresh_token):null;
 if(provider==='google')await env.DB.prepare('INSERT INTO google_account(tenant_id,id,email,access_token,refresh_token,expires_at,scope,connected_at) VALUES(?,1,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET email=excluded.email,access_token=excluded.access_token,refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,scope=excluded.scope,connected_at=excluded.connected_at').bind(tenant(env),email,access,refresh,expires,scope,Date.now()).run();
 else await env.DB.prepare('INSERT INTO microsoft_account VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET email=excluded.email,access_token=excluded.access_token,refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,scope=excluded.scope,connected_at=excluded.connected_at').bind(tenant(env),email,access,refresh,expires,scope,Date.now()).run();
 await saveSecret(env,provider,t.refresh_token?own:{},{mode:t.refresh_token?'refresh-token':'access-token',sendPermissionVerified:provider==='google'||!!t.refresh_token});
 return json({ok:true,email,autoRefresh:!!t.refresh_token,expiresAt:expires});
 }catch(e){return bad(e.message);}
}
