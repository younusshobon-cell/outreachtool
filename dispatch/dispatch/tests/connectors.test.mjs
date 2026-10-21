import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createHash} from 'node:crypto';
async function setup(){
 const mock=`const fetch=async(url,init={})=>{const u=String(url),auth=new Headers(init.headers).get('authorization')||new Headers(init.headers).get('x-api-key');if(auth?.includes('invalid'))return Response.json({}, {status:401});if(u.includes('tokeninfo'))return Response.json({expires_in:1800,scope:'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly'});if(u.endsWith('/token'))return Response.json({access_token:'refreshed-secret',refresh_token:'refresh-secret',expires_in:3600,scope:'Mail.Send Mail.ReadWrite User.Read'});if(u.endsWith('/profile'))return Response.json({emailAddress:'gmail@example.com'});if(u.includes('graph.microsoft.com')&&u.includes('/me?'))return Response.json({mail:'outlook@example.com'});if(u.includes('graph.microsoft.com')&&u.includes('/messages?'))return Response.json({value:[]});if(u.includes('hubapi.com'))return Response.json({results:[{properties:{email:'hubspot@example.com',company:'HubSpot Lead',firstname:'Alex'}}]});if(u.endsWith('/credits'))return Response.json({credits:42});if(u.includes('email-validation'))return Response.json({email_status:'invalid',credits_consumed:0.25});if(u.includes('outboundsync.com'))return Response.json({status:'ready',account:{name:'Demo'}});throw Error('Unexpected outbound request '+u);};`;
 const bundle=await build({entryPoints:['src/index.js'],bundle:true,format:'esm',platform:'browser',write:false,external:['cloudflare:sockets']});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:mock+bundle.outputFiles[0].text,compatibilityDate:'2026-10-17',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{MAILBOX_SECRET:'test-only-secret'}}));
 const db=await mf.getD1Database('DB');await db.batch((await readFile('schema.sql','utf8')).split(';').map(x=>x.trim()).filter(Boolean).map(x=>db.prepare(x)));
 async function req(path,cookie='',body,method=body?'POST':'GET',headers={}){return mf.dispatchFetch('https://app.test'+path,{method,redirect:'manual',headers:{origin:'https://app.test','content-type':'application/json',cookie,...headers},body:body===undefined?undefined:JSON.stringify(body)});}
 async function api(path,cookie='',body,method){const r=await req('/api/'+path,cookie,body,method);const d=await r.json();assert(r.ok,path+': '+r.status+' '+JSON.stringify(d));return d;}
 async function signup(email){const r=await req('/api/account/register','',{email,name:'Test',password:'correct-test-password'});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};}
 return {mf,db,req,api,signup};
}
test('personal Gmail/Outlook tokens work without owner app keys, are encrypted and remain private',async()=>{
 const {mf,db,req,api,signup}=await setup();try{const a=await signup('a@example.com'),b=await signup('b@example.com');
 assert.equal((await api('connectors',a.cookie)).google.enabled,false);
 assert.equal((await req('/api/connectors/google/credentials',a.cookie,{accessToken:'invalid-token'})).status,400);
 assert.equal((await api('connectors',a.cookie)).google.connected,false);
 const g=await api('connectors/google/credentials',a.cookie,{accessToken:'google-secret',expiresIn:1000});assert.equal(g.autoRefresh,false);assert.equal(g.email,'gmail@example.com');
 const m=await api('connectors/microsoft/credentials',a.cookie,{refreshToken:'refresh-secret',clientId:'my-app',clientSecret:'my-secret'});assert.equal(m.autoRefresh,true);
 const state=await api('state',a.cookie);assert(state.connectors.google.connected);assert(state.connectors.microsoft.autoRefresh);assert(!JSON.stringify(state).includes('my-secret'));
 const rows=(await db.prepare('SELECT secret_enc FROM connector_secrets').all()).results;assert(rows.every(x=>!x.secret_enc.includes('my-secret')));
 assert.equal((await api('connectors',b.cookie)).google.connected,false);
 const app=await api('connectors/google/credentials',b.cookie,{mode:'oauth',clientId:'bob-app',clientSecret:'bob-secret'});assert.equal(app.authorize,'/auth/google');
 const redirect=await req('/auth/google',b.cookie);assert.equal(new URL(redirect.headers.get('location')).searchParams.get('client_id'),'bob-app');
 assert.equal((await req('/auth/google',a.cookie)).status,503,'access token must not silently use another tenant OAuth app');
 }finally{await mf.dispose();}
});
test('connectors verify keys before saving, import HubSpot idempotently and use LeadMagic only on explicit verification',async()=>{
 const {mf,db,req,api,signup}=await setup();try{const a=await signup('a@example.com'),b=await signup('b@example.com');
 assert.equal((await req('/api/integrations/hubspot/connect',a.cookie,{apiKey:'invalid-key'})).status,400);
 assert.equal((await api('integrations',a.cookie)).connections.length,0);
 for(const p of ['hubspot','leadmagic','outboundsync'])await api('integrations/'+p+'/connect',a.cookie,{apiKey:'working-api-key'});
 assert.equal((await api('integrations',b.cookie)).connections.length,0);
 assert.equal((await api('integrations/hubspot/import',a.cookie,{})).added,1);
 assert.equal((await api('integrations/hubspot/import',a.cookie,{})).duplicates,1);
 const lead=(await api('businesses',a.cookie))[0];assert.equal(lead.verification,'unchecked');
 assert.equal((await req('/api/integrations/leadmagic/verify',a.cookie,{businessId:lead.id})).status,400);
 assert.equal((await req('/api/integrations/leadmagic/verify',b.cookie,{businessId:lead.id,confirmCredits:true})).status,400);
 assert.equal((await api('integrations/leadmagic/verify',a.cookie,{businessId:lead.id,confirmCredits:true})).status,'invalid');
 assert.equal((await api('suppressions',a.cookie))[0].email,lead.email);
 assert.equal((await api('integrations/outboundsync/status',a.cookie)).status,'ready');
 await api('workspace/delete',a.cookie,{confirm:'DELETE MY ACCOUNT'});assert.equal((await db.prepare('SELECT COUNT(*) n FROM connector_secrets').first()).n,0);
 }finally{await mf.dispose();}
});
test('Clay import tokens are scoped, rotated and revoked; blocklisted imports remain blocked',async()=>{
 const {mf,req,api,signup}=await setup();try{const a=await signup('a@example.com'),b=await signup('b@example.com');
 const key=await api('integrations/clay/key',a.cookie,{});
 async function ingest(token,email='lead@example.com'){const r=await req('/integrations/leads','',{leads:[{email,name:'Lead'}]},'POST',{origin:'https://clay.com',authorization:'Bearer '+token});return {status:r.status,data:await r.json()};}
 assert.equal((await ingest('bad-token')).status,401);assert.equal((await ingest(key.token)).data.added,1);assert.equal((await ingest(key.token)).data.duplicates,1);
 assert.equal((await api('businesses',b.cookie)).length,0);
 await api('suppressions',a.cookie,{email:'blocked@example.com'});assert.equal((await ingest(key.token,'blocked@example.com')).data.blocked,1);
 const next=await api('integrations/clay/key',a.cookie,{});assert.equal((await ingest(key.token)).status,401);assert.equal((await ingest(next.token,'new@example.com')).data.added,1);
 await api('integrations/clay',a.cookie,undefined,'DELETE');assert.equal((await ingest(next.token)).status,401);
 }finally{await mf.dispose();}
});
test('A/B preflight is read-only, snapshots both variants, blocks duplicate enrollment and confirms unsubscribe before suppression',async()=>{
 const {mf,db,req,api,signup}=await setup();try{const a=await signup('a@example.com');
 await api('connectors/google/credentials',a.cookie,{accessToken:'google-secret'});await api('connectors/google/activate',a.cookie,{});
 const ids=[];for(let i=0;i<4;i++)ids.push((await api('businesses',a.cookie,{name:'Company',email:`lead${i}@example.com`})).id);
 const A=await api('templates',a.cookie,{name:'A',subject:'Hi {{business}}',body:'Message A'}),B=await api('templates',a.cookie,{name:'B',subject:'Alternative',body:'Message B'});
 const payload={name:'AB test',businessIds:ids,templateId:A.id,variantTemplateId:B.id,startAt:Date.now(),gapMinutes:1,dailyCap:10};
 assert.equal((await api('campaigns/preflight',a.cookie,payload)).eligible,4);assert.equal((await api('campaigns',a.cookie)).length,0);
 const campaign=await api('campaigns',a.cookie,payload);const mails=await api('mails',a.cookie);assert.equal(mails.filter(m=>m.variant==='B'&&m.body==='Message B').length,2);
 assert.equal((await req('/api/campaigns',a.cookie,payload)).status,400,'do not queue same contacts twice');
 const token='a'.repeat(64);await db.prepare('INSERT INTO unsubscribe_tokens VALUES(?,?,?,?)').bind(createHash('sha256').update(token).digest('hex'),a.user.id,'lead0@example.com',Date.now()).run();
 assert.equal((await req('/unsubscribe/'+token)).status,200);assert.equal((await api('suppressions',a.cookie)).length,0,'GET link scanner cannot unsubscribe');
 assert.equal((await req('/unsubscribe/'+token,'',{},'POST')).status,200);assert.equal((await api('suppressions',a.cookie)).length,1);
 assert.equal((await api('mails',a.cookie)).find(m=>m.to_email==='lead0@example.com').status,'cancelled');
 await api('businesses/'+ids[0],a.cookie,undefined,'DELETE');assert.equal((await req('/api/businesses',a.cookie,{email:'lead0@example.com'})).status,400);
 const variants=await api('campaigns/'+campaign.id+'/variants',a.cookie);assert.equal(variants.length,2);
 }finally{await mf.dispose();}
});
