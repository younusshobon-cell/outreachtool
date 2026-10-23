import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const src=(await readFile('src/imap.js','utf8')).replace("import {connect} from 'cloudflare:sockets';",'const connect=()=>{};').replace("import {validateMailbox} from './smtp.js';",'const validateMailbox=x=>x;');
const {readInbox}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
test('IMAP handles byte literals, UID reset, read-only access and incremental cursor',async()=>{
 const writes=[],seen=[],progress=[];let c;const raw='Subject: বাংলা\r\n\r\nHello';const bytes=new TextEncoder().encode(raw);
 const open=()=>({opened:Promise.resolve(),closed:Promise.resolve(),close:async()=>{},readable:new ReadableStream({start(x){c=x;c.enqueue(new TextEncoder().encode('* OK ready\r\n'));}}),writable:new WritableStream({write(v){const text=new TextDecoder().decode(v);writes.push(text);const tag=text.split(' ')[0];let r='';if(text.includes('EXAMINE'))r='* OK [UIDVALIDITY 123]\r\n';if(text.includes('SEARCH'))r='* SEARCH 1 2\r\n';if(text.includes('FETCH')){c.enqueue(new TextEncoder().encode('* 1 FETCH (UID 1 BODY[] {'+bytes.length+'}\r\n'));c.enqueue(bytes.slice(0,10));c.enqueue(bytes.slice(10));r=')\r\n';}c.enqueue(new TextEncoder().encode(r+tag+' OK done\r\n'));}})});
 const result=await readInbox({host:'mail.example.com',username:'a@example.com',password:'secret',cursor:500,validity:'old',onMessage:async raw=>seen.push(new TextDecoder().decode(raw)),onProgress:async uid=>progress.push(uid)},open);
 assert.equal(result.cursor,2);assert.deepEqual(progress,[1,2]);assert.equal(seen[0],raw);assert(writes.some(x=>x.includes('UID SEARCH UID 1:*')));assert(writes.some(x=>x.includes('BODY.PEEK')));assert(!writes.some(x=>/SELECT|STORE/.test(x)));
});
test('IMAP replies are tenant scoped, deduplicated and cancel follow-ups',async()=>{
 const b=await build({stdin:{contents:"import {ingestReply} from './src/inbox-sync.js';export default {async fetch(r,env){const x=await r.json();return Response.json(await ingestReply({...env,TENANT_ID:x.tenant},{id:'mb',email:'sender@example.com'},x.raw,x.uid,'123'))}}",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',write:false,external:['cloudflare:sockets']});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:b.outputFiles[0].text,compatibilityDate:'2026-10-17',compatibilityFlags:['nodejs_compat'],d1Databases:['DB']}));
 try{const db=await mf.getD1Database('DB');const schema=(await readFile('schema.sql','utf8')).replace(/--[^\n]*/g,'');await db.batch(schema.split(';').map(x=>x.trim()).filter(Boolean).map(s=>db.prepare(s)));
 const tenant='11111111111111111111111111111111';await db.prepare("INSERT INTO businesses(tenant_id,id,name,email,status) VALUES(?,'biz','Client','client@example.com','contacted')").bind(tenant).run();await db.prepare("INSERT INTO mails(tenant_id,id,mailbox_id,business_id,to_email,status,gmail_id,sent_at) VALUES(?,'mail','mb','biz','client@example.com','sent','<sent@example.com>',?)").bind(tenant,Date.now()-60000).run();await db.prepare("INSERT INTO mails(tenant_id,id,mailbox_id,business_id,to_email,status) VALUES(?,'follow','mb','biz','client@example.com','queued')").bind(tenant).run();
 const raw='From: Client <client@example.com>\r\nTo: sender@example.com\r\nMessage-ID: <reply@example.com>\r\nIn-Reply-To: <sent@example.com>\r\nSubject: Re: Hello\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nInterested, tell me more.';
 async function ingest(t,uid){return (await mf.dispatchFetch('https://test/',{method:'POST',body:JSON.stringify({tenant:t,uid,raw})})).json();}
 assert.equal(await ingest('22222222222222222222222222222222',1),0);assert.equal(await ingest(tenant,1),1);assert.equal(await ingest(tenant,1),0);assert.equal(await ingest(tenant,2),0,'same Message-ID is deduplicated across UIDs');assert.equal((await db.prepare("SELECT status FROM mails WHERE id='follow'").first()).status,'cancelled');assert.equal((await db.prepare('SELECT COUNT(*) n FROM replies').first()).n,1);
 }finally{await mf.dispose();}
});
