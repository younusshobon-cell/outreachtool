import { json, bad, isEmail } from './util.js';

const encoder = new TextEncoder();
export const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export async function digest(value) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
const passwordOK = p => typeof p === 'string' && p.length >= 12 && p.length <= 200;
export async function passwordHash(password, salt = randomToken()) {
 const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
 const hash = await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100000},key,256);
 return `pbkdf2$100000$${salt}$${hex(hash)}`;
}
export function equal(a,b) { if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0; }
async function checkPassword(password, stored) { const parts=stored.split('$');return parts.length===4&&equal(await passwordHash(password,parts[2]),stored); }
export function cookie(request,name) { return request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||''; }
const sessionCookie = value => `__Host-dispatch_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${value?604800:0}`;
export async function sessionUser(request,env) {
 const raw=cookie(request,'__Host-dispatch_session');if(!/^[a-f0-9]{64}$/.test(raw))return null;
 const hash=await digest(raw);
 const u=await env.DB.prepare('SELECT u.id,u.email,u.name,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').bind(hash,Date.now()).first();
 return u?{...u,sessionHash:hash}:null;
}
export async function rateLimit(env,key,max=10,window=900000) {
 const hash=await digest(key);const now=Date.now();
 const row=await env.DB.prepare('INSERT INTO auth_limits(key,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN expires_at<? THEN 1 ELSE attempts+1 END, expires_at=CASE WHEN expires_at<? THEN excluded.expires_at ELSE expires_at END RETURNING attempts').bind(hash,now+window,now,now).first();
 return row.attempts<=max;
}
async function openSession(env,u,extra={}) {
 const token=randomToken();
 await env.DB.prepare('INSERT INTO sessions VALUES(?,?,?,?)').bind(await digest(token),u.id,Date.now()+604800000,Date.now()).run();
 return json({ok:true,user:{id:u.id,email:u.email,name:u.name},...extra},200,{'set-cookie':sessionCookie(token)});
}
export async function accountApi(request,env,path,user) {
 if(path==='me'&&request.method==='GET')return user?json({id:user.id,email:user.email,name:user.name}):bad('Sign in to continue',401);
 if(request.method!=='POST')return bad('Method not allowed',405);
 const ip=request.headers.get('cf-connecting-ip')||'local';
 if(!await rateLimit(env,`auth-ip:${ip}`,40))return bad('Too many attempts. Try again in 15 minutes.',429);
 if(path==='logout'){
  if(user)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(user.sessionHash).run();
  return json({ok:true},200,{'set-cookie':sessionCookie('')});
 }
 const body=await request.json().catch(()=>({}));
 const email=String(body.email||'').trim().toLowerCase();
 if(!isEmail(email)||email.length>254)return bad('Enter a valid email address');
 if(!await rateLimit(env,`auth-email:${email}`,12))return bad('Too many attempts. Try again in 15 minutes.',429);
 if(path==='register'){
  if(!passwordOK(body.password))return bad('Use a password with 12–200 characters');
  const name=String(body.name||'').trim().slice(0,100);if(!name)return bad('Enter your name');
  const recovery=randomToken();const uid=crypto.randomUUID().replaceAll('-','');
  try{await env.DB.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').bind(uid,email,name,await passwordHash(body.password),await digest(recovery),Date.now()).run();}
  catch(e){if(/UNIQUE/i.test(e.message))return bad('Unable to create this account. Try signing in or recovering your account.',409);throw e;}
  return openSession(env,{id:uid,email,name},{recoveryCode:recovery});
 }
 const u=await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
 if(path==='login'){
  const dummy='pbkdf2$100000$'+ '0'.repeat(64)+'$'+'0'.repeat(64);
  const valid=await checkPassword(String(body.password||'').slice(0,201),u?.password_hash||dummy);
  if(!u||!valid)return bad('Email or password is incorrect',401);
  return openSession(env,u);
 }
 if(path==='recover'){
  if(!passwordOK(body.password))return bad('Use a password with 12–200 characters');
  if(!u||!equal(await digest(String(body.recoveryCode||'')),u.recovery_hash))return bad('Email or recovery code is incorrect',401);
  const recovery=randomToken();
  await env.DB.batch([env.DB.prepare('UPDATE users SET password_hash=?,recovery_hash=? WHERE id=?').bind(await passwordHash(body.password),await digest(recovery),u.id),env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id),env.DB.prepare('DELETE FROM oauth_states WHERE user_id=?').bind(u.id)]);
  return openSession(env,u,{recoveryCode:recovery});
 }
 return bad('Unknown account action',404);
}
