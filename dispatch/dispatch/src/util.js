import { tenant } from './tenant.js';
// Small helpers shared across the Worker.

export const now = () => Date.now();

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function bad(message, status = 400) {
  return json({ error: message }, status);
}

export function id(prefix = '') {
  const s = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return prefix ? `${prefix}_${s}` : s;
}

// base64url for Gmail's `raw` field
export function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// RFC 2047 encoded-word, so non-ASCII subjects survive.
export function encodeHeader(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}?=`;
}

/**
 * Replace {{token}} and {{token|fallback}} in a string.
 * Known tokens: business, owner, first_name, city, website, domain, email,
 *               sender, sender_name, signature
 */
export function personalise(text, biz = {}, extra = {}) {
  if (!text) return '';
  const owner = (biz.owner || '').trim();
  const first = owner ? owner.split(/\s+/)[0] : '';
  const site = (biz.website || '').trim();
  const domain = site.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
  const map = {
    business: biz.name || '',
    owner,
    first_name: first,
    city: biz.city || '',
    website: site,
    domain,
    email: biz.email || '',
    notes: biz.notes || '',
    ...extra,
  };
  return spinText(String(text),biz.email||biz.id||'sample').replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (_m, key, fallback) => {
    const v = Object.hasOwn(map,String(key).toLowerCase())?map[String(key).toLowerCase()]:undefined;
    if (v !== undefined && String(v).trim() !== '') return String(v);
    return (fallback || '').trim();
  });
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export async function log(env, level, message) {
  try {
    await env.DB.prepare(`INSERT INTO logs (tenant_id, at, level, message) VALUES ('${tenant(env)}', ?, ?, ?)`)
      .bind(now(), level, String(message).slice(0, 1000))
      .run();
  } catch {
    /* logging must never break a send */
  }
}

// Deterministic per recipient and source: previews and delivery use the same variation.
export function spinText(text,seed='sample') {
 return String(text).replace(/\[\[([^\[\]\n]+)\]\]/g,(match,inner,offset)=>{
  const options=inner.split('|').map(s=>s.trim());if(options.length<2||options.some(s=>!s))return match;
  let hash=2166136261;for(const c of seed+':'+offset+':'+inner)hash=Math.imul(hash^c.charCodeAt(0),16777619);
  return options[(hash>>>0)%options.length];
 });
}
export function inspectCopy(subject,body,biz={},extra={}) {
 const source=String(subject||'')+'\n'+String(body||''),missing=new Set();
 for(const m of source.matchAll(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi))if(!personalise(m[0],biz,extra).trim())missing.add(m[1].toLowerCase());
 const renderedSubject=personalise(subject,biz,extra),renderedBody=personalise(body,biz,extra);
 const warnings=[];const words=renderedBody.trim().split(/\s+/).filter(Boolean).length;
 if(!renderedSubject.trim())warnings.push('Subject is empty.');
 if(renderedSubject.length>70)warnings.push('Subject is longer than 70 characters; consider shortening it.');
 if(words>180)warnings.push('Body exceeds 180 words; consider a shorter first touch.');
 if((renderedBody.match(/https?:\/\//g)||[]).length>2)warnings.push('More than two links; consider one clear next step.');
 if(/!!!|\b(?:guaranteed|act now|100% free)\b/i.test(renderedBody))warnings.push('Review promotional wording or repeated exclamation marks.');
 if(/\[\[|\]\]/.test(renderedSubject+' '+renderedBody))warnings.push('Check variation syntax: [[Hi|Hello]] with non-empty choices.');
 if(missing.size)warnings.push('Missing values: '+[...missing].join(', ')+'. Add data or a fallback such as {{first_name|there}}.');
 return {subject:renderedSubject,body:renderedBody,missing:[...missing],warnings,words,subjectLength:renderedSubject.length};
}
