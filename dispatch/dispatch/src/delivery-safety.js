import {tenant} from './tenant.js';
import {now,log} from './util.js';
export function isBounce(reply){return /(?:mailer-daemon|postmaster)@/i.test(reply.from||'')&&/(?:undeliver|delivery.{0,30}(?:fail)|address not found|status:\s*5\.)/i.test((reply.subject||'')+' '+(reply.body||''));}
export async function enforceDeliverySafety(env){
 const result=await env.DB.prepare(`UPDATE campaigns SET status='paused',pause_reason='Auto-paused: 2 or more emails failed, were deferred, or bounced. Check sender and recipients before resuming.' WHERE tenant_id=? AND status='active' AND (SELECT COUNT(*) FROM delivery_incidents d WHERE d.tenant_id=campaigns.tenant_id AND d.campaign_id=campaigns.id AND d.recorded_at>campaigns.safety_reset_at)>=2 RETURNING id`).bind(tenant(env)).all();
 for(const c of result.results||[])await log(env,'warn','Campaign '+c.id+' auto-paused after 2 delivery incidents.');
}
export async function recordDeliveryIncident(env,mail,kind){
 if(!mail?.campaign_id)return;
 await env.DB.prepare('INSERT INTO delivery_incidents(tenant_id,campaign_id,mail_id,kind,recorded_at) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,campaign_id,mail_id) DO UPDATE SET kind=excluded.kind,recorded_at=excluded.recorded_at WHERE delivery_incidents.recorded_at <= (SELECT safety_reset_at FROM campaigns WHERE tenant_id=excluded.tenant_id AND id=excluded.campaign_id)').bind(tenant(env),mail.campaign_id,mail.id,kind,now()).run();
 await enforceDeliverySafety(env);
}
export async function recordBusinessBounce(env,businessId){
 const mails=await env.DB.prepare("SELECT id,campaign_id FROM mails WHERE tenant_id=? AND business_id=? AND status IN('sent','failed') AND campaign_id IS NOT NULL ORDER BY created_at DESC").bind(tenant(env),businessId).all();
 const seen=new Set();for(const m of mails.results||[])if(!seen.has(m.campaign_id)){seen.add(m.campaign_id);await recordDeliveryIncident(env,m,'bounce');}
}
