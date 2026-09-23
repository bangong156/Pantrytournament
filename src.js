import { mountPublicVideo, stopPublicVideo } from './video-playback.js'
import { parseRosterRows } from './roster-import.js'
import { competitionClient } from './event-scope.js'
import { createClient } from '@supabase/supabase-js'
import './style.css'
import pantryLogo from './assets/the-pantry-logo.png'
const pantryLogoMarkup=(className)=>`<img class="pantry-logo ${className}" src="${pantryLogo}" alt="The Pantry">`
const supabase=createClient('https://duuklzzxpegptsarcbqq.supabase.co','sb_publishable_FmGKX67AD3M4QvCuL3dSyg_w0X5vIX9')
const app=document.querySelector('#app'); let activeEvent=null, tournamentEvents=[], session=null, profile=null, currentTournament=null, liveTimer=null, liveView=null, liveBusy=false, renderEpoch=0, discoveryTimer=null;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
function registrationLink(value){
 const input=String(value||'').trim();
 if(!input||/\s/.test(input))return null;
 try{const url=new URL(input);return url.protocol==='https:'&&url.hostname&&!url.username&&!url.password?url.href:null}catch{return null}
}
function stopLive(){stopPublicVideo();if(liveTimer)clearInterval(liveTimer);if(discoveryTimer)clearInterval(discoveryTimer);discoveryTimer=null;liveTimer=null;liveView=null;liveBusy=false}
function startLive(view,refresh){stopLive();liveView=view;liveTimer=setInterval(async()=>{if(liveBusy||liveView!==view||document.querySelector('#modal')?.hasChildNodes()||document.activeElement?.matches('input[type=number]'))return;if(view.startsWith('ref:')&&[...document.querySelectorAll('[data-ref-s1],[data-ref-s2]')].some(x=>x.value!==x.dataset.original))return;if(view.startsWith('admin:matches:')&&[...document.querySelectorAll('[data-s1],[data-s2]')].some(x=>x.value!==x.dataset.original))return;liveBusy=true;try{await refresh()}catch(error){console.error('Live refresh:',error)}finally{liveBusy=false}},15000)}
function clearRefereeSession(tid){localStorage.removeItem(`pantry_ref_${tid}`);if(localStorage.getItem('pantry_ref_active')===tid)localStorage.removeItem('pantry_ref_active')}
async function validRefereeSession(tid,token){const {data,error}=await supabase.rpc('get_referee_session',{p_session_token:token});if(error)throw error;const row=data?.[0];return row?.tournament_id===tid?row:null}
async function refereeWriteError(tid,token,error){try{if(!await validRefereeSession(tid,token)){clearRefereeSession(tid);await publicTournament(tid);return false}}catch{}alert(error.message);return true}
async function restoreRefereeSession(){
 const preferred=localStorage.getItem('pantry_ref_active'),ids=[...new Set([preferred,...Object.keys(localStorage).filter(k=>k.startsWith('pantry_ref_')&&k!=='pantry_ref_active').map(k=>k.slice(11))].filter(Boolean))];
 let fallback=null;
 for(const tid of ids){
  let saved;try{saved=JSON.parse(localStorage.getItem(`pantry_ref_${tid}`)||'null')}catch{}
  if(!saved?.session_token){clearRefereeSession(tid);fallback??=tid;continue}
  let row;try{row=await validRefereeSession(tid,saved.session_token)}catch(error){console.error('Referee session check:',error);await publicTournament(tid);return true}
  if(row){localStorage.setItem('pantry_ref_active',tid);await refereeConsole(tid,row.session_token,row);return true}
  clearRefereeSession(tid);fallback??=tid;
 }
 if(fallback){await publicTournament(fallback);return true}
 return false;
}
async function getOrCreatePlayer(fullName, gender=null){
  const name=String(fullName||'').trim();
  if(!name) throw new Error('Tên VĐV không được để trống.');
  const {data:existing,error:findError}=await supabase.from('players').select('*').eq('full_name',name).limit(1);
  if(findError) throw findError;
  if(existing?.length){
    const player=existing[0];
    if(gender && gender!=='any' && !player.gender){
      const {data:updated,error:updateError}=await supabase.from('players').update({gender}).eq('id',player.id).select().single();
      if(updateError) throw updateError;
      return updated;
    }
    return player;
  }
  const payload={full_name:name};
  if(gender && gender!=='any') payload.gender=gender;
  const {data,error}=await supabase.from('players').insert(payload).select().single();
  if(error) throw error;
  return data;
}
async function boot(){if(new URLSearchParams(location.search).has('broadcaster')){const {renderBroadcaster}=await import('./video-ui.js');return renderBroadcaster(app)}({data:{session}}=await supabase.auth.getSession()); if(session){const {data}=await supabase.from('profiles').select('*').eq('id',session.user.id).single();profile=data;return render()}if(await restoreRefereeSession())return;render()}
function render(){if(!session)return publicDashboard(); dashboard()}

const vietnamToday=()=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}`};
const eventDate=date=>/^\d{4}-\d{2}-\d{2}$/.test(date||'')?date:String(date||'').slice(0,10);
const displayEventDate=date=>eventDate(date)?.split('-').reverse().join('/')||'—';
const eventCategory=(date,today)=>eventDate(date)>today?'upcoming':eventDate(date)<today?'completed':'live';
const eventType=t=>t.event_type==='minigame'?'MINIGAME':'GIẢI ĐẤU';
const eventFormat=t=>t.format==='mlp'?'Đồng đội / MLP':'Đánh đôi';
function discoveryCard(t,live=false,count=0){
 const id=esc(t.id),status=live?'● LIVE':eventCategory(t.start_date,vietnamToday())==='upcoming'?'📅 SẮP DIỄN RA':'🏆 ĐÃ KẾT THÚC';
 return `<article class="discovery-card ${live?'discovery-live':''}" data-enter-tournament="${id}" tabindex="0" role="link" aria-label="Vào giải ${esc(t.name)}"><div class="discovery-card-top"><span class="pill">${eventType(t)} · ${eventFormat(t)}</span><span class="discovery-status ${live?'live-status':''}">${status}</span></div><h3>${esc(t.name)}</h3><p>${esc(displayEventDate(t.start_date))}${t.start_time?' • '+esc(t.start_time.slice(0,5)):''}${live?` · ${count} đội`:''}</p><div class="discovery-actions">${live?`<button data-hub="${id}">VÀO GIẢI →</button><button class="secondary" data-info="${id}">Thông tin giải</button>`:`<button class="secondary" data-info="${id}">Thông tin giải</button><button data-hub="${id}">Chi tiết giải →</button>`}</div></article>`;
}
async function publicDashboard(selectedCategory=null){
 stopLive();const epoch=++renderEpoch;
 const {data:t,error}=await supabase.from('tournaments').select('id,name,event_type,format,start_date,start_time').order('start_date');
 if(epoch!==renderEpoch)return;
 if(error){app.innerHTML=`<main class="wrap"><p>${esc(error.message)}</p><button id="retryDiscovery">Thử lại</button></main>`;document.querySelector('#retryDiscovery').onclick=()=>publicDashboard();return}
 const today=vietnamToday(),all=t||[],live=all.filter(x=>eventCategory(x.start_date,today)==='live').sort((a,b)=>a.name.localeCompare(b.name,'vi')||a.id.localeCompare(b.id)),upcoming=all.filter(x=>eventCategory(x.start_date,today)==='upcoming').sort((a,b)=>eventDate(a.start_date).localeCompare(eventDate(b.start_date))||a.name.localeCompare(b.name,'vi')),completed=all.filter(x=>eventCategory(x.start_date,today)==='completed').sort((a,b)=>eventDate(b.start_date).localeCompare(eventDate(a.start_date))||a.name.localeCompare(b.name,'vi'));
 const category=selectedCategory==='completed'||selectedCategory==='upcoming'?selectedCategory:upcoming.length?'upcoming':'completed';
 const counts=Object.fromEntries(await Promise.all(live.map(async x=>{const {count}=await supabase.from('teams').select('id',{count:'exact',head:true}).eq('tournament_id',x.id);return [x.id,count??0]})));
 if(epoch!==renderEpoch)return;
 const shown=category==='upcoming'?upcoming:completed;
 app.innerHTML=`<header class="public-header public-home-header"><div class="pantry-header-brand">${pantryLogoMarkup('pantry-logo-public')}<span>Tournament</span></div><button class="ghost" id="adminLogin">Admin / Staff</button></header><main class="wrap discovery-home"><div class="hero public-hero"><div><small>THE PANTRY · LIVE TOURNAMENT</small><h1>Giải đấu & Minigame</h1><p>Khám phá giải đấu, lịch thi đấu và kết quả của The Pantry.</p></div></div>${live.length?`<section class="discovery-live-section" aria-label="Đang diễn ra"><h2><span class="live-dot"></span> ĐANG DIỄN RA</h2><div class="discovery-grid">${live.map(x=>discoveryCard(x,true,counts[x.id]||0)).join('')}</div></section>`:''}<section class="discovery-browse"><div class="discovery-tabs" role="tablist" aria-label="Danh sách giải"><button role="tab" aria-selected="${category==='upcoming'}" data-category="upcoming" class="${category==='upcoming'?'selected':''}">📅 Giải sắp diễn ra <span>${upcoming.length}</span></button><button role="tab" aria-selected="${category==='completed'}" data-category="completed" class="${category==='completed'?'selected':''}">🏆 Giải đã kết thúc <span>${completed.length}</span></button></div><div class="discovery-grid" role="tabpanel">${shown.map(x=>discoveryCard(x)).join('')||`<p class="discovery-empty">${category==='upcoming'?'Chưa có giải sắp diễn ra.':'Chưa có giải đã kết thúc.'}</p>`}</div></section></main>`;
 document.querySelector('#adminLogin').onclick=login;
 document.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>publicDashboard(b.dataset.category));
 document.querySelectorAll('[data-hub]').forEach(b=>b.onclick=e=>{e.stopPropagation();publicTournament(b.dataset.hub)});
 document.querySelectorAll('[data-info]').forEach(b=>b.onclick=e=>{e.stopPropagation();publicTournamentInfo(b.dataset.info)});
 document.querySelectorAll('[data-enter-tournament]').forEach(card=>{card.onclick=()=>publicTournament(card.dataset.enterTournament);card.onkeydown=e=>{if(e.target===card&&(e.key==='Enter'||e.key===' ')){e.preventDefault();publicTournament(card.dataset.enterTournament)}}});
 discoveryTimer=setInterval(()=>{if(vietnamToday()!==today)publicDashboard(category)},60000);
}

const posterBucket='tournament-posters';
const posterPathValid=(tid,path)=>typeof path==='string'&&new RegExp(`^${tid}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png|webp)$`).test(path);
function posterUrl(tid,path){return posterPathValid(tid,path)?supabase.storage.from(posterBucket).getPublicUrl(path).data.publicUrl:null}
async function publicTournamentInfo(tid){
 stopLive();const epoch=++renderEpoch;
 const [{data:t,error},{data:info}]=await Promise.all([
  supabase.from('tournaments').select('id,name,event_type,format,start_date,start_time').eq('id',tid).single(),
  supabase.from('tournament_info').select('content,prize_information,rules,poster_path,registration_url').eq('tournament_id',tid).maybeSingle()
 ]);
 if(epoch!==renderEpoch)return;
 if(error||!t)return publicDashboard();
 const image=posterUrl(t.id,info?.poster_path),registrationUrl=registrationLink(info?.registration_url);
 const section=(title,value)=>value?.trim()?`<section class="event-info-section"><h2>${title}</h2><p>${esc(value)}</p></section>`:'';
 app.innerHTML=`<header class="public-header public-home-header"><div class="pantry-header-brand">${pantryLogoMarkup('pantry-logo-public')}<span>Tournament</span></div><button class="ghost" id="infoBack">← Danh sách giải</button></header><main class="wrap event-info-page"><div class="event-info-hero">${image?`<div class="event-poster"><img src="${esc(image)}" alt="Poster ${esc(t.name)}" loading="eager"></div>`:''}<div class="event-info-identity"><small>${eventType(t)} · ${eventFormat(t)}</small><h1>${esc(t.name)}</h1><p>${esc(displayEventDate(t.start_date))}${t.start_time?' • '+esc(t.start_time.slice(0,5)):''}</p><div class="event-info-actions">${registrationUrl?`<a class="event-register" href="${esc(registrationUrl)}" target="_blank" rel="noopener noreferrer">ĐĂNG KÝ NGAY →</a>`:''}<button class="secondary" id="infoToHub">XEM CHI TIẾT THI ĐẤU →</button></div></div></div>${section('THÔNG TIN GIẢI',info?.content)}${section('GIẢI THƯỞNG',info?.prize_information)}${section('QUY ĐỊNH',info?.rules)}</main>`;
 const poster=app.querySelector('.event-poster img');if(poster)poster.onerror=()=>poster.parentElement.remove();
 document.querySelector('#infoBack').onclick=()=>publicDashboard();document.querySelector('#infoToHub').onclick=()=>publicTournament(tid);
}
async function publicTournament(tid,tab='overview',eventId=null){
 stopLive();const epoch=++renderEpoch;
 const {data:tournament}=await supabase.from('tournaments').select('*').eq('id',tid).single();
 if(epoch!==renderEpoch)return;if(!tournament)return publicDashboard();
 if(!await loadCompetitionEvents(tournament,eventId,epoch))return;
 const db=competitionClient(supabase,activeEvent);
 const [{data:t},{data:groups},{data:teams},{data:matches},standings,{data:awards},{data:roster,error:rosterError}]=await Promise.all([
  Promise.resolve({data:{...tournament,format:activeEvent.format}}),
  db.from('groups').select('id,name,group_order').eq('tournament_id',tid).order('group_order'),
  db.from('teams').select('id,name,registration_order').eq('tournament_id',tid).order('registration_order'),
  db.from('matches').select('id,group_id,match_code,status,team1_id,team2_id,team1_score,team2_score').eq('tournament_id',tid).eq('stage','group').order('match_code'),
  standingsData(tid),
  db.from('tournament_awards').select('placement,placement_slot,team_name,player_names').eq('tournament_id',tid).order('placement').order('placement_slot'),
  supabase.rpc('public_event_roster',{p_event_id:db.event.id})
 ]);
 if(epoch!==renderEpoch)return;
 if(!t)return publicDashboard();
 const links=(standings||[]).flatMap(item=>item.rows.map(row=>({group_id:item.group.id,team_id:row.id})));
 const tabs=[['overview','TỔNG QUAN'],['teams','VĐV / ĐỘI'],['groups','CHIA BẢNG'],['matches','TRẬN ĐẤU'],['standings','BXH'],...(awards?.length?[['awards','VINH DANH']]:[])];
 if(!tabs.some(x=>x[0]===tab))tab='overview';
 const teamMap=Object.fromEntries((teams||[]).map(x=>[x.id,x.name]));
 const members=Object.fromEntries((roster||[]).map(x=>[x.team_id,x.player_names||[]]));
 const teamOrder=Object.fromEntries((teams||[]).map((x,i)=>[x.id,i]));
 const context={t,groups:groups||[],teams:teams||[],matches:matches||[],standings:standings||[],awards:awards||[],links,teamMap,members,teamOrder,rosterError,registeredPlayers:roster?.[0]?.registered_players};
 const displayDate=t.start_date?.split('-').reverse().join('/')||'—';
 app.innerHTML=`<header class="public-header public-tournament-header"><div><button class="ghost" id="publicBack" aria-label="Quay lại danh sách giải"><span class="public-back-full">← Danh sách giải</span><span class="public-back-mobile" aria-hidden="true">←</span></button>${pantryLogoMarkup('pantry-logo-small')}<b class="public-header-title">${esc(t.name)}</b></div><button id="beReferee">⚖ Tôi là trọng tài</button></header><main class="wrap public-event public-hub"><div class="public-event-head"><div><small>${t.event_type==='minigame'?'MINIGAME':'GIẢI ĐẤU'} · ${t.format==='mlp'?'MLP':'ĐÁNH ĐÔI'}</small><h1>${esc(t.name)}</h1><p>${esc(displayDate)}${tournament.start_time?' • '+esc(tournament.start_time.slice(0,5)):''} · ${groups?.length||0} bảng</p></div>${(matches||[]).some(m=>m.status==='playing')?'<div class="live-badge"><span></span> LIVE</div>':''}</div>${publicEventSelector()}<div class="event-context">→ ${esc(activeEvent.name)}${activeEvent.start_time?' · '+esc(activeEvent.start_time.slice(0,5)):''}</div><div class="public-hub-tab-shell"><nav class="public-hub-tabs" aria-label="Nội dung giải đấu">${tabs.map(([key,label])=>`<button data-public-tab="${key}" class="${tab===key?'public-hub-tab-active':''}" ${tab===key?'aria-current="page"':''}>${label}</button>`).join('')}</nav></div><div class="public-hub-view">${publicHubContent(tab,context)}</div></main><div id="modal"></div>`;
 const tabBar=app.querySelector('.public-hub-tabs'),selectedTab=tabBar.querySelector('.public-hub-tab-active');
 if(selectedTab)tabBar.scrollLeft=selectedTab.offsetLeft-tabBar.offsetLeft-(tabBar.clientWidth-selectedTab.offsetWidth)/2;
 document.querySelector('#publicBack').onclick=publicDashboard;
 document.querySelectorAll('[data-public-event]').forEach(b=>b.onclick=()=>publicTournament(tid,tab,b.dataset.publicEvent));
 document.querySelector('#beReferee').onclick=async()=>{let saved;try{saved=JSON.parse(localStorage.getItem(`pantry_ref_${tid}`)||'null')}catch{}if(saved?.session_token){try{const row=await validRefereeSession(tid,saved.session_token);if(row){const {data:group}=await supabase.from('groups').select('event_id').eq('id',row.group_id).single();if(group?.event_id===db.event.id)return refereeConsole(tid,row.session_token,row);return refereeClaimModal(t,groups||[])}}catch(error){console.error('Referee session check:',error);return alert('Không thể kiểm tra phiên trọng tài. Thử lại sau.')}}clearRefereeSession(tid);refereeClaimModal(t,groups||[])};
 document.querySelectorAll('[data-public-tab]').forEach(button=>button.onclick=()=>publicTournament(tid,button.dataset.publicTab));
 document.querySelectorAll('[data-public-team]').forEach(button=>button.onclick=()=>publicTeamDetail(button.dataset.publicTeam,context));
 if(['overview','matches','standings'].includes(tab))startLive(`public:${tid}:${tab}`,()=>publicTournament(tid,tab));
 if(tab==='matches')mountPublicVideo({tournament_id:tid,event_id:db.event.id});
}
function publicTeamButton(id,name){
 return id?`<button class="public-hub-team-link" data-public-team="${id}">${esc(name||'TBD')}</button>`:`<span>${esc(name||'TBD')}</span>`;
}
function publicTeamDetail(id,context){
 const name=context.teamMap[id];if(!name)return;
 const names=context.members[id]||[];
 document.querySelector('#modal').innerHTML=`<div class="overlay"><section class="modal public-hub-team-modal" role="dialog" aria-modal="true" aria-label="Đội ${esc(name)}"><div class="modalhead"><div><small>VĐV / ĐỘI</small><h2>${esc(name)}</h2></div><button type="button" class="x" id="closePublicTeam" aria-label="Đóng">×</button></div>${context.rosterError?'<p>Không thể tải danh sách VĐV.</p>':names.length?`<ol>${names.map(n=>`<li>${esc(n)}</li>`).join('')}</ol>`:'<p>Chưa có VĐV.</p>'}</section></div>`;
 document.querySelector('#closePublicTeam').onclick=()=>document.querySelector('#modal').innerHTML='';
 document.querySelector('#modal .overlay').onclick=e=>{if(e.target.classList.contains('overlay'))document.querySelector('#modal').innerHTML=''};
}
function publicHubContent(tab,c){
 const {t,groups,teams,matches,standings,awards,links,teamMap,members,teamOrder,rosterError}=c;
 const names=id=>members[id]||[];
 const rosterProblem=rosterError?'<div class="public-hub-note">Không thể tải danh sách VĐV lúc này.</div>':'';
 if(tab==='overview'){
  const completed=matches.filter(m=>m.status==='completed').length;
  const date=t.start_date?.split('-').reverse().join('/')||'—';
  return `<section class="public-hub-overview"><div class="public-hub-kicker">${t.event_type==='minigame'?'MINIGAME':'GIẢI ĐẤU'} · ${t.format==='mlp'?'MLP':'ĐÁNH ĐÔI'}</div><h2>${esc(t.name)}</h2><p>${esc(date)}</p><div class="public-hub-stats"><div><strong>${teams.length}</strong><span>đội / cặp</span></div><div><strong>${rosterError?'—':c.registeredPlayers??0}</strong><span>VĐV</span></div><div><strong>${groups.length}</strong><span>bảng</span></div><div><strong>${completed} / ${matches.length}</strong><span>trận đã đấu</span></div></div>${rosterProblem}</section>`;
 }
 if(tab==='teams')return `${rosterProblem}<div class="public-hub-team-grid">${teams.map(team=>`<article class="public-hub-team-card"><div class="public-hub-team-title">${publicTeamButton(team.id,team.name)}</div>${rosterError?'':names(team.id).length?`<ol>${names(team.id).map(n=>`<li>${esc(n)}</li>`).join('')}</ol><p class="public-hub-member-line">${names(team.id).map(esc).join(' · ')}</p>`:'<p class="public-hub-member-empty">Chưa có VĐV.</p><p class="public-hub-member-line">Chưa có VĐV.</p>'}</article>`).join('')||'<div class="public-hub-empty">Chưa có đội đăng ký.</div>'}</div>`;
 if(tab==='groups')return `${rosterProblem}<div class="public-hub-group-grid">${groups.map(group=>{const assigned=links.filter(x=>x.group_id===group.id).sort((a,b)=>(teamOrder[a.team_id]??9999)-(teamOrder[b.team_id]??9999));return `<section class="public-hub-group-card"><h2>Bảng ${esc(group.name)}</h2><ol>${assigned.map(link=>`<li><div>${publicTeamButton(link.team_id,teamMap[link.team_id])}</div>${rosterError?'':`<small>${names(link.team_id).map(esc).join(' · ')}</small>`}</li>`).join('')||'<li>Chưa có đội.</li>'}</ol></section>`}).join('')||'<div class="public-hub-empty">Chưa chia bảng.</div>'}</div>`;
 if(tab==='matches')return groups.map(group=>{const gm=matches.filter(m=>m.group_id===group.id);return `<section class="public-hub-match-group"><div class="public-hub-section-head"><h2>Bảng ${esc(group.name)}</h2><span>${gm.filter(m=>m.status==='completed').length}/${gm.length} trận</span></div><div class="public-hub-match-list">${gm.map(m=>`<article class="public-hub-match-card"><div class="public-hub-match-code">${esc(m.match_code)}</div><div class="public-hub-match-team">${publicTeamButton(m.team1_id,teamMap[m.team1_id])}</div><div class="public-hub-match-score ${m.status==='playing'?'public-hub-score-live':''}">${m.status==='playing'||m.status==='completed'?`${m.team1_score??0} — ${m.team2_score??0}`:'—'}</div><div class="public-hub-match-team">${publicTeamButton(m.team2_id,teamMap[m.team2_id])}</div><div class="public-hub-match-state ${m.status==='playing'?'public-hub-state-live':''}">${m.status==='playing'?'● LIVE':m.status==='completed'?'Kết thúc':'Chưa đấu'}</div><div class="public-video-slot" data-public-video="${esc(m.id)}" data-video-label="${esc(m.match_code)}">Đang kiểm tra video…</div></article>`).join('')||'<p>Chưa có lịch thi đấu.</p>'}</div></section>`}).join('')||'<div class="public-hub-empty">Chưa chia bảng.</div>';
 if(tab==='standings')return standings.map(item=>`<section class="public-hub-standings"><div class="public-hub-section-head"><h2>Bảng ${esc(item.group.name)}</h2></div><div class="public-hub-table-wrap"><table><thead><tr><th>#</th><th>Đội</th><th>Tr</th><th>W</th><th>L</th><th>+/-</th></tr></thead><tbody>${item.rows.map((row,i)=>`<tr class="${i<2?'qualify-row':''}"><td>${i+1}</td><td>${publicTeamButton(row.id,row.name)}</td><td>${row.p}</td><td>${row.w}</td><td>${row.l}</td><td>${row.diff>0?'+':''}${row.diff}</td></tr>`).join('')}</tbody></table></div></section>`).join('')||'<div class="public-hub-empty">Chưa có bảng xếp hạng.</div>';
 if(tab==='awards')return awardShowcase(awards);
 return '';
}
function refereeClaimModal(t,groups){
 if(!groups.length)return alert('Giải chưa có bảng.');document.querySelector('#modal').innerHTML=`<div class="overlay"><form class="modal referee-claim" id="refClaim"><div class="modalhead"><div><small>${esc(t.name)} → ${esc(activeEvent.name)}</small><h2>⚖ Tôi là trọng tài</h2></div><button type="button" class="x">×</button></div><p>Nhập thông tin Admin đã cấp. Bạn chỉ được nhập điểm của bảng phụ trách.</p><label>Tên trọng tài<input name="name" required placeholder="VD: Minh"></label><label>Bảng phụ trách<select name="group">${groups.map(g=>`<option value="${g.id}">Bảng ${esc(g.name)}</option>`).join('')}</select></label><label>Mã trọng tài<input name="code" required inputmode="numeric" autocomplete="one-time-code" placeholder="Mã Admin cung cấp"></label><button class="wide">Vào bàn trọng tài</button><div id="refMsg"></div></form></div>`;
 const f=document.querySelector('#refClaim');f.querySelector('.x').onclick=()=>document.querySelector('#modal').innerHTML='';f.onsubmit=async e=>{e.preventDefault();const fd=new FormData(f),btn=f.querySelector('.wide');btn.disabled=true;btn.textContent='Đang xác thực…';const {data,error}=await supabase.rpc('claim_referee_access',{p_tournament_id:t.id,p_group_id:fd.get('group'),p_referee_name:fd.get('name'),p_code:fd.get('code')});const row=data?.[0];if(error||!row){btn.disabled=false;btn.textContent='Vào bàn trọng tài';f.querySelector('#refMsg').textContent=error?.message||'Mã không hợp lệ hoặc tạm thời bị khóa.';return}localStorage.setItem(`pantry_ref_${t.id}`,JSON.stringify(row));localStorage.setItem('pantry_ref_active',t.id);document.querySelector('#modal').innerHTML='';refereeConsole(t.id,row.session_token,row)};
}
async function refereeConsole(tid,token,validated=null,showList=false){
 stopLive();const epoch=++renderEpoch;let saved=validated;
 if(!saved)try{saved=await validRefereeSession(tid,token)}catch(error){console.error('Referee session check:',error);return publicTournament(tid)}
 if(epoch!==renderEpoch)return;if(!saved||saved.session_token!==token){clearRefereeSession(tid);return publicTournament(tid)}
 localStorage.setItem(`pantry_ref_${tid}`,JSON.stringify(saved));
 const {data:refGroup}=await supabase.from('groups').select('event_id').eq('id',saved.group_id).eq('tournament_id',tid).single();
 if(epoch!==renderEpoch)return;
 if(!refGroup||!await loadCompetitionEvents({id:tid},refGroup.event_id,epoch))return;
 const db=competitionClient(supabase,activeEvent);
 const [{data:t},{data:g},{data:teams},{data:matches},{data:mlp},{data:slots},{data:active,error:activeError},standings]=await Promise.all([
  supabase.from('tournaments').select('*').eq('id',tid).single(),
  db.from('groups').select('*').eq('id',saved.group_id).eq('tournament_id',tid).single(),
  db.from('teams').select('id,name').eq('tournament_id',tid),
  db.from('matches').select('*').eq('tournament_id',tid).eq('group_id',saved.group_id).eq('stage','group').order('match_code'),
  db.from('mlp_configs').select('style,members_per_team').eq('tournament_id',tid).maybeSingle(),
  db.from('mlp_slots').select('id').eq('tournament_id',tid),
  supabase.rpc('referee_live_state',{p_session_token:token}),standingsData(tid)
 ]);
 if(epoch!==renderEpoch)return;
 if(activeError){console.error('Active match:',activeError);return publicTournament(tid)}
 if(active&&!showList)return renderScoreboard(tid,token,active);
 const tm=Object.fromEntries((teams||[]).map(x=>[x.id,x.name])),st=(standings||[]).find(x=>x.group.id===saved.group_id)?.rows||[],isMini=mlp?.style==='mini'||mlp?.members_per_team===3||slots?.length===3,isBasic=activeEvent.format==='mlp'&&!isMini;
 const cards=(matches||[]).map(m=>{
  const team1=esc(tm[m.team1_id]||'TBD'),team2=esc(tm[m.team2_id]||'TBD'),code=esc(m.match_code);
  if(isBasic)return `<article class="ref-match ${m.status==='completed'?'done':''}"><div class="ref-order"><span>${code}</span></div><div class="ref-teams"><b>${team1}</b><span>VS</span><b>${team2}</b></div><div class="series-result"><b>${m.team1_score??'–'}</b><span>:</span><b>${m.team2_score??'–'}</b></div><button data-ref-mlp="${m.id}">Nhập game MLP</button></article>`;
  if(m.status==='completed')return `<article class="ref-match done ref-completed"><strong>${code} ✓</strong><span>${team1} <b>${m.team1_score}–${m.team2_score}</b> ${team2}</span><button class="ghost" data-ref-correct="${m.id}">Sửa kết quả</button></article>`;
  const playing=m.status==='playing',owned=active?.match_id===m.id;
  return `<article class="ref-match ref-scheduled ${playing?'ref-playing':''}"><div class="ref-match-head"><b>${code}</b><span>${playing?'🔴 LIVE':'CHƯA BẮT ĐẦU'}</span></div><div class="ref-match-teams">${team1} <span>vs</span> ${team2}</div>${playing?`<div class="ref-current-score">${m.team1_score??0}–${m.team2_score??0}</div>`:`<div class="ref-start-options"><label>Đích điểm<input type="number" inputmode="numeric" min="1" max="999" step="1" required data-ref-target="${m.id}" value="${m.score_target??11}"></label><label class="ref-win-two"><input type="checkbox" data-ref-win-two="${m.id}" ${m.win_by_two!==false?'checked':''}> Thắng cách 2 điểm</label></div>`}<button class="ref-start-button" data-live-start="${m.id}" ${active&&!owned?'disabled':''}>${owned?'TIẾP TỤC CHẤM ĐIỂM':playing?'MỞ BẢNG ĐIỂM':'BẮT ĐẦU TRẬN NÀY'}</button><div class="ref-target-error" role="alert" data-ref-target-error="${m.id}"></div></article>`;
 }).join('');
 app.innerHTML=`<header class="ref-header"><div><button class="ghost" id="leaveRef">← Rời bàn</button>${pantryLogoMarkup('pantry-logo-small')}<b>⚖ Bảng ${esc(g?.name||saved.group_name)}</b></div><div class="ref-name">${esc(saved.referee_name)}</div></header><main class="wrap referee-page"><div class="referee-banner"><div><small>REFEREE MODE</small><h1>Bảng ${esc(g?.name||saved.group_name)}</h1><p>${esc(t?.name)} → ${esc(activeEvent.name)} · Chỉ nhập kết quả của bảng này.</p></div></div>${active?`<button class="ref-active-banner" id="resumeLive">🔴 Trận ${esc(active.match_code)} đang thi đấu · Tiếp tục</button>`:''}<div class="ref-layout"><section><div class="ref-match-list">${cards||'<div class="panel">Chưa có trận.</div>'}</div></section><aside class="ref-standing"><h3>BXH LIVE</h3><table><tr><th>#</th><th>Đội</th><th>W</th><th>+/-</th></tr>${st.map((r,i)=>`<tr class="${i<2?'qualify-row':''}"><td>${i+1}</td><td><b>${esc(r.name)}</b></td><td>${r.w}</td><td>${r.diff>0?'+':''}${r.diff}</td></tr>`).join('')}</table></aside></div></main><div id="modal"></div>`;
 document.querySelector('#leaveRef').onclick=()=>publicTournament(tid);
 if(active)document.querySelector('#resumeLive').onclick=()=>renderScoreboard(tid,token,active);
 document.querySelectorAll('[data-ref-mlp]').forEach(b=>b.onclick=()=>refereeMlpModal(tid,token,(matches||[]).find(x=>x.id===b.dataset.refMlp),tm));
 document.querySelectorAll('[data-ref-correct]').forEach(b=>b.onclick=()=>{
  const m=(matches||[]).find(x=>x.id===b.dataset.refCorrect);
  document.querySelector('#modal').innerHTML=`<div class="overlay"><form class="modal" id="correctScore"><div class="modalhead"><h2>Sửa kết quả ${esc(m.match_code)}</h2><button type="button" class="x">×</button></div><p>${esc(tm[m.team1_id])} vs ${esc(tm[m.team2_id])}</p><div class="twocol"><label>${esc(tm[m.team1_id])}<input name="score1" type="number" min="0" required value="${m.team1_score}"></label><label>${esc(tm[m.team2_id])}<input name="score2" type="number" min="0" required value="${m.team2_score}"></label></div><button class="wide">Lưu kết quả sửa</button><div id="correctMsg"></div></form></div>`;
  const f=document.querySelector('#correctScore');f.querySelector('.x').onclick=()=>document.querySelector('#modal').innerHTML='';
  f.onsubmit=async e=>{e.preventDefault();const fd=new FormData(f),a=+fd.get('score1'),c=+fd.get('score2');if(a===c)return f.querySelector('#correctMsg').textContent='Tỉ số không được hòa.';const save=f.querySelector('.wide');save.disabled=true;save.textContent='Đang lưu…';const {error}=await supabase.rpc('referee_submit_score',{p_session_token:token,p_match_id:m.id,p_team1_score:a,p_team2_score:c});if(error){save.disabled=false;save.textContent='Lưu kết quả sửa';return refereeWriteError(tid,token,error)}document.querySelector('#modal').innerHTML='';refereeConsole(tid,token,null,true)};
 });
 document.querySelectorAll('[data-live-start]').forEach(b=>b.onclick=async()=>{
  if(active?.match_id===b.dataset.liveStart)return renderScoreboard(tid,token,active);
  const id=b.dataset.liveStart,match=(matches||[]).find(m=>m.id===id);
  const input=document.querySelector(`[data-ref-target="${id}"]`),raw=input?.value.trim(),target=match?.status==='playing'?match.score_target:Number(raw);
  if(match?.status!=='playing'&&(!raw||!/^[0-9]+$/.test(raw)||!Number.isInteger(target)||target<1||target>999)){
   document.querySelector(`[data-ref-target-error="${id}"]`).textContent='Đích điểm phải là số nguyên từ 1 đến 999.';input?.focus();return;
  }
  b.disabled=true;b.textContent='ĐANG MỞ…';stopLive();
  const winTwo=document.querySelector(`[data-ref-win-two="${id}"]`)?.checked??true;
  const {data,error}=await supabase.rpc('referee_live_start',{p_session_token:token,p_match_id:id,p_score_target:target,p_win_by_two:winTwo});
  if(error){await refereeWriteError(tid,token,error);return refereeConsole(tid,token,null,true)}
  renderScoreboard(tid,token,data);
 });
 startLive(`ref:${tid}`,()=>refereeConsole(tid,token,null,showList));
}
async function loadScoreboard(tid,token){
 const epoch=renderEpoch,{data,error}=await supabase.rpc('referee_live_state',{p_session_token:token});
 if(epoch!==renderEpoch)return;
 if(error){await refereeWriteError(tid,token,error);return}
 if(!data)return refereeConsole(tid,token,null,true);
 renderScoreboard(tid,token,data);
}
let scoreTapLockUntil=0;
function renderScoreboard(tid,token,state,message='',pulseTeam=0){
 stopLive();renderEpoch++;
 const s1=+state.team1_score,s2=+state.team2_score,ready=state.can_finish===true;
 app.innerHTML=`<main class="scorekeeper-shell"><header class="scorekeeper-header"><button class="ghost" id="scoreBack">← Danh sách</button><div><b>${esc(state.match_code)}</b><small>${esc(state.tournament_name)} → ${esc(state.event_name)} · Bảng ${esc(state.group_name)}</small></div>${pantryLogoMarkup('pantry-logo-scorekeeper')}<span class="scorekeeper-live">● LIVE</span></header><div class="scorekeeper-content"><div class="scorekeeper-rules"><span>ĐÍCH ${state.score_target} ĐIỂM</span><span>${state.win_by_two?'THẮNG CÁCH 2':'THẮNG CÁCH 1'}</span></div><div class="scorekeeper-teams">${[1,2].map(n=>`<section class="scorekeeper-team"><div class="scorekeeper-team-name">${esc(n===1?state.team1_name:state.team2_name)}</div><div class="scorekeeper-score ${pulseTeam===n?'scorekeeper-score-pulse':''}" data-score="${n}">${n===1?s1:s2}</div><div class="scorekeeper-actions"><button class="scorekeeper-plus" data-score-team="${n}" data-score-delta="1" aria-label="Cộng một điểm cho ${esc(n===1?state.team1_name:state.team2_name)}">＋</button><button class="scorekeeper-minus" data-score-team="${n}" data-score-delta="-1" ${n===1&&s1===0||n===2&&s2===0?'disabled':''} aria-label="Trừ một điểm cho ${esc(n===1?state.team1_name:state.team2_name)}">− <span>Hoàn tác</span></button></div></section>`).join('')}</div>${ready?'<button class="scorekeeper-finish" id="finishLive">🏁 KẾT THÚC TRẬN</button>':''}<div class="scorekeeper-feedback" id="scoreFeedback" role="status">${esc(message)}</div>${ready?'':'<p class="scorekeeper-hint">Trận chỉ có thể kết thúc khi đạt đích điểm và đủ cách biệt.</p>'}</div><div id="modal"></div></main>`;
 document.querySelector('#scoreBack').onclick=()=>refereeConsole(tid,token,null,true);
 document.querySelectorAll('[data-score-team]').forEach(b=>b.onclick=async()=>{
  if(Date.now()<scoreTapLockUntil)return;scoreTapLockUntil=Date.now()+500;
  app.querySelectorAll('button').forEach(x=>x.disabled=true);
  const score=app.querySelector(`[data-score="${b.dataset.scoreTeam}"]`);score.classList.add('scorekeeper-score-pending');
  document.querySelector('#scoreFeedback').textContent='Đang lưu điểm…';stopLive();
  const {data,error}=await supabase.rpc('referee_live_adjust',{p_session_token:token,p_match_id:state.match_id,p_team:+b.dataset.scoreTeam,p_delta:+b.dataset.scoreDelta,p_expected_version:state.version,p_expected_team1_score:s1,p_expected_team2_score:s2,p_action_id:crypto.randomUUID()});
  if(error){if(await refereeWriteError(tid,token,error))return loadScoreboard(tid,token);return}
  if(!data.stale&&data[`team${b.dataset.scoreTeam}_score`]!==state[`team${b.dataset.scoreTeam}_score`]&&navigator.vibrate)navigator.vibrate(10);
  renderScoreboard(tid,token,data,data.stale?'Điểm đã đổi trên thiết bị khác. Kiểm tra rồi bấm lại.':'Đã lưu điểm',data.stale?0:+b.dataset.scoreTeam);
 });
 if(ready)document.querySelector('#finishLive').onclick=()=>{
  document.querySelector('#modal').innerHTML=`<div class="overlay"><div class="modal scorekeeper-confirm"><h2>🏁 KẾT THÚC TRẬN?</h2><p>Đội thắng: <b>${esc(state.winner_name)}</b></p><p>Tỉ số cuối: <strong>${s1}–${s2}</strong></p><div class="scorekeeper-confirm-actions"><button class="ghost" id="cancelFinish">Hủy</button><button id="confirmFinish">Xác nhận kết thúc</button></div><div id="finishMsg" role="status"></div></div></div>`;
  document.querySelector('#cancelFinish').onclick=()=>document.querySelector('#modal').innerHTML='';
  document.querySelector('#confirmFinish').onclick=async()=>{
   const confirmButton=document.querySelector('#confirmFinish');confirmButton.disabled=true;document.querySelector('#cancelFinish').disabled=true;document.querySelector('#finishMsg').textContent='Đang xác nhận…';stopLive();
   const {data,error}=await supabase.rpc('referee_live_finish',{p_session_token:token,p_match_id:state.match_id,p_expected_version:state.version,p_expected_team1_score:s1,p_expected_team2_score:s2});
   if(error){if(await refereeWriteError(tid,token,error))return loadScoreboard(tid,token);return}
   if(data.stale)return renderScoreboard(tid,token,data,'Điểm đã đổi trên thiết bị khác. Hãy xác nhận lại.');
   refereeConsole(tid,token,null,true);
  };
 };
 startLive(`score:${tid}`,()=>loadScoreboard(tid,token));
}

async function refereeMlpModal(tid,token,match,tm){const db=competitionClient(supabase,activeEvent);
 const epoch=renderEpoch;
 const {data:games}=await db.from('mlp_games').select('*').eq('match_id',match.id).order('game_order');if(epoch!==renderEpoch)return;const map=Object.fromEntries((games||[]).map(g=>[g.game_order,g])),types=[['women_doubles','Đôi nữ'],['men_doubles','Đôi nam'],['mixed_1','Mixed 1'],['mixed_2','Mixed 2']],a4=(games||[]).filter(g=>g.game_order<=4&&g.winner_team_id===match.team1_id).length,b4=(games||[]).filter(g=>g.game_order<=4&&g.winner_team_id===match.team2_id).length,needDB=((games||[]).filter(g=>g.game_order<=4).length===4&&a4===2&&b4===2),rows=[...types,...(needDB?[['dreambreaker','DreamBreaker']]:[])];
 document.querySelector('#modal').innerHTML=`<div class="overlay"><div class="modal mlp-match-modal"><div class="modalhead"><div><small>TRỌNG TÀI · ${esc(match.match_code)}</small><h2>${esc(tm[match.team1_id])} <span class="mlp-vs">vs</span> ${esc(tm[match.team2_id])}</h2></div><button class="x">×</button></div><div class="mlp-game-list">${rows.map(([type,label],i)=>{const n=i+1,g=map[n];return `<div class="mlp-game-row ${g?'game-done':''}"><div class="mlp-game-no">G${n}</div><div class="mlp-game-name"><b>${label}</b><small>${n===5?'Quyết định khi 2–2':'Game '+n}</small></div><div class="mlp-game-score"><input type="number" min="0" data-rg1="${n}" value="${g?.team1_score??''}"><span>:</span><input type="number" min="0" data-rg2="${n}" value="${g?.team2_score??''}"></div><button data-rg-save="${n}" data-type="${type}" class="${g?'saved-btn':''}">${g?'Sửa':'Lưu'}</button></div>`}).join('')}</div><div class="mlp-match-note">${needDB?'Đang hòa 2–2 · nhập DreamBreaker.':'Nhập lần lượt 4 game chính.'}</div></div></div>`;document.querySelector('#modal .x').onclick=()=>document.querySelector('#modal').innerHTML='';
 document.querySelectorAll('[data-rg-save]').forEach(b=>b.onclick=async()=>{const n=+b.dataset.rgSave,a=document.querySelector(`[data-rg1="${n}"]`).value,c=document.querySelector(`[data-rg2="${n}"]`).value;if(a===''||c==='')return alert('Nhập đủ tỉ số.');if(+a===+c)return alert('Tỉ số không được hòa.');if(!confirm(`Xác nhận G${n}: ${a} – ${c}?`))return;const {error}=await supabase.rpc('referee_submit_mlp_game',{p_session_token:token,p_match_id:match.id,p_game_order:n,p_game_type:b.dataset.type,p_team1_score:+a,p_team2_score:+c});if(error)return refereeWriteError(tid,token,error);document.querySelector('#modal').innerHTML='';refereeConsole(tid,token)});
}

function login(){stopLive();renderEpoch++;app.innerHTML=`<main class="login"><section><button class="ghost public-login-back" id="loginBack">← Xem giải đấu</button><div class="brand">THE PANTRY</div><h1>Tournament Manager</h1><p>Vận hành giải đấu & minigame pickleball.</p><form id="login"><label>Email<input name="email" type="email" required></label><label>Mật khẩu<input name="password" type="password" required></label><button>Đăng nhập</button><div id="msg"></div></form></section></main>`;document.querySelector('#loginBack').onclick=publicDashboard;document.querySelector('#login').onsubmit=async e=>{e.preventDefault();let f=new FormData(e.target);let {error}=await supabase.auth.signInWithPassword({email:f.get('email'),password:f.get('password')});if(error)return document.querySelector('#msg').textContent=error.message;boot()}}
async function dashboard(){
 stopLive();const epoch=++renderEpoch;
 const {data:t}=await supabase.from('tournaments').select('*').order('start_date',{ascending:false});if(epoch!==renderEpoch)return;
 const isAdmin=String(profile?.role||'').toLowerCase()==='admin';
 app.innerHTML=`<header class="dashboard-header"><div class="pantry-header-brand">${pantryLogoMarkup('pantry-logo-dashboard')}<span>Tournament Manager</span></div><div class="dashboard-account">${esc(profile?.full_name)} · ${esc(profile?.role)} <button class="ghost" id="logout">Đăng xuất</button></div></header><main class="wrap"><div class="hero"><div><small>CONTROL CENTER</small><h1>Giải đấu & Minigame</h1><p>Tạo giải, import VĐV, chia bảng và nhập kết quả tại một nơi.</p></div><button id="new">＋ Tạo giải</button></div><div id="dashboardMsg" class="dashboard-message" role="status"></div><div class="cards" id="tournamentCards">${(t||[]).map(x=>`<article class="card tournament-card" data-id="${x.id}"><div class="pill">${x.event_type==='minigame'?'MINIGAME':'GIẢI ĐẤU'}</div><h3>${esc(x.name)}</h3><p>${x.format==='mlp'?'Đồng đội / MLP':'Đánh đôi'} · ${esc(x.start_date)}</p><strong>${esc(x.status)}</strong>${isAdmin?`<button class="tournament-delete" data-delete-tournament="${x.id}" aria-label="Xóa giải ${esc(x.name)}">Xóa giải</button>`:''}</article>`).join('')||'<div class="empty">Chưa có giải nào. Tạo giải đầu tiên để bắt đầu.</div>'}</div></main><div id="modal"></div>`;
 document.querySelector('#logout').onclick=async()=>{await supabase.auth.signOut();session=null;render()};
 document.querySelector('#new').onclick=createModal;
 document.querySelectorAll('.tournament-card').forEach(c=>c.onclick=()=>workspace(c.dataset.id));
 if(isAdmin)document.querySelectorAll('[data-delete-tournament]').forEach(b=>b.onclick=e=>{
  e.stopPropagation();
  const tournament=(t||[]).find(x=>x.id===b.dataset.deleteTournament);
  if(tournament)deleteTournamentModal(tournament);
 });
}
function deleteTournamentModal(tournament){
 const modal=document.querySelector('#modal');
 modal.innerHTML=`<div class="overlay"><div class="modal tournament-delete-modal" role="dialog" aria-modal="true" aria-labelledby="deleteTournamentTitle"><h2 id="deleteTournamentTitle">Xóa giải</h2><p>Bạn có chắc muốn xóa giải "<strong>${esc(tournament.name)}</strong>"?</p><p>Toàn bộ bảng đấu, trận đấu, tỉ số và dữ liệu của giải này sẽ bị xóa.</p><div class="tournament-delete-actions"><button class="ghost" id="cancelTournamentDelete">Hủy</button><button class="danger" id="confirmTournamentDelete">Xóa giải</button></div><div id="deleteTournamentMsg" role="alert"></div></div></div>`;
 const cancel=modal.querySelector('#cancelTournamentDelete'),confirm=modal.querySelector('#confirmTournamentDelete');
 cancel.onclick=()=>modal.innerHTML='';
 confirm.onclick=async()=>{
  confirm.disabled=true;cancel.disabled=true;confirm.textContent='Đang xóa…';
  let posterPath=null,posterLookupFailed=false;
  try{
   const {data:info,error:lookupError}=await supabase.from('tournament_info').select('poster_path').eq('tournament_id',tournament.id).maybeSingle();
   posterLookupFailed=!!lookupError;posterPath=info?.poster_path||null;
  }catch{posterLookupFailed=true}
  const {error}=await supabase.rpc('delete_tournament',{p_tournament_id:tournament.id});
  if(error){confirm.disabled=false;cancel.disabled=false;confirm.textContent='Xóa giải';modal.querySelector('#deleteTournamentMsg').textContent=error.message;return}
  modal.innerHTML='';
  document.querySelectorAll('.tournament-card').forEach(c=>{if(c.dataset.id===tournament.id)c.remove()});
  if(!document.querySelector('.tournament-card'))document.querySelector('#tournamentCards').innerHTML='<div class="empty">Chưa có giải nào. Tạo giải đầu tiên để bắt đầu.</div>';
  document.querySelector('#dashboardMsg').textContent='✓ Đã xóa giải';
  if(posterLookupFailed)document.querySelector('#dashboardMsg').textContent='✓ Đã xóa giải. Không thể kiểm tra poster cũ; Admin cần kiểm tra Storage.';
  else if(posterPathValid(tournament.id,posterPath)){
   try{
    const {error:posterError}=await supabase.storage.from(posterBucket).remove([posterPath]);
    if(posterError)throw posterError;
   }catch{document.querySelector('#dashboardMsg').textContent='✓ Đã xóa giải. Không thể dọn poster; Admin cần kiểm tra Storage.'}
  }
 };
}

function mlpStyleFields(){return `<div class="mlpbox"><p class="label">Style MLP</p><div class="formats mlp-styles"><label><input type="radio" name="mlp_style" value="basic" checked><span><b>MLP Cơ bản</b><small>4 VĐV · 2 Nam + 2 Nữ</small></span></label><label><input type="radio" name="mlp_style" value="mini"><span><b>MLP Mini</b><small>3 VĐV · Không phân giới tính</small></span></label></div><div class="mlp-style-note" id="mlpStyleNote">Excel: Tên đội · Nam 1 · Nam 2 · Nữ 1 · Nữ 2</div></div>`}
function createModal(){
 const epoch=renderEpoch;
 document.querySelector('#modal').innerHTML=`<div class="overlay"><form class="modal" id="create"><div class="modalhead"><div><small>TẠO WORKSPACE</small><h2>Tạo giải mới</h2></div><button type="button" class="x">×</button></div><label>Tên giải / Minigame<input name="name" required></label><div class="twocol"><label>Loại<select name="event_type"><option value="tournament">Giải đấu</option><option value="minigame">Minigame</option></select></label><label>Ngày bắt đầu<input name="start_date" type="date" required></label></div><label>Giờ bắt đầu giải<input name="start_time" type="time"></label><p class="label">Format thi đấu</p><div class="formats"><label><input type="radio" name="format" value="doubles" checked><span><b>👥 Đánh đôi</b><small>2 VĐV / đội</small></span></label><label><input type="radio" name="format" value="mlp"><span><b>🛡 Đồng đội / MLP</b><small>Chọn style MLP</small></span></label></div><div id="mlp"></div><label><span id="expectedLabel">Số cặp VĐV dự kiến</span><input name="expected_team_count" type="number" min="1" step="1"></label><button class="wide">Tạo giải</button><div id="msg" role="alert"></div></form></div>`;
 const form=document.querySelector('#create');form.querySelector('.x').onclick=()=>document.querySelector('#modal').innerHTML='';
 const syncMlp=()=>{
  const mlp=form.querySelector('[name=format]:checked').value==='mlp';
  form.querySelector('#expectedLabel').textContent=mlp?'Số đội dự kiến':'Số cặp VĐV dự kiến';
  form.querySelector('#mlp').innerHTML=mlp?mlpStyleFields():'';
  form.querySelectorAll('[name=mlp_style]').forEach(r=>r.onchange=()=>{form.querySelector('#mlpStyleNote').textContent=r.value==='basic'?'Excel: Tên đội · Nam 1 · Nam 2 · Nữ 1 · Nữ 2':'Excel: Tên đội · VĐV 1 · VĐV 2 · VĐV 3'});
 };
 form.querySelectorAll('[name=format]').forEach(r=>r.onchange=syncMlp);
 form.onsubmit=async e=>{
  e.preventDefault();const f=new FormData(form),button=form.querySelector('.wide');button.disabled=true;
  const {data,error}=await supabase.rpc('create_competition_tournament',{
   p_name:f.get('name').trim(),p_event_type:f.get('event_type'),p_start_date:f.get('start_date'),
   p_start_time:f.get('start_time')||null,p_format:f.get('format'),
   p_expected_team_count:f.get('expected_team_count')?Number(f.get('expected_team_count')):null,p_style:f.get('mlp_style')||'basic'
  });
  if(error){button.disabled=false;form.querySelector('#msg').textContent=error.message;return}
  if(epoch===renderEpoch)await workspace(data);
 };
}

async function loadCompetitionEvents(tournament,requestedId,epoch){
 const {data,error}=await supabase.from('tournament_events').select('*').eq('tournament_id',tournament.id).order('sort_order').order('created_at');
 if(epoch!==renderEpoch)return false;
 if(error||!data?.length){
  app.innerHTML=`<main class="wrap"><div class="panel"><h1>Chưa tải được nội dung giải</h1><p>${esc(error?.message||'Chưa tìm thấy nội dung giải. Vui lòng thử lại hoặc liên hệ ban tổ chức.')}</p><button id="eventLoadBack">← Danh sách giải</button></div></main>`;
  document.querySelector('#eventLoadBack').onclick=render;return false;
 }
 const preferred=requestedId||(activeEvent?.tournament_id===tournament.id?activeEvent.id:null);
 tournamentEvents=data;activeEvent=data.find(e=>e.id===preferred)||data.find(e=>e.is_default)||data[0];
 return true;
}
function publicEventSelector(){
 if(tournamentEvents.length===1)return '';
 return `<nav class="competition-tabs" aria-label="Nội dung giải">${tournamentEvents.map(e=>`<button class="${e.id===activeEvent.id?'':'secondary'}" data-public-event="${e.id}" aria-pressed="${e.id===activeEvent.id}">${esc(e.name)}</button>`).join('')}</nav>`;
}
function competitionEventCards(t){
 const canManage=['admin','staff'].includes(String(profile?.role||'').toLowerCase());
 return `<section class="competition-events"><div class="toolbar"><div><h2>NỘI DUNG GIẢI</h2><p>${esc(displayEventDate(t.start_date))}${t.start_time?' • '+esc(t.start_time.slice(0,5)):''}</p></div>${canManage?'<button id="addCompetitionEvent">＋ Thêm nội dung</button>':''}</div><div class="competition-grid">${tournamentEvents.map(e=>`<article class="panel competition-card ${e.id===activeEvent.id?'competition-active':''}"><h3>${esc(e.name)}</h3><p>${e.start_time?esc(e.start_time.slice(0,5)):'Chưa có giờ dự kiến'} · ${eventFormat(e)}</p>${e.expected_team_count?`<p>${e.expected_team_count} ${e.format==='mlp'?'đội':'cặp'} dự kiến</p>`:''}<button data-open-event="${e.id}" class="${e.id===activeEvent.id?'':'secondary'}">${e.id===activeEvent.id?'Đang quản lý':'→ Quản lý nội dung'}</button>${canManage?`<div class="actions"><button class="ghost" data-edit-event="${e.id}">Sửa nội dung</button><button class="danger" data-delete-event="${e.id}" ${tournamentEvents.length===1?'disabled':''}>Xóa nội dung</button></div>`:''}</article>`).join('')}</div><p class="event-context">${esc(t.name)} → <strong>${esc(activeEvent.name)}</strong></p></section>`;
}
function bindCompetitionEvents(t,tab){
 const epoch=renderEpoch;
 document.querySelector('#addCompetitionEvent')?.addEventListener('click',()=>competitionEventModal(t));
 document.querySelectorAll('[data-open-event]').forEach(b=>b.onclick=()=>workspace(t.id,tab,b.dataset.openEvent));
 document.querySelectorAll('[data-edit-event]').forEach(b=>b.onclick=()=>competitionEventModal(t,tournamentEvents.find(e=>e.id===b.dataset.editEvent)));
 document.querySelectorAll('[data-delete-event]').forEach(b=>b.onclick=async()=>{
  const event=tournamentEvents.find(e=>e.id===b.dataset.deleteEvent);
  if(!confirm(`Xóa nội dung “${event.name}”? Chỉ có thể xóa nội dung chưa có dữ liệu thi đấu.`))return;
  b.disabled=true;const {error}=await supabase.rpc('delete_competition_event',{p_event_id:event.id});
  if(error){b.disabled=false;return alert(error.message)}
  if(epoch===renderEpoch)await workspace(t.id);
 });
}
function competitionEventModal(t,event=null){
 const epoch=renderEpoch;
 document.querySelector('#modal').innerHTML=`<div class="overlay"><form class="modal" id="competitionEventForm"><div class="modalhead"><h2>${event?'Sửa nội dung':'Thêm nội dung'}</h2><button type="button" class="x">×</button></div><label>Tên nội dung<input name="name" required maxlength="160" value="${esc(event?.name||'')}" placeholder="VD: Đôi hỗn hợp 4.8"></label><label>Giờ dự kiến bắt đầu<input name="start_time" type="time" value="${esc(event?.start_time?.slice(0,5)||'')}"></label><label>Format thi đấu<select name="format"><option value="doubles" ${event?.format==='mlp'?'':'selected'}>Đánh đôi</option><option value="mlp" ${event?.format==='mlp'?'selected':''}>Đồng đội / MLP</option></select></label><div id="eventMlpStyle"></div><label><span id="eventExpectedLabel"></span><input name="expected_team_count" type="number" min="1" step="1" value="${event?.expected_team_count??''}"></label><p>Số lượng dự kiến chỉ để lên kế hoạch, không giới hạn đăng ký. Format chỉ đổi được khi chưa có đội hoặc trận đấu.</p><button class="wide">Lưu nội dung</button><p id="eventFormError" role="alert"></p></form></div>`;
 const form=document.querySelector('#competitionEventForm');form.querySelector('.x').onclick=()=>document.querySelector('#modal').innerHTML='';
 const sync=()=>{const mlp=form.elements.format.value==='mlp';form.querySelector('#eventExpectedLabel').textContent=mlp?'Số đội dự kiến':'Số cặp VĐV dự kiến';form.querySelector('#eventMlpStyle').innerHTML=mlp&&event?.format!=='mlp'?'<label>Style MLP<select name="style"><option value="basic">MLP Cơ bản</option><option value="mini">MLP Mini</option></select></label>':''};sync();form.elements.format.onchange=sync;
 form.onsubmit=async e=>{
  e.preventDefault();const fd=new FormData(form),button=form.querySelector('.wide');button.disabled=true;
  const {data,error}=await supabase.rpc('save_competition_event',{p_tournament_id:t.id,p_event_id:event?.id||null,p_name:fd.get('name').trim(),p_start_time:fd.get('start_time')||null,p_format:fd.get('format'),p_expected_team_count:fd.get('expected_team_count')?Number(fd.get('expected_team_count')):null,p_style:fd.get('style')||'basic'});
  if(error){button.disabled=false;form.querySelector('#eventFormError').textContent=error.message;return}
  if(epoch!==renderEpoch)return;
  document.querySelector('#modal').innerHTML='';await workspace(t.id,'overview',data);
 };
}

async function workspace(id,tab='overview',eventId=null){
  stopLive();const epoch=++renderEpoch;
  app.innerHTML='<main class="wrap"><p role="status">Đang tải nội dung giải…</p></main>';
  let {data:t}=await supabase.from('tournaments').select('*').eq('id',id).single(); if(epoch!==renderEpoch)return;if(!t)return dashboard();
  if(!await loadCompetitionEvents(t,eventId,epoch))return;
  const db=competitionClient(supabase,activeEvent);
  const tournament=t;t={...t,format:activeEvent.format,status:activeEvent.status,expected_team_count:activeEvent.expected_team_count};currentTournament=t;
  const {data:teams}=await db.from('teams').select('*').eq('tournament_id',id).order('registration_order');
  if(epoch!==renderEpoch)return;
  app.innerHTML=`<header class="workspace-header"><div><button class="ghost" id="back">← Dashboard</button>${pantryLogoMarkup('pantry-logo-small')}<b>${esc(t.name)} → ${esc(activeEvent.name)}</b></div><div>${t.format==='mlp'?'MLP':'ĐÁNH ĐÔI'} · ${esc(t.start_date)}</div></header><main class="wrap ${tab==='matches'?'match-control-page':''}">${competitionEventCards(tournament)}<div class="workspace"><aside>${navButton('overview','Tổng quan',tab)}${navButton('info','Thông tin giải',tab)}${navButton('teams','VĐV / Đội',tab)}${navButton('groups','Chia bảng',tab)}${navButton('matches','Trận đấu',tab)}${navButton('standings','BXH',tab)}${navButton('referees','Trọng tài',tab)}${navButton('knockout','Knockout',tab)}${navButton('awards','🏆 Vinh danh',tab)}</aside><section id="workcontent"></section></div></main><div id="modal"></div>`;
  document.querySelector('#back').onclick=dashboard;
  bindCompetitionEvents(tournament,tab);
  document.querySelectorAll('aside button[data-tab]').forEach(b=>b.onclick=()=>workspace(id,b.dataset.tab));
  if(tab==='overview')await renderOverview(t,teams||[]); if(tab==='info')await renderTournamentInfoEditor(tournament); if(tab==='teams')await renderTeams(t,teams||[]); if(tab==='groups')await showGroups(id); if(tab==='matches')await renderMatches(id); if(tab==='standings')await renderStandings(id); if(tab==='referees')await renderRefereeAdmin(id); if(tab==='knockout')await renderKnockout(id); if(tab==='awards')await renderAwards(id,teams||[]);
}
function navButton(k,label,active){return `<button data-tab="${k}" class="${k===active?'nav-active':''}">${label}</button>`}
const posterTypes={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
async function renderTournamentInfoEditor(t,{preserveOnError=false}={}){
 const epoch=renderEpoch,area=document.querySelector('#workcontent');
 const {data:info,error}=await supabase.from('tournament_info').select('content,prize_information,rules,poster_path,registration_url').eq('tournament_id',t.id).maybeSingle();
 if(epoch!==renderEpoch)return false;
 if(error){if(!preserveOnError)area.innerHTML=`<div class="panel">${esc(error.message)}</div>`;return false}
 const isAdmin=String(profile?.role||'').toLowerCase()==='admin',image=posterUrl(t.id,info?.poster_path);
 area.innerHTML=`<section class="info-editor"><div class="page-kicker">TRANG SỰ KIỆN CÔNG KHAI</div><h1>Thông tin giải</h1><p class="muted">Nội dung này xuất hiện trên trang Thông tin giải.</p><div class="panel"><h2>POSTER GIẢI</h2><div id="posterPreview" class="editor-poster">${image?`<img src="${esc(image)}" alt="Poster hiện tại">`:'<p>Chưa có poster.</p>'}</div>${isAdmin?'<label>Chọn poster mới<input id="posterUpload" type="file" accept="image/jpeg,image/png,image/webp"></label><button type="button" class="secondary" id="removePoster">Gỡ poster</button>':''}</div><div class="panel"><label>NỘI DUNG GIẢI<textarea id="eventContent" rows="7" ${isAdmin?'':'readonly'} placeholder="Giới thiệu và nội dung giải">${esc(info?.content||'')}</textarea></label><label>GIẢI THƯỞNG<textarea id="eventPrizes" rows="5" ${isAdmin?'':'readonly'} placeholder="Thông tin giải thưởng">${esc(info?.prize_information||'')}</textarea></label><label>QUY ĐỊNH<textarea id="eventRules" rows="7" ${isAdmin?'':'readonly'} placeholder="Thể lệ và quy định">${esc(info?.rules||'')}</textarea></label><label>LINK ĐĂNG KÝ<input id="eventRegistration" type="text" inputmode="url" ${isAdmin?'':'readonly'} value="${esc(info?.registration_url||'')}" placeholder="Dán link nhóm Zalo hoặc link đăng ký"></label><p class="info-registration-help">Khách sẽ được chuyển đến link này khi bấm Đăng ký ngay.</p>${isAdmin?'<button id="saveEventInfo">Lưu thông tin giải</button>':''}<p id="eventInfoMessage" role="status"></p></div></section>`;
 if(!isAdmin)return true;
 const savedInfo=info||{poster_path:null};
 let pendingPoster=null,removePoster=false;
 const preview=area.querySelector('#posterPreview'),fileInput=area.querySelector('#posterUpload'),message=area.querySelector('#eventInfoMessage');
 fileInput.onchange=()=>{
  const file=fileInput.files?.[0];pendingPoster=null;
  if(!file)return;
  if(!posterTypes[file.type]||file.size>5*1024*1024||file.size===0){fileInput.value='';message.textContent='Chỉ nhận JPEG, PNG hoặc WebP tối đa 5 MB.';return}
  pendingPoster=file;removePoster=false;message.textContent='Poster mới sẽ được tải lên khi lưu.';
  const url=URL.createObjectURL(file);preview.replaceChildren();const img=document.createElement('img');img.src=url;img.alt='Xem trước poster';img.onload=()=>URL.revokeObjectURL(url);preview.append(img);
 };
 area.querySelector('#removePoster').onclick=()=>{pendingPoster=null;removePoster=true;fileInput.value='';preview.innerHTML='<p>Poster sẽ được gỡ khi lưu.</p>';message.textContent='';};
 area.querySelector('#saveEventInfo').onclick=async()=>{
  const button=area.querySelector('#saveEventInfo');button.disabled=true;message.textContent='Đang lưu…';
  const enteredRegistration=area.querySelector('#eventRegistration').value.trim();
  const registrationUrl=registrationLink(enteredRegistration);
  if(enteredRegistration&&!registrationUrl){message.textContent='Link đăng ký không hợp lệ. Vui lòng nhập link https://...';button.disabled=false;return}
  const oldPath=savedInfo.poster_path;
  let nextPath=removePoster?null:oldPath,newPath=null,newPosterUploaded=false;
  // Phase A: upload a distinct object; a failed upload never owns that path.
  if(pendingPoster){
   try{
    const bytes=new Uint8Array(await pendingPoster.slice(0,12).arrayBuffer());
    const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    const png=bytes.slice(0,8).join(',')==='137,80,78,71,13,10,26,10';
    const webp=String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
    if(!(pendingPoster.type==='image/jpeg'&&jpeg||pendingPoster.type==='image/png'&&png||pendingPoster.type==='image/webp'&&webp))throw new Error('Nội dung tệp không đúng định dạng ảnh đã chọn.');
    const candidatePath=`${t.id}/${crypto.randomUUID()}.${posterTypes[pendingPoster.type]}`;
    const {error:uploadError}=await supabase.storage.from(posterBucket).upload(candidatePath,pendingPoster,{contentType:pendingPoster.type,upsert:false});
    if(uploadError)throw uploadError;
    newPath=candidatePath;newPosterUploaded=true;nextPath=newPath;
   }catch(err){message.textContent=err.message||'Không thể tải poster mới.';button.disabled=false;return}
  }
  // Phase B: only a confirmed database failure may roll back the new object.
  const payload={tournament_id:t.id,content:area.querySelector('#eventContent').value,prize_information:area.querySelector('#eventPrizes').value,rules:area.querySelector('#eventRules').value,registration_url:registrationUrl,poster_path:nextPath,updated_at:new Date().toISOString()};
  let saveError,saveOutcomeUnknown=false;
  try{({error:saveError}=await supabase.from('tournament_info').upsert(payload,{onConflict:'tournament_id'}))}
  catch(err){saveError=err;saveOutcomeUnknown=true}
  if(saveError){
   try{
    const {data:current,error:verifyError}=await supabase.from('tournament_info').select('poster_path').eq('tournament_id',t.id).maybeSingle();
    if(verifyError)throw verifyError;
    if(current&&current.poster_path===nextPath&&(newPosterUploaded||oldPath!==nextPath))saveError=null;
    else saveOutcomeUnknown=false;
   }catch{saveOutcomeUnknown=true}
  }
  if(saveError){
   let rollbackWarning='';
   if(newPosterUploaded&&!saveOutcomeUnknown){
    try{const {error:removeError}=await supabase.storage.from(posterBucket).remove([newPath]);if(removeError)throw removeError}
    catch{rollbackWarning=' Chưa xóa được file mới khỏi Storage.'}
   }
   if(saveOutcomeUnknown)rollbackWarning=' Không xác định được kết quả lưu; file mới được giữ để tránh làm hỏng poster đang hiển thị. Admin cần kiểm tra lại.';
   message.textContent=(saveError.message||'Không thể lưu thông tin giải.')+rollbackWarning;
   button.disabled=false;return;
  }
  // Phase C: the database now owns nextPath. Never roll it back below.
  savedInfo.poster_path=nextPath;pendingPoster=null;removePoster=false;fileInput.value='';
  let cleanupWarning='';
  if(oldPath&&oldPath!==nextPath&&posterPathValid(t.id,oldPath)){
   try{const {error:cleanupError}=await supabase.storage.from(posterBucket).remove([oldPath]);if(cleanupError)throw cleanupError}
   catch{cleanupWarning=nextPath?' Không thể xóa file poster cũ.':' Đã gỡ poster khỏi giải nhưng chưa xóa được file cũ.'}
  }
  try{
   const refreshed=await renderTournamentInfoEditor(t,{preserveOnError:true});
   if(refreshed){document.querySelector('#eventInfoMessage').textContent='✓ Đã lưu thông tin giải'+cleanupWarning;return}
  }catch{}
  if(message.isConnected)message.textContent='✓ Đã lưu thông tin giải'+cleanupWarning+' Không thể làm mới màn hình; hãy mở lại Thông tin giải.';
  button.disabled=false;
 };
 return true;
}
const awardLabels={1:'VÔ ĐỊCH',2:'Á QUÂN',3:'HẠNG BA'};
const awardMedals={1:'🥇',2:'🥈',3:'🥉'};
function awardShowcase(awards){
 if(!awards.length)return '';
 const tied=awards.some(a=>a.placement===3&&a.placement_slot===2);
 return `<section class="awards-showcase" aria-label="Vinh danh"><div class="awards-showcase-heading"><small>THE PANTRY · HONORS</small><h2>VINH DANH</h2></div><div class="awards-podium ${tied?'awards-podium-tied':''}">${awards.map(a=>`<article class="awards-podium-card awards-podium-${a.placement}"><div class="awards-medal" aria-hidden="true">${awardMedals[a.placement]||''}</div><small>${awardLabels[a.placement]||''}</small>${a.team_name?`<h3>${esc(a.team_name)}</h3>`:''}${a.player_names?`<p>${esc(a.player_names)}</p>`:''}</article>`).join('')}</div></section>`;
}
async function renderAwards(tid,teams,roster=null){const db=competitionClient(supabase,activeEvent);
 const epoch=renderEpoch;
 const awardsRequest=db.from('tournament_awards').select('placement,placement_slot,team_id,team_name,player_names').eq('tournament_id',tid).order('placement').order('placement_slot');
 const isAdmin=String(profile?.role||'').toLowerCase()==='admin';
 const memberRequest=isAdmin&&!roster&&teams.length?db.from('team_members').select('team_id,player_id,slot_order').in('team_id',teams.map(t=>t.id)):Promise.resolve({data:[]});
 const [{data:awards,error},{data:members,error:memberError}]=await Promise.all([awardsRequest,memberRequest]);
 if(epoch!==renderEpoch)return;
 const area=document.querySelector('#workcontent');
 if(error||memberError){area.innerHTML=`<div class="panel">${esc((error||memberError).message)}</div>`;return}
 if(isAdmin&&!roster){
  const ids=[...new Set((members||[]).map(m=>m.player_id))];
  const {data:players,error:playerError}=ids.length?await supabase.from('players').select('id,full_name').in('id',ids):{data:[]};
  if(epoch!==renderEpoch)return;
  if(playerError){area.innerHTML=`<div class="panel">${esc(playerError.message)}</div>`;return}
  const names=Object.fromEntries((players||[]).map(p=>[p.id,p.full_name]));
  roster=Object.fromEntries(teams.map(t=>[t.id,(members||[]).filter(m=>m.team_id===t.id).sort((a,b)=>a.slot_order-b.slot_order).map(m=>names[m.player_id]).filter(Boolean).join('\n')]));
 }
 const byKey=Object.fromEntries((awards||[]).map(a=>[`${a.placement}-${a.placement_slot}`,a]));
 const tied=!!byKey['3-2'];
 const positions=[[1,1],[2,1],[3,1],...(isAdmin||tied?[[3,2]]:[])];
 const card=(placement,slot)=>{
  const key=`${placement}-${slot}`,a=byKey[key],label=awardLabels[placement],manual=!!a&&!a.team_id;
  return `<article class="panel awards-editor-card" data-award-card="${key}" data-award-editing="${manual}" ${placement===3&&slot===2&&!tied?'hidden':''}><div class="awards-editor-title"><span aria-hidden="true">${awardMedals[placement]}</span><h2>${label}</h2></div>${isAdmin?`<div class="awards-team-picker"><label for="award-select-${key}">Chọn đội / cặp</label><div class="awards-picker-control"><input type="search" data-award-search="${key}" placeholder="Tìm đội / cặp…" aria-label="Tìm đội hoặc cặp"><select id="award-select-${key}" data-award-select="${key}"><option value="">Chọn đội / cặp</option>${teams.map(t=>`<option value="${t.id}" ${a?.team_id===t.id?'selected':''}>${esc(t.name)}</option>`).join('')}</select></div><button type="button" class="awards-manual" data-award-manual="${key}">+ Nhập thủ công</button></div><div class="awards-selected-summary" data-award-summary="${key}" ${a?.team_id?'':'hidden'}><div><strong data-award-summary-team="${key}">${esc(a?.team_name||'')}</strong><p data-award-summary-players="${key}">${esc((a?.player_names||'').split('\n').filter(Boolean).join(' · '))}</p></div><button type="button" data-award-edit="${key}">Chỉnh sửa</button></div><div class="awards-edit-fields" data-award-fields="${key}" ${manual?'':'hidden'}><label>Tên đội / Cặp<input data-award-team="${key}" value="${esc(a?.team_name||'')}" placeholder="Tên hiển thị"></label><label>Tên VĐV<textarea data-award-players="${key}" rows="3" placeholder="Mỗi VĐV một dòng">${esc(a?.player_names||'')}</textarea></label></div>${a?`<button class="awards-delete" data-award-delete="${key}">Xóa kết quả</button>`:''}`:`<div class="awards-view-team">${a?.team_name?esc(a.team_name):'Chưa có kết quả'}</div>${a?.player_names?`<p class="awards-view-players">${esc(a.player_names)}</p>`:''}`}</article>`;
 };
 area.innerHTML=`<section class="awards-editor"><div class="page-kicker">THE PANTRY · HONORS</div><div class="match-page-title"><div><h1>🏆 Vinh danh</h1><p>Chọn từ danh sách thi đấu hoặc nhập tên hiển thị thủ công.</p></div></div><div class="awards-editor-grid">${positions.filter(([p])=>p<3).map(([p,s])=>card(p,s)).join('')}</div><div class="awards-third-heading"><h2>🥉 Hạng Ba</h2>${isAdmin?`<label><input type="checkbox" id="tiedThird" ${tied?'checked':''}> Đồng hạng Ba</label>`:tied?'<span>Đồng hạng Ba</span>':''}</div><div class="awards-editor-grid awards-third-grid ${tied?'awards-third-tied':''}">${positions.filter(([p])=>p===3).map(([p,s])=>card(p,s)).join('')}</div>${isAdmin?'<div class="awards-save-bar"><button id="saveAwards">Lưu vinh danh</button><span id="awardsMessage" role="status"></span></div>':''}</section>`;
 if(!isAdmin)return;
 const message=area.querySelector('#awardsMessage');
 const syncCard=card=>{
  const key=card.dataset.awardCard,selected=!!card.querySelector('[data-award-select]').value,editing=card.dataset.awardEditing==='true';
  card.querySelector('[data-award-fields]').hidden=!editing;
  card.querySelector('[data-award-summary]').hidden=!selected||editing;
  card.querySelector('[data-award-manual]').hidden=selected||editing;
  if(selected){
   card.querySelector('[data-award-summary-team]').textContent=card.querySelector('[data-award-team]').value;
   card.querySelector('[data-award-summary-players]').textContent=card.querySelector('[data-award-players]').value.split('\n').filter(Boolean).join(' · ');
  }
 };
 const syncChoices=()=>{
  const selected=[...area.querySelectorAll('[data-award-select]')].filter(x=>!x.closest('[data-award-card]').hidden).map(x=>x.value).filter(Boolean);
  area.querySelectorAll('[data-award-select]').forEach(select=>{
   const query=area.querySelector(`[data-award-search="${select.dataset.awardSelect}"]`).value.trim().toLocaleLowerCase('vi');
   const current=select.value;
   select.replaceChildren(new Option('Chọn đội / cặp',''),...teams.filter(team=>!query||team.name.toLocaleLowerCase('vi').includes(query)||team.id===current).map(team=>{
    const option=new Option(team.name,team.id,false,team.id===current);
    option.disabled=team.id!==current&&selected.includes(team.id);
    return option;
   }));
  });
 };
 area.querySelectorAll('[data-award-search]').forEach(input=>input.oninput=syncChoices);
 area.querySelectorAll('[data-award-select]').forEach(select=>select.onchange=()=>{
  const card=select.closest('[data-award-card]');
  if(select.value){
   const team=teams.find(t=>t.id===select.value),key=select.dataset.awardSelect;
   area.querySelector(`[data-award-team="${key}"]`).value=team?.name||'';
   area.querySelector(`[data-award-players="${key}"]`).value=roster?.[select.value]||'';
  }
  card.dataset.awardEditing='false';syncCard(card);
  syncChoices();
 });
 area.querySelectorAll('[data-award-manual]').forEach(button=>button.onclick=()=>{
  const key=button.dataset.awardManual;
  area.querySelector(`[data-award-select="${key}"]`).value='';
  area.querySelector(`[data-award-search="${key}"]`).value='';
  const card=button.closest('[data-award-card]');card.dataset.awardEditing='true';syncCard(card);
  area.querySelector(`[data-award-team="${key}"]`).focus();
  syncChoices();
 });
 area.querySelectorAll('[data-award-edit]').forEach(button=>button.onclick=()=>{
  const card=button.closest('[data-award-card]');card.dataset.awardEditing='true';syncCard(card);
  card.querySelector('[data-award-team]').focus();
 });
 const toggle=area.querySelector('#tiedThird');
 toggle.onchange=async()=>{
  const second=area.querySelector('[data-award-card="3-2"]');
  if(toggle.checked){second.hidden=false;area.querySelector('.awards-third-grid').classList.add('awards-third-tied');syncCard(second);syncChoices();return}
  if(!confirm('Tắt Đồng hạng Ba sẽ xóa đội Hạng Ba thứ hai. Tiếp tục?')){toggle.checked=true;return}
  if(byKey['3-2']){
   const {error:deleteError}=await db.from('tournament_awards').delete().eq('tournament_id',tid).eq('placement',3).eq('placement_slot',2);
   if(deleteError){toggle.checked=true;message.textContent=deleteError.message;return}
   delete byKey['3-2'];second.querySelector('[data-award-delete]')?.remove();
  }
  second.hidden=true;second.querySelector('[data-award-select]').value='';second.querySelector('[data-award-team]').value='';second.querySelector('[data-award-players]').value='';
  second.dataset.awardEditing='false';syncCard(second);
  area.querySelector('.awards-third-grid').classList.remove('awards-third-tied');syncChoices();
 };
 area.querySelector('#saveAwards').onclick=async()=>{
  const changes=[...area.querySelectorAll('[data-award-card]')].filter(card=>!card.hidden).map(card=>{
   const key=card.dataset.awardCard,[placement,placement_slot]=key.split('-').map(Number);
   return {placement,placement_slot,team_id:card.querySelector('[data-award-select]').value||null,team_name:card.querySelector('[data-award-team]').value.trim(),player_names:card.querySelector('[data-award-players]').value.trim()};
  });
  if(changes.some(a=>byKey[`${a.placement}-${a.placement_slot}`]&&!a.team_name&&!a.player_names)){message.textContent='Dùng “Xóa kết quả” để xóa một vị trí.';return}
  const ids=changes.map(a=>a.team_id).filter(Boolean);
  if(new Set(ids).size!==ids.length){message.textContent='Một đội chỉ được chọn cho một vị trí.';return}
  const rows=changes.filter(a=>a.team_name||a.player_names).map(a=>({...a,tournament_id:tid,created_by:session.user.id,updated_at:new Date().toISOString()}));
  if(!rows.length){message.textContent='Hãy nhập ít nhất một kết quả.';return}
  const button=area.querySelector('#saveAwards');button.disabled=true;
  const {error:saveError}=await db.from('tournament_awards').upsert(rows,{onConflict:'event_id,placement,placement_slot'});
  if(saveError){button.disabled=false;message.textContent=saveError.message;return}
  if(epoch!==renderEpoch)return;
  await renderAwards(tid,teams,roster);
  document.querySelector('#awardsMessage')?.replaceChildren(document.createTextNode('✓ Đã lưu vinh danh'));
 };
 area.querySelectorAll('[data-award-delete]').forEach(button=>button.onclick=async()=>{
  const [placement,slot]=button.dataset.awardDelete.split('-').map(Number);
  if(!confirm(`Xóa kết quả ${placement===3&&slot===2?'Hạng Ba thứ hai':awardLabels[placement]}?`))return;
  button.disabled=true;
  const {error:deleteError}=await db.from('tournament_awards').delete().eq('tournament_id',tid).eq('placement',placement).eq('placement_slot',slot);
  if(deleteError){button.disabled=false;message.textContent=deleteError.message;return}
  if(epoch===renderEpoch)await renderAwards(tid,teams,roster);
 });
 area.querySelectorAll('[data-award-card]').forEach(syncCard);
 syncChoices();
}
async function renderOverview(t,teams){const db=competitionClient(supabase,activeEvent);const epoch=renderEpoch;let mlp=null,slots=[];if(t.format==='mlp'){({data:mlp}=await db.from('mlp_configs').select('*').eq('tournament_id',t.id).single());({data:slots}=await db.from('mlp_slots').select('*').eq('tournament_id',t.id).order('slot_order'));slots=slots||[]}const style=t.format==='mlp'?((mlp?.style==='mini'||mlp?.members_per_team===3)?'MLP Mini':'MLP Cơ bản'):null;const formatHelp=t.format==='mlp'?(mlp?.members_per_team===3?'File MLP Mini: Tên đội · VĐV 1 · VĐV 2 · VĐV 3':'File MLP Cơ bản: Tên đội · Nam 1 · Nam 2 · Nữ 1 · Nữ 2'):'File đánh đôi: Cặp VĐV hoặc VĐV 1 · VĐV 2';if(epoch!==renderEpoch)return;const el=document.querySelector('#workcontent');el.innerHTML=`<small>WORKSPACE</small><h1>${esc(t.name)}</h1><div class="stats"><div><b>${teams.length}</b><span>Đội</span></div><div><b>${t.expected_team_count??'—'}</b><span>${t.format==='mlp'?'Đội dự kiến':'Cặp dự kiến'}</span></div><div><b>${esc(t.status)}</b><span>Trạng thái</span></div></div>${t.format==='mlp'?`<div class="panel mlp-summary"><div><small>STYLE MLP</small><h2>${style}</h2><p>${mlp?.members_per_team||4} thành viên / đội · ${style==='MLP Mini'?'Không phân giới tính':'2 Nam + 2 Nữ'}</p></div><div class="slot-chips">${slots.map(x=>`<span>${esc(x.slot_name)}</span>`).join('')}</div></div>`:''}<div class="panel"><h2>${t.format==='mlp'?'Import đội MLP':'Danh sách thi đấu'}</h2><p>${formatHelp}</p><input id="excel" type="file" accept=".xlsx,.xls,.csv"><div id="preview"></div></div>${t.format==='mlp'?`<div class="panel"><h2>Cấu hình MLP</h2><p>Style được tạo sẵn theo giải; vẫn có thể chỉnh tên slot hoặc Max trình.</p><button id="slots">Cấu hình đội hình</button></div>`:''}`;document.querySelector('#excel').onchange=previewExcel;if(t.format==='mlp')document.querySelector('#slots').onclick=()=>slotsModal(t)}

async function previewExcel(e){
 const file=e.target.files?.[0];if(!file)return;
 const epoch=renderEpoch,event={...activeEvent},t={...currentTournament},db=competitionClient(supabase,event);
 const area=document.querySelector('#preview');
 try{
  const XLSX=await import('xlsx');
  const workbook=XLSX.read(await file.arrayBuffer(),{type:'array'});
  const {data:slots,error}=await db.from('mlp_slots').select('*').order('slot_order');if(error)throw error;
  if(epoch!==renderEpoch)return;
  const rows=parseRosterRows(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1,defval:''}),event.format,event.format==='mlp'?(slots?.length||4):2);
  area.innerHTML=`<p>${rows.length} ${event.format==='mlp'?'đội':'cặp'} → ${esc(event.name)}</p><ol>${rows.map(r=>`<li>${esc(r.name)} · ${r.names.map(esc).join(' / ')}</li>`).join('')}</ol><button id="confirmImport">Import vào nội dung này</button><p id="importMessage" role="status"></p>`;
  area.querySelector('#confirmImport').onclick=async()=>{
   const button=area.querySelector('#confirmImport'),message=area.querySelector('#importMessage');button.disabled=true;
   let completed=0;
   try{
    for(const row of rows){
     if(epoch!==renderEpoch)throw new Error('Đã đổi workspace. Import đã dừng.');
     const players=[];for(let i=0;i<row.names.length;i++)players.push(await getOrCreatePlayer(row.names[i],event.format==='mlp'?slots?.[i]?.gender:null));
     const {data:team,error:teamError}=await db.from('teams').insert({tournament_id:t.id,name:row.name}).select().single();if(teamError)throw teamError;
     const {error:memberError}=await db.from('team_members').insert(players.map((p,i)=>({team_id:team.id,player_id:p.id,slot_order:i+1})));
     if(memberError){const {error:cleanupError}=await db.from('teams').delete().eq('id',team.id);throw new Error(memberError.message+(cleanupError?' · Không thể xóa đội chưa đủ thành viên: '+cleanupError.message:''))}
     completed++;message.textContent=`Đã import ${completed}/${rows.length}.`;
    }
    if(epoch===renderEpoch)await workspace(t.id,'teams',event.id);
   }catch(error){message.textContent=`Đã import ${completed}/${rows.length}. ${error.message} Kiểm tra danh sách đội trước khi import phần còn lại.`}
  };
 }catch(error){if(epoch===renderEpoch)area.textContent=error.message}
}

async function renderTeams(t,teams){const db=competitionClient(supabase,activeEvent);const epoch=renderEpoch;const {data:members}=await db.from('team_members').select('team_id,player_id,slot_order').in('team_id',teams.map(x=>x.id).length?teams.map(x=>x.id):['00000000-0000-0000-0000-000000000000']);const pids=[...new Set((members||[]).map(x=>x.player_id))];const {data:players}=pids.length?await supabase.from('players').select('id,full_name').in('id',pids):{data:[]};const pm=Object.fromEntries((players||[]).map(x=>[x.id,x]));const {data:flags}=pids.length?await supabase.from('player_flags').select('*').in('player_id',pids).eq('active',true):{data:[]};const fm={};(flags||[]).forEach(f=>(fm[f.player_id]??=[]).push(f));if(epoch!==renderEpoch)return;document.querySelector('#workcontent').innerHTML=`<small>VĐV / ĐỘI</small><h1>${esc(t.name)}</h1><div class="panel"><div class="toolbar"><button id="addTeam">＋ Thêm đội</button><button class="secondary" id="goImport">Import thêm Excel</button></div>${teams.map((team,i)=>{let ms=(members||[]).filter(m=>m.team_id===team.id).sort((a,b)=>a.slot_order-b.slot_order);return `<div class="team-line"><div><b>${i+1}. ${esc(team.name||ms.map(m=>pm[m.player_id]?.full_name).join(' - '))}</b><div>${ms.map(m=>{let fs=fm[m.player_id]||[];return `${esc(pm[m.player_id]?.full_name||'')} ${fs.map(f=>`<span class="badge flag-${f.level}" title="${esc(f.note)}">${f.level==='out_of_level'?'OUT TRÌNH':f.level==='warning'?'CẢNH BÁO':'THEO DÕI'}</span>`).join(' ')}`}).join(' · ')}</div></div><div class="actions"><button class="secondary flagbtn" data-team="${team.id}">⚑ Note</button><button class="danger delteam" data-id="${team.id}">Xóa</button></div></div>`}).join('')||'<p>Chưa có đội.</p>'}</div>`;document.querySelector('#goImport').onclick=()=>workspace(t.id,'overview');document.querySelector('#addTeam').onclick=()=>addTeamModal(t);document.querySelectorAll('.delteam').forEach(b=>b.onclick=async()=>{if(confirm('Xóa đội này khỏi giải?')){await db.from('teams').delete().eq('id',b.dataset.id);if(epoch===renderEpoch)await workspace(t.id,'teams')}});document.querySelectorAll('.flagbtn').forEach(b=>b.onclick=()=>flagTeamModal(b.dataset.team,members||[],pm,t))}
async function addTeamModal(t){const db=competitionClient(supabase,activeEvent);const epoch=renderEpoch;let slots=[];if(t.format==='mlp'){let {data,error}=await db.from('mlp_slots').select('*').eq('tournament_id',t.id).order('slot_order');if(error)return alert(error.message);slots=data||[];if(!slots.length){let {data:c}=await db.from('mlp_configs').select('*').eq('tournament_id',t.id).single();slots=Array.from({length:c?.members_per_team||4},(_,i)=>({slot_order:i+1,slot_name:`VĐV ${i+1}`,gender:'any'}))}}let isMlp=t.format==='mlp';let fields=isMlp?`<label>Tên đội<input name="team_name" required placeholder="VD: The Pantry"></label><div class="manual-roster"><p class="label">Đội hình</p>${slots.map((x,i)=>`<label>${esc(x.slot_name||`VĐV ${i+1}`)}${x.gender==='male'?'<small> · Nam</small>':x.gender==='female'?'<small> · Nữ</small>':''}<input name="p${i+1}" required placeholder="Tên VĐV"></label>`).join('')}</div>`:`<label>VĐV 1<input name="p1" required></label><label>VĐV 2<input name="p2" required></label>`;if(epoch!==renderEpoch)return;document.querySelector('#modal').innerHTML=`<div class="overlay"><form class="modal" id="addteam"><div class="modalhead"><div><small>${isMlp?'MLP · NHẬP BẰNG TAY':'ĐÁNH ĐÔI'}</small><h2>Thêm đội</h2></div><button type="button" class="x">×</button></div>${fields}<div id="addTeamMsg"></div><button class="wide">＋ Thêm đội</button></form></div>`;let f=document.querySelector('#addteam');f.querySelector('.x').onclick=()=>document.querySelector('#modal').innerHTML='';f.onsubmit=async e=>{e.preventDefault();let btn=f.querySelector('button.wide'),msg=f.querySelector('#addTeamMsg');btn.disabled=true;btn.textContent='Đang thêm…';msg.textContent='';try{let fd=new FormData(f),names=isMlp?slots.map((_,i)=>(fd.get(`p${i+1}`)||'').trim()):[(fd.get('p1')||'').trim(),(fd.get('p2')||'').trim()];if(names.some(x=>!x))throw new Error('Vui lòng nhập đủ tên VĐV.');let teamName=isMlp?(fd.get('team_name')||'').trim():names.join(' - ');if(!teamName)throw new Error('Vui lòng nhập tên đội.');let players=[];for(let i=0;i<names.length;i++)players.push(await getOrCreatePlayer(names[i],isMlp?slots[i]?.gender:null));let {data:team,error}=await db.from('teams').insert({tournament_id:t.id,name:teamName}).select().single();if(error)throw error;let {error:me}=await db.from('team_members').insert(players.map((p,i)=>({team_id:team.id,player_id:p.id,slot_order:i+1})));if(me){await db.from('teams').delete().eq('id',team.id);throw me}if(epoch!==renderEpoch)return;document.querySelector('#modal').innerHTML='';workspace(t.id,'teams')}catch(err){msg.textContent=err.message||String(err);btn.disabled=false;btn.textContent='＋ Thêm đội'}}}
function flagTeamModal(teamId,members,pm,t){let ms=members.filter(x=>x.team_id===teamId);document.querySelector('#modal').innerHTML=`<div class="overlay"><form class="modal" id="flagform"><div class="modalhead"><h2>Ghi chú VĐV</h2><button type="button" class="x">×</button></div><label>VĐV<select name="pid">${ms.map(m=>`<option value="${m.player_id}">${esc(pm[m.player_id]?.full_name)}</option>`).join('')}</select></label><label>Mức<select name="level"><option value="watch">Theo dõi</option><option value="warning">Cảnh báo</option><option value="out_of_level">Out trình</option></select></label><label>Ghi chú<textarea name="note" required rows="4"></textarea></label><button>Lưu cảnh báo</button></form></div>`;let f=document.querySelector('#flagform');f.querySelector('.x').onclick=()=>document.querySelector('#modal').innerHTML='';f.onsubmit=async e=>{e.preventDefault();let fd=new FormData(f);let {error}=await supabase.from('player_flags').insert({player_id:fd.get('pid'),tournament_id:t.id,level:fd.get('level'),note:fd.get('note'),created_by:session.user.id});if(error)return alert(error.message);document.querySelector('#modal').innerHTML='';workspace(t.id,'teams')}}

function groupName(i){
  let n=i+1,out='';
  while(n>0){n--;out=String.fromCharCode(65+(n%26))+out;n=Math.floor(n/26)}
  return out;
}
function shuffled(arr){
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}
  return a;
}
async function saveGroupDistribution(tid,count,teamIds,doShuffle=true){const db=competitionClient(supabase,activeEvent);
  count=Math.max(1,Math.min(Number(count)||1,Math.max(1,teamIds.length)));
  const ids=doShuffle?shuffled(teamIds):[...teamIds];
  const {data:oldGroups,error:oldErr}=await db.from('groups').select('id').eq('tournament_id',tid);
  if(oldErr)throw oldErr;
  const oldIds=(oldGroups||[]).map(x=>x.id);
  if(oldIds.length){
    const {error:e1}=await db.from('group_teams').delete().in('group_id',oldIds);if(e1)throw e1;
  }
  const {error:e2}=await db.from('matches').delete().eq('tournament_id',tid).eq('stage','group');if(e2)throw e2;
  if(oldIds.length){const {error:e3}=await db.from('groups').delete().eq('tournament_id',tid);if(e3)throw e3}
  const rows=Array.from({length:count},(_,i)=>({tournament_id:tid,name:groupName(i),group_order:i+1}));
  const {data:groups,error:e4}=await db.from('groups').insert(rows).select('*');if(e4)throw e4;
  const links=ids.map((teamId,i)=>({group_id:groups[i%count].id,team_id:teamId}));
  if(links.length){const {error:e5}=await db.from('group_teams').insert(links);if(e5)throw e5}
}
async function createGroupSchedule(tid){const db=competitionClient(supabase,activeEvent);
  const [{data:groups,error:ge},{data:links,error:le}]=await Promise.all([
    db.from('groups').select('*').eq('tournament_id',tid).order('group_order'),
    db.from('group_teams').select('*')
  ]);
  if(ge)throw ge;if(le)throw le;
  const gids=(groups||[]).map(g=>g.id), valid=(links||[]).filter(x=>gids.includes(x.group_id));
  if(!groups?.length)throw new Error('Chưa có bảng.');
  const {error:deleteError}=await db.from('matches').delete().eq('tournament_id',tid).eq('stage','group');
  if(deleteError)throw deleteError;
  const rows=[];
  for(const g of groups){
    const ids=valid.filter(x=>x.group_id===g.id).map(x=>x.team_id);
    let raw=[];
    for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++)raw.push({team1_id:ids[i],team2_id:ids[j]});
    const ordered=fairMatchOrder(raw);
    ordered.forEach((m,i)=>rows.push({tournament_id:tid,group_id:g.id,match_code:`${g.name}${String(i+1).padStart(2,'0')}`,stage:'group',team1_id:m.team1_id,team2_id:m.team2_id,status:'scheduled',scheduled_order:i+1}));
  }
  if(rows.length){const {error}=await db.from('matches').insert(rows);if(error)throw error}
  const {error:statusError}=await supabase.from('tournament_events').update({status:'group_stage'}).eq('id',db.event.id);
  if(statusError)throw statusError;
}
async function showGroups(tid){const db=competitionClient(supabase,activeEvent);const epoch=renderEpoch;
  const [{data:teams,error:te},{data:groups,error:ge}]=await Promise.all([
    db.from('teams').select('id,name,registration_order').eq('tournament_id',tid).order('registration_order'),
    db.from('groups').select('*').eq('tournament_id',tid).order('group_order')
  ]);
  if(epoch!==renderEpoch)return;
  if(te||ge){document.querySelector('#workcontent').innerHTML=`<div class="panel">${esc((te||ge).message)}</div>`;return}
  if((teams||[]).length && !(groups||[]).length){
    try{await saveGroupDistribution(tid,1,(teams||[]).map(x=>x.id),false);if(epoch===renderEpoch)return showGroups(tid)}catch(e){document.querySelector('#workcontent').innerHTML=`<div class="panel">${esc(e.message)}</div>`;return}
  }
  const freshGroups=(await db.from('groups').select('*').eq('tournament_id',tid).order('group_order')).data||[];
  const gids=freshGroups.map(g=>g.id);
  const {data:allLinks}=gids.length?await db.from('group_teams').select('*').in('group_id',gids):{data:[]};
  if(epoch!==renderEpoch)return;
  const links=allLinks||[], tm=Object.fromEntries((teams||[]).map(t=>[t.id,t]));
  const counts=freshGroups.map(g=>links.filter(x=>x.group_id===g.id).length);
  const maxGroups=Math.max(1,(teams||[]).length);
  document.querySelector('#workcontent').innerHTML=`<div class="page-kicker">CHIA BẢNG</div><div class="groups-title"><div><h1>${esc(currentTournament.name)}</h1><p>${teams.length} đội · Chọn số bảng, hệ thống tự chia đều.</p></div></div>
  <div class="panel group-control"><div class="group-control-main"><label>Số bảng<input id="groupCount" type="number" min="1" max="${maxGroups}" value="${Math.max(1,freshGroups.length)}"></label><div class="balance-preview">Phân bổ hiện tại: <b>${counts.length?counts.join(' · '):teams.length}</b> đội</div></div><div class="group-actions"><button id="divideGroups">🎲 Xáo & chia đều</button><button class="ghost" id="reshuffleGroups">Xáo lại</button><button id="lockGroups">✓ Chốt bảng & tạo lịch</button></div></div>
  <div class="group-board">${freshGroups.map(g=>{const gl=links.filter(x=>x.group_id===g.id);return `<section class="group-column"><div class="group-column-head"><div><small>BẢNG</small><h2>${esc(g.name)}</h2></div><span>${gl.length} đội</span></div><div class="group-team-list">${gl.map((x,i)=>`<div class="group-team"><span class="team-index">${i+1}</span><b>${esc(tm[x.team_id]?.name||'Đội')}</b><select data-move-team="${x.team_id}" data-from="${g.id}" aria-label="Chuyển đội ${esc(tm[x.team_id]?.name||'')}">${freshGroups.map(dest=>`<option value="${dest.id}" ${dest.id===g.id?'selected':''}>Bảng ${esc(dest.name)}</option>`).join('')}</select></div>`).join('')||'<div class="group-empty">Chưa có đội</div>'}</div></section>`}).join('')}</div>`;
  const run=async(shuffle=true)=>{const b=document.querySelector(shuffle?'#divideGroups':'#reshuffleGroups');try{b.disabled=true;b.textContent='Đang chia…';await saveGroupDistribution(tid,+document.querySelector('#groupCount').value,(teams||[]).map(x=>x.id),true);if(epoch===renderEpoch)await showGroups(tid)}catch(e){alert(e.message);b.disabled=false}};
  document.querySelector('#divideGroups').onclick=()=>run(true);
  document.querySelector('#reshuffleGroups').onclick=()=>run(false);
  document.querySelectorAll('[data-move-team]').forEach(sel=>sel.onchange=async()=>{const teamId=sel.dataset.moveTeam,from=sel.dataset.from,to=sel.value;if(from===to)return;const {error}=await db.from('group_teams').update({group_id:to}).eq('group_id',from).eq('team_id',teamId);if(error)return alert(error.message);if(epoch===renderEpoch)await showGroups(tid)});
  document.querySelector('#lockGroups').onclick=async()=>{const b=document.querySelector('#lockGroups');try{b.disabled=true;b.textContent='Đang tạo lịch…';await createGroupSchedule(tid);if(epoch===renderEpoch)await workspace(tid,'matches')}catch(e){alert(e.message);b.disabled=false;b.textContent='✓ Chốt bảng & tạo lịch'}};
}

function fairMatchOrder(matches){
  const left=[...matches]; const out=[]; let last=new Set();
  while(left.length){
    let best=0,bestScore=-999;
    for(let i=0;i<left.length;i++){
      const m=left[i]; const overlap=(last.has(m.team1_id)?1:0)+(last.has(m.team2_id)?1:0);
      const appearances=out.slice(-4).reduce((n,x)=>n+(x.team1_id===m.team1_id||x.team2_id===m.team1_id||x.team1_id===m.team2_id||x.team2_id===m.team2_id?1:0),0);
      const score=(2-overlap)*100-appearances*5-(m.scheduled_order||999)/1000;
      if(score>bestScore){bestScore=score;best=i}
    }
    const pick=left.splice(best,1)[0]; out.push(pick); last=new Set([pick.team1_id,pick.team2_id]);
  }
  return out;
}
async function getMlpConfig(tid){const db=competitionClient(supabase,activeEvent);
  if(currentTournament?.format!=='mlp') return null;
  const [{data:config,error},{data:slots}]=await Promise.all([
    db.from('mlp_configs').select('*').eq('tournament_id',tid).maybeSingle(),
    db.from('mlp_slots').select('slot_order').eq('tournament_id',tid).order('slot_order')
  ]);
  if(error){console.error('MLP config:',error);return null}
  if(!config)return null;
  // Old MLP Mini tournaments may have been backfilled as style=basic by the V2.5 migration.
  // members_per_team / actual slot count are authoritative for those existing tournaments.
  const slotCount=(slots||[]).length;
  const isMini=config.style==='mini' || Number(config.members_per_team)===3 || slotCount===3;
  const normalized={...config,style:isMini?'mini':'basic',members_per_team:isMini?3:(Number(config.members_per_team)||4)};
  return normalized;
}
function mlpGameLabel(type){return ({women_doubles:'Đôi nữ',men_doubles:'Đôi nam',mixed_1:'Mixed 1',mixed_2:'Mixed 2',dreambreaker:'DreamBreaker'})[type]||type}
async function openMlpMatch(match,tm,tid){const db=competitionClient(supabase,activeEvent);const epoch=renderEpoch;
  const {data:games,error}=await db.from('mlp_games').select('*').eq('match_id',match.id).order('game_order');
  if(error)return alert(error.message);
  const gameMap=Object.fromEntries((games||[]).map(g=>[g.game_order,g]));
  const firstFour=[['women_doubles','Đôi nữ'],['men_doubles','Đôi nam'],['mixed_1','Mixed 1'],['mixed_2','Mixed 2']];
  let wins1=0,wins2=0;
  for(let i=1;i<=4;i++){let g=gameMap[i];if(g?.winner_team_id===match.team1_id)wins1++;if(g?.winner_team_id===match.team2_id)wins2++}
  const needDream=(Object.keys(gameMap).filter(k=>+k<=4).length>=4 && wins1===2 && wins2===2) || !!gameMap[5];
  const rows=[...firstFour,...(needDream?[['dreambreaker','DreamBreaker']]:[])];
  if(epoch!==renderEpoch)return;document.querySelector('#modal').innerHTML=`<div class="overlay"><div class="modal mlp-match-modal"><div class="modalhead"><div><small>MLP CƠ BẢN · ${esc(match.match_code)}</small><h2>${esc(tm[match.team1_id])} <span class="mlp-vs">vs</span> ${esc(tm[match.team2_id])}</h2></div><button type="button" class="x">×</button></div><div class="mlp-series-score"><div><b id="series1">${wins1}</b><span>${esc(tm[match.team1_id])}</span></div><strong>:</strong><div><b id="series2">${wins2}</b><span>${esc(tm[match.team2_id])}</span></div></div><div class="mlp-game-list">${rows.map(([type,label],idx)=>{let n=idx+1,g=gameMap[n];return `<div class="mlp-game-row ${g?'game-done':''}" data-game-row="${n}"><div class="mlp-game-no">G${n}</div><div class="mlp-game-name"><b>${label}</b><small>${n===5?'Chỉ xuất hiện khi 2–2':'Game '+n}</small></div><div class="mlp-game-score"><input type="number" min="0" data-g1="${n}" value="${g?.team1_score??''}"><span>:</span><input type="number" min="0" data-g2="${n}" value="${g?.team2_score??''}"></div><button type="button" data-save-game="${n}" data-type="${type}" class="${g?'saved-btn':''}">${g?'✓ Đã lưu':'Lưu'}</button></div>`}).join('')}</div><div class="mlp-match-note" id="mlpMatchNote">${needDream?'Tỉ số 2–2 · DreamBreaker quyết định trận đấu.':'Nhập đủ 4 game để hệ thống xác định kết quả trận.'}</div></div></div>`;
  const modal=document.querySelector('#modal');modal.querySelector('.x').onclick=()=>modal.innerHTML='';
  modal.querySelectorAll('[data-save-game]').forEach(btn=>btn.onclick=async()=>{
    const n=+btn.dataset.saveGame,type=btn.dataset.type;
    let a=modal.querySelector(`[data-g1="${n}"]`).value,b=modal.querySelector(`[data-g2="${n}"]`).value;
    if(a===''||b==='')return alert('Nhập đủ tỉ số game.');a=+a;b=+b;if(a===b)return alert('Game không được hòa.');
    const winner=a>b?match.team1_id:match.team2_id;btn.disabled=true;btn.textContent='Đang lưu…';
    const old=gameMap[n];let err;
    if(old){({error:err}=await db.from('mlp_games').update({game_type:type,team1_score:a,team2_score:b,winner_team_id:winner}).eq('id',old.id))}
    else{({error:err}=await db.from('mlp_games').insert({match_id:match.id,game_order:n,game_type:type,team1_score:a,team2_score:b,winner_team_id:winner}))}
    if(err){btn.disabled=false;btn.textContent='Lưu lại';return alert(err.message)}
    const {data:fresh}=await db.from('mlp_games').select('*').eq('match_id',match.id).order('game_order');
    let w1=0,w2=0;for(const g of fresh||[]){if(g.winner_team_id===match.team1_id)w1++;else if(g.winner_team_id===match.team2_id)w2++}
    const first4=(fresh||[]).filter(g=>g.game_order<=4);
    let completed=false,matchWinner=null;
    if(first4.length===4){let a4=first4.filter(g=>g.winner_team_id===match.team1_id).length,b4=4-a4;if(a4!==b4){completed=true;matchWinner=a4>b4?match.team1_id:match.team2_id;w1=a4;w2=b4}else{const db=(fresh||[]).find(g=>g.game_order===5);if(db){completed=true;matchWinner=db.winner_team_id;w1=a4+(db.winner_team_id===match.team1_id?1:0);w2=b4+(db.winner_team_id===match.team2_id?1:0)}}}
    const payload={team1_score:w1,team2_score:w2,winner_id:completed?matchWinner:null,status:completed?'completed':'scheduled',completed_at:completed?new Date().toISOString():null};
    const {error:me}=await db.from('matches').update(payload).eq('id',match.id);if(me)return alert(me.message);
    if(epoch!==renderEpoch)return;
    await openMlpMatch({...match,...payload},tm,tid);
    if(completed){setTimeout(()=>{if(epoch!==renderEpoch)return;document.querySelector('#modal').innerHTML='';renderMatches(tid)},250)}
  });
}
async function renderMatches(tid){const db=competitionClient(supabase,activeEvent);
  const epoch=renderEpoch;
  const [{data:matches},{data:teams},{data:groups},standings,mlpConfig]=await Promise.all([
    db.from('matches').select('*').eq('tournament_id',tid).eq('stage','group').order('match_code'),
    db.from('teams').select('id,name').eq('tournament_id',tid),
    db.from('groups').select('*').eq('tournament_id',tid).order('group_order'),
    standingsData(tid),getMlpConfig(tid)
  ]);
  if(epoch!==renderEpoch)return;
  const isBasic=currentTournament?.format==='mlp' && mlpConfig?.style==='basic';
  const tm=Object.fromEntries((teams||[]).map(x=>[x.id,x.name]));
  const sm=Object.fromEntries((standings||[]).map(x=>[x.group.id,x]));
  const groupHtml=(groups||[]).map(g=>{
    const gm=fairMatchOrder((matches||[]).filter(m=>m.group_id===g.id));
    const st=sm[g.id]?.rows||[];const done=gm.filter(m=>m.status==='completed').length;
    return `<section class="match-group"><div class="match-group-head"><div><small>VÒNG BẢNG</small><h2>Bảng ${esc(g.name)}</h2><p class="group-sub">${isBasic?'Mở từng cặp đấu để nhập 4 game MLP và DreamBreaker khi 2–2.':'Thứ tự gọi trận đã được dàn đều để hạn chế một đội đánh liên tục.'}</p></div><div class="progress-pill"><b>${done}</b> / ${gm.length} trận</div></div><div class="group-live-grid"><div class="group-matches"><div class="match-list-head"><span>Thứ tự</span><span>Trận đấu</span><span>Tỉ số</span><span>Trạng thái</span></div>${gm.map((m,idx)=>{const saved=m.status==='completed'&&m.team1_score!==null&&m.team2_score!==null;if(isBasic)return `<div class="match-card ${saved?'match-saved':''}"><div class="call-order"><span>${String(idx+1).padStart(2,'0')}</span><small>${esc(m.match_code)}${m.status==='playing'?' · 🔴 LIVE':''}</small></div><div class="versus"><span class="team-name">${esc(tm[m.team1_id]||'TBD')}</span><span class="vs">VS</span><span class="team-name">${esc(tm[m.team2_id]||'TBD')}</span></div><div class="series-result"><b>${m.team1_score??'–'}</b><span>:</span><b>${m.team2_score??'–'}</b></div><button class="open-mlp ${saved?'saved-btn':''}" data-open-mlp="${m.id}">${saved?'✓ '+m.team1_score+'–'+m.team2_score:'Nhập game'}</button></div>`;return `<div class="match-card ${saved?'match-saved':''}" data-match-row="${m.id}"><div class="call-order"><span>${String(idx+1).padStart(2,'0')}</span><small>${esc(m.match_code)}${m.status==='playing'?' · 🔴 LIVE':''}</small></div><div class="versus"><span class="team-name">${esc(tm[m.team1_id]||'TBD')}</span><span class="vs">VS</span><span class="team-name">${esc(tm[m.team2_id]||'TBD')}</span></div><div class="score-box"><input class="score-input" type="number" min="0" value="${m.team1_score??''}" data-s1="${m.id}" data-original="${m.team1_score??''}" ${m.status==='playing'?'disabled':''}><b>:</b><input class="score-input" type="number" min="0" value="${m.team2_score??''}" data-s2="${m.id}" data-original="${m.team2_score??''}" ${m.status==='playing'?'disabled':''}></div><button class="save-score ${saved?'saved-btn':''}" data-save="${m.id}" ${m.status==='playing'?'disabled':''}>${m.status==='playing'?'🔴 LIVE':saved?'✓ Đã lưu':'Lưu tỉ số'}</button></div>`}).join('')||'<p>Chưa có trận.</p>'}</div><div class="live-standing"><div class="standing-title"><div><small>LIVE TABLE</small><h3>BXH Bảng ${esc(g.name)}</h3></div><span>${done===gm.length&&gm.length?'Hoàn tất':'Đang diễn ra'}</span></div><table><thead><tr><th>#</th><th>Đội</th><th>Tr</th><th>W</th><th>L</th><th>+/-</th></tr></thead><tbody>${st.map((r,i)=>`<tr class="${i<2?'qualify-row':''}"><td><span class="rank rank-${i+1}">${i+1}</span></td><td><b>${esc(r.name)}</b></td><td>${r.p}</td><td>${r.w}</td><td>${r.l}</td><td class="diff ${r.diff>0?'positive':r.diff<0?'negative':''}">${r.diff>0?'+':''}${r.diff}</td></tr>`).join('')}</tbody></table><div class="standing-note"><span class="qual-dot"></span> Top 2 tạm thời</div></div></div></section>`;
  }).join('');
  document.querySelector('#workcontent').innerHTML=`<div class="page-kicker">TRẬN ĐẤU</div><div class="match-page-title"><div><h1>${esc(currentTournament.name)}</h1><p>${isBasic?'MLP Cơ bản · 4 game chính + DreamBreaker khi hòa 2–2':'Nhập tỉ số theo từng bảng · BXH cập nhật ngay sau khi lưu'}</p></div><div class="live-badge"><span></span> LIVE</div></div>${groupHtml||'<div class="panel">Chưa có lịch. Hãy chia bảng trước.</div>'}`;
  if(['admin','staff'].includes(String(profile?.role).toLowerCase())){
    document.querySelectorAll('[data-save],[data-open-mlp]').forEach(control=>{
      const button=document.createElement('button');button.type='button';button.className='secondary video-enable';button.textContent='Bật LIVE';
      const matchId=control.dataset.save||control.dataset.openMlp;
      control.closest('.match-card').querySelector('.call-order').append(button);
      button.onclick=async()=>{button.disabled=true;try{const {showBroadcasterQR}=await import('./video-ui.js');await showBroadcasterQR(supabase,matchId)}catch(error){alert(error.message)}finally{button.disabled=false}};
    });
  }
  startLive(`admin:matches:${tid}`,()=>renderMatches(tid));
  if(isBasic){document.querySelectorAll('[data-open-mlp]').forEach(b=>b.onclick=()=>{const m=(matches||[]).find(x=>x.id===b.dataset.openMlp);openMlpMatch(m,tm,tid)});return}
  document.querySelectorAll('[data-save]').forEach(b=>{const id=b.dataset.save,i1=document.querySelector(`[data-s1="${id}"]`),i2=document.querySelector(`[data-s2="${id}"]`);const markChanged=()=>{const dirty=i1.value!==i1.dataset.original||i2.value!==i2.dataset.original;if(dirty){b.textContent='Lưu thay đổi';b.classList.remove('saved-btn')}else if(i1.dataset.original!==''&&i2.dataset.original!==''){b.textContent='✓ Đã lưu';b.classList.add('saved-btn')}else{b.textContent='Lưu tỉ số';b.classList.remove('saved-btn')}};i1.addEventListener('input',markChanged);i2.addEventListener('input',markChanged);b.onclick=async()=>{let s1=i1.value,s2=i2.value;if(s1===''||s2==='')return alert('Nhập đủ 2 tỉ số');s1=+s1;s2=+s2;if(s1===s2)return alert('Tỉ số không được hòa');let m=(matches||[]).find(x=>x.id===id),winner=s1>s2?m.team1_id:m.team2_id;b.disabled=true;b.textContent='Đang lưu…';let {error}=await db.from('matches').update({team1_score:s1,team2_score:s2,winner_id:winner,status:'completed',completed_at:new Date().toISOString()}).eq('id',id);if(error){b.disabled=false;b.textContent='Lưu lại';return alert(error.message)}if(epoch===renderEpoch)await renderMatches(tid)}});
}
async function standingsData(tid){const db=competitionClient(supabase,activeEvent);const {data:groups}=await db.from('groups').select('*').eq('tournament_id',tid).order('group_order');const {data:teams}=await db.from('teams').select('id,name').eq('tournament_id',tid);const {data:links}=await db.from('group_teams').select('*').in('group_id',(groups||[]).map(g=>g.id).length?(groups||[]).map(g=>g.id):['00000000-0000-0000-0000-000000000000']);const {data:matches}=await db.from('matches').select('*').eq('tournament_id',tid).eq('stage','group').eq('status','completed');let tm=Object.fromEntries((teams||[]).map(x=>[x.id,x.name]));let out=[];for(let g of groups||[]){let ids=(links||[]).filter(x=>x.group_id===g.id).map(x=>x.team_id),rows=ids.map(id=>({id,name:tm[id],p:0,w:0,l:0,pf:0,pa:0,diff:0})),map=Object.fromEntries(rows.map(r=>[r.id,r]));(matches||[]).filter(m=>m.group_id===g.id).forEach(m=>{let a=map[m.team1_id],b=map[m.team2_id];if(!a||!b)return;a.p++;b.p++;a.pf+=m.team1_score;a.pa+=m.team2_score;b.pf+=m.team2_score;b.pa+=m.team1_score;if(m.winner_id===a.id){a.w++;b.l++}else{b.w++;a.l++}});rows.forEach(r=>r.diff=r.pf-r.pa);rows.sort((a,b)=>b.w-a.w||b.diff-a.diff||b.pf-a.pf);out.push({group:g,rows})}return out}

async function renderRefereeAdmin(tid){const db=competitionClient(supabase,activeEvent);
 const epoch=renderEpoch;
 const isAdmin=String(profile?.role||'').toLowerCase()==='admin';
 const [{data:groups},{data:codes},{data:sessions},{data:logs},{data:matches},adminCodes]=await Promise.all([
  db.from('groups').select('id,name,group_order').eq('tournament_id',tid).order('group_order'),
  db.from('referee_access_codes').select('id,group_id,active,expires_at').eq('tournament_id',tid),
  db.from('referee_sessions').select('id,group_id,referee_name,active,expires_at').eq('tournament_id',tid),
  db.from('referee_score_logs').select('*').eq('tournament_id',tid).order('created_at',{ascending:false}).limit(30),
  db.from('matches').select('id,match_code').eq('tournament_id',tid),
  isAdmin?supabase.rpc('admin_event_referee_codes',{p_event_id:db.event.id}):Promise.resolve({data:[]})
 ]);
 if(epoch!==renderEpoch)return;
 startLive(`admin:referees:${tid}`,()=>renderRefereeAdmin(tid));
 const readableCodes=Object.fromEntries((adminCodes.data||[]).map(x=>[x.group_id,x.readable_code]));
 const cm=Object.fromEntries((codes||[]).map(x=>[x.group_id,x])),gm=Object.fromEntries((groups||[]).map(x=>[x.id,x.name])),mm=Object.fromEntries((matches||[]).map(x=>[x.id,x.match_code])),active=(sessions||[]).filter(x=>x.active&&new Date(x.expires_at)>new Date()&&cm[x.group_id]?.active&&(!cm[x.group_id].expires_at||new Date(cm[x.group_id].expires_at)>new Date()));
 const score=(a,b)=>a==null||b==null?'—':`${a}–${b}`;const actionLabel={live_start:'Bắt đầu',live_takeover:'Nhận bàn',live_plus:'+1',live_minus:'−1',live_finish:'Kết thúc'};
 document.querySelector('#workcontent').innerHTML=`<div class="page-kicker">VẬN HÀNH</div><div class="match-page-title"><div><h1>Quản lý trọng tài</h1><p>Mỗi bảng có một mã riêng. Trọng tài không cần tài khoản.</p></div></div><div class="ref-admin-grid">${(groups||[]).map(g=>{const c=cm[g.id],ss=active.filter(x=>x.group_id===g.id),valid=c?.active&&(!c.expires_at||new Date(c.expires_at)>new Date());return `<div class="panel ref-admin-card"><div><small>BẢNG</small><h2>${esc(g.name)}</h2></div>${valid&&isAdmin?`<div class="ref-admin-code"><small>MÃ TRỌNG TÀI</small>${adminCodes.error?`<p>Không thể tải mã: ${esc(adminCodes.error.message)}</p>`:readableCodes[g.id]?`<div class="ref-admin-code-row"><strong>${esc(readableCodes[g.id])}</strong><button class="ghost" data-copy-code="${g.id}">Sao chép</button></div><span class="ref-copy-feedback" role="status" data-copy-feedback="${g.id}"></span>`:'<p>Mã cũ không thể hiển thị. Đổi code để xem và sao chép.</p>'}</div>`:''}<div class="ref-admin-status ${valid?'active':''}">${valid?'● Đang hoạt động':'○ Chưa có code hoạt động'}</div><p>${ss.length?`Đang đăng nhập: <b>${ss.map(x=>esc(x.referee_name)).join(', ')}</b>`:'Chưa có trọng tài đăng nhập.'}</p><div class="ref-admin-actions"><button data-new-code="${g.id}">${valid?'Đổi code':'Tạo code'}</button>${c?.active?`<button class="danger" data-revoke-code="${g.id}">Thu hồi</button>`:''}</div></div>`}).join('')||'<div class="panel">Hãy chia bảng trước.</div>'}</div><div class="panel ref-log"><h2>Nhật ký nhập điểm</h2>${(logs||[]).map(l=>`<div class="ref-log-row"><b>${esc(l.referee_name||'Trọng tài')}</b><span>Bảng ${esc(l.group_name||gm[l.group_id]||'—')} · ${esc(l.match_code||mm[l.match_id]||'Trận đã xóa')}${l.game_order?` · G${l.game_order} ${esc(mlpGameLabel(l.game_type))}`:''}${actionLabel[l.action]?` · ${actionLabel[l.action]}`:''}</span><span>${l.game_order?score(l.old_game_team1_score,l.old_game_team2_score)+' → '+score(l.new_game_team1_score,l.new_game_team2_score):score(l.old_team1_score,l.old_team2_score)+' → '+score(l.new_team1_score,l.new_team2_score)}</span><small>${new Date(l.created_at).toLocaleString('vi-VN')}</small></div>`).join('')||'<p>Chưa có hoạt động.</p>'}</div>`;
 document.querySelectorAll('[data-copy-code]').forEach(b=>b.onclick=async()=>{
  try{await navigator.clipboard.writeText(readableCodes[b.dataset.copyCode]);const feedback=document.querySelector(`[data-copy-feedback="${b.dataset.copyCode}"]`);feedback.textContent='✓ Đã sao chép';setTimeout(()=>{if(feedback.isConnected)feedback.textContent=''},2200)}
  catch{alert('Không thể sao chép. Vui lòng chọn và sao chép mã thủ công.')}
 });
 document.querySelectorAll('[data-new-code]').forEach(b=>b.onclick=()=>refereeCodeModal(tid,(groups||[]).find(g=>g.id===b.dataset.newCode)));
 document.querySelectorAll('[data-revoke-code]').forEach(b=>b.onclick=async()=>{if(!confirm('Thu hồi code và đăng xuất trọng tài của bảng này?'))return;const {error}=await supabase.rpc('revoke_referee_code',{p_tournament_id:tid,p_group_id:b.dataset.revokeCode});if(error)return alert(error.message);if(epoch===renderEpoch)await renderRefereeAdmin(tid)});
}
function refereeCodeModal(tid,g){
 const epoch=renderEpoch;
 let code='';while(code.length<8){for(const byte of crypto.getRandomValues(new Uint8Array(8))){if(byte<250)code+=byte%10;if(code.length===8)break}}
 document.querySelector('#modal').innerHTML=`<div class="overlay"><form class="modal" id="codeForm"><div class="modalhead"><div><small>BẢNG ${esc(g.name)}</small><h2>Cấp mã trọng tài</h2><p>${esc(activeEvent.name)}</p></div><button type="button" class="x">×</button></div><p>Gửi mã này cho trọng tài phụ trách Bảng ${esc(g.name)}.</p><label>Mã code<input name="code" value="${code}" minlength="8" required inputmode="numeric"></label><div class="code-preview">${code}</div><button class="wide">Kích hoạt code</button><div id="codeMsg"></div></form></div>`;
 const f=document.querySelector('#codeForm'),input=f.querySelector('[name=code]'),preview=f.querySelector('.code-preview');
 f.querySelector('.x').onclick=()=>document.querySelector('#modal').innerHTML='';input.oninput=()=>preview.textContent=input.value;
 f.onsubmit=async e=>{e.preventDefault();const val=input.value.trim(),btn=f.querySelector('.wide');btn.disabled=true;const {error}=await supabase.rpc('set_referee_code',{p_tournament_id:tid,p_group_id:g.id,p_code:val,p_expires_at:null});if(error){btn.disabled=false;f.querySelector('#codeMsg').textContent=error.message;return}if(epoch!==renderEpoch)return;alert(`Code Bảng ${g.name}: ${val}\n\nHãy gửi code này cho trọng tài.`);document.querySelector('#modal').innerHTML='';renderRefereeAdmin(tid)};
}

async function renderStandings(tid){const epoch=renderEpoch;let data=await standingsData(tid);if(epoch!==renderEpoch)return;startLive(`admin:standings:${tid}`,()=>renderStandings(tid));document.querySelector('#workcontent').innerHTML=`<small>BXH</small><h1>${esc(currentTournament.name)}</h1>${data.map(x=>`<div class="panel standings"><h2>Bảng ${esc(x.group.name)}</h2><table><tr><th>#</th><th>Đội</th><th>Trận</th><th>W</th><th>L</th><th>+</th><th>-</th><th>+/-</th></tr>${x.rows.map((r,i)=>`<tr><td>${i+1}</td><td>${esc(r.name)}</td><td>${r.p}</td><td>${r.w}</td><td>${r.l}</td><td>${r.pf}</td><td>${r.pa}</td><td>${r.diff>0?'+':''}${r.diff}</td></tr>`).join('')}</table></div>`).join('')||'<div class="panel">Chưa chia bảng.</div>'}`}
async function renderKnockout(tid){const db=competitionClient(supabase,activeEvent);const epoch=renderEpoch;const stages=['round_of_16','quarterfinal','semifinal','final'];const {data:ko}=await db.from('matches').select('*').eq('tournament_id',tid).in('stage',stages).order('created_at');const {data:teams}=await db.from('teams').select('id,name').eq('tournament_id',tid);let tm=Object.fromEntries((teams||[]).map(x=>[x.id,x.name]));if(epoch!==renderEpoch)return;document.querySelector('#workcontent').innerHTML=`<small>KNOCKOUT</small><h1>${esc(currentTournament.name)}</h1><div class="panel"><div class="toolbar"><button id="makeKO">Tạo Knockout từ BXH</button></div>${ko?.length?stages.map(st=>{let arr=ko.filter(x=>x.stage===st);return arr.length?`<h3>${stageLabel(st)}</h3><div class="bracket-round">${arr.map(m=>`<div class="bracket-match"><b>${esc(m.match_code)}</b> · ${esc(tm[m.team1_id]||'TBD')} vs ${esc(tm[m.team2_id]||'TBD')}</div>`).join('')}</div>`:''}).join(''):'<p>Chưa tạo nhánh Knockout.</p>'}</div>`;document.querySelector('#makeKO').onclick=()=>createKnockout(tid)}
function stageLabel(s){return ({round_of_16:'1/16',quarterfinal:'Tứ kết',semifinal:'Bán kết',final:'Chung kết'})[s]||s}
async function createKnockout(tid){const epoch=renderEpoch;const db=competitionClient(supabase,activeEvent);let standings=await standingsData(tid);if(!standings.length)return alert('Chưa có bảng.');let qualified=standings.flatMap(x=>x.rows.slice(0,2).map((r,i)=>({...r,group:x.group.name,pos:i+1})));let target=qualified.length<=8?8:qualified.length<=16?16:32;if(qualified.length<target){let thirds=standings.map(x=>x.rows[2]).filter(Boolean).sort((a,b)=>b.w-a.w||b.diff-a.diff||b.pf-a.pf);qualified.push(...thirds.slice(0,target-qualified.length))}if(qualified.length<target)return alert(`Chỉ có ${qualified.length} đội đủ dữ liệu, chưa đủ bracket ${target}.`);qualified=qualified.slice(0,target);await db.from('matches').delete().eq('tournament_id',tid).neq('stage','group');let stage=target===16?'round_of_16':target===8?'quarterfinal':'round_of_32';let rows=[];for(let i=0;i<target/2;i++){let a=qualified[i],b=qualified[target-1-i];rows.push({tournament_id:tid,match_code:`KO${String(i+1).padStart(2,'0')}`,stage,team1_id:a.id,team2_id:b.id,status:'scheduled',scheduled_order:i+1})}let {error}=await db.from('matches').insert(rows);if(error)return alert(error.message);await supabase.from('tournament_events').update({status:'knockout'}).eq('id',db.event.id);if(epoch===renderEpoch)await workspace(tid,'knockout')}
async function slotsModal(t){
 const db=competitionClient(supabase,activeEvent),epoch=renderEpoch;
 const [{data:c,error:configError},{data:slots,error:slotError}]=await Promise.all([
  db.from('mlp_configs').select('*').eq('tournament_id',t.id).single(),
  db.from('mlp_slots').select('*').eq('tournament_id',t.id).order('slot_order')
 ]);
 if(epoch!==renderEpoch)return;
 if(configError||slotError)return alert((configError||slotError).message);
 const n=c?.members_per_team||4;
 const rosterSlots=Array.from({length:n},(_,i)=>slots?.find(s=>s.slot_order===i+1)||{slot_order:i+1,slot_name:`VĐV ${i+1}`,gender:'any',max_rating:null});
 document.querySelector('#modal').innerHTML=`<div class="overlay"><form class="modal" id="slotform"><div class="modalhead"><h2>Đội hình MLP</h2><button type="button" class="x">×</button></div>${rosterSlots.map((slot,i)=>`<div class="slot"><input name="name${i}" value="${esc(slot.slot_name)}"><select name="gender${i}">${[['any','Không giới hạn'],['male','Nam'],['female','Nữ']].map(([value,label])=>`<option value="${value}" ${slot.gender===value?'selected':''}>${label}</option>`).join('')}</select><input name="rating${i}" type="number" step=".1" value="${esc(slot.max_rating??'')}" placeholder="Max trình"></div>`).join('')}<button class="wide">Lưu đội hình</button><p id="slotMessage" role="alert"></p></form></div>`;
 const form=document.querySelector('#slotform');form.querySelector('.x').onclick=()=>document.querySelector('#modal').innerHTML='';
 form.onsubmit=async e=>{
  e.preventDefault();const fd=new FormData(form),button=form.querySelector('.wide');button.disabled=true;
  const rows=rosterSlots.map((slot,i)=>({...(slot.id?{id:slot.id}:{}),tournament_id:t.id,slot_order:slot.slot_order,slot_name:fd.get('name'+i),gender:fd.get('gender'+i),max_rating:fd.get('rating'+i)?Number(fd.get('rating'+i)):null}));
  const {error}=await db.from('mlp_slots').upsert(rows,{onConflict:'event_id,slot_order'});
  if(epoch!==renderEpoch)return;
  if(error){button.disabled=false;form.querySelector('#slotMessage').textContent=error.message;return}
  document.querySelector('#modal').innerHTML='';
  await workspace(t.id,'overview',db.event.id);
 };
}
boot()
