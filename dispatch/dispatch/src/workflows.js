import { getSettings } from './scheduler.js';
import { getAccount } from './google.js';
import { tenant } from './tenant.js';
import { json, bad, id, now, isEmail } from './util.js';
import { activeMailbox } from './mailboxes.js';
import { sendMail } from './gmail.js';

export function campaignPace(gap, cap) {
  gap=Number(gap);cap=Number(cap);
  if(!Number.isInteger(gap)||gap<1||gap>1440)throw Error('Interval must be a whole number from 1 to 1440 minutes');
  if(!Number.isInteger(cap)||cap<1||cap>500)throw Error('Daily limit must be between 1 and 500');
  return {gap,cap};
}
export async function sequenceSnapshot(env, steps) {
  if(!Array.isArray(steps)||!steps.length||steps.length>7)throw Error('Choose 1–7 sequence steps');
  const result=[];
  for(let i=0;i<steps.length;i++){
    const t=await env.DB.prepare(`SELECT * FROM (SELECT * FROM templates WHERE tenant_id = '${tenant(env)}') templates WHERE id = ?`).bind(steps[i].templateId).first();
    if(!t)throw Error('A selected letter no longer exists');
    const delay=i===0?0:Number(steps[i].delayDays);
    if(!Number.isInteger(delay)||delay<0||delay>90||(i>0&&delay<1))throw Error('Follow-up delays must be 1–90 days');
    result.push({templateId:t.id,name:t.name,subject:t.subject,body:t.body,delayDays:delay});
  }return result;
}
export async function createCampaign(env, body) {
  const {gap,cap}=campaignPace(body.gapMinutes??12,body.dailyCap??25);
  const ids=[...new Set(body.businessIds||[])];
  if(!ids.length||ids.length>1000)throw Error('Choose between 1 and 1000 recipients');
  const start=Number(body.startAt);if(!Number.isFinite(start)||start<now()-60000)throw Error('Choose a valid start time, now or later');
  let steps,tpl;
  if(body.sequenceId){const seq=await env.DB.prepare(`SELECT * FROM (SELECT * FROM sequences WHERE tenant_id = '${tenant(env)}') sequences WHERE id = ?`).bind(body.sequenceId).first();if(!seq)throw Error('Sequence not found');steps=JSON.parse(seq.steps_json);tpl={id:null,...steps[0]};}
  else {tpl=await env.DB.prepare(`SELECT * FROM (SELECT * FROM templates WHERE tenant_id = '${tenant(env)}') templates WHERE id = ?`).bind(body.templateId||'').first();if(!tpl)throw Error('Choose a letter or a sequence');}
  const sender=await activeMailbox(env,body.mailboxId)||(!body.mailboxId?await getAccount(env):null);
  if(!sender)throw Error('Connect a sender account first');
  if(sender.host&&!sender.verified_at)throw Error('Test the selected sender connection first');
  body={...body,mailboxId:typeof sender.id==='string'?sender.id:'oauth:google'};
  const recipients=[];
  for(const bid of ids){const b=await env.DB.prepare(`SELECT * FROM (SELECT * FROM businesses WHERE tenant_id = '${tenant(env)}') businesses WHERE id = ?`).bind(bid).first();if(b&&isEmail(b.email)&&!['unsubscribed','bounced','replied'].includes(b.status))recipients.push(b);}
  if(!recipients.length)throw Error('No eligible recipients. Replied, bounced and unsubscribed businesses are excluded.');
  const cid=id('c');const begin=Math.max(start,now());
  const statements=[env.DB.prepare(`INSERT INTO campaigns (tenant_id, id,name,template_id,status,start_at,gap_minutes,daily_cap,created_at,sequence_json,mailbox_id) VALUES ('${tenant(env)}', ?,?,?,?,?,?,?,?,?,?)`).bind(cid,String(body.name||'Untitled campaign').slice(0,200),tpl.id||null,'active',begin,gap,cap,now(),steps?JSON.stringify(steps):null,body.mailboxId||null)];
  for(let i=0;i<recipients.length;i++){const b=recipients[i];statements.push(env.DB.prepare(`INSERT INTO mails (tenant_id, id,campaign_id,business_id,to_email,to_name,subject,body,step,scheduled_at,status,created_at,mailbox_id) VALUES ('${tenant(env)}', ?,?,?,?,?,?,?,1,?,'queued',?,?)`).bind(id('m'),cid,b.id,b.email,b.owner||'',tpl.subject,tpl.body,begin+i*gap*60000,now(),body.mailboxId||null));statements.push(env.DB.prepare(`UPDATE businesses SET status='queued' WHERE tenant_id = '${tenant(env)}' AND (id=? AND status='new') `).bind(b.id));}
  // D1 limits bound parameters per statement; batch in bounded groups.
  for(let i=0;i<statements.length;i+=80)await env.DB.batch(statements.slice(i,i+80));
  return {id:cid,queued:recipients.length,excluded:ids.length-recipients.length};
}

export async function workflowApi(request, env, url, seg, body) {
 const method=request.method;
 if(seg[0]==='sequences'){
  if(method==='GET')return json((await env.DB.prepare(`SELECT * FROM (SELECT * FROM sequences WHERE tenant_id = '${tenant(env)}') sequences ORDER BY created_at DESC`).all()).results.map(s=>({...s,steps:JSON.parse(s.steps_json)})));
  if(['POST','PUT'].includes(method)){try{const steps=await sequenceSnapshot(env,body.steps);if(!String(body.name||'').trim())return bad('Name your sequence');if(method==='PUT'){await env.DB.prepare(`UPDATE sequences SET name=?,steps_json=? WHERE tenant_id = '${tenant(env)}' AND (id=?) `).bind(body.name,JSON.stringify(steps),seg[1]).run();return json({ok:true});}const sid=id('seq');await env.DB.prepare(`INSERT INTO sequences (tenant_id, id,name,steps_json,created_at) VALUES ('${tenant(env)}', ?,?,?,?)`).bind(sid,body.name,JSON.stringify(steps),now()).run();return json({id:sid});}catch(e){return bad(e.message);}}
  if(method==='DELETE'&&seg[1]){await env.DB.prepare(`DELETE FROM sequences WHERE tenant_id = '${tenant(env)}' AND (id=?) `).bind(seg[1]).run();return json({ok:true});}
 }
 if(seg[0]==='analytics'&&method==='GET'){
  const days=Number(url.searchParams.get('days')||30);const since=[7,30,90].includes(days)?now()-days*86400000:0;
  const campaign=url.searchParams.get('campaign')||'';
  const filter=' AND (? = \'\' OR m.campaign_id = ?)';
  const totals=await env.DB.prepare(`SELECT COUNT(CASE WHEN status='sent' THEN 1 END) sent,COUNT(CASE WHEN status='drafted' THEN 1 END) drafted,COUNT(CASE WHEN status='failed' THEN 1 END) failed,COUNT(CASE WHEN status='queued' THEN 1 END) queued,COUNT(DISTINCT CASE WHEN status='sent' THEN business_id END) reached FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') m WHERE COALESCE(sent_at,created_at)>=? ${filter}`).bind(since,campaign,campaign).first();
  const replies=await env.DB.prepare(`SELECT COUNT(DISTINCT r.business_id) replied,COUNT(DISTINCT CASE WHEN r.category='positive' THEN r.business_id END) positive FROM (SELECT * FROM replies WHERE tenant_id = '${tenant(env)}') r LEFT JOIN (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') m ON m.id=r.mail_id WHERE r.received_at>=? ${filter}`).bind(since,campaign,campaign).first();
  const daysRows=(await env.DB.prepare(`SELECT date(sent_at/1000,'unixepoch') day,COUNT(*) sent,SUM(CASE WHEN step>1 THEN 1 ELSE 0 END) followups FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') m WHERE status='sent' AND sent_at>=? ${filter} GROUP BY day ORDER BY day`).bind(since,campaign,campaign).all()).results;
  const campaigns=(await env.DB.prepare(`SELECT c.id,c.name,c.status,c.gap_minutes,c.daily_cap,COUNT(m.id) total,SUM(m.status='sent') sent,SUM(m.status='failed') failed FROM (SELECT * FROM campaigns WHERE tenant_id = '${tenant(env)}') c LEFT JOIN (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') m ON m.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`).all()).results;
  return json({totals:{...totals,...replies},days:daysRows,campaigns,tracking:{opens:false,clicks:false}});
 }
 if(seg[0]==='businesses'&&seg[2]==='outcome'&&method==='POST'){
  if(!['replied','bounced','unsubscribed','new'].includes(body.status))return bad('Invalid outcome');
  const statements=[env.DB.prepare(`UPDATE businesses SET status=? WHERE tenant_id = '${tenant(env)}' AND (id=?) `).bind(body.status,seg[1])];
  if(body.status!=='new')statements.push(env.DB.prepare(`UPDATE mails SET status='cancelled',error=? WHERE tenant_id = '${tenant(env)}' AND (business_id=? AND status='queued') `).bind('Stopped: '+body.status,seg[1]));
  if(body.status==='replied'){
   const biz=await env.DB.prepare(`SELECT * FROM (SELECT * FROM businesses WHERE tenant_id = '${tenant(env)}') businesses WHERE id=?`).bind(seg[1]).first();if(!biz)return bad('Business not found',404);
   const m=await env.DB.prepare(`SELECT id FROM (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') mails WHERE business_id=? ORDER BY created_at DESC LIMIT 1`).bind(seg[1]).first();
   statements.push(env.DB.prepare(`INSERT INTO replies (tenant_id, id,mail_id,business_id,from_email,subject,body,snippet,received_at,seen,category) VALUES ('${tenant(env)}', ?,?,?,?,?,?,?,?,0,?)`).bind(id('r'),m?.id||null,biz.id,biz.email,body.subject||'Recorded reply',String(body.message||'Reply recorded manually'),String(body.message||'').slice(0,200),now(),body.category||'uncategorized'));
  }await env.DB.batch(statements);return json({ok:true});
 }
 if(seg[0]==='replies'&&seg[1]&&seg[2]==='category'&&method==='POST'){
  if(!['uncategorized','positive','negative','question','out-of-office'].includes(body.category))return bad('Invalid category');
  await env.DB.prepare(`UPDATE replies SET category=? WHERE tenant_id = '${tenant(env)}' AND (id=?) `).bind(body.category,seg[1]).run();return json({ok:true});
 }
 if(seg[0]==='replies'&&seg[1]&&seg[2]==='respond'&&method==='POST'){
  const r=await env.DB.prepare(`SELECT r.*,m.mailbox_id FROM (SELECT * FROM replies WHERE tenant_id = '${tenant(env)}') r LEFT JOIN (SELECT * FROM mails WHERE tenant_id = '${tenant(env)}') m ON m.id=r.mail_id WHERE r.id=?`).bind(seg[1]).first();
  if(!r)return bad('Conversation not found',404);if(!String(body.message||'').trim())return bad('Write a reply');
  const biz=await env.DB.prepare(`SELECT email FROM (SELECT * FROM businesses WHERE tenant_id = '${tenant(env)}') businesses WHERE id=?`).bind(r.business_id).first();
  const settings=await getSettings(env);
  const midnight=new Date(new Date(now()+settings.tzOffset*60000).toISOString().slice(0,10)+'T00:00:00Z').getTime()-settings.tzOffset*60000;
  const count=await env.DB.prepare("SELECT COUNT(*) n FROM mails WHERE tenant_id=? AND sent_at>=? AND status IN('sent','drafted')").bind(tenant(env),midnight).first();
  if(count.n>=settings.dailyCap)return bad('Daily sending limit reached',429);
  const result=await sendMail(env,{to:biz?.email||r.from_email,subject:'Re: '+String(r.subject||'').replace(/^Re:\s*/i,''),body:body.message,mode:'send',mailboxId:r.mailbox_id||undefined,threadId:r.thread_id||undefined});
  await env.DB.prepare("INSERT INTO mails(tenant_id,id,business_id,to_email,subject,body,status,sent_at,created_at,mailbox_id,gmail_id,gmail_thread_id) VALUES(?,?,?,?,?,?,'sent',?,?,?,?,?)").bind(tenant(env),id('m'),r.business_id,biz?.email||r.from_email,'Re: '+(r.subject||''),String(body.message),now(),now(),r.mailbox_id||'oauth:google',result.id||null,result.threadId||null).run();
  await env.DB.prepare(`INSERT INTO logs (tenant_id, at,level,message) VALUES ('${tenant(env)}', ?,?,?)`).bind(now(),'info','Reply sent to '+(biz?.email||r.from_email)).run();
  return json({ok:true,id:result.id});
 }
 return null;
}
