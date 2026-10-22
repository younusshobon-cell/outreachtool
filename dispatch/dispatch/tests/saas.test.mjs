import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

async function setup(mockOAuth=false){
 const bundle=await build({entryPoints:['src/index.js'],bundle:true,format:'esm',platform:'browser',write:false,external:['cloudflare:sockets']});
 const mock=`const fetch=async(url,init={})=>{const u=String(url);if(u.includes('/token'))return Response.json({access_token:'secret-access-token',refresh_token:'secret-refresh-token',expires_in:3600,scope:'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly'});if(u.includes('userinfo'))return Response.json({email:'connected@example.com',verified_email:true});if(u.includes('graph.microsoft.com/v1.0/me?'))return Response.json({mail:'outlook@example.com'});throw Error('Unexpected outbound request '+u);};`;
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:(mockOAuth?mock:'')+bundle.outputFiles[0].text,compatibilityDate:'2026-10-17',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{MAILBOX_SECRET:'unit-test-key-not-production',GOOGLE_CLIENT_ID:'google-test',GOOGLE_CLIENT_SECRET:'secret-test',MICROSOFT_CLIENT_ID:'ms-test',MICROSOFT_CLIENT_SECRET:'ms-test-secret'}}));
 const db=await mf.getD1Database('DB');const schema=await readFile('schema.sql','utf8');await db.batch(schema.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
 async function req(path,{cookie='',body,method=body?'POST':'GET',origin='https://app.test',redirect='manual'}={}){return mf.dispatchFetch('https://app.test'+path,{method,redirect,headers:{cookie,origin,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});}
 async function api(path,cookie,body,method){const r=await req('/api/'+path,{cookie,body,method});const d=await r.json();assert(r.ok,`${path}: ${r.status} ${JSON.stringify(d)}`);return d;}
 async function signup(email){const r=await req('/api/account/register',{body:{email,name:'Test user',password:'correct-test-password'}});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};}
 return {mf,db,req,api,signup};
}
test('private workspaces isolate CRUD, searches, analytics, exports, SMTP credentials, sessions and OAuth state',async()=>{
 const {mf,db,req,api,signup}=await setup();try{
  assert.equal((await req('/api/state')).status,401);
  const a=await signup('alice@example.com'),b=await signup('bob@example.com');
  assert.notEqual(a.user.id,b.user.id);assert.equal(a.recoveryCode.length,64);
  const stored=await db.prepare('SELECT * FROM users WHERE id=?').bind(a.user.id).first();assert(!stored.password_hash.includes('correct-test-password'));assert.notEqual(stored.recovery_hash,a.recoveryCode);
  assert.equal((await req('/api/settings',{cookie:a.cookie,origin:'https://evil.test',body:{running:true}})).status,403);
  const biz=await api('businesses',a.cookie,{name:'Alice private clinic',email:'lead@example.com'});
  const letter=await api('templates',a.cookie,{name:'Secret letter',subject:'Private subject',body:'Private body'});
  const seq=await api('sequences',a.cookie,{name:'Private sequence',steps:[{templateId:letter.id,delayDays:0}]});
  const mb=await api('mailboxes',a.cookie,{email:'sender@example.com',name:'Alice',host:'smtp.example.com',port:465,password:'smtp-private-password'});
  const mb2=await api('mailboxes',b.cookie,{email:'sender@example.com',name:'Bob',host:'smtp.example.com',port:465,password:'smtp-private-password-b'});
  assert.notEqual(mb.id,mb2.id);
  const encrypted=await db.prepare('SELECT password_enc FROM mailboxes WHERE id=?').bind(mb.id).first();assert(!encrypted.password_enc.includes('smtp-private-password'));
  await db.prepare('UPDATE mailboxes SET verified_at=1,active=1 WHERE id=?').bind(mb.id).run();
  const campaign=await api('campaigns',a.cookie,{name:'Private campaign',templateId:letter.id,businessIds:[biz.id],mailboxId:mb.id,startAt:Date.now(),gapMinutes:10,dailyCap:25});
  for(const endpoint of ['businesses','businesses?q=clinic','templates','campaigns','mails','replies','sequences','logs'])assert.deepEqual(await api(endpoint,b.cookie),[],endpoint);
  assert.equal((await api('state',b.cookie)).counts.businesses,0);
  assert.equal((await api('analytics',b.cookie)).totals.queued,0);
  const exported=await api('workspace/export',b.cookie);assert.equal(exported.businesses.length,0);assert(!JSON.stringify(exported).includes('Alice'));
  assert(!JSON.stringify(await api('mailboxes',a.cookie)).includes('password_enc'));
  await api('businesses/'+biz.id,b.cookie,{name:'Stolen',email:'x@example.com'},'PUT');
  await api('templates/'+letter.id,b.cookie,{},'DELETE');
  await api('campaigns/'+campaign.id+'/status',b.cookie,{status:'stopped'});
  await api('mailboxes/'+mb.id,b.cookie,{},'DELETE');
  assert.equal((await api('businesses',a.cookie))[0].name,'Alice private clinic');
  assert.equal((await api('templates',a.cookie)).length,1);
  assert.equal((await api('campaigns',a.cookie))[0].status,'active');
  assert.equal((await api('mailboxes',a.cookie)).length,1);
  const forged=await req('/api/campaigns',{cookie:b.cookie,body:{name:'Attack',templateId:letter.id,businessIds:[biz.id],mailboxId:mb.id,startAt:Date.now(),gapMinutes:1,dailyCap:10}});assert.equal(forged.status,400);
  assert.equal((await req('/api/mailboxes/'+mb.id+'/activate',{cookie:b.cookie,body:{}})).status,400);
  assert.equal((await req('/api/sequences',{cookie:b.cookie,body:{name:'Attack',steps:[{templateId:letter.id,delayDays:0}]}})).status,400);
  const oauth=await req('/auth/google',{cookie:a.cookie});assert.equal(oauth.status,302);const u=new URL(oauth.headers.get('location'));assert.equal(u.hostname,'accounts.google.com');assert.equal(u.searchParams.get('code_challenge_method'),'S256');
  const st=u.searchParams.get('state');assert.equal((await req('/auth/google/callback?state='+st+'&error=access_denied',{cookie:b.cookie})).status,400);
  assert.equal((await req('/auth/google/callback?state='+st+'&error=access_denied',{cookie:a.cookie})).status,200);
  assert.equal((await req('/auth/google/callback?state='+st+'&error=access_denied',{cookie:a.cookie})).status,400,'replayed state blocked');
  const ms=await req('/auth/microsoft',{cookie:a.cookie});assert.equal(ms.status,302);assert.equal(new URL(ms.headers.get('location')).hostname,'login.microsoftonline.com');
  await api('account/logout',a.cookie,{});assert.equal((await req('/api/state',{cookie:a.cookie})).status,401);
  const login=await req('/api/account/login',{body:{email:'alice@example.com',password:'correct-test-password'}});assert.equal(login.status,200);
  const oldCookie=login.headers.get('set-cookie').split(';')[0];
  const recovery=await req('/api/account/recover',{body:{email:'alice@example.com',password:'new-correct-password',recoveryCode:a.recoveryCode}});assert.equal(recovery.status,200);assert.equal((await req('/api/state',{cookie:oldCookie})).status,401);
  assert.equal((await req('/api/account/recover',{body:{email:'alice@example.com',password:'new-correct-password',recoveryCode:a.recoveryCode}})).status,401,'old recovery code cannot replay');
  await api('workspace/delete',b.cookie,{confirm:'DELETE MY ACCOUNT'});assert.equal((await req('/api/state',{cookie:b.cookie})).status,401);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM businesses WHERE tenant_id=?').bind(a.user.id).first()).n,1);
 }finally{await mf.dispose();}
});

test('migration preserves legacy records without granting them to a new signup',async()=>{
 const old=(await readFile('tests/fixtures/legacy-schema.sql','utf8')).replace(/--[^\n]*/g,'');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-17',d1Databases:['DB']}));
 try{const db=await mf.getD1Database('DB');await db.batch(old.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));await db.prepare("INSERT INTO businesses(id,name,email) VALUES('old','Preserved','old@example.com')").run();const migration=await readFile('migrations/0004_saas.sql','utf8');await db.batch(migration.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));const row=await db.prepare("SELECT * FROM businesses WHERE id='old'").first();assert.equal(row.tenant_id,'0'.repeat(32));assert.equal(row.name,'Preserved');const next=await readFile('migrations/0005_campaign_connectors.sql','utf8');await db.batch(next.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));assert.equal((await db.prepare("SELECT verification FROM businesses WHERE id='old'").first()).verification,'unchecked');}finally{await mf.dispose();}
});


test('OAuth callbacks store encrypted per-workspace tokens and return only connection metadata',async()=>{
 const {mf,db,req,api,signup}=await setup(true);try{
  const a=await signup('oauth@example.com'),b=await signup('other@example.com');
  for(const provider of ['google','microsoft']){
   const r=await req('/auth/'+provider,{cookie:a.cookie});const state=new URL(r.headers.get('location')).searchParams.get('state');
   const callback=await req('/auth/'+provider+'/callback?code=mock-code&state='+state,{cookie:a.cookie});
   assert.equal(callback.status,302,await callback.text());
   const row=await db.prepare('SELECT * FROM '+(provider==='google'?'google_account':'microsoft_account')+' WHERE tenant_id=?').bind(a.user.id).first();
   assert(row);assert(!row.access_token.includes('secret-access-token'));assert(!row.refresh_token.includes('secret-refresh-token'));
   assert.equal((await api('connectors',a.cookie))[provider].connected,true);
   assert.equal((await api('connectors',b.cookie))[provider].connected,false);
  }
  const status=await api('state',a.cookie);assert(!JSON.stringify(status).includes('access_token'));
 }finally{await mf.dispose();}
});

test('service lists separate imports and bulk operations stay workspace-scoped',async()=>{
 const {mf,db,api,signup}=await setup();try{
 const a=await signup('lists@example.com'),b=await signup('otherlists@example.com');
 const csv='business,email\nExample,lead@example.com';
 assert.equal((await api('businesses/import',a.cookie,{csv,service_list:'SEO'})).added,1);
 assert.equal((await api('businesses/import',a.cookie,{csv,service_list:'SEO'})).skipped,1);
 assert.equal((await api('businesses/import',a.cookie,{csv,service_list:'Design'})).added,1);
 assert.deepEqual(await api('businesses/lists',a.cookie),['Design','SEO']);
 const rows=await api('businesses',a.cookie);assert.equal(rows.length,2);
 await api('businesses/bulk-list',b.cookie,{ids:rows.map(r=>r.id),service_list:'Intruder'});
 assert.deepEqual(await api('businesses/lists',a.cookie),['Design','SEO']);
 await api('businesses/bulk-delete',b.cookie,{ids:rows.map(r=>r.id)});assert.equal((await api('businesses',a.cookie)).length,2);
 await api('businesses/bulk-list',a.cookie,{ids:[rows[0].id],service_list:'Branding'});
 assert.equal((await api('businesses',a.cookie)).find(r=>r.id===rows[0].id).service_list,'Branding');
 assert.equal((await api('businesses/bulk-delete',a.cookie,{ids:rows.map(r=>r.id)})).changed,2);
 assert.equal((await api('businesses',a.cookie)).length,0);
 }finally{await mf.dispose();}
});

test('campaign launch blocks missing personalization before queueing and accepts fallbacks',async()=>{
 const {mf,db,api,signup}=await setup();try{
 const a=await signup('copycheck@example.com');const lead=await api('businesses',a.cookie,{name:'Acme',email:'lead@example.com'});
 const sender=await api('mailboxes',a.cookie,{email:'sender@example.com',host:'smtp.example.com',port:465,password:'private-test-password'});
 await db.prepare('UPDATE mailboxes SET verified_at=1,active=1 WHERE id=?').bind(sender.id).run();
 const template=await api('templates',a.cookie,{name:'Needs name',subject:'Hi {{first_name}}',body:'[[Hi|Hello]] {{business}}'});
 const payload={name:'Check',templateId:template.id,businessIds:[lead.id],mailboxId:sender.id,startAt:Date.now(),gapMinutes:10,dailyCap:25};
 await assert.rejects(()=>api('campaigns',a.cookie,payload),/Missing personalization/);assert.equal((await api('mails',a.cookie)).length,0);
 await api('templates/'+template.id,a.cookie,{name:'Safe',subject:'Hi {{first_name|there}}',body:'[[Hi|Hello]] {{business}}'},'PUT');
 assert.equal((await api('campaigns/preflight',a.cookie,payload)).sample.subject,'Hi there');
 assert.equal((await api('campaigns',a.cookie,payload)).queued,1);
 }finally{await mf.dispose();}
});
