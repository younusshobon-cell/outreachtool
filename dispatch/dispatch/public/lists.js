/* Service audiences and explicit bulk actions. */
async function servicePicker(value=''){
 const names=await api('businesses/lists');const input=el('input',{value,placeholder:'e.g. SEO · Sydney roofers',maxlength:100,list:'service-list-options'});
 const options=el('datalist',{id:'service-list-options'},...names.map(n=>el('option',{value:n})));
 return {input,node:el('div',{},field('Service / business list',input,'Choose an existing list or type a new name. Empty means Unassigned.'),options)};
}
views.businesses=async()=>{
 const businesses=await api('businesses');S.businesses=businesses;
 const selected=new Set(),checks=new Map(),rows=new Map();
 const count=el('span',{role:'status'},'0 selected');
 const search=el('input',{type:'search',placeholder:'Filter by name, email or city…'});
 const filter=el('select',{'aria-label':'Filter service list'},el('option',{value:'*'},'All service lists'),el('option',{value:''},'Unassigned'),...[...new Set(businesses.map(b=>b.service_list).filter(Boolean))].sort().map(n=>el('option',{value:n},n)));
 const all=el('input',{type:'checkbox','aria-label':'Select all visible businesses'});
 const sync=()=>{count.textContent=`${selected.size} selected`;const visible=[...rows].filter(([,row])=>!row.hidden).map(([id])=>id);all.checked=visible.length>0&&visible.every(id=>selected.has(id));all.indeterminate=visible.some(id=>selected.has(id))&&!all.checked;};
 const apply=()=>{for(const b of businesses){const visible=(filter.value==='*'||(b.service_list||'')===filter.value)&&`${b.name} ${b.email} ${b.city} ${b.owner}`.toLowerCase().includes(search.value.toLowerCase());rows.get(b.id).hidden=!visible;if(!visible){selected.delete(b.id);checks.get(b.id).checked=false;}}sync();};
 search.oninput=apply;filter.onchange=apply;all.onchange=()=>{for(const [id,row] of rows)if(!row.hidden){checks.get(id).checked=all.checked;all.checked?selected.add(id):selected.delete(id);}sync();};
 const bulkDelete=button('Delete selected',async()=>{if(!selected.size)return toast('Select businesses first.',true);if(!confirm(`Permanently delete ${selected.size} selected businesses and remove their queued emails? Sent history will remain.`))return;const r=await api('businesses/bulk-delete',{method:'POST',body:{ids:[...selected]}});toast(`${r.changed} businesses deleted.`);await refreshState();render();});bulkDelete.classList.add('danger');
 const move=button('Move selected to list',async()=>{if(!selected.size)return toast('Select businesses first.',true);const picker=await servicePicker();modal('Move selected businesses',picker.node,[button('Save list',async()=>{await api('businesses/bulk-list',{method:'POST',body:{ids:[...selected],service_list:picker.input.value}});closeModal();render();},true)]);});
 const tbody=el('tbody',{},...businesses.map(b=>{const cb=el('input',{type:'checkbox','aria-label':'Select '+(b.name||b.email),onchange:()=>{cb.checked?selected.add(b.id):selected.delete(b.id);sync();}});checks.set(b.id,cb);const row=el('tr',{},el('td',{},cb),el('td',{},el('div',{class:'biz'},b.name),el('div',{class:'sub'},b.website||'')),el('td',{},b.owner||'—'),el('td',{},b.email,el('div',{class:'sub'},b.city||'')),el('td',{},el('span',{class:'tag'},b.service_list||'Unassigned')),el('td',{},b.status),el('td',{class:'act'},button('Edit',()=>editBusiness(b)),button('Outcome',()=>recordOutcome(b)),button('Delete',async()=>{if(!confirm(`Remove ${b.name||b.email}?`))return;await api('businesses/'+b.id,{method:'DELETE'});await refreshState();render();})));rows.set(b.id,row);return row;}));
 return el('div',{},heading('Businesses','Organize prospects by service, then choose a list in your campaign.',el('div',{class:'actions'},button('Import CSV',importSheet),button('Add business',()=>editBusiness(null),true))),el('div',{class:'toolbar'},search,filter),el('div',{class:'toolbar'},count,move,bulkDelete),businesses.length?el('div',{class:'panel tablescroll'},el('table',{class:'ledger'},el('thead',{},el('tr',{},el('th',{},all),...['Business','Owner','Email','Service list','Status','Actions'].map(n=>el('th',{},n)))),tbody)):empty('No businesses yet','Import CSV or add a business to create your first service list.'));
};
