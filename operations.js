import { suggestMatches } from './smart-calling.js';
import { competitionClient } from './event-scope.js';
import { courtLabel, courtOptions, assignCourt } from './match-courts.js';
import './operations.css';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
export function readiness(teams){
 const count=teams.filter(t=>t.checked_in===true).length;
 return {count,total:teams.length,ready:teams.length>0&&count===teams.length};
}
export function readinessBadge(teams){const r=readiness(teams);return `<span class="ops-badge ${r.ready?'ops-ready':'ops-missing'}">${r.ready?'✓ ĐỦ CHECK-IN':`⚠ CHƯA ĐỦ CHECK-IN · ${r.count}/${r.total}`}</span>`;}
export async function mountOperations({client,event,tournament,tab,allowed,isCurrent,startLive,openMatch,getPlayer}){
 if(!allowed())return;
 const db=competitionClient(client,event),host=document.querySelector('#workcontent');
 let search='',filter='all',busy=false,latest;
 const read=async()=>{
  const results=await Promise.all([
   db.from('teams').select('*').eq('tournament_id',tournament.id).order('registration_order'),
   db.from('groups').select('*').eq('tournament_id',tournament.id).order('group_order'),
   db.from('group_teams').select('group_id,team_id'),
   db.from('team_members').select('team_id,player_id,slot_order').order('slot_order'),
   tab==='control'?db.from('matches').select('*').eq('tournament_id',tournament.id).order('scheduled_order'):Promise.resolve({data:[]}),
   tournament.format==='mlp'?db.from('mlp_slots').select('*').eq('tournament_id',tournament.id):Promise.resolve({data:[]}),
   tab==='control'?client.from('tournaments').select('court_count').eq('id',tournament.id).single():Promise.resolve({data:null}),
   tab==='control'?client.from('matches').select('id,event_id,status,court_number,team1_id,team2_id').eq('tournament_id',tournament.id).in('status',['playing','scheduled']):Promise.resolve({data:[]})
  ]);
  for(const r of results)if(r.error)throw r.error;
  const [teams,groups,links,members,matches,slots,settings,occupancy]=results.map(r=>r.data||[]);
  const ids=[...new Set(members.map(m=>m.player_id))];
  const {data:players,error}=ids.length?await client.from('players').select('id,full_name').in('id',ids):{data:[]};
  if(error)throw error;
  return {teams,groups,links,members,matches,slots,courtCount:settings?.court_count??6,occupancy,pm:Object.fromEntries((players||[]).map(p=>[p.id,p.full_name]))};
 };
 const refresh=async()=>{
  if(busy||!isCurrent()||!allowed())return;
  try{const data=await read();if(!isCurrent()||busy)return;latest=data;draw(data)}catch(e){if(isCurrent()){let msg=host.querySelector('[data-ops-error]');if(!msg){host.innerHTML='<p data-ops-error role="alert"></p>';msg=host.firstElementChild}msg.textContent=e.message}}
 };
 const draw=data=>{
  const {teams,groups,links,members,matches,pm}=data,tm=Object.fromEntries(teams.map(t=>[t.id,t]));
  const groupTeams=g=>links.filter(l=>l.group_id===g.id).map(l=>tm[l.team_id]).filter(Boolean);
  const groupSummary=()=>`<div class="ops-grid">${groups.map(g=>{const ts=groupTeams(g),r=readiness(ts);return `<article class="panel"><b>BẢNG ${esc(g.name)}</b> · ${tab==='checkin'&&r.ready?'ĐÃ ĐỦ':`${r.count}/${r.total}`}<p>${readinessBadge(ts)}</p>${r.ready?'':`<small>${r.total?`⚠ THIẾU ${r.total-r.count}`:'Chưa có đội'}</small>`}</article>`}).join('')||'<p>Chưa chia bảng.</p>'}</div>`;
  host.innerHTML=`<div class="operations"><h1>${tab==='checkin'?'CHECK-IN':'ĐIỀU HÀNH'}</h1><p>${esc(event.name)} · Tự cập nhật mỗi 15 giây</p><p data-ops-error role="alert"></p><div data-ops-body></div></div>`;
  const body=host.querySelector('[data-ops-body]');
  if(tab==='checkin'){
   const r=readiness(teams),percent=r.total?Math.round(r.count/r.total*100):0;
   body.innerHTML=`<div class="panel"><h2>${r.count} / ${r.total} ĐỘI ĐÃ CHECK-IN</h2><progress max="100" value="${percent}" aria-label="Tiến độ check-in"></progress> ${percent}%</div><button data-check-all>✓ ĐÃ ĐỦ TẤT CẢ</button>${groupSummary()}<div class="ops-tools"><input type="search" placeholder="Tìm VĐV / đội..." aria-label="Tìm VĐV / đội" value="${esc(search)}"><div class="actions">${[['all','TẤT CẢ'],['no','CHƯA CHECK-IN'],['yes','ĐÃ CHECK-IN']].map(([v,l])=>`<button data-filter="${v}" class="${v===filter?'':'secondary'}" aria-pressed="${v===filter}">${l}</button>`).join('')}</div></div><div data-team-list></div>`;
   body.querySelector('[data-check-all]').onclick=()=>{
    if(busy||!allowed()||!isCurrent())return;
    const modal=document.querySelector('#modal');
    modal.innerHTML='<div class="overlay"><div class="modal" role="dialog" aria-modal="true" aria-label="CHECK-IN TẤT CẢ"><p>Xác nhận tất cả VĐV/đội của nội dung này đã có mặt?</p><p role="alert"></p><div class="actions"><button data-cancel class="secondary">HỦY</button><button data-confirm>XÁC NHẬN ĐÃ ĐỦ</button></div></div></div>';
    modal.querySelector('[data-cancel]').onclick=()=>{if(!busy)modal.innerHTML=''};
    modal.querySelector('[data-confirm]').onclick=async()=>{
     if(busy||!allowed()||!isCurrent())return;busy=true;
     modal.querySelectorAll('button').forEach(b=>b.disabled=true);
     try{
      const {error}=await db.from('teams').update({checked_in:true,checked_in_at:new Date().toISOString()}).eq('tournament_id',tournament.id).or('checked_in.eq.false,checked_in.is.null');
      if(error)throw error;
      modal.innerHTML='';
     }catch(e){modal.querySelector('[role=alert]').textContent=e.message}
     finally{busy=false;modal.querySelectorAll('button').forEach(b=>b.disabled=false)}
     await refresh();
    };
   };
   const list=()=>{
    const assigned=new Set(links.map(l=>l.team_id)),sections=[...groups.map(g=>({name:`BẢNG ${g.name}`,teams:groupTeams(g)})),{name:'CHƯA CHIA BẢNG',teams:teams.filter(t=>!assigned.has(t.id))}];
    body.querySelector('[data-team-list]').innerHTML=sections.map(g=>{
     const visible=g.teams.filter(t=>(filter==='all'||t.checked_in===(filter==='yes'))&&`${t.name} ${members.filter(m=>m.team_id===t.id).map(m=>pm[m.player_id]).join(' ')}`.toLocaleLowerCase('vi').includes(search.toLocaleLowerCase('vi')));
     if(!visible.length)return '';const r=readiness(g.teams);
     return `<section class="panel"><h2>${esc(g.name)} · ${r.count}/${r.total} CHECK-IN</h2>${readinessBadge(g.teams)}${visible.map(t=>`<article class="ops-team"><div><b>${t.checked_in?'✓':'○'} ${esc(t.name)}</b><p>${esc(members.filter(m=>m.team_id===t.id).map(m=>pm[m.player_id]).join(' · '))}</p><small>${t.checked_in?'ĐÃ CHECK-IN':'CHƯA CHECK-IN'}</small></div><div class="actions"><button data-check="${t.id}" class="${t.checked_in?'secondary':''}">${t.checked_in?'HỦY CHECK-IN':'CHECK-IN'}</button><button class="secondary" data-edit="${t.id}">SỬA VĐV</button></div></article>`).join('')}</section>`;
    }).join('')||'<p>Không có đội phù hợp.</p>';
    body.querySelectorAll('[data-check]').forEach(b=>b.onclick=async()=>{
     if(busy||!allowed()||!isCurrent())return;busy=true;b.disabled=true;
     const team=tm[b.dataset.check],checked=!team.checked_in;
     try{const {data:saved,error}=await db.from('teams').update({checked_in:checked,checked_in_at:checked?new Date().toISOString():null}).eq('id',team.id).eq('tournament_id',tournament.id).select('id,checked_in,checked_in_at').single();if(error)throw error;Object.assign(team,saved);if(isCurrent())draw(data)}catch(e){if(isCurrent())host.querySelector('[data-ops-error]').textContent=e.message}finally{busy=false;b.disabled=false}
    });
    body.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>edit(tm[b.dataset.edit]));
   };
   body.querySelector('input').oninput=e=>{search=e.target.value;list()};
   body.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;draw(data)});list();
  }else{
   const active=matches.filter(m=>m.status==='playing'),waiting=matches.filter(m=>m.status==='scheduled'),done=matches.filter(m=>m.status==='completed');
   const courts=courtOptions(null,data.courtCount),plan=suggestMatches({matches,teams,groups,courtCount:data.courtCount,occupancy:data.occupancy});
   const occupied=new Set(plan.active.map(m=>m.court_number).filter(n=>courts.includes(n)));
   const calledCourts=new Set(plan.called.map(m=>m.court_number).filter(n=>!occupied.has(n)));
   const playingTeams=new Set(plan.active.flatMap(m=>[m.team1_id,m.team2_id]));
   const ready=m=>!!(m.team1_id&&m.team2_id&&!playingTeams.has(m.team1_id)&&!playingTeams.has(m.team2_id)&&(m.stage!=='group'||(tm[m.team1_id]?.checked_in&&tm[m.team2_id]?.checked_in)));
   const waitingLabel=m=>playingTeams.has(m.team1_id)||playingTeams.has(m.team2_id)?'⚠ ĐỘI ĐANG THI ĐẤU':!m.team1_id||!m.team2_id?'⚠ CHƯA XÁC ĐỊNH ĐỦ ĐỘI':ready(m)?'✓ SẴN SÀNG':'⚠ CHƯA ĐỦ CHECK-IN';
   const card=m=>`<article class="panel ops-match"><small>${courtLabel(m.court_number)||'Chưa xếp sân'} · ${esc(event.name)} · ${esc(groups.find(g=>g.id===m.group_id)?.name?`Bảng ${groups.find(g=>g.id===m.group_id).name}`:m.stage)}</small><h3>${esc(m.match_code)}</h3><b>${esc(tm[m.team1_id]?.name||'Chưa xác định')}</b><p>vs</p><b>${esc(tm[m.team2_id]?.name||'Chưa xác định')}</b><h3>${m.status==='playing'||m.status==='completed'?`${m.team1_score??0} : ${m.team2_score??0}`:'—'}</h3><span data-ops-live="${m.id}"></span>${m.status==='scheduled'&&courts.includes(m.court_number)?'<p>🟡 ĐANG GỌI</p>':''}${m.status==='scheduled'?`<p class="ops-badge ${ready(m)?'ops-ready':'ops-missing'}">${waitingLabel(m)}</p>`:''}<button data-open="${m.id}" class="secondary">XEM TRẬN</button></article>`;
   body.innerHTML=`<div class="ops-grid ops-stats">${[`${courts.length} SÂN`,`${occupied.size} ĐANG ĐÁNH`,`${courts.length-occupied.size-calledCourts.size} TRỐNG`,`${calledCourts.size} ĐANG GỌI`,`${done.length} / ${matches.length} TRẬN HOÀN THÀNH`,`${waiting.length} TRẬN ĐANG CHỜ`,`${groups.filter(g=>!readiness(groupTeams(g)).ready).length} BẢNG CHƯA ĐỦ CHECK-IN`].map(s=>`<div class="panel"><b>${s}</b></div>`).join('')}<div class="panel" data-ops-live-count>Đang tải LIVE…</div></div><h2>TÌNH TRẠNG SÂN</h2><div class="ops-grid">${courts.map(n=>{
     const occupants=plan.active.filter(m=>m.court_number===n),calls=plan.called.filter(m=>m.court_number===n),suggestion=plan.suggestions.get(n);
     const rows=occupants.length?occupants:calls;
     const content=rows.length?rows.map(row=>{const local=matches.find(m=>m.id===row.id);return local?card(local):'<div class="panel">Sân đang được sử dụng bởi nội dung khác trong giải.</div>'}).join(''):suggestion?`<div><h4>GỢI Ý TIẾP THEO</h4>${card(suggestion)}${suggestion.stage==='group'?'<p>✓ ĐÃ CHECK-IN</p>':''}<button data-call="${suggestion.id}" data-court="${n}">GỌI VÀO SÂN ${n}</button></div>`:'<div class="panel">Chưa có trận phù hợp để gọi.</div>';
     return `<section><h3>SÂN ${n} · ${occupants.length?'● ĐANG ĐÁNH':calls.length?'🟡 ĐANG GỌI':'○ TRỐNG'}</h3>${content}</section>`;
   }).join('')}</div><h2>ĐANG DIỄN RA</h2><div class="ops-grid">${active.map(card).join('')||'<p>Chưa có trận đang thi đấu.</p>'}</div><h2>TRẬN ĐANG CHỜ</h2><div class="ops-grid">${waiting.map(card).join('')||'<p>Không có trận đang chờ.</p>'}</div><h2>TÌNH TRẠNG CÁC BẢNG</h2>${groupSummary()}`;
   body.querySelectorAll('[data-call]').forEach(button=>button.onclick=async()=>{
    if(busy||!allowed()||!isCurrent())return;busy=true;button.disabled=true;
    let failure;
    try{
     const fresh=await read();if(!allowed()||!isCurrent())return;
     const next=suggestMatches({matches:fresh.matches,teams:fresh.teams,groups:fresh.groups,courtCount:fresh.courtCount,occupancy:fresh.occupancy}).suggestions.get(Number(button.dataset.court));
     if(next?.id!==button.dataset.call)throw Error('Tình trạng sân hoặc đội đã thay đổi. Vui lòng chọn gợi ý mới.');
     await assignCourt(db,tournament.id,next.id,button.dataset.court,next.court_number??null);
    }catch(error){failure=error.message}finally{busy=false;button.disabled=false}
    if(isCurrent()){await refresh();if(failure)host.querySelector('[data-ops-error]').textContent=failure}
   });
   body.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openMatch(matches.find(m=>m.id===b.dataset.open)));
   fetch('/.netlify/functions/video-playback?'+new URLSearchParams({tournament_id:tournament.id,event_id:event.id}),{cache:'no-store',signal:AbortSignal.timeout(12000)}).then(r=>{if(!r.ok)throw Error();return r.json()}).then(result=>{if(!body.isConnected||!isCurrent())return;const ids=new Set((result.streams||[]).map(s=>s.match_id).filter(id=>matches.some(m=>m.id===id)));body.querySelector('[data-ops-live-count]').textContent=`🔴 ${ids.size} LIVE`;body.querySelectorAll('[data-ops-live]').forEach(el=>el.textContent=ids.has(el.dataset.opsLive)?'🔴 LIVE':'')}).catch(()=>{if(body.isConnected)body.querySelector('[data-ops-live-count]').textContent='Chưa tải được LIVE'});
  }
 };
 const edit=team=>{
  if(!allowed()||!isCurrent())return;
  const {members,pm,slots}=latest,rows=members.filter(m=>m.team_id===team.id);
  const modal=document.querySelector('#modal');
  modal.innerHTML=`<div class="overlay"><form class="modal" role="dialog" aria-modal="true" aria-label="SỬA VĐV"><h2>SỬA VĐV</h2><p>${esc(team.name)}</p>${rows.map((m,i)=>`<label>${esc(slots.find(s=>s.slot_order===m.slot_order)?.slot_name||`VĐV ${i+1}`)}<input name="player${i}" value="${esc(pm[m.player_id])}" required maxlength="200"></label>`).join('')||'<p>Đội chưa có thành viên. Thêm đội hình tại VĐV / ĐỘI.</p>'}<p role="alert"></p><div class="actions"><button type="button" class="secondary">HỦY</button><button type="submit" ${rows.length?'':'disabled'}>LƯU THAY ĐỔI</button></div></form></div>`;
  const form=modal.querySelector('form'),cancel=form.querySelector('[type=button]'),save=form.querySelector('[type=submit]');
  cancel.onclick=()=>{if(!busy)modal.innerHTML=''};form.querySelector('input')?.focus();
  form.onsubmit=async e=>{
   e.preventDefault();if(busy||!allowed()||!isCurrent())return;busy=true;save.disabled=true;cancel.disabled=true;
   try{
    const names=rows.map((_,i)=>form.elements[`player${i}`].value.trim());if(names.some(n=>!n))throw Error('Vui lòng nhập đủ tên VĐV.');
    const replacements=[];
    for(let i=0;i<rows.length;i++){if(!isCurrent()||!allowed())throw Error('Nội dung hoặc quyền vận hành đã thay đổi.');const m=rows[i],p=names[i]===pm[m.player_id]?{id:m.player_id}:await getPlayer(names[i],slots.find(s=>s.slot_order===m.slot_order)?.gender);replacements.push({slot_order:m.slot_order,old_player_id:m.player_id,player_id:p.id})}
    if(!isCurrent()||!allowed())throw Error('Nội dung hoặc quyền vận hành đã thay đổi.');
    const {error}=await client.rpc('pantry_replace_team_members',{p_event:event.id,p_team:team.id,p_members:replacements}).setHeader('x-client-info',`pantry-event/${event.id}`);if(error)throw error;
    modal.innerHTML='';
   }catch(e){form.querySelector('[role=alert]').textContent=e.message}finally{busy=false;save.disabled=false;cancel.disabled=false}
   if(!modal.hasChildNodes())await refresh();
  };
 };
 await refresh();if(isCurrent())startLive(`admin:operations:${event.id}:${tab}`,async()=>{if(!host.querySelector('input:focus'))await refresh()});
}
