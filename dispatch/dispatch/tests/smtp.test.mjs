import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source=(await readFile(new URL('../src/smtp.js',import.meta.url),'utf8'))
 .replace("import { connect } from 'cloudflare:sockets';",'const connect=(...args)=>globalThis.fakeConnect(...args);')
 .replace("import { encodeHeader } from './util.js';",'const encodeHeader=s=>s;');
const {smtpSession,validateMailbox}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const m={email:'hello@example.com',host:'smtp.example.com',port:465,username:'hello@example.com',name:'Hello'};
function server({rejectAuth=false,failQuit=false}={}) {
 const writes=[];let upgrades=0,stage=0,auth=0;
 function socket(greeting=true) {
  let controller;const push=s=>controller.enqueue(new TextEncoder().encode(s+'\r\n'));
  const readable=new ReadableStream({start(c){controller=c;if(greeting)push('220 SMTP ready');}});
  const writable=new WritableStream({write(bytes){const line=new TextDecoder().decode(bytes).replace(/\r\n$/,'');writes.push(line);
   if(line.startsWith('EHLO'))push('250-example\r\n250 AUTH LOGIN');
   else if(line==='STARTTLS')push('220 TLS ready');
   else if(line==='AUTH LOGIN'){auth=1;push('334 username');}
   else if(auth===1){auth=2;push('334 password');}
   else if(auth===2){auth=0;push(rejectAuth?'535 bad password':'235 authenticated');}
   else if(line.startsWith('MAIL FROM')||line.startsWith('RCPT TO'))push('250 OK');
   else if(line==='DATA'){stage=1;push('354 continue');}
   else if(stage===1){stage=0;push('250 accepted');}
   else if(line==='QUIT'){if(failQuit)controller.close();else push('221 bye');}
  }});
  return {readable,writable,opened:Promise.resolve({}),closed:Promise.resolve(),close:async()=>{},startTls(){upgrades++;return socket(false);}};
 }
 globalThis.fakeConnect=()=>socket();return {writes,get upgrades(){return upgrades;}};
}
test('validates TLS ports and prevents header injection / local hosts',()=>{
 assert.equal(validateMailbox({...m}).port,465);
 for(const input of [{...m,port:25},{...m,email:'a@example.com\r\nBcc:x@example.com'},{...m,host:'127.0.0.1'},{...m,host:'mail.local'},{...m,name:'X\r\nBcc:y'}])assert.throws(()=>validateMailbox(input));
});
test('connection test authenticates but never sends mail',async()=>{
 const s=server();await smtpSession(m,'secret');assert(!s.writes.some(x=>x.startsWith('MAIL FROM')));assert(s.writes.includes('QUIT'));
});
test('587 upgrades TLS before authentication',async()=>{
 const s=server();await smtpSession({...m,port:587},'secret');assert.equal(s.upgrades,1);assert(s.writes.indexOf('STARTTLS')<s.writes.indexOf('AUTH LOGIN'));
});
test('sending accepts DATA and does not retry after QUIT failure',async()=>{
 const s=server({failQuit:true});const r=await smtpSession(m,'secret',{to:'client@example.com',subject:'Hello',body:'.\r\nUnicode বাংলা'});assert.match(r.id,/@example.com>/);assert.equal(s.writes.filter(x=>x==='DATA').length,1);
});
test('invalid credentials produce no delivery',async()=>{
 const s=server({rejectAuth:true});await assert.rejects(smtpSession(m,'wrong'),/Authentication failed/);assert(!s.writes.includes('DATA'));
});
test('SMTP includes reply address and threading without an automatic unsubscribe footer or header',async()=>{
 const s=server();await smtpSession(m,'secret',{to:'client@example.com',subject:'Re: Hello',body:'Hello',inReplyTo:'<parent@example.com>',unsubscribeUrl:'https://example.com/unsubscribe/token'});const data=s.writes.find(x=>x.startsWith('From:'));assert.match(data,/Reply-To: <hello@example.com>/);assert.match(data,/In-Reply-To: <parent@example.com>/);assert.doesNotMatch(data,/List-Unsubscribe|To stop these emails/);assert(s.writes.includes('EHLO example.com'));
});
