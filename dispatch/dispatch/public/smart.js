/* Recipient-level preview uses the same server renderer as delivery. */
previewTemplate=async function(t){
 const businesses=await api('businesses');
 const select=el('select',{'aria-label':'Preview recipient'},...businesses.map(b=>el('option',{value:b.id},`${b.name||b.email} · ${b.service_list||'Unassigned'}`)));
 const step=el('select',{'aria-label':'Preview message'},el('option',{value:'first'},'First email'),t.followup_body?el('option',{value:'followup'},'Follow-up'):null);
 const content=el('div',{role:'status'});let request=0;
 const draw=async()=>{const ticket=++request;const biz=businesses.find(b=>b.id===select.value)||{name:'Example company',owner:'Jamie Lee',email:'example@example.com'};const follow=step.value==='followup';content.replaceChildren(el('p',{},'Preparing preview…'));try{const r=await api('preview',{method:'POST',body:{business:biz,subject:follow?t.followup_subject||t.subject:t.subject,body:follow?t.followup_body:t.body}});if(ticket!==request)return;content.replaceChildren(el('div',{class:'envelope'},el('div',{class:'hd'},el('div',{class:'to'},'To: '+biz.email),el('div',{class:'sj'},r.subject)),el('pre',{},r.body)),el('p',{class:'hint'},`${r.words} words · ${r.subjectLength} subject characters`),...(r.warnings.length?r.warnings.map(w=>el('div',{class:'note'},w)):[el('div',{class:'note'},'Copy checks passed for this recipient.')]),el('p',{class:'hint'},'Writing checks are suggestions, not a spam score or delivery guarantee. Signature and unsubscribe footer are added at send time.'));}catch(e){if(ticket===request)content.replaceChildren(el('p',{class:'alert'},e.message));}};
 select.onchange=draw;step.onchange=draw;
 modal('Preview & copy checks · '+t.name,el('div',{},businesses.length?field('Recipient',select):el('p',{class:'hint'},'No businesses yet. Showing illustrative sample data.'),field('Message',step),content),[button('Close',closeModal)]);await draw();
};
