import {qualify,buildBracket,knockoutStages,knockoutLabel,sourceLabel,knockoutRPC} from './knockout-engine.js';
import {competitionClient} from './event-scope.js';
import {courtLabel} from './match-courts.js';
import {matchStatus} from './spectator.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
// Layout only: source references determine visual positions; persisted matches
// and their order/participants are never changed by the bracket renderer.
function fiveGroupPreview(groups){
  const pantryGroup=groups.find(group=>group.id==='edd73fb4-9e56-4885-856a-63453b146df0');
  const exampleGroup=pantryGroup||groups.at(-1);
  const standings=groups.map(group=>({
    group,
    rows:Array.from({length:group===exampleGroup?3:2},(_,i)=>({
      id:`${group.id}:${i+1}`,
      name:`${group.name}${i+1}`,
      w:0,diff:0,pf:0
    }))
  }));
  const result=qualify(standings);
  const labels=Object.fromEntries(result.qualifiers.map(team=>[team.team_id,team.name]));
  return `<details class="panel">
    <summary><strong>Xem trước nhánh 5 bảng · A1, B2…</strong></summary>
    <p>5 đội nhất bảng vào thẳng tứ kết. 5 đội nhì bảng và ${pantryGroup?'đội hạng ba bảng E':'đội hạng ba tốt nhất'} đá 3 trận playoff.</p>
    <p>${pantryGroup?'Vé vớt dành cho':'Sơ đồ minh họa giả sử'} <strong>${esc(exampleGroup.name)}3</strong> nhận vé vớt. Cặp đấu thực tế được xác định sau vòng bảng.</p>
    ${publicBracket(buildBracket(result),labels)}
  </details>`;
}

export function publicBracket(matches,teamNames,{admin=false}={}){
  const rounds=knockoutStages.map(stage=>({stage,matches:matches.filter(m=>m.stage===stage)
    .sort((a,b)=>(a.scheduled_order??0)-(b.scheduled_order??0))})).filter(r=>r.matches.length);
  if(!rounds.length)return '';
  const rows=Math.max(...rounds.map(r=>r.matches.length));
  const anchor=rounds.findIndex(r=>r.matches.length===rows);
  const byId=new Map(matches.filter(m=>m.id).map(m=>[m.id,m]));
  const byCode=new Map(matches.map(m=>[m.match_code,m]));
  const sources=m=>[1,2].map(side=>byId.get(m[`team${side}_source_match_id`])||byCode.get(m[`team${side}_source_code`])).filter(Boolean);
  const positions=new Map();
  rounds.forEach(r=>r.matches.forEach((m,i)=>positions.set(m,Math.round((i+.5)*rows*2/r.matches.length))));
  // R16 (or QF in the five-group format) sets the vertical rhythm. Earlier
  // playoffs align with their QF destination; later rounds center on feeders.
  for(let i=anchor-1;i>=0;i--)for(const target of rounds[i+1].matches){
    const feeders=sources(target).filter(m=>rounds[i].matches.includes(m));
    feeders.forEach((m,j)=>positions.set(m,positions.get(target)+(feeders.length===1?0:j*2-1)));
  }
  for(let i=anchor+1;i<rounds.length;i++)for(const m of rounds[i].matches){
    const feeders=sources(m).filter(source=>positions.has(source));
    if(feeders.length)positions.set(m,Math.round(feeders.reduce((sum,source)=>sum+positions.get(source),0)/feeders.length));
  }
  const playoffs=rounds.find(round=>round.stage==='playoff')?.matches||[];
  if(playoffs.length===3&&rows===4){
    const ordered=[...playoffs].sort((a,b)=>b.match_code.localeCompare(a.match_code,undefined,{numeric:true}));
    const slots=playoffs.map(match=>positions.get(match)).sort((a,b)=>a-b);
    ordered.forEach((match,index)=>positions.set(match,slots[index]));
  }
  const card=m=>{
    const codeTag=admin||!m.id?'b':'button';
    const hasScore=m.team1_score!=null||m.team2_score!=null;
    return `<article class="knockout-card" ${m.id?`data-knockout-match="${esc(m.id)}"`:''} aria-label="${esc(m.match_code)}" style="grid-row:${positions.get(m)+1} / span 2">
      <div class="knockout-card-head"><${codeTag} class="knockout-code ${codeTag==='button'?'public-match-link':''}" ${m.id?`data-open-match="${esc(m.id)}"`:''}>${esc(m.match_code)}</${codeTag}><span class="knockout-card-state" ${m.id?`data-match-state="${esc(m.id)}"`:''} data-base-status="${matchStatus(m)}">${matchStatus(m)}</span></div>
      ${[1,2].map(side=>`<div class="knockout-team"><span>${esc(sourceLabel(m,side,matches,teamNames))}</span><strong aria-label="Điểm đội ${side}">${hasScore?esc(m[`team${side}_score`]??'—'):'—'}</strong></div>`).join('')}
      <div class="knockout-card-footer"><span class="knockout-court">${courtLabel(m.court_number)||'Chưa xếp sân'}</span>${m.id?`<div class="public-video-slot" data-public-video="${esc(m.id)}" data-video-label="${esc(m.match_code)}"></div>`:''}</div>
    </article>`;
  };
  const edges=index=>index===rounds.length-1?'':rounds[index+1].matches.flatMap(target=>sources(target)
    .filter(source=>rounds[index].matches.includes(source)).map(source=>{
      const from=positions.get(source),to=positions.get(target),travel=Math.abs(to-from);
      return `<div class="knockout-edge ${from>to?'knockout-edge-up':''}" aria-hidden="true" style="grid-row:${Math.min(from,to)+1} / span ${travel+2};--edge-rows:${travel+2};--travel:${travel}"><span class="knockout-wire"></span></div>`;
    })).join('');
  return `<div class="knockout-scroll" role="region" aria-label="Nhánh knockout · Cuộn ngang để xem các vòng" tabindex="0"><div class="knockout-bracket ${admin?'knockout-bracket-admin':''}" style="--round-count:${rounds.length};--bracket-rows:${rows*2}">${rounds.map((round,i)=>`<section class="knockout-round" style="grid-column:${i+1}" aria-label="${knockoutLabel(round.stage)}"><h2>${knockoutLabel(round.stage)}</h2>${round.matches.map(card).join('')}${edges(i)}</section>`).join('')}</div></div>`;
}
function knockoutPoster(matches,teamNames,eventName){
 const rounds=knockoutStages.map(stage=>({stage,matches:matches.filter(m=>m.stage===stage).sort((a,b)=>(a.scheduled_order??0)-(b.scheduled_order??0))})).filter(r=>r.matches.length);
 if(!rounds.length)throw Error('Chưa có nhánh Knockout để xuất ảnh.');
 const playoffs=rounds.find(round=>round.stage==='playoff');
 if(playoffs?.matches.length===3&&rounds.some(round=>round.stage==='quarterfinal'&&round.matches.length===4)){
  playoffs.matches.sort((a,b)=>b.match_code.localeCompare(a.match_code,undefined,{numeric:true}));
 }
 const cardW=370,cardH=142,colGap=105,top=260,bottom=100,left=75,spacing=26;
 const firstCount=Math.max(...rounds.map(r=>r.matches.length));
 const rowStep=cardH+spacing;
 const width=left*2+rounds.length*cardW+(rounds.length-1)*colGap;
 const height=top+Math.max(firstCount*rowStep,cardH+100)+bottom;
 const canvas=document.createElement('canvas');const ratio=Math.min(2,4000/Math.max(width,height));canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
 const c=canvas.getContext('2d');c.scale(ratio,ratio);
 c.fillStyle='#142319';c.fillRect(0,0,width,height);
 c.fillStyle='#b5cc91';c.fillRect(0,0,width,12);
 c.fillStyle='#a6c188';c.font='bold 24px system-ui,sans-serif';c.fillText('THE PANTRY  •  TOURNAMENT',left,76);
 const title=String(eventName||'KNOCKOUT');let font=58;while(font>25){c.font='800 '+font+'px system-ui,sans-serif';if(c.measureText(title).width<width-left*2)break;font-=2}
 c.fillStyle='#fff';c.fillText(title,left,151);
 c.fillStyle='#d0dcc2';c.font='bold 27px system-ui,sans-serif';c.fillText('NHÁNH THI ĐẤU KNOCKOUT',left,205);
 const map=new Map();
 rounds.forEach((round,j)=>round.matches.forEach((m,i)=>{
  const x=left+j*(cardW+colGap),cy=top+((i+.5)*firstCount/round.matches.length)*rowStep;
  map.set(m.match_code,{x,y:cy-cardH/2,cy});
 }));
 const byCode=new Map(matches.map(m=>[m.match_code,m])),byId=new Map(matches.filter(m=>m.id).map(m=>[m.id,m]));
 c.strokeStyle='#91a983';c.lineWidth=4;
 for(const round of rounds)for(const m of round.matches){const to=map.get(m.match_code);if(!to)continue;for(const side of [1,2]){const fromMatch=byId.get(m[`team${side}_source_match_id`])||byCode.get(m[`team${side}_source_code`]);const from=fromMatch&&map.get(fromMatch.match_code);if(!from)continue;c.beginPath();c.moveTo(from.x+cardW,from.cy);c.lineTo(from.x+cardW+colGap/2,from.cy);c.lineTo(from.x+cardW+colGap/2,to.cy);c.lineTo(to.x,to.cy);c.stroke()}}
 const fit=(value,max,size=23)=>{let n=size;while(n>14){c.font='700 '+n+'px system-ui,sans-serif';if(c.measureText(value).width<=max)break;n--}return n};
 for(const [j,round] of rounds.entries()){
  const x=left+j*(cardW+colGap);c.fillStyle='#b9d49c';c.font='800 27px system-ui,sans-serif';c.fillText(knockoutLabel(round.stage).toUpperCase(),x,top-46);
  for(const m of round.matches){const box=map.get(m.match_code),y=box.y;
   c.fillStyle='#f5f4e9';c.beginPath();c.roundRect(x,y,cardW,cardH,15);c.fill();
   c.fillStyle='#405435';c.beginPath();c.roundRect(x,y,cardW,37,[15,15,0,0]);c.fill();
   c.fillStyle='#fff';c.font='700 19px system-ui,sans-serif';c.fillText(m.match_code,x+17,y+25);
   for(const side of [1,2]){const label=String(sourceLabel(m,side,matches,teamNames)),score=m[`team${side}_score`],yy=y+74+(side-1)*43;
    c.fillStyle='#1b2a1e';fit(label,cardW-90);let shown=label;while(c.measureText(shown).width>cardW-90&&shown.length>4)shown=shown.slice(0,-2)+'…';c.fillText(shown,x+17,yy);
    if(score!=null){c.textAlign='right';c.fillText(String(score),x+cardW-18,yy);c.textAlign='left'}
   }
  }
 }
 c.fillStyle='#bbd0ab';c.font='22px system-ui,sans-serif';c.fillText('giaipantry.com',left,height-47);
 return canvas;
}
function openKnockoutPoster(matches,teamNames,eventName){
 let canvas;try{canvas=knockoutPoster(matches,teamNames,eventName)}catch(error){alert(error.message);return}
 const overlay=document.createElement('div');overlay.className='overlay';overlay.style.zIndex='10000';
 const image=canvas.toDataURL('image/png'),filename='pantry-knockout-'+new Date().toISOString().slice(0,10)+'.png';
 overlay.innerHTML=`<div class="modal" style="width:min(96vw,1000px);max-height:94dvh;overflow:auto"><div class="modalhead"><h2>Ảnh nhánh Knockout</h2><button class="x" type="button" aria-label="Đóng">×</button></div><p>Tải ảnh PNG hoặc chia sẻ trực tiếp cho VĐV.</p><img alt="Sơ đồ nhánh Knockout" src="${image}" style="display:block;width:100%;max-height:65dvh;object-fit:contain;background:#142319;border-radius:12px"><div class="actions" style="display:flex;flex-wrap:wrap;gap:10px;margin-top:15px"><button type="button" id="koPosterDownload">⬇ TẢI ẢNH PNG</button><button type="button" class="secondary" id="koPosterShare">CHIA SẺ</button><button type="button" class="ghost" id="koPosterClose">Đóng</button></div><p id="koPosterError" role="status"></p></div>`;
 document.body.appendChild(overlay);const close=()=>overlay.remove();
 overlay.querySelector('.x').onclick=close;overlay.querySelector('#koPosterClose').onclick=close;
 overlay.querySelector('#koPosterDownload').onclick=()=>{const a=document.createElement('a');a.href=image;a.download=filename;document.body.appendChild(a);a.click();a.remove()};
 overlay.querySelector('#koPosterShare').onclick=async()=>{try{const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('Không tạo được ảnh.');const file=new File([blob],filename,{type:'image/png'});if(!navigator.share||!navigator.canShare?.({files:[file]}))throw Error('Thiết bị không hỗ trợ chia sẻ ảnh trực tiếp. Hãy tải PNG.');await navigator.share({files:[file],title:'Nhánh Knockout'})}catch(error){if(error.name!=='AbortError')overlay.querySelector('#koPosterError').textContent=error.message}};
}
export async function renderManagedKnockout({client,event,host,standingsData,isCurrent,mountCourt,mountLive=()=>{}}){
  const db=competitionClient(client,event),rpc=(name,args)=>knockoutRPC(client,event,name,args);
  host.innerHTML='<p>Đang tải Knockout…</p>';
  try{
    const [decisionResult,matchResult,teamResult]=await Promise.all([
      client.from('knockout_decisions').select('*').eq('event_id',event.id).maybeSingle(),
      db.from('matches').select('*').neq('stage','group').order('scheduled_order'),
      db.from('teams').select('id,name')
    ]);
    if(!isCurrent())return;
    for(const r of [decisionResult,matchResult,teamResult])if(r.error)throw r.error;
    const decision=decisionResult.data,matches=matchResult.data||[],names=Object.fromEntries((teamResult.data||[]).map(t=>[t.id,t.name]));
    const managed=decision?.state==='generated',started=decision?.started_at||matches.some(m=>['playing','completed'].includes(m.status)||m.started_at||m.completed_at||m.team1_score!==null||m.team2_score!==null);
    host.innerHTML=`<small>KNOCKOUT</small><h1>${esc(event.name)}</h1><div class="panel" id="koControls"></div>${matches.length?'<div class="ko-export-actions"><button id="koExportPoster" class="secondary">📷 XUẤT ẢNH NHÁNH KNOCKOUT</button></div>':''}${publicBracket(matches,names,{admin:true})}<div id="koPreview"></div>`;
    const controls=host.querySelector('#koControls');host.querySelector('#koExportPoster')?.addEventListener('click',()=>openKnockoutPoster(matches,names,event.name));
    // Preserve existing court control; scoring is only exposed for managed doubles.
    for(const m of matches){const card=host.querySelector(`[data-knockout-match="${m.id}"]`);if(!card)continue;mountCourt(card,m,db);
      if(managed&&event.format==='doubles'&&m.team1_id&&m.team2_id){
        const form=document.createElement('form');form.className='knockout-score';form.noValidate=true;
        form.innerHTML=`<label>Điểm đội 1<input name="s1" type="number" min="0" step="1" required value="${m.team1_score??''}"></label><span class="knockout-score-separator" aria-hidden="true">:</span><label>Điểm đội 2<input name="s2" type="number" min="0" step="1" required value="${m.team2_score??''}"></label><button>LƯU TỈ SỐ</button><p role="alert"></p>`;
        card.append(form);form.onsubmit=async e=>{
          e.preventDefault();const b=form.querySelector('button'),errorBox=form.querySelector('[role=alert]');
          if(b.disabled)return;
          errorBox.textContent='';
          const values=[form.elements.s1.value.trim(),form.elements.s2.value.trim()],scores=values.map(Number);
          if(values.some(value=>value==='')||scores.some(score=>!Number.isFinite(score)||!Number.isInteger(score)||score<0)){
            errorBox.textContent='Vui lòng nhập đầy đủ hai tỉ số là số nguyên không âm.';return;
          }
          if(scores[0]===scores[1]){errorBox.textContent='Trận knockout không được hòa. Vui lòng nhập tỉ số xác định đội thắng.';return}
          b.disabled=true;
          try{await rpc('pantry_knockout_score',{p_match:m.id,p_expected_revision:decision.revision,p_expected_score_version:m.score_version,p_score1:scores[0],p_score2:scores[1]});if(isCurrent())await renderManagedKnockout({client,event,host,standingsData,isCurrent,mountCourt,mountLive})}
          catch(error){form.querySelector('[role=alert]').textContent=error.message}finally{b.disabled=false}
        };
      }
    }
    mountLive(managed&&event.format==='doubles'?matches.filter(m=>m.team1_id&&m.team2_id):[]);
    if(event.format!=='doubles'){controls.textContent='MLP knockout chưa được bật. MLP hiện tại tiếp tục hoạt động như trước.';return}
    if(started){controls.textContent='Knockout đã bắt đầu. Không thể tạo lại nhánh.';return}
    if(matches.length&&!managed){controls.textContent='Nhánh cũ chưa được quản lý. Không tự động thay thế hoặc nhận nhánh cũ.';return}
    // Save symbolic group pairings before round-robin results exist.
    const groupInput=await rpc('pantry_knockout_inputs');
    const planGroups=(groupInput.groups||[]).slice().sort((a,b)=>a.group_order-b.group_order);
    if(!isCurrent())return;
    if(planGroups.length===5)controls.insertAdjacentHTML('beforebegin',fiveGroupPreview(planGroups));
    let knockoutPreplan=null;
    if(planGroups.length===4){
      const {data:savedPlan,error:planError}=await client.rpc('pantry_knockout_preplan_get',{p_event:event.id});
      if(planError)throw planError;
      knockoutPreplan=savedPlan;
      const idToName=Object.fromEntries(planGroups.map(g=>[g.id,g.name]));
      let pairings=Array.isArray(savedPlan)&&savedPlan.length===2?savedPlan: [[planGroups[0].id,planGroups[2].id],[planGroups[1].id,planGroups[3].id]];
      const options=planGroups.map(g=>`<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
      const symbolic=()=>pairings.flatMap(([a,b])=>[[`Nhất ${idToName[a]}`,`Nhì ${idToName[b]}`],[`Nhất ${idToName[b]}`,`Nhì ${idToName[a]}`]]);
      const exportPlan=()=>{
        if(new Set(pairings.flat()).size!==4){alert('Mỗi bảng phải xuất hiện đúng một lần.');return}
        const names={},nodes=[];
        const slots=symbolic();
        slots.forEach((pair,i)=>{
          const ids=pair.map((label,side)=>'preplan-'+i+'-'+side);
          ids.forEach((id,side)=>names[id]=pair[side]);
          nodes.push({match_code:'TK-'+(i+1),stage:'quarterfinal',scheduled_order:i+1,team1_id:ids[0],team2_id:ids[1],team1_score:null,team2_score:null});
        });
        for(let i=0;i<2;i++)nodes.push({match_code:'BK-'+(i+1),stage:'semifinal',scheduled_order:5+i,team1_source_code:'TK-'+(i+1),team2_source_code:'TK-'+(i+3),team1_score:null,team2_score:null});
        nodes.push({match_code:'CK-1',stage:'final',scheduled_order:7,team1_source_code:'BK-1',team2_source_code:'BK-2',team1_score:null,team2_score:null});
        openKnockoutPoster(nodes,names,event.name);
      };
      const plan=document.createElement('section');plan.className='panel';plan.id='koPreplan';
      const paintPlan=()=>{
        plan.innerHTML=`<h2>VẼ NHÁNH TRƯỚC VÒNG BẢNG</h2><p>4 bảng · 8 đội vào Tứ kết. Chọn hai cặp bảng đối đầu, mỗi bảng chỉ được chọn một lần.</p>
          <div class="ko-pairings">${pairings.map(([a,b],i)=>`<label>Cặp bảng ${i+1} <select data-pair="${i}" data-side="0">${options}</select> ↔ <select data-pair="${i}" data-side="1">${options}</select></label>`).join('')}</div>
          <h3>XEM TRƯỚC TỨ KẾT</h3><div class="ko-preplan-grid">${symbolic().map((x,i)=>`<div class="ko-preplan-match"><strong>TỨ KẾT ${i+1}</strong><div>${esc(x[0])}</div><div>${esc(x[1])}</div></div>`).join('')}</div>
          <p>Bán kết 1: Thắng TK1 vs Thắng TK3. Bán kết 2: Thắng TK2 vs Thắng TK4. Các đội cùng bảng chỉ có thể gặp lại ở chung kết. Tên đội sẽ được xác định theo BXH sau vòng bảng.</p>
          <button id="koSavePreplan">LƯU NHÁNH THEO BẢNG</button> <button id="koExportPreplan" class="secondary">📷 XUẤT ẢNH NHÁNH TỨ KẾT → CHUNG KẾT</button><p role="alert" id="koPreplanError"></p>`;
        plan.querySelectorAll('select').forEach(el=>{el.value=pairings[Number(el.dataset.pair)][Number(el.dataset.side)];el.onchange=()=>{pairings[Number(el.dataset.pair)][Number(el.dataset.side)]=el.value;paintPlan()}});
        plan.querySelector('#koExportPreplan').onclick=exportPlan;
        plan.querySelector('#koSavePreplan').onclick=async()=>{
          const flat=pairings.flat();
          const error=plan.querySelector('#koPreplanError');
          if(new Set(flat).size!==4){error.textContent='Mỗi bảng phải xuất hiện đúng một lần.';return}
          const button=plan.querySelector('#koSavePreplan');button.disabled=true;
          try{const {error:e}=await client.rpc('pantry_knockout_preplan_save',{p_event:event.id,p_pairings:pairings});if(e)throw e;knockoutPreplan=pairings.map(p=>[...p]);error.textContent='Đã lưu nhánh theo bảng. Khi hoàn tất vòng bảng, chọn TỰ VẼ NHÁNH để xác nhận đội và tạo trận.'}
          catch(e){error.textContent=e.message}finally{button.disabled=false}
        };
      };
      paintPlan();controls.before(plan);
    }
    controls.innerHTML=`<button id="koPreviewButton">⚡ TỰ VẼ NHÁNH KNOCKOUT</button><p role="alert"></p>`;
    controls.querySelector('button').onclick=async()=>{
      const b=controls.querySelector('button');b.disabled=true;
      try{
        // Capture before standings: any changed group inputs invalidate generation.
        const inputs=await rpc('pantry_knockout_inputs');if(!isCurrent())return;
        const standings=await standingsData();if(!isCurrent())return;
        const incomplete=[];
        for(const {group,rows} of standings){
          const gm=inputs.matches.filter(m=>m.group_id===group.id);
          const missing=[];
          for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
            const pair=gm.filter(m=>[m.team1_id,m.team2_id].includes(rows[i].id)&&[m.team1_id,m.team2_id].includes(rows[j].id));
            if(pair.length!==1||pair[0].status!=='completed'||pair[0].team1_score==null||pair[0].team2_score==null||![pair[0].team1_id,pair[0].team2_id].includes(pair[0].winner_id))missing.push(`${rows[i].name} – ${rows[j].name}`);
          }
          if(rows.length<2||missing.length)incomplete.push(`Bảng ${group.name}: ${missing.join('; ')||'chưa đủ đội'}`);
        }
        const registered=teamResult.data||[];
        const unassigned=registered.filter(t=>!inputs.links.some(l=>l.team_id===t.id));
        if(unassigned.length)incomplete.push(`${unassigned.length} VĐV/đội chưa có bảng`);
        if(incomplete.length)throw Error('Chưa xác định được suất Knockout. '+incomplete.join(' · '));
        let draws=decision?.snapshot?.draws||[],revision=decision?.revision||0;
        const preview=host.querySelector('#koPreview');
        let redraw=false;
        const shuffle=items=>{const out=[...items];for(let i=out.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[out[i],out[j]]=[out[j],out[i]]}return out};
        const paint=()=>{
          const result=qualify(standings,draws);result.snapshot.input_state=inputs;
          const nodes=result.unresolved.length?[]:buildBracket(redraw&&!knockoutPreplan?{...result,qualifiers:shuffle(result.qualifiers),snapshot:{...result.snapshot,standings:shuffle(result.snapshot.standings)}}:result,knockoutPreplan);
          preview.innerHTML=`<div class="panel"><h2>XEM TRƯỚC NHÁNH KNOCKOUT</h2><h3>${result.group_count===5?'VÀO THẲNG TỨ KẾT':`${result.qualifiers.length} ĐỘI VÀO VÒNG LOẠI`}</h3>${[['group_winner',result.group_count===5?'VÀO THẲNG TỨ KẾT':'NHẤT BẢNG'],['runner_up','NHÌ BẢNG'],['wildcard_third','VÉ VỚT HẠNG 3']].map(([type,label])=>`<h3>${label}</h3><ul>${result.qualifiers.filter(q=>q.qualification_type===type&&!result.unresolved.some(t=>t.teams.some(x=>x.team_id===q.team_id))).map(q=>`<li>${esc(q.group_name)}${q.group_position} · ${esc(q.name)}${q.group_position===3?` · ${q.point_difference>0?'+':''}${q.point_difference} / ${q.points_scored} điểm`:''}</li>`).join('')}</ul>`).join('')}${result.unresolved.map((tie,i)=>`<fieldset><legend>Đồng hạng vé vớt: chọn thứ tự bốc thăm (${tie.slots} suất)</legend><p>Hiệu số ${tie.point_difference} · Tổng điểm ${tie.points_scored}. Nhập thứ tự đầy đủ, không trùng.</p>${tie.teams.map((q,j)=>`<label>${esc(q.group_name)}3 · ${esc(q.name)}<input data-draw="${i}" data-team="${esc(q.team_id)}" type="number" min="1" max="${tie.teams.length}" placeholder="Thứ tự"></label>`).join('')}<button data-resolve="${i}">Xác nhận thứ tự bốc thăm</button></fieldset>`).join('')}${nodes.length?publicBracket(nodes,Object.fromEntries(result.qualifiers.map(q=>[q.team_id,`${q.group_name}${q.group_position} · ${q.name}`]))):''}<p role="alert" id="koError"></p>${nodes.length?`<button id="koRedraw" class="secondary">VẼ LẠI</button><button id="koPreviewExport" class="secondary">📷 XUẤT ẢNH NHÁNH</button><button id="koGenerate">XÁC NHẬN NHÁNH</button>`:''}</div>`;
          preview.querySelectorAll('[data-resolve]').forEach(button=>button.onclick=async()=>{
            const i=Number(button.dataset.resolve),tie=result.unresolved[i],items=[...preview.querySelectorAll(`[data-draw="${i}"]`)].map(input=>({id:input.dataset.team,rank:Number(input.value)}));
            if(items.some(x=>!Number.isInteger(x.rank)||x.rank<1||x.rank>items.length)||new Set(items.map(x=>x.rank)).size!==items.length){preview.querySelector('#koError').textContent='Cần nhập đầy đủ thứ tự 1 đến '+items.length;return}
            const nextDraws=[...draws,{group_position:3,point_difference:tie.point_difference,points_scored:tie.points_scored,ordered_team_ids:items.sort((a,b)=>a.rank-b.rank).map(x=>x.id),method:'admin_draw'}];
            button.disabled=true;
            try{
              const resolved=qualify(standings,nextDraws);resolved.snapshot.input_state=inputs;
              draws=nextDraws;if(isCurrent())paint();
            }catch(error){preview.querySelector('#koError').textContent=error.message;button.disabled=false}
          });
          const exportButton=preview.querySelector('#koPreviewExport');if(exportButton)exportButton.onclick=()=>openKnockoutPoster(nodes,Object.fromEntries(result.qualifiers.map(q=>[q.team_id,q.name])),event.name);
          const redrawButton=preview.querySelector('#koRedraw');if(redrawButton)redrawButton.onclick=()=>{redraw=true;paint()};
          const generate=preview.querySelector('#koGenerate');if(generate)generate.onclick=async()=>{
            if(!isCurrent())return;
            if(!confirm(managed?'Xác nhận thay thế toàn bộ nhánh Knockout chưa bắt đầu của nội dung này?':'Xác nhận tạo nhánh Knockout theo bản xem trước?'))return;
            generate.disabled=true;
            try{
              // Regeneration persists changed draws with the new graph atomically.
              await rpc('pantry_knockout_generate',{p_expected_revision:revision,p_confirm_regeneration:managed,p_snapshot:result.snapshot,p_nodes:nodes});
              if(isCurrent())await renderManagedKnockout({client,event,host,standingsData,isCurrent,mountCourt,mountLive});
            }catch(error){preview.querySelector('#koError').textContent=error.message;generate.disabled=false}
          };
        };paint();
      }catch(error){controls.querySelector('[role=alert]').textContent=error.message}finally{b.disabled=false}
    };
  }catch(error){if(isCurrent())host.innerHTML=`<p role="alert">${esc(error.message)}</p>`}
}
