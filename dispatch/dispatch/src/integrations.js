import {tenant} from './tenant.js';
import {secret,saveSecret,providerJson} from './credentials.js';
import {digest,randomToken,rateLimit} from './accounts.js';
import {json,bad,isEmail,id} from './util.js';
import {suppressed,suppress} from './suppression.js';
const supported=['hubspot','leadmagic','outboundsync'];
const bearer=key=>({authorization:'Bearer '+key});
async function check(provider,key){
 if(provider==='hubspot')return providerJson('https://api.hubapi.com/crm/v3/objects/contacts?limit=1&properties=email',{headers:bearer(key)});
 if(provider==='leadmagic')return providerJson('https://api.leadmagic.io/v1/credits',{headers:{'X-API-Key':key}});
 if(provider==='outboundsync')return providerJson('https://app.outboundsync.com/api/v1/me',{headers:bearer(key)});
 throw Error('Unknown provider');
}
export async function importLeads(env,rows,source){
 if(!Array.isArray(rows)||!rows.length||rows.length>100)throw Error('Send 1–100 leads per request');
 let added=0,duplicates=0,blocked=0,invalid=0;
 for(const b of rows){const email=String(b?.email||'').trim().toLowerCase();if(!isEmail(email)||email.length>254){invalid++;continue;}if(await suppressed(env,email)){blocked++;continue;}
 const text=k=>String(b[k]||'').slice(0,k==='notes'?4000:300);
 const r=await env.DB.prepare("INSERT INTO businesses(tenant_id,id,name,owner,email,website,city,notes,status,created_at) SELECT ?,?,?,?,?,?,?,?,'new',? WHERE NOT EXISTS(SELECT 1 FROM businesses WHERE tenant_id=? AND lower(trim(email))=?)").bind(tenant(env),id('b'),text('name')||email.split('@')[1],text('owner'),email,text('website'),text('city'),('Imported from '+source+'\n'+text('notes')).trim(),Date.now(),tenant(env),email).run();r.meta.changes?added++:duplicates++;
 }return {added,duplicates,blocked,invalid};
}
export async function ingestion(request,env){
 if(request.method!=='POST')return bad('Use POST',405);
 if(!request.headers.get('content-type')?.startsWith('application/json'))return bad('Use application/json',415);
 const value=request.headers.get('authorization')?.replace(/^Bearer /,'')||'';if(!/^[a-f0-9]{64}$/.test(value))return bad('Invalid API token',401);
 const key=await env.DB.prepare('SELECT k.* FROM integration_keys k JOIN users u ON u.id=k.tenant_id WHERE token_hash=?').bind(await digest(value)).first();if(!key)return bad('Invalid API token',401);
 if(!await rateLimit(env,'ingest:'+key.tenant_id,30,60000))return bad('Rate limit reached',429);
 if(Number(request.headers.get('content-length')||0)>262144)return bad('Payload too large',413);
 const reader=request.body.getReader();let chunks=[],n=0;try{while(true){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>262144)return bad('Payload too large',413);chunks.push(value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(n);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try{const b=JSON.parse(new TextDecoder().decode(bytes));const result=await importLeads({...env,TENANT_ID:key.tenant_id},b.leads||[b],key.provider);await env.DB.prepare('UPDATE integration_keys SET last_used_at=? WHERE token_hash=?').bind(Date.now(),key.token_hash).run();return json(result);}catch(e){return bad(e.message);}
}
export async function integrationApi(request,env,url){
 const [,, ,provider,action]=url.pathname.split('/');
 try{
 if(request.method==='GET'&&!provider){const rows=(await env.DB.prepare("SELECT provider,metadata,updated_at FROM connector_secrets WHERE tenant_id=? AND provider IN ('hubspot','leadmagic','outboundsync')").bind(tenant(env)).all()).results;const keys=(await env.DB.prepare('SELECT provider,created_at,last_used_at FROM integration_keys WHERE tenant_id=?').bind(tenant(env)).all()).results;return json({connections:rows.map(r=>({...r,metadata:JSON.parse(r.metadata)})),keys});}
 if(provider==='clay'){
  if(request.method==='POST'&&action==='key'){const token=randomToken();await env.DB.prepare('INSERT INTO integration_keys VALUES(?,?,?,?,NULL) ON CONFLICT(tenant_id,provider) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at,last_used_at=NULL').bind(await digest(token),tenant(env),'clay',Date.now()).run();return json({token,endpoint:url.origin+'/integrations/leads',example:{leads:[{email:'person@company.com',name:'Company',owner:'First Last',website:'https://company.com',city:'London',notes:'Personalisation context'}]}});}
  if(request.method==='DELETE'){await env.DB.prepare("DELETE FROM integration_keys WHERE tenant_id=? AND provider='clay'").bind(tenant(env)).run();return json({ok:true});}
 }
 if(!supported.includes(provider))return bad('Unknown integration',404);
 if(request.method==='DELETE'){await env.DB.prepare('DELETE FROM connector_secrets WHERE tenant_id=? AND provider=?').bind(tenant(env),provider).run();return json({ok:true});}
 const b=request.method==='POST'?await request.json():{};
 if(request.method==='POST'&&action==='connect'){
  const key=String(b.apiKey||'').trim();if(key.length<8||key.length>4096)return bad('Enter a valid API token');
  const result=await check(provider,key);const metadata=provider==='leadmagic'?{credits:result.credits}:{};
  await saveSecret(env,provider,{apiKey:key},metadata);return json({ok:true,...metadata});
 }
 const c=await secret(env,provider);if(!c)return bad('Connect this integration first');
 if(provider==='hubspot'&&action==='import'&&request.method==='POST'){
  const after=String(b.after||'');if(after.length>200)return bad('Invalid pagination cursor');
  const data=await providerJson('https://api.hubapi.com/crm/v3/objects/contacts?'+new URLSearchParams({limit:'100',properties:'email,firstname,lastname,company,website,city',...(after?{after}:{})}),{headers:bearer(c.apiKey)});
  const rows=(data.results||[]).map(r=>({email:r.properties.email,owner:[r.properties.firstname,r.properties.lastname].filter(Boolean).join(' '),name:r.properties.company,website:r.properties.website,city:r.properties.city}));
  const result=rows.length?await importLeads(env,rows,'HubSpot'):{added:0,duplicates:0,blocked:0,invalid:0};return json({...result,next:data.paging?.next?.after||null});
 }
 if(provider==='leadmagic'&&action==='verify'&&request.method==='POST'){
  if(b.confirmCredits!==true)return bad('Confirm use of your LeadMagic credits');
  const lead=await env.DB.prepare('SELECT id,email FROM businesses WHERE tenant_id=? AND id=?').bind(tenant(env),String(b.businessId||'')).first();if(!lead)return bad('Lead not found',404);
  const d=await providerJson('https://api.leadmagic.io/v1/people/email-validation',{method:'POST',headers:{'X-API-Key':c.apiKey,'content-type':'application/json'},body:JSON.stringify({email:lead.email})});
  const status=['valid','invalid','unknown'].includes(d.email_status)?d.email_status:'unknown';
  await env.DB.prepare('UPDATE businesses SET verification=?,verified_at=? WHERE tenant_id=? AND id=?').bind(status,Date.now(),tenant(env),lead.id).run();if(status==='invalid')await suppress(env,lead.email,'invalid-email');return json({status,creditsConsumed:d.credits_consumed??null});
 }
 if(provider==='leadmagic'&&action==='credits'&&request.method==='GET'){const d=await check(provider,c.apiKey);return json({credits:d.credits});}
 if(provider==='outboundsync'&&action==='status'&&request.method==='GET')return json(await providerJson('https://app.outboundsync.com/api/v1/account/status',{headers:bearer(c.apiKey)}));
 return bad('Unknown integration action',404);
 }catch(e){return bad(e.message);}
}
