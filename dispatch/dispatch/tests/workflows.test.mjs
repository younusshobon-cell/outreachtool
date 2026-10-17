import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

test('campaigns enforce their own intervals/caps, preserve paused mail, sequence snapshots and suppression',async()=>{
 const result=await build({entryPoints:['src/index.js'],bundle:true,format:'esm',platform:'browser',write:false,external:['cloudflare:sockets'],plugins:[{name:'no-network-mail-test',setup(b){b.onLoad({filter:/\/gmail\.js$/},()=>({contents:`export async function sendMail(){return {id:'mock-'+crypto.randomUUID(),threadId:'mock-thread'}}; export async function messageIdHeader(){return null};export async function findReply(){return null};`,loader:'js'}));}}]});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:result.outputFiles[0].text,compatibilityDate:'2026-10-17',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{MAILBOX_SECRET:'test-only-encryption-key'}}));
 try{
  const db=await mf.getD1Database('DB');const schema=(await readFile('schema.sql','utf8')).replace(/--[^\n]*/g,'');
  await db.batch(schema.split(';').map(x=>x.trim()).filter(Boolean).map(sql=>db.prepare(sql)));
  async function api(path,body,method=body?'POST':'GET'){const r=await mf.dispatchFetch('https://app.test/api/'+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();assert(r.ok,JSON.stringify(data));return data;}
  await db.prepare("INSERT INTO google_account(id,email,access_token,expires_at) VALUES(1,'sender@example.com','test',9999999999999)").run();
  await api('settings',{running:true,mode:'send',daily_cap:100,window_start:0,window_end:0,weekdays_only:false,poll_replies:false,gap_minutes:600});
  const t1=await api('templates',{name:'Intro',subject:'Hello {{business}}',body:'First'});
  const t2=await api('templates',{name:'Follow-up',subject:'Following up',body:'Second'});
  const ids=[];for(let i=0;i<3;i++)ids.push((await api('businesses',{name:'Company '+i,email:`client${i}@example.com`})).id);
  const seq=await api('sequences',{name:'Two steps',steps:[{templateId:t1.id,delayDays:0},{templateId:t2.id,delayDays:3}]});
  const c=await api('campaigns',{name:'Custom pace',sequenceId:seq.id,businessIds:ids,startAt:Date.now(),gapMinutes:7,dailyCap:1});
  assert.equal(c.queued,3);await db.prepare("UPDATE mails SET scheduled_at=0 WHERE campaign_id=?").bind(c.id).run();
  const r1=await api('tick',{force:false});assert.equal(r1.sent,1,'global 600-min setting must not override campaign pacing');
  const sent=await db.prepare("SELECT * FROM mails WHERE campaign_id=? AND status='sent'").bind(c.id).first();
  const follow=await db.prepare('SELECT * FROM mails WHERE parent_id=?').bind(sent.id).first();assert.equal(follow.step,2);assert.equal(follow.scheduled_at-sent.sent_at,3*86400000);
  assert.equal((await api('tick',{force:false})).sent,0,'campaign daily cap blocks more');
  await api('campaigns/'+c.id,{gapMinutes:7,dailyCap:10},'PUT');
  assert.equal((await api('tick',{force:false})).sent,0,'actual previous send controls interval');
  await db.prepare('UPDATE mails SET sent_at=? WHERE id=?').bind(Date.now()-8*60000,sent.id).run();
  await api('campaigns/'+c.id+'/status',{status:'paused'});const queued=await db.prepare("SELECT COUNT(*) n FROM mails WHERE campaign_id=? AND status='queued'").bind(c.id).first();assert.equal(queued.n,3);
  assert.equal((await api('tick',{force:false})).sent,0,'paused campaigns stay queued');
  await api('campaigns/'+c.id+'/status',{status:'active'});assert.equal((await api('tick',{force:false})).sent,1,'resume sends eligible next mail');
  await api('businesses/'+sent.business_id+'/outcome',{status:'replied',message:'Interested',category:'positive'});
  assert.equal((await db.prepare('SELECT status FROM mails WHERE id=?').bind(follow.id).first()).status,'cancelled');
  const a=await api('analytics?days=30');assert.equal(a.totals.sent,2);assert.equal(a.totals.positive,1);
  await api('sequences/'+seq.id,undefined,'DELETE');assert((await db.prepare('SELECT sequence_json FROM campaigns WHERE id=?').bind(c.id).first()).sequence_json,'deleting a sequence preserves campaign snapshots');
  const invalid=await mf.dispatchFetch('https://app.test/api/campaigns',{method:'POST',body:JSON.stringify({businessIds:ids,startAt:Date.now(),gapMinutes:0,dailyCap:10}),headers:{'content-type':'application/json'}});assert.equal(invalid.status,400);
 }finally{await mf.dispose();}
});
