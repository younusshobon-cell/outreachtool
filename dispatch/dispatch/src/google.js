import { tenant } from './tenant.js';
import { seal, unseal } from './mailboxes.js';
export const SCOPES = ['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.compose','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/userinfo.email'].join(' ');
export function redirectUri(url) { return `${url.origin}/auth/google/callback`; }
export function consentUrl(env,url,state,challenge) {
 return 'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:redirectUri(url),response_type:'code',scope:SCOPES,access_type:'offline',prompt:'consent select_account',include_granted_scopes:'true',state,code_challenge:challenge,code_challenge_method:'S256'});
}
export async function exchangeCode(env,url,code,verifier) {
 const res=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,code_verifier:verifier,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:redirectUri(url),grant_type:'authorization_code'})});
 const data=await res.json();if(!res.ok)throw Error('Google authorization failed. Please reconnect.');return data;
}
export async function saveAccount(env,tokens) {
 const res=await fetch('https://www.googleapis.com/oauth2/v2/userinfo',{headers:{authorization:`Bearer ${tokens.access_token}`}});
 const who=await res.json();if(!res.ok||!who.email||!who.verified_email)throw Error('Google could not verify this mailbox');
 const scopes=new Set((tokens.scope||'').split(' '));
 for(const scope of SCOPES.split(' ').filter(s=>s.includes('/gmail.')))if(!scopes.has(scope))throw Error('Approve the requested Gmail permissions to connect this mailbox.');
 const old=await getAccount(env);
 if(old&&old.email.toLowerCase()!==who.email.toLowerCase())throw Error('Disconnect your current Gmail before connecting a different mailbox.');
 const refresh=tokens.refresh_token?await seal(env,tokens.refresh_token):old?.refresh_token;
 if(!refresh)throw Error('Offline access was not granted. Reconnect and approve access.');
 await env.DB.prepare('INSERT INTO google_account(tenant_id,id,email,access_token,refresh_token,expires_at,scope,connected_at) VALUES(?,1,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET email=excluded.email,access_token=excluded.access_token,refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,scope=excluded.scope,connected_at=excluded.connected_at').bind(tenant(env),who.email,await seal(env,tokens.access_token),refresh,Date.now()+tokens.expires_in*1000-60000,tokens.scope||'',Date.now()).run();
 return who.email;
}
export async function getAccount(env) {return env.DB.prepare('SELECT * FROM google_account WHERE tenant_id=? AND id=1').bind(tenant(env)).first();}
export async function accessToken(env) {
 const a=await getAccount(env);if(!a)throw Error('Connect Gmail first');
 if(a.expires_at>Date.now())return unseal(env,a.access_token);
 const res=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:await unseal(env,a.refresh_token),grant_type:'refresh_token'})});
 const data=await res.json();if(!res.ok)throw Error('Gmail access expired. Reconnect Gmail.');
 await env.DB.prepare('UPDATE google_account SET access_token=?,expires_at=? WHERE tenant_id=?').bind(await seal(env,data.access_token),Date.now()+data.expires_in*1000-60000,tenant(env)).run();
 return data.access_token;
}
export async function disconnect(env) {
 const a=await getAccount(env);
 if(a?.refresh_token){try{await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:await unseal(env,a.refresh_token)})});}catch{}}
 await env.DB.prepare('DELETE FROM google_account WHERE tenant_id=?').bind(tenant(env)).run();
}
