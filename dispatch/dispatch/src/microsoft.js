import { tenant } from './tenant.js';
import { seal,unseal } from './mailboxes.js';
const scope='offline_access User.Read Mail.Send Mail.ReadWrite';
const base='https://login.microsoftonline.com/common/oauth2/v2.0';
export const redirectUri=url=>`${url.origin}/auth/microsoft/callback`;
export function consentUrl(env,url,state,challenge){return base+'/authorize?'+new URLSearchParams({client_id:env.MICROSOFT_CLIENT_ID,redirect_uri:redirectUri(url),response_type:'code',response_mode:'query',scope,state,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'});}
async function token(env,values){const res=await fetch(base+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.MICROSOFT_CLIENT_ID,client_secret:env.MICROSOFT_CLIENT_SECRET,scope,...values})});const data=await res.json();if(!res.ok)throw Error('Microsoft authorization failed. Reconnect Outlook.');return data;}
export const exchangeCode=(env,url,code,verifier)=>token(env,{grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:redirectUri(url)});
export async function getAccount(env){return env.DB.prepare('SELECT * FROM microsoft_account WHERE tenant_id=?').bind(tenant(env)).first();}
export async function saveAccount(env,tokens){
 const res=await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName',{headers:{authorization:`Bearer ${tokens.access_token}`}});const p=await res.json();const email=p.mail||p.userPrincipalName;if(!res.ok||!email)throw Error('Microsoft could not identify this mailbox');
 const old=await getAccount(env);if(old&&old.email.toLowerCase()!==email.toLowerCase())throw Error('Disconnect the current Outlook mailbox before switching accounts.');
 if(!tokens.refresh_token)throw Error('Offline access was not granted. Reconnect Outlook.');
 await env.DB.prepare('INSERT INTO microsoft_account VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET email=excluded.email,access_token=excluded.access_token,refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,scope=excluded.scope,connected_at=excluded.connected_at').bind(tenant(env),email,await seal(env,tokens.access_token),await seal(env,tokens.refresh_token),Date.now()+tokens.expires_in*1000-60000,tokens.scope||'',Date.now()).run();return email;
}
export async function accessToken(env){const a=await getAccount(env);if(!a)throw Error('Connect Outlook first');if(a.expires_at>Date.now())return unseal(env,a.access_token);const t=await token(env,{grant_type:'refresh_token',refresh_token:await unseal(env,a.refresh_token)});await env.DB.prepare('UPDATE microsoft_account SET access_token=?,refresh_token=?,expires_at=? WHERE tenant_id=?').bind(await seal(env,t.access_token),t.refresh_token?await seal(env,t.refresh_token):a.refresh_token,Date.now()+t.expires_in*1000-60000,tenant(env)).run();return t.access_token;}
export async function call(env,path,options={}){const r=await fetch('https://graph.microsoft.com/v1.0/me'+path,{...options,headers:{authorization:'Bearer '+await accessToken(env),'content-type':'application/json',Prefer:'outlook.body-content-type="text"',...options.headers}});if(!r.ok){const e=Error('Outlook request failed ('+r.status+'). Reconnect if access has expired.');e.retriable=false;throw e;}return r.status===202||r.status===204?{}:r.json();}
export async function sendMail(env,m){
 const message={subject:m.subject||'',body:{contentType:'Text',content:m.body||''},toRecipients:[{emailAddress:{address:m.to,name:m.toName||m.to}}]};
 if(m.mode==='draft'){const d=await call(env,'/messages',{method:'POST',body:JSON.stringify(message)});return {id:d.id,threadId:d.conversationId};}
 // Create the draft first so replies can be tracked by the conversation ID.
 const d=await call(env,'/messages',{method:'POST',body:JSON.stringify(message)});
 await call(env,`/messages/${encodeURIComponent(d.id)}/send`,{method:'POST'});return {id:d.id,threadId:d.conversationId};
}
export async function findReply(env,threadId,sentAt){const a=await getAccount(env);const filter=`conversationId eq '${threadId.replaceAll("'","''")}'`;const data=await call(env,'/mailFolders/inbox/messages?'+new URLSearchParams({'$filter':filter,'$top':'50','$select':'from,subject,body,bodyPreview,receivedDateTime'}));const m=(data.value||[]).filter(m=>m.from?.emailAddress?.address?.toLowerCase()!==a.email.toLowerCase()&&Date.parse(m.receivedDateTime)>sentAt).sort((a,b)=>Date.parse(a.receivedDateTime)-Date.parse(b.receivedDateTime))[0];return m?{from:m.from.emailAddress.address,subject:m.subject,snippet:m.bodyPreview||'',body:(m.body?.content||'').slice(0,8000),receivedAt:Date.parse(m.receivedDateTime)}:null;}
export async function disconnect(env){await env.DB.prepare('DELETE FROM microsoft_account WHERE tenant_id=?').bind(tenant(env)).run();}
