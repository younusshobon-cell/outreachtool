/* OutreachLead — front end. Plain JS, no build step. */

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(kid));
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = { view: 'campaigns', state: null, businesses: [], templates: [], campaigns: [], mails: [], replies: [], filter: 'queued' };

/* ---------- plumbing ---------- */

async function api(path, options = {}) {
  const res = await fetch(`/api/${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function toast(message, bad = false) {
  const t = el('div', { class: `toast${bad ? ' bad' : ''}` }, message);
  $('toast').append(t);
  setTimeout(() => t.remove(), 4200);
}

const fmt = (ts) => {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const rel = (ts) => {
  if (!ts) return '';
  const diff = Number(ts) - Date.now();
  const mins = Math.round(diff / 60000);
  if (Math.abs(mins) < 60) return mins >= 0 ? `in ${mins}m` : `${-mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (Math.abs(hrs) < 48) return hrs >= 0 ? `in ${hrs}h` : `${-hrs}h ago`;
  return `${Math.round(hrs / 24)}d`;
};
const toLocalInput = (ts) => {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function modal(title, bodyNode, footNodes = []) {
  $('modal-title').textContent = title;
  $('modal-body').replaceChildren(bodyNode);
  $('modal-foot').replaceChildren(...footNodes);
  $('modal').hidden = false;
}
const closeModal = () => { $('modal').hidden = true; };
$('modal-x').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

/* ---------- shell ---------- */

async function refreshState() {
  S.state = await api('state');
  const c = S.state.counts || {};
  $('m-queued').textContent = c.queued || 0;
  $('m-sent').textContent = c.sent || 0;
  $('m-replies').textContent = c.unread || 0;
  $('t-queued').textContent = c.queued || 0;
  $('t-biz').textContent = c.businesses || 0;
  $('t-tpl').textContent = c.templates || 0;
  $('t-camp').textContent = c.campaigns || 0;
  const rep = $('t-replies');
  rep.textContent = c.unread || 0;
  rep.classList.toggle('hot', (c.unread || 0) > 0);

  const running = S.state.settings.running;
  $('runchip').classList.toggle('on', running);
  $('runlabel').textContent = running
    ? (S.state.inWindow ? (S.state.settings.mode === 'draft' ? 'drafting' : 'sending') : 'waiting for window')
    : 'paused';
  $('btn-run').textContent = running ? 'Pause' : 'Start';

  const g = $('gmail-state');
  g.innerHTML = S.state.account
    ? `<span class="dot ok"></span> ${esc(S.state.account.email)}`
    : '<span class="dot bad"></span> No sender connected';
  $('next-due').textContent = S.state.nextDueAt ? `next: ${fmt(S.state.nextDueAt)}` : '';
}

const views = {};

let renderVersion = 0;
async function render() {
  const version = ++renderVersion;
  for (const b of document.querySelectorAll('#rail button[data-view]')) {
    b.setAttribute('aria-current', b.dataset.view === S.view ? 'true' : 'false');
  }
  const pane = $('pane');
  pane.replaceChildren(el('div', { class: 'wrap' }, el('p', { class: 'lede' }, 'Loading…')));
  try {
    const node = await views[S.view]();
    if (version !== renderVersion) return;
    pane.replaceChildren(el('div', { class: 'wrap' }, node));
    pane.scrollTop = 0;
  } catch (e) {
    if (version !== renderVersion) return;
    pane.replaceChildren(el('div', { class: 'wrap' }, el('div', { class: 'alert' }, el('b', {}, 'Could not load this view'), el('p', {}, e.message))));
  }
}

function go(view) { S.view = view; history.replaceState({},'', '#'+view); render(); }

document.querySelectorAll('#rail button[data-view]').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));

$('btn-run').addEventListener('click', async () => {
  const next = !S.state.settings.running;
  if (next && !S.state.account && !(S.state.mailboxes||[]).some(m=>m.verified_at)) return toast('Add and activate a mailbox in Setup first.', true);
  if (next && !confirm('Start sending queued emails from active campaigns? Sending windows and daily limits apply.')) return;
  await api('settings', { method: 'POST', body: next ? { running: true, mode: 'send' } : { running: false } });
  await refreshState();
  toast(next ? 'Scheduler started.' : 'Scheduler paused.');
  if (S.view === 'outbox') render();
});

$('btn-tick').addEventListener('click', async () => {
  $('btn-tick').disabled = true;
  try {
    const r = await api('tick', { method: 'POST', body: { force: true } });
    showSendResult(r);
    await refreshState();
    render();
  } catch (e) { toast(e.message, true); }
  $('btn-tick').disabled = false;
});

/* ---------- outbox ---------- */

const STATUS_TAG = {
  queued: 'tag amber', sending: 'tag amber', sent: 'tag go', drafted: 'tag ac',
  failed: 'tag red', cancelled: 'tag', replied: 'tag go',
};

views.outbox = async () => {
  S.mails = await api(`mails?status=${S.filter}${S.campaignFilter ? '&campaign='+encodeURIComponent(S.campaignFilter) : ''}`);
  const head = el('div', { class: 'viewhead' },
    el('div', {}, el('h2', {}, 'Outbox'), el('p', { class: 'lede' }, 'Everything queued, sent and failed. The cron trigger works through this list on its own.')),
    el('div', { class: 'push' }, el('button', { class: 'btn primary', onclick: () => go('newcampaign') }, 'New campaign')),
  );

  const tabs = el('div', { class: 'tabs' },
    ...[['queued', 'Queued'], ['sent', 'Sent'], ['failed', 'Failed'], ['cancelled', 'Cancelled'], ['all', 'Everything']].map(([k, label]) =>
      el('button', { 'aria-current': S.filter === k ? 'true' : 'false', onclick: () => { S.filter = k; render(); } }, label)),
  );

  const notes = [];
  if (!S.state.account) {
    notes.push(el('div', { class: 'alert' }, el('b', {}, 'No sending mailbox is connected'), el('p', {}, 'Add an SMTP mailbox or connect Gmail in Setup.')));
  } else if (S.state.settings.mode === 'draft') {
    notes.push(el('div', { class: 'note' }, el('b', {}, 'Draft mode. '), S.state.smtpActive ? 'SMTP sending is paused. Choose Send for real in Setup when ready.' : 'Mail is written into your Gmail drafts instead of being sent. Switch to send mode in Setup once you trust the copy.'));
  }

  if (!S.mails.length) {
    return el('div', {}, head, tabs, ...notes, el('div', { class: 'empty' }, el('b', {}, 'Nothing here'), 'Add businesses, write a letter, then schedule a campaign.'));
  }

  const rows = S.mails.map((m) => el('tr', {},
    el('td', {}, el('div', { class: 'biz' }, m.biz_name || m.to_email), el('div', { class: 'sub' }, `${m.to_email}${m.city ? ` · ${m.city}` : ''}`)),
    el('td', {}, el('div', {}, m.subject || '—'), m.step > 1 ? el('div', { class: 'sub' }, 'follow-up') : null, m.error ? el('div', { class: 'sub' }, m.error) : null),
    el('td', { class: 'num' }, fmt(m.sent_at || m.scheduled_at), el('div', { class: 'sub' }, rel(m.sent_at || m.scheduled_at))),
    el('td', {}, el('span', { class: STATUS_TAG[m.status] || 'tag' }, m.status)),
    el('td', { class: 'act' },
      el('button', { class: 'btn sm', onclick: () => showMail(m) }, 'View'),
      ' ',
      ['queued', 'failed'].includes(m.status)
        ? el('button', { class: 'btn sm', onclick: async (e) => { const btn=e.currentTarget; if(btn.disabled)return; btn.disabled=true; try { const r=await api(`mails/${m.id}/now`, { method: 'POST' }); showSendResult(r); await refreshState(); render(); } catch (e) { toast(e.message, true); } finally {btn.disabled=false;} } }, 'Send now')
        : null,
      ' ',
      ['queued', 'failed'].includes(m.status)
        ? el('button', { class: 'btn sm danger', onclick: async () => { await api(`mails/${m.id}`, { method: 'DELETE' }); toast('Cancelled.'); await refreshState(); render(); } }, 'Cancel')
        : null,
    ),
  ));

  const table = el('div', { class: 'panel tight' }, el('div', { class: 'tablescroll' },
    el('table', { class: 'ledger' },
      el('thead', {}, el('tr', {}, el('th', {}, 'To'), el('th', {}, 'Subject'), el('th', {}, 'When'), el('th', {}, 'Status'), el('th', {}))),
      el('tbody', {}, ...rows))));

  return el('div', {}, head, tabs, ...notes, table);
};

function showMail(m) {
  modal(m.biz_name || m.to_email,
    el('div', { class: 'envelope' },
      el('div', { class: 'hd' },
        el('div', { class: 'to' }, `To: ${m.to_email}`),
        el('div', { class: 'sj' }, m.subject || '(no subject)')),
      el('pre', {}, m.body || '')),
    [el('button', { class: 'btn', onclick: closeModal }, 'Close'),
     el('span', { class: 'sp' }, `${m.status} · ${fmt(m.sent_at || m.scheduled_at)}`)]);
}

/* ---------- replies ---------- */

views.replies = async () => {
  S.replies = await api('replies');
  const head = el('div', { class: 'viewhead' },
    el('div', {}, el('h2', {}, 'Replies'), el('p', { class: 'lede' }, 'Anyone who wrote back. A reply cancels their pending follow-up automatically.')),
    el('div', { class: 'push' }, el('button', {
      class: 'btn', onclick: async () => { const r = await api('replies/poll', { method: 'POST' }); toast(`${r.found} new ${r.found === 1 ? 'reply' : 'replies'}.`); render(); refreshState(); },
    }, 'Check now')),
  );

  if (!S.replies.length) return el('div', {}, head, el('div', { class: 'empty' }, el('b', {}, 'No replies yet'), 'OutreachLead checks your sent threads on every scheduler run.'));

  const cards = S.replies.map((r) => el('div', { class: 'panel' },
    el('div', { style: 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap' },
      el('h3', { class: 'sec', style: 'margin:0;flex:1' }, r.biz_name || r.from_email),
      !r.seen ? el('span', { class: 'tag red' }, 'new') : null,
      el('span', { class: 'tag' }, fmt(r.received_at))),
    el('p', { class: 'lede', style: 'margin:6px 0 10px' }, `${r.from_email} — ${r.subject || ''}`),
    el('div', { class: 'envelope' }, el('pre', {}, (r.body || r.snippet || '').slice(0, 4000))),
    el('div', { style: 'margin-top:10px;display:flex;gap:8px' },
      !r.seen ? el('button', { class: 'btn sm', onclick: async () => { await api(`replies/${r.id}/seen`, { method: 'POST' }); refreshState(); render(); } }, 'Mark read') : null,
      el('a', { class: 'btn sm', href: `https://mail.google.com/mail/u/0/#inbox/${r.thread_id}`, target: '_blank', rel: 'noopener' }, 'Open in Gmail')),
  ));

  return el('div', {}, head, ...cards);
};

/* ---------- businesses ---------- */

views.businesses = async () => {
  S.businesses = await api('businesses');
  const head = el('div', { class: 'viewhead' },
    el('div', {}, el('h2', {}, 'Businesses'), el('p', { class: 'lede' }, 'Your prospect list. Name, owner and city feed the personalisation tokens.')),
    el('div', { class: 'push' },
      el('button', { class: 'btn', onclick: importSheet }, 'Import CSV'),
      el('button', { class: 'btn primary', onclick: () => editBusiness(null) }, 'Add business')),
  );

  if (!S.businesses.length) {
    return el('div', {}, head, el('div', { class: 'empty' }, el('b', {}, 'No businesses yet'), 'Add one by hand, or paste a CSV with columns like business, owner, email, website, city.'));
  }

  const search = el('input', { placeholder: 'Filter by name, email or city…', oninput: (e) => {
    const q = e.target.value.toLowerCase();
    for (const tr of document.querySelectorAll('#biz-body tr')) {
      tr.style.display = tr.dataset.hay.includes(q) ? '' : 'none';
    }
  } });

  const body = el('tbody', { id: 'biz-body' }, ...S.businesses.map((b) => el('tr', {
    'data-hay': `${b.name} ${b.email} ${b.city} ${b.owner}`.toLowerCase(),
  },
    el('td', {}, el('div', { class: 'biz' }, b.name || '—'), el('div', { class: 'sub' }, b.website || '')),
    el('td', {}, b.owner || '—'),
    el('td', {}, el('div', {}, b.email), el('div', { class: 'sub' }, b.city || '')),
    el('td', {}, el('span', { class: b.status === 'replied' ? 'tag go' : b.status === 'contacted' ? 'tag ac' : 'tag' }, b.status)),
    el('td', { class: 'act' },
      el('button', { class: 'btn sm', onclick: () => editBusiness(b) }, 'Edit'), ' ',
      el('button', { class: 'btn sm', onclick: () => recordOutcome(b) }, 'Outcome'), ' ',
      el('button', { class: 'btn sm danger', onclick: async () => { if (!confirm(`Remove ${b.name || b.email}?`)) return; await api(`businesses/${b.id}`, { method: 'DELETE' }); toast('Removed.'); refreshState(); render(); } }, 'Delete')),
  )));

  return el('div', {}, head,
    el('div', { class: 'toolbar' }, search),
    el('div', { class: 'panel tight' }, el('div', { class: 'tablescroll' },
      el('table', { class: 'ledger' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Business'), el('th', {}, 'Owner'), el('th', {}, 'Email'), el('th', {}, 'Status'), el('th', {}))),
        body))));
};

function editBusiness(b) {
  const f = {};
  const field = (key, label, value = '', type = 'text') => {
    const input = el('input', { type, value });
    f[key] = input;
    return el('div', { class: 'field' }, el('label', {}, label), input);
  };
  const form = el('div', {},
    field('name', 'Business name', b?.name || ''),
    field('owner', 'Owner name', b?.owner || ''),
    field('email', 'Official email', b?.email || '', 'email'),
    field('website', 'Website', b?.website || ''),
    field('city', 'City', b?.city || ''),
    field('service_list', 'Service / business list', b?.service_list || ''),
    el('div', { class: 'field' }, el('label', {}, 'Notes'), (f.notes = el('textarea', {}, b?.notes || ''))),
  );
  modal(b ? 'Edit business' : 'Add business', form, [
    el('button', { class: 'btn primary', onclick: async () => {
      const payload = Object.fromEntries(Object.entries(f).map(([k, n]) => [k, n.value.trim()]));
      payload.status = b?.status || 'new';
      try {
        if (b) await api(`businesses/${b.id}`, { method: 'PUT', body: payload });
        else await api('businesses', { method: 'POST', body: payload });
        closeModal(); toast('Saved.'); refreshState(); render();
      } catch (e) { toast(e.message, true); }
    } }, 'Save'),
    el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
  ]);
}

async function importSheet() {
  const picker=await servicePicker();
  const ta = el('textarea', { class: 'mono', rows: 12, placeholder: 'business,owner,email,website,city\nRoyal Dental,Dr. Karim,hello@royaldental.com,royaldental.com,Feni' });
  modal('Import businesses from CSV',
    el('div', {},
      el('p', { class: 'lede' }, 'Choose or create a service list, then upload or paste CSV. Columns: business, owner, email, website, city, notes. Duplicate emails within this list are skipped.'),
      picker.node, ta),
    [el('button', { class: 'btn primary', onclick: async () => {
      try {
        const r = await api('businesses/import', { method: 'POST', body: { csv: ta.value, service_list: picker.input.value } });
        closeModal(); toast(`${r.added} added, ${r.skipped} skipped.`); refreshState(); render();
      } catch (e) { toast(e.message, true); }
    } }, 'Import'),
     el('button', { class: 'btn', onclick: closeModal }, 'Cancel')]);
}

/* ---------- templates ---------- */

const TOKENS = ['business', 'owner', 'first_name', 'city', 'website', 'domain', 'email', 'sender_name'];

views.templates = async () => {
  S.templates = await api('templates');
  const head = el('div', { class: 'viewhead' },
    el('div', {}, el('h2', {}, 'Letters'), el('p', { class: 'lede' }, 'Write once, personalise per recipient. A letter can carry its own follow-up.')),
    el('div', { class: 'push' }, el('button', { class: 'btn primary', onclick: () => editTemplate(null) }, 'New letter')),
  );

  if (!S.templates.length) {
    return el('div', {}, head, el('div', { class: 'empty' }, el('b', {}, 'No letters yet'), `Use tokens like {{business}} and {{first_name|there}} inside the subject and body.`));
  }

  const cards = S.templates.map((t) => el('div', { class: 'panel' },
    el('div', { style: 'display:flex;gap:10px;align-items:baseline;flex-wrap:wrap' },
      el('h3', { class: 'sec', style: 'margin:0;flex:1' }, t.name),
      t.followup_days > 0 ? el('span', { class: 'tag ac' }, `follow-up +${t.followup_days}d`) : el('span', { class: 'tag' }, 'no follow-up')),
    el('p', { class: 'lede', style: 'margin:6px 0 10px' }, t.subject),
    el('div', { class: 'envelope' }, el('pre', {}, (t.body || '').slice(0, 700))),
    el('div', { style: 'margin-top:10px;display:flex;gap:8px' },
      el('button', { class: 'btn sm', onclick: () => editTemplate(t) }, 'Edit'),
      el('button', { class: 'btn sm', onclick: () => previewTemplate(t) }, 'Preview & check'),
      el('button', { class: 'btn sm', onclick: () => editTemplate({...t,id:null,name:t.name+' (copy)'}) }, 'Duplicate'),
      el('button', { class: 'btn sm danger', onclick: async () => { if (!confirm(`Delete "${t.name}"?`)) return; await api(`templates/${t.id}`, { method: 'DELETE' }); toast('Deleted.'); refreshState(); render(); } }, 'Delete')),
  ));

  return el('div', {}, head, ...cards);
};

function editTemplate(t) {
  const name = el('input', { value: t?.name || '' });
  const subject = el('input', { value: t?.subject || '' });
  const body = el('textarea', { class: 'mono', rows: 12 }, t?.body || '');
  const fSubject = el('input', { value: t?.followup_subject || '' });
  const fBody = el('textarea', { class: 'mono', rows: 7 }, t?.followup_body || '');
  const fDays = el('input', { type: 'number', min: 0, max: 60, value: t?.followup_days ?? 0 });

  let focused = body;
  for (const n of [subject, body, fSubject, fBody]) n.addEventListener('focus', () => { focused = n; });

  const tokenBar = el('div', { class: 'tokens' }, ...TOKENS.map((tok) =>
    el('button', { type: 'button', onclick: () => {
      const insert = tok==='business'?'{Business}':`{{${tok}}}`;
      const start = focused.selectionStart ?? focused.value.length;
      focused.value = focused.value.slice(0, start) + insert + focused.value.slice(focused.selectionEnd ?? start);
      focused.focus();
      focused.selectionStart = focused.selectionEnd = start + insert.length;
    } }, tok==='business'?'{Business}':`{{${tok}}}`)));

  const form = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Letter name'), name),
    el('div', { class: 'field' }, el('label', {}, 'Subject'), subject),
    el('div', { class: 'field' }, el('label', {}, 'Body'), body, tokenBar,
      el('p', { class: 'hint' }, 'Business greeting: Hi {Business} Team, — owner name is not required. Use {Business} anywhere in your subject or body. Fallback: {{first_name|there}}. Message variations: [[Hi|Hello|Hey]]. Preview & check before sending.')),
    el('h3', { class: 'sec', style: 'margin-top:18px' }, 'Follow-up'),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', {}, 'Send after (days, 0 = off)'), fDays),
      el('div', { class: 'field', style: 'flex:3 1 260px' }, el('label', {}, 'Follow-up subject (blank = Re: original)'), fSubject)),
    el('div', { class: 'field' }, el('label', {}, 'Follow-up body'), fBody),
  );

  modal(t ? 'Edit letter' : 'New letter', form, [
    el('button', { class: 'btn primary', onclick: async () => {
      const payload = {
        name: name.value.trim() || 'Untitled',
        subject: subject.value.trim(),
        body: body.value,
        followup_subject: fSubject.value.trim(),
        followup_body: fBody.value,
        followup_days: Number(fDays.value || 0),
      };
      try {
        if (t?.id) await api(`templates/${t.id}`, { method: 'PUT', body: payload });
        else await api('templates', { method: 'POST', body: payload });
        closeModal(); toast('Saved.'); refreshState(); render();
      } catch (e) { toast(e.message, true); }
    } }, 'Save'),
    el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
  ]);
}

async function previewTemplate(t) {
  const biz = S.businesses[0] || await api('businesses').then((b) => b[0]).catch(() => null);
  const sample = biz || { name: 'Royal Dental', owner: 'Karim Rahman', city: 'Feni', website: 'royaldental.com', email: 'hello@royaldental.com' };
  const r = await api('preview', { method: 'POST', body: { subject: t.subject, body: t.body, business: sample } });
  modal(`Preview — ${t.name}`,
    el('div', { class: 'envelope' },
      el('div', { class: 'hd' }, el('div', { class: 'to' }, `To: ${sample.email}`), el('div', { class: 'sj' }, r.subject)),
      el('pre', {}, r.body)),
    [el('button', { class: 'btn', onclick: closeModal }, 'Close'), el('span', { class: 'sp' }, `sample: ${sample.name}`)]);
}

/* ---------- campaigns ---------- */

views.campaigns = async () => {
  S.campaigns = await api('campaigns');
  const head = el('div', { class: 'viewhead' },
    el('div', {}, el('h2', {}, 'Campaigns'), el('p', { class: 'lede' }, 'A letter plus a list plus a start time. OutreachLead spaces the sends out for you.')),
    el('div', { class: 'push' }, el('button', { class: 'btn primary', onclick: newCampaign }, 'Schedule a campaign')),
  );

  if (!S.campaigns.length) {
    return el('div', {}, head, el('div', { class: 'empty' }, el('b', {}, 'No campaigns yet'), 'Add businesses and a letter first, then schedule the run.'));
  }

  const rows = S.campaigns.map((c) => el('tr', {},
    el('td', {}, el('div', { class: 'biz' }, c.name), el('div', { class: 'sub' }, c.template_name || 'letter deleted')),
    el('td', { class: 'num' }, fmt(c.start_at), el('div', { class: 'sub' }, `every ${c.gap_minutes}m`)),
    el('td', { class: 'num' }, `${c.sent}/${c.total}`, el('div', { class: 'sub' }, `${c.queued} queued${c.failed ? ` · ${c.failed} failed` : ''}`)),
    el('td', {}, el('span', { class: c.replies ? 'tag go' : 'tag' }, `${c.replies} ${c.replies === 1 ? 'reply' : 'replies'}`)),
    el('td', {}, el('span', { class: c.status === 'active' ? 'tag ac' : 'tag' }, c.status)),
    el('td', { class: 'act' },
      el('button', { class: 'btn sm', onclick: () => { S.filter = 'all'; S.view = 'outbox'; render(); } }, 'Mail'), ' ',
      c.status === 'active'
        ? el('button', { class: 'btn sm', onclick: async () => { if (!confirm('Pausing cancels the mail still queued for this campaign. Continue?')) return; await api(`campaigns/${c.id}/status`, { method: 'POST', body: { status: 'paused' } }); toast('Paused.'); refreshState(); render(); } }, 'Pause')
        : el('button', { class: 'btn sm danger', onclick: async () => { if (!confirm(`Delete "${c.name}"? Sent mail stays in the outbox.`)) return; await api(`campaigns/${c.id}`, { method: 'DELETE' }); toast('Deleted.'); refreshState(); render(); } }, 'Delete')),
  ));

  return el('div', {}, head, el('div', { class: 'panel tight' }, el('div', { class: 'tablescroll' },
    el('table', { class: 'ledger' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Campaign'), el('th', {}, 'Starts'), el('th', {}, 'Progress'), el('th', {}, 'Replies'), el('th', {}, 'Status'), el('th', {}))),
      el('tbody', {}, ...rows)))));
};

async function newCampaign() {
  const [businesses, templates] = await Promise.all([api('businesses'), api('templates')]);
  if (!businesses.length) return toast('Add some businesses first.', true);
  if (!templates.length) return toast('Write a letter first.', true);

  const name = el('input', { value: `Outreach — ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` });
  const tplSel = el('select', {}, ...templates.map((t) => el('option', { value: t.id }, t.name)));
  const start = el('input', { type: 'datetime-local', value: toLocalInput(Date.now() + 10 * 60000) });
  const gap = el('input', { type: 'number', min: 1, max: 600, value: S.state.settings.gapMinutes || 12 });
  const cap = el('input', { type: 'number', min: 1, max: 500, value: S.state.settings.dailyCap || 25 });

  const checks = new Map();
  const list = el('div', { class: 'picker' }, ...businesses.map((b) => {
    const cb = el('input', { type: 'checkbox', checked: b.status === 'new' });
    checks.set(b.id, cb);
    return el('label', { class: 'opt' }, cb, el('div', {},
      el('b', {}, b.name || b.email),
      el('span', {}, `${b.email}${b.city ? ` · ${b.city}` : ''} · ${b.status}`)));
  }));

  const count = el('span', { class: 'sp' }, '');
  const recount = () => { count.textContent = `${[...checks.values()].filter((c) => c.checked).length} selected`; };
  list.addEventListener('change', recount);

  const form = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Campaign name'), name),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', {}, 'Letter'), tplSel),
      el('div', { class: 'field' }, el('label', {}, 'First send'), start)),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', {}, 'Default campaign interval (minutes)'), gap),
      el('div', { class: 'field' }, el('label', {}, 'Global daily safety limit'), cap)),
    el('div', { style: 'display:flex;gap:8px;margin-bottom:6px' },
      el('button', { class: 'btn sm', onclick: () => { checks.forEach((c) => { c.checked = true; }); recount(); } }, 'Select all'),
      el('button', { class: 'btn sm', onclick: () => { checks.forEach((c) => { c.checked = false; }); recount(); } }, 'None')),
    list,
    el('p', { class: 'hint' }, 'Sends still obey your global send window, daily cap and pause switch in Setup.'),
  );
  recount();

  modal('Schedule a campaign', form, [
    el('button', { class: 'btn primary', onclick: async () => {
      const ids = [...checks.entries()].filter(([, c]) => c.checked).map(([id]) => id);
      if (!ids.length) return toast('Pick at least one business.', true);
      try {
        const r = await api('campaigns', { method: 'POST', body: {
          name: name.value.trim(), templateId: tplSel.value, businessIds: ids,
          startAt: new Date(start.value).getTime(), gapMinutes: Number(gap.value), dailyCap: Number(cap.value),
        } });
        closeModal(); toast(`${r.queued} mails queued.`); refreshState(); go('outbox');
      } catch (e) { toast(e.message, true); }
    } }, 'Queue it'),
    el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
    count,
  ]);
}

/* ---------- settings ---------- */

views.settings = async () => {
  const s = S.state.settings;
  const head = el('div', { class: 'viewhead' }, el('div', {}, el('h2', {}, 'Setup'), el('p', { class: 'lede' }, 'Mailboxes, sending rhythm and quiet hours.')));

  const mailboxPanel = el('div', {class:'panel'},
    el('h3', {class:'sec'}, 'Domain mailboxes · SMTP'),
    el('p', {class:'hint'}, 'Add your provider’s SMTP details. Save, test the connection, then choose an active sender. Passwords are encrypted and never returned to the browser. SMTP requires an app password or SMTP AUTH support; OAuth-only accounts cannot use this form.'),
    el('p', {class:'hint'}, 'Your mailbox credentials are encrypted and private to your account. Enable incoming IMAP over TLS port 993 to sync campaign replies. Uses the same mailbox username and app password.'),
  );
  for (const m of S.state.mailboxes || []) {
    const action = (label, suffix, method='POST') => el('button', {class:'btn', onclick: async () => {
      if(method==='DELETE' && !confirm('Remove this mailbox?'))return;
      try { await api(`mailboxes/${m.id}${suffix}`,{method});toast(label==='Test connection'?'Connection successful. No email sent.':'Updated.');await refreshState();render(); }catch(e){toast(e.message,true);}
    }}, label);
    mailboxPanel.append(el('div', {class:'panel'},
      el('b', {}, `${m.email}${m.active ? ' · Active sender' : ''}`),
      el('p', {class:'hint'}, `${m.host}:${m.port} · ${m.verified_at ? 'Connection tested' : 'Not tested'} · ${m.inbox?.error?'Inbox error: '+m.inbox.error:m.inbox?.lastSync?'Inbox synced '+fmt(m.inbox.lastSync):m.inbox?'Inbox waiting for first sync':'Inbox not connected'}`),
      el('div', {style:'display:flex;gap:8px;flex-wrap:wrap'}, el('button',{class:'btn',onclick:()=>connectIncoming(m)},m.inbox?'IMAP settings':'Connect inbox'), action('Test connection','/test'), action('Use as sender','/activate'), action('Remove','','DELETE'))));
  }
  const mbName=el('input',{placeholder:'Sender name',maxlength:120});
  const mbEmail=el('input',{type:'email',placeholder:'you@yourdomain.com',required:true});
  const mbHost=el('input',{placeholder:'mail.yourprovider.com',required:true});
  const mbPort=el('select',{},el('option',{value:'465'},'465 · TLS'),el('option',{value:'587'},'587 · STARTTLS'));
  const mbUser=el('input',{placeholder:'SMTP username (usually your email)',autocomplete:'off'});
  const mbPass=el('input',{type:'password',placeholder:'Mailbox password or app password',required:true,autocomplete:'new-password'});
  const mbSave=el('button',{class:'btn primary',type:'submit'},'Add mailbox');
  const mbForm=el('form',{onsubmit:async(e)=>{e.preventDefault();mbSave.disabled=true;try{
    await api('mailboxes',{method:'POST',body:{name:mbName.value,email:mbEmail.value,host:mbHost.value,port:Number(mbPort.value),username:mbUser.value,password:mbPass.value}});
    mbPass.value='';toast('Mailbox saved. Test the connection, then choose it as sender.');await refreshState();render();
  }catch(err){toast(err.message,true);}finally{mbSave.disabled=false;}}},
    el('div',{class:'row'},el('div',{class:'field'},el('label',{},'Sender name'),mbName),el('div',{class:'field'},el('label',{},'Email address'),mbEmail)),
    el('div',{class:'row'},el('div',{class:'field'},el('label',{},'SMTP host'),mbHost),el('div',{class:'field'},el('label',{},'Port and security'),mbPort)),
    el('div',{class:'row'},el('div',{class:'field'},el('label',{},'Username'),mbUser),el('div',{class:'field'},el('label',{},'Password / app password'),mbPass)),mbSave);
  mailboxPanel.append(mbForm);

  const gmailPanel = el('div', { class: 'panel' },
    el('h3', { class: 'sec' }, 'Gmail'),
    S.state.account && !S.state.smtpActive
      ? el('div', {},
          el('p', { class: 'lede' }, `Connected as ${S.state.account.email}. OutreachLead sends as you — same deliverability as mail you write by hand.`),
          el('div', { style: 'display:flex;gap:8px' },
            el('a', { class: 'btn', href: '/auth/google' }, 'Reconnect'),
            el('button', { class: 'btn danger', onclick: async () => { if (!confirm('Disconnect Gmail? Queued mail will stop going out.')) return; await api('disconnect', { method: 'POST' }); toast('Disconnected.'); await refreshState(); render(); } }, 'Disconnect')))
      : el('div', {},
          el('p', { class: 'lede' }, 'Not connected. OutreachLead needs permission to send mail and read your own threads so it can spot replies.'),
          el('a', { class: 'btn primary', href: '/auth/google' }, 'Connect Gmail')),
  );

  const mode = el('select', {}, el('option', { value: 'draft' }, 'Draft only — write into Gmail drafts'), el('option', { value: 'send' }, 'Send for real'));
  mode.value = s.mode;
  if (S.state.smtpActive) {mode.options[0].disabled=true;mode.title='SMTP supports sending only; select Send for real when ready.';}
  const cap = el('input', { type: 'number', min: 1, max: 100, value: s.dailyCap });
  const gap = el('input', { type: 'number', min: 0, max: 600, value: s.gapMinutes });
  const wStart = el('input', { type: 'number', min: 0, max: 23, value: s.windowStart });
  const wEnd = el('input', { type: 'number', min: 0, max: 23, value: s.windowEnd });
  const tz = el('input', { type: 'number', min: -720, max: 840, step: 15, value: s.tzOffset });
  const weekdays = el('input', { type: 'checkbox', checked: s.weekdaysOnly });
  const sender = el('input', { value: s.senderName, placeholder: 'Name shown in the From line' });
  const sig = el('textarea', { class: 'mono', rows: 4 }, s.signature);
  const poll = el('input', { type: 'checkbox', checked: s.pollReplies && !S.state.smtpActive, disabled:S.state.smtpActive });

  const sendPanel = el('div', { class: 'panel' },
    el('h3', { class: 'sec' }, 'Sending'),
    el('div', { class: 'field' }, el('label', {}, 'Mode'), mode),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', {}, 'Global daily safety limit'), cap),
      el('div', { class: 'field' }, el('label', {}, 'Default campaign interval (minutes)'), gap)),
    el('div', { class: 'row' },
      el('div', { class: 'field' }, el('label', {}, 'Window opens (hour)'), wStart),
      el('div', { class: 'field' }, el('label', {}, 'Window closes (hour)'), wEnd),
      el('div', { class: 'field' }, el('label', {}, 'Timezone offset (minutes)'), tz)),
    el('label', { class: 'check' }, weekdays, 'Weekdays only'),
    el('label', { class: 'check' }, poll, 'Watch for replies on every run'),
    el('p', { class: 'hint' }, 'Dhaka is +360. Gmail throttles hard above a few hundred a day on a personal account — Your provider’s limits also apply; use a conservative daily limit.'),
  );

  const idPanel = el('div', { class: 'panel' },
    el('h3', { class: 'sec' }, 'Your details'),
    el('div', { class: 'field' }, el('label', {}, 'Sender name'), sender),
    el('div', { class: 'field' }, el('label', {}, 'Signature (appended if not already in the body)'), sig),
  );

  const save = el('button', { class: 'btn primary', onclick: async () => {
    await api('settings', { method: 'POST', body: {
      mode: mode.value, daily_cap: cap.value, gap_minutes: gap.value,
      window_start: wStart.value, window_end: wEnd.value, tz_offset: tz.value,
      weekdays_only: weekdays.checked, sender_name: sender.value, signature: sig.value,
      poll_replies: poll.checked,
    } });
    toast('Saved.'); await refreshState(); render();
  } }, 'Save settings');

  return el('div', {}, head, mailboxPanel, gmailPanel, sendPanel, idPanel, el('div', { style: 'display:flex;gap:8px' }, save));
};

/* ---------- logs ---------- */

views.logs = async () => {
  const logs = await api('logs');
  const head = el('div', { class: 'viewhead' }, el('div', {}, el('h2', {}, 'Activity'), el('p', { class: 'lede' }, 'What the scheduler has been doing, including the runs you were not around for.')));
  if (!logs.length) return el('div', {}, head, el('div', { class: 'empty' }, el('b', {}, 'Nothing logged yet')));
  return el('div', {}, head, el('div', { class: 'panel tight' }, el('div', { class: 'tablescroll' },
    el('table', { class: 'ledger' },
      el('thead', {}, el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Level'), el('th', {}, 'Message'))),
      el('tbody', {}, ...logs.map((l) => el('tr', {},
        el('td', { class: 'num' }, fmt(l.at)),
        el('td', {}, el('span', { class: l.level === 'error' ? 'tag red' : l.level === 'warn' ? 'tag amber' : 'tag' }, l.level)),
        el('td', {}, l.message))))))));
};

/* ---------- boot ---------- */

document.addEventListener('DOMContentLoaded', async function start() {
  try {
    await refreshState();
    if (new URLSearchParams(location.search).get('connected')) {
      toast('Email account connected.');
      history.replaceState({}, '', '/app#connectors');
    }
    S.view = location.hash.slice(1) && views[location.hash.slice(1)] ? location.hash.slice(1) : 'campaigns';
    await render();
    setInterval(() => refreshState().catch(() => {}), 60000);
  } catch (e) {
    $('pane').replaceChildren(el('div', { class: 'wrap' },
      el('div', { class: 'alert' }, el('b', {}, 'OutreachLead could not start'), el('p', {}, e.message))));
  }
});

function showSendResult(r) {
 const reasons = {'paused':'Scheduler paused. Click Start to enable scheduled sending.','outside-send-window':'Outside your sending window. Check Setup timezone and hours.','smtp-needs-send-mode':'SMTP cannot create drafts. Select Send for real in Setup or click Start.','daily-cap-reached':'Daily sending limit reached.','campaign-paused-or-pacing-limit':'Campaign paused, daily limit reached, or waiting for its sending interval.','nothing-due':'No eligible email yet. Check schedule, campaign status and sending interval.','another-run-active':'Another send is in progress. Refresh shortly.','mailbox-not-connected':'Reconnect the campaign sender in Setup.','suppressed':'Recipient is suppressed; no email sent.'};
 if(r.sent>0) return toast(`${r.sent} email accepted by the mail provider.`);
 if(r.drafted>0) return toast(`${r.drafted} draft created. No email sent.`);
 toast((r.skipped||[]).map(x=>reasons[x]||x.replace(/^error:/,'Send failed: ')).join(' ')||'No email sent.',true);
}

function connectIncoming(m){const host=el('input',{value:m.inbox?.host||(m.host==='smtp.gmail.com'?'imap.gmail.com':m.host),required:true});modal('Connect incoming mail · '+m.email,el('div',{},el('p',{},'Enter your provider’s IMAP hostname. TLS port 993; uses the saved username and password. Imports campaign replies from INBOX, starting with the last 30 days.'),host),[button('Test & connect inbox',async()=>{await api(`mailboxes/${m.id}/inbox`,{method:'POST',body:{host:host.value}});closeModal();toast('Inbox connected. Replies will sync in the background.');await refreshState();render();},true)]);}
