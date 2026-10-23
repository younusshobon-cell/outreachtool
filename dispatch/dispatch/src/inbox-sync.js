import PostalMime from 'postal-mime';
import {readInbox,validateImapHost} from './imap.js';
import {unseal,activeMailbox} from './mailboxes.js';
import {tenant} from './tenant.js';
import {digest} from './accounts.js';
import {recordDeliveryIncident} from './delivery-safety.js';
import {suppress} from './suppression.js';
const key=id=>'imap:'+id;
export async function syncState(env,id){const r=await env.DB.prepare('SELECT value FROM settings WHERE tenant_id=? AND key=?').bind(tenant(env),key(id)).first();return r?JSON.parse(r.value):null;}
async function save(env,id,state){await env.DB.prepare('INSERT INTO settings(tenant_id,key,value) VALUES(?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value').bind(tenant(env),key(id),JSON.stringify(state)).run();}
export async function connectInbox(env,id,host){const m=await activeMailbox(env,id);if(!m?.host)throw Error('SMTP mailbox not found');host=validateImapHost(host);const r=await readInbox({host,username:m.username,password:await unseal(env,m.password_enc),testOnly:true});const previous=await syncState(env,id);await save(env,id,{host,enabled:true,cursor:previous?.host===host?previous.cursor||0:0,validity:r.validity,lastSync:previous?.lastSync||null,error:null});return {ok:true};}
export async function ingestReply(env,mailbox,raw,uid,validity){
 const parsed=await PostalMime.parse(raw);const from=(parsed.from?.address||'').toLowerCase();if(!from||from===mailbox.email.toLowerCase())return 0;
 const replyId='imap_'+await digest(mailbox.id+':'+validity+':'+uid);if(await env.DB.prepare('SELECT id FROM replies WHERE tenant_id=? AND id=?').bind(tenant(env),replyId).first())return 0;
 const refs=(String(parsed.inReplyTo||'')+' '+String(parsed.references||'')).match(/<[^<>\s]+>/g)||[];
 let mail=null;for(const ref of refs.slice(-20).reverse()){mail=await env.DB.prepare("SELECT * FROM mails WHERE tenant_id=? AND mailbox_id=? AND gmail_id=? AND status='sent' ORDER BY sent_at DESC LIMIT 1").bind(tenant(env),mailbox.id,ref).first();if(mail)break;}
 const receivedAt=Date.parse(parsed.date)||Date.now();
 if(!mail)mail=await env.DB.prepare("SELECT * FROM mails WHERE tenant_id=? AND mailbox_id=? AND lower(to_email)=? AND status='sent' AND sent_at<=? ORDER BY sent_at DESC LIMIT 1").bind(tenant(env),mailbox.id,from,receivedAt+300000).first();
 if(!mail)return 0;
 if(parsed.messageId && await env.DB.prepare('SELECT r.id FROM replies r JOIN mails m ON m.id=r.mail_id AND m.tenant_id=r.tenant_id WHERE r.tenant_id=? AND m.mailbox_id=? AND r.thread_id=?').bind(tenant(env),mailbox.id,parsed.messageId).first())return 0;
 const body=String(parsed.text||parsed.html?.replace(/<[^>]*>/g,' ')||'').slice(0,100000),subject=parsed.subject||'';
 if(/mailer-daemon|postmaster/i.test(from)&&/undeliver|delivery.*fail|returned mail|failure notice/i.test(subject+' '+body)){
 await suppress(env,mail.to_email,'bounced');await env.DB.prepare("UPDATE businesses SET status='bounced' WHERE tenant_id=? AND id=?").bind(tenant(env),mail.business_id).run();await env.DB.prepare("UPDATE mails SET status='failed',error='Delivery notification: bounced' WHERE tenant_id=? AND id=?").bind(tenant(env),mail.id).run();await recordDeliveryIncident(env,mail,'bounce');return 0;}
 await env.DB.batch([
 env.DB.prepare('INSERT OR IGNORE INTO replies(tenant_id,id,mail_id,business_id,thread_id,from_email,subject,snippet,body,received_at,seen) VALUES(?,?,?,?,?,?,?,?,?,?,0)').bind(tenant(env),replyId,mail.id,mail.business_id,parsed.messageId||null,from,subject,body.slice(0,300),body,receivedAt),
 env.DB.prepare("UPDATE businesses SET status='replied' WHERE tenant_id=? AND id=?").bind(tenant(env),mail.business_id),
 env.DB.prepare("UPDATE mails SET status='cancelled',error='cancelled — they replied' WHERE tenant_id=? AND business_id=? AND status='queued'").bind(tenant(env),mail.business_id)]);return 1;
}
export async function pollImap(env){
 const rows=await env.DB.prepare("SELECT key,value FROM settings WHERE tenant_id=? AND key LIKE 'imap:%'").bind(tenant(env)).all();let found=0;const errors=[];
 for(const row of rows.results){const state=JSON.parse(row.value);if(!state.enabled)continue;const id=row.key.slice(5),mailbox=await activeMailbox(env,id);if(!mailbox?.host)continue;
 try{const result=await readInbox({host:state.host,username:mailbox.username,password:await unseal(env,mailbox.password_enc),cursor:state.cursor,validity:state.validity,onMessage:async(raw,uid,v)=>{found+=await ingestReply(env,mailbox,raw,uid,v);},onProgress:async(cursor,validity)=>{Object.assign(state,{cursor,validity});await save(env,id,state);}});Object.assign(state,result,{lastSync:Date.now(),error:null});}
 catch(e){state.error=String(e.message).slice(0,240);errors.push(mailbox.email+': '+state.error);}
 await save(env,id,state);
 }return {found,errors};
}
