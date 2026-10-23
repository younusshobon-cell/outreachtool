import {connect} from 'cloudflare:sockets';
import {validateMailbox} from './smtp.js';
const enc=new TextEncoder(),dec=new TextDecoder();
export function validateImapHost(host){return validateMailbox({email:'check@example.com',host,port:465}).host;}
const quote=v=>'"'+String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
// Read-only IMAP: EXAMINE and BODY.PEEK never mark messages read or alter the mailbox.
export async function readInbox({host,username,password,cursor=0,validity='',onMessage=async()=>{},onProgress=async()=>{},testOnly=false},open=connect){
 validateImapHost(host);if(/[\r\n\0]/.test(username+password))throw Error('Invalid IMAP credentials');
 const socket=open({hostname:host,port:993},{secureTransport:'on'});socket.closed.catch(()=>{});
 const timer=setTimeout(()=>void socket.close().catch(()=>{}),25000);
 const reader=socket.readable.getReader(),writer=socket.writable.getWriter();let buf=new Uint8Array(),seq=0;
 async function more(){const r=await reader.read();if(r.done)throw Error('IMAP connection closed or timed out');const n=new Uint8Array(buf.length+r.value.length);n.set(buf);n.set(r.value,buf.length);buf=n;if(buf.length>1100000)throw Error('IMAP response exceeds size limit');}
 async function line(){while(true){for(let i=0;i<buf.length-1;i++)if(buf[i]===13&&buf[i+1]===10){const s=dec.decode(buf.slice(0,i));buf=buf.slice(i+2);return s;}if(buf.length>65536)throw Error('IMAP line exceeds size limit');await more();}}
 async function literal(n){if(n>1048576)throw Error('IMAP message exceeds size limit');while(buf.length<n)await more();const data=buf.slice(0,n);buf=buf.slice(n);return data;}
 async function cmd(command){const tag='A'+(++seq);await writer.write(enc.encode(tag+' '+command+'\r\n'));const lines=[],literals=[];for(let i=0;i<2000;i++){const l=await line();if(l.startsWith(tag+' ')){if(!l.startsWith(tag+' OK'))throw Error('IMAP request rejected. Check incoming host, app password and IMAP access.');return {lines,literals};}lines.push(l);const m=l.match(/\{(\d+)\}$/);if(m)literals.push(await literal(Number(m[1])));}throw Error('IMAP response too long');}
 try{await socket.opened;const greeting=await line();if(!greeting.startsWith('* OK'))throw Error('IMAP service unavailable');await cmd('LOGIN '+quote(username)+' '+quote(password));const selected=await cmd('EXAMINE INBOX');const current=selected.lines.join(' ').match(/UIDVALIDITY (\d+)/i)?.[1];if(!current)throw Error('IMAP UIDVALIDITY missing');if(testOnly)return {validity:current};if(validity!==current)cursor=0;
 const date=new Date(Date.now()-30*86400000);const since=`${date.getUTCDate()}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getUTCMonth()]}-${date.getUTCFullYear()}`;
 const search=await cmd(`UID SEARCH UID ${Number(cursor)+1}:* SINCE ${since}`);const uids=search.lines.filter(l=>l.startsWith('* SEARCH')).flatMap(l=>l.slice(8).trim().split(/\s+/).map(Number)).filter(n=>Number.isSafeInteger(n)&&n>cursor).sort((a,b)=>a-b).slice(0,20);
 for(const uid of uids){const r=await cmd(`UID FETCH ${uid} (UID BODY.PEEK[]<0.1048576>)`);if(r.literals.length)await onMessage(r.literals[0],uid,current);cursor=uid;await onProgress(cursor,current);}
 return {cursor,validity:current,processed:uids.length};
 }finally{clearTimeout(timer);await socket.close().catch(()=>{});}
}
