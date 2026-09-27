import {qualify,buildBracket,knockoutStages,knockoutLabel,sourceLabel,knockoutRPC} from './knockout-engine.js';
import {competitionClient} from './event-scope.js';
import {courtLabel} from './match-courts.js';
import {matchStatus} from './spectator.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
export function publicBracket(matches,teamNames){
  return `<div class="knockout-bracket">${knockoutStages.map(stage=>{
    const round=matches.filter(m=>m.stage===stage).sort((a,b)=>a.scheduled_order-b.scheduled_order);
    return round.length?`<section class="knockout-round"><h2>${knockoutLabel(stage)}</h2>${round.map(m=>`<article class="public-hub-match-card knockout-card"><button class="public-match-link" data-open-match="${esc(m.id)}">${esc(m.match_code)}</button><div>${esc(sourceLabel(m,1,matches,teamNames))}</div><strong>${['playing','completed'].includes(m.status)?`${m.team1_score??0} — ${m.team2_score??0}`:'—'}</strong><div>${esc(sourceLabel(m,2,matches,teamNames))}</div>${courtLabel(m.court_number)?`<small>${courtLabel(m.court_number)}</small>`:''}<div data-match-state="${esc(m.id)}" data-base-status="${matchStatus(m)}">${matchStatus(m)}</div><div class="public-video-slot" data-public-video="${esc(m.id)}" data-video-label="${esc(m.match_code)}"></div></article>`).join('')}</section>`:'';
  }).join('')}</div>`;
}
export async function renderManagedKnockout({client,event,host,standingsData,isCurrent,mountCourt}){
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
    host.innerHTML=`<small>KNOCKOUT</small><h1>${esc(event.name)}</h1><div class="panel" id="koControls"></div>${publicBracket(matches,names)}<div id="koPreview"></div>`;
    const controls=host.querySelector('#koControls');
    // Preserve existing court control; scoring is only exposed for managed doubles.
    for(const m of matches){const card=host.querySelector(`[data-open-match="${m.id}"]`)?.closest('article');if(!card)continue;mountCourt(card,m,db);
      if(managed&&event.format==='doubles'&&m.team1_id&&m.team2_id){
        const form=document.createElement('form');form.className='knockout-score';
        form.innerHTML=`<label>Điểm 1<input name="s1" type="number" min="0" step="1" required value="${m.team1_score??''}"></label><label>Điểm 2<input name="s2" type="number" min="0" step="1" required value="${m.team2_score??''}"></label><button>Lưu kết quả</button><p role="alert"></p>`;
        card.append(form);form.onsubmit=async e=>{e.preventDefault();const b=form.querySelector('button');b.disabled=true;
          try{await rpc('pantry_knockout_score',{p_match:m.id,p_expected_revision:decision.revision,p_expected_score_version:m.score_version,p_score1:Number(form.elements.s1.value),p_score2:Number(form.elements.s2.value)});if(isCurrent())await renderManagedKnockout({client,event,host,standingsData,isCurrent,mountCourt})}
          catch(error){form.querySelector('[role=alert]').textContent=error.message}finally{b.disabled=false}
        };
      }
    }
    if(event.format!=='doubles'){controls.textContent='MLP knockout chưa được bật. MLP hiện tại tiếp tục hoạt động như trước.';return}
    if(started){controls.textContent='Knockout đã bắt đầu. Không thể tạo lại nhánh.';return}
    if(matches.length&&!managed){controls.textContent='Nhánh cũ chưa được quản lý. Không tự động thay thế hoặc nhận nhánh cũ.';return}
    controls.innerHTML=`<button id="koPreviewButton">${managed?'Xem trước tạo lại Knockout':'Xem trước Knockout từ BXH'}</button><p role="alert"></p>`;
    controls.querySelector('button').onclick=async()=>{
      const b=controls.querySelector('button');b.disabled=true;
      try{
        // Capture before standings: any changed group inputs invalidate generation.
        const inputs=await rpc('pantry_knockout_inputs');if(!isCurrent())return;
        const standings=await standingsData();if(!isCurrent())return;
        let draws=decision?.snapshot?.draws||[],revision=decision?.revision||0;
        const preview=host.querySelector('#koPreview');
        const paint=()=>{
          const result=qualify(standings,draws);result.snapshot.input_state=inputs;
          const nodes=result.unresolved.length?[]:buildBracket(result);
          preview.innerHTML=`<div class="panel"><h2>${result.group_count===5?'VÀO THẲNG TỨ KẾT':`${result.qualifiers.length} ĐỘI VÀO VÒNG LOẠI`}</h2>${[['group_winner',result.group_count===5?'VÀO THẲNG TỨ KẾT':'NHẤT BẢNG'],['runner_up','NHÌ BẢNG'],['wildcard_third','VÉ VỚT HẠNG 3']].map(([type,label])=>`<h3>${label}</h3><ul>${result.qualifiers.filter(q=>q.qualification_type===type&&!result.unresolved.some(t=>t.teams.some(x=>x.team_id===q.team_id))).map(q=>`<li>${esc(q.group_name)}${q.group_position} · ${esc(q.name)}${q.group_position===3?` · ${q.point_difference>0?'+':''}${q.point_difference} / ${q.points_scored} điểm`:''}</li>`).join('')}</ul>`).join('')}${result.unresolved.map((tie,i)=>`<fieldset><legend>Đồng hạng vé vớt: chọn thứ tự bốc thăm (${tie.slots} suất)</legend><p>Hiệu số ${tie.point_difference} · Tổng điểm ${tie.points_scored}. Nhập thứ tự đầy đủ, không trùng.</p>${tie.teams.map((q,j)=>`<label>${esc(q.group_name)}3 · ${esc(q.name)}<input data-draw="${i}" data-team="${esc(q.team_id)}" type="number" min="1" max="${tie.teams.length}" placeholder="Thứ tự"></label>`).join('')}<button data-resolve="${i}">Xác nhận thứ tự bốc thăm</button></fieldset>`).join('')}${nodes.length?knockoutStages.map(st=>{const round=nodes.filter(m=>m.stage===st);return round.length?`<h3>${knockoutLabel(st)}</h3>${round.map(m=>`<p><b>${m.match_code}</b> · ${esc(sourceLabel(m,1,nodes,names))} vs ${esc(sourceLabel(m,2,nodes,names))}</p>`).join('')}`:''}).join(''):''}<p role="alert" id="koError"></p>${nodes.length?`<button id="koGenerate">${managed?'TẠO LẠI NHÁNH KNOCKOUT':'TẠO NHÁNH KNOCKOUT'}</button>`:''}</div>`;
          preview.querySelectorAll('[data-resolve]').forEach(button=>button.onclick=async()=>{
            const i=Number(button.dataset.resolve),tie=result.unresolved[i],items=[...preview.querySelectorAll(`[data-draw="${i}"]`)].map(input=>({id:input.dataset.team,rank:Number(input.value)}));
            if(items.some(x=>!Number.isInteger(x.rank)||x.rank<1||x.rank>items.length)||new Set(items.map(x=>x.rank)).size!==items.length){preview.querySelector('#koError').textContent='Cần nhập đầy đủ thứ tự 1 đến '+items.length;return}
            const nextDraws=[...draws,{group_position:3,point_difference:tie.point_difference,points_scored:tie.points_scored,ordered_team_ids:items.sort((a,b)=>a.rank-b.rank).map(x=>x.id),method:'admin_draw'}];
            button.disabled=true;
            try{
              const resolved=qualify(standings,nextDraws);resolved.snapshot.input_state=inputs;
              if(!managed)revision=await rpc('pantry_knockout_resolve',{p_expected_revision:revision,p_snapshot:resolved.snapshot});
              draws=nextDraws;if(isCurrent())paint();
            }catch(error){preview.querySelector('#koError').textContent=error.message;button.disabled=false}
          });
          const generate=preview.querySelector('#koGenerate');if(generate)generate.onclick=async()=>{
            if(!confirm(managed?'Xác nhận thay thế toàn bộ nhánh Knockout chưa bắt đầu của nội dung này?':'Xác nhận tạo nhánh Knockout theo bản xem trước?'))return;
            generate.disabled=true;
            try{
              // Regeneration persists changed draws with the new graph atomically.
              await rpc('pantry_knockout_generate',{p_expected_revision:revision,p_confirm_regeneration:managed,p_snapshot:result.snapshot,p_nodes:nodes});
              if(isCurrent())await renderManagedKnockout({client,event,host,standingsData,isCurrent,mountCourt});
            }catch(error){preview.querySelector('#koError').textContent=error.message;generate.disabled=false}
          };
        };paint();
      }catch(error){controls.querySelector('[role=alert]').textContent=error.message}finally{b.disabled=false}
    };
  }catch(error){if(isCurrent())host.innerHTML=`<p role="alert">${esc(error.message)}</p>`}
}
