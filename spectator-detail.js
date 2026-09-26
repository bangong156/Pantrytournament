import {competitionClient} from './event-scope.js';
import {courtLabel} from './match-courts.js';
import {matchStatus} from './spectator.js';
import {competitionURL,matchURL,teamURL} from './public-links.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const stages=['group','round_of_32','round_of_16','quarterfinal','semifinal','final'];
export const journeyStage=stage=>({group:'VÒNG BẢNG',round_of_32:'VÒNG 1/16',round_of_16:'VÒNG 1/8',quarterfinal:'TỨ KẾT',semifinal:'BÁN KẾT',final:'CHUNG KẾT'}[stage]||stage||'TRẬN ĐẤU');
export function completedWinner(match){
  if(match.status!=='completed'||!match.team1_id||!match.team2_id||match.team1_id===match.team2_id||!Number.isFinite(match.team1_score)||!Number.isFinite(match.team2_score)||match.team1_score===match.team2_score)return null;
  return match.team1_score>match.team2_score?match.team1_id:match.team2_id;
}
// The caller supplies matches fetched through one event-scoped competitionClient.
export function teamJourney(matches,team){
  const rank=stage=>stages.includes(stage)?stages.indexOf(stage):stages.length;
  const rows=matches.filter(m=>['scheduled','playing','completed'].includes(m.status)&&(m.team1_id===team||m.team2_id===team)).sort((a,b)=>rank(a.stage)-rank(b.stage)||(a.scheduled_order??Infinity)-(b.scheduled_order??Infinity)||String(a.match_code).localeCompare(String(b.match_code),'vi',{numeric:true})||String(a.id).localeCompare(String(b.id)));
  const grouped=new Map();
  for(const match of rows){if(!grouped.has(match.stage))grouped.set(match.stage,[]);grouped.get(match.stage).push(match);}
  return [...grouped].map(([stage,matches])=>({stage,matches}));
}
const score=(match,reverse=false)=>{
  if(!['playing','completed'].includes(match.status))return '—';
  const values=[match.team1_score??'–',match.team2_score??'–'];return (reverse?values.reverse():values).join('–');
};
export function spectatorDetail({tournament,event,teams,matches,matchId,teamId}){
  const names=Object.fromEntries(teams.map(t=>[t.id,t.name]));
  const teamLink=id=>id&&names[id]?`<a class="public-hub-team-link" href="${esc(teamURL(tournament.id,event.id,id))}">${esc(names[id])}</a>`:'<span>TBD</span>';
  const back=`<a class="spectator-back" href="${esc(competitionURL(tournament.id,event.id))}">${teamId?'← QUAY LẠI GIẢI':'← XEM TOÀN BỘ GIẢI'}</a>`;
  const header=`<header class="spectator-detail-heading"><p>${esc(tournament.name)}</p><p>${esc(event.name)} · ${event.format==='mlp'?'MLP':'ĐÁNH ĐÔI'}</p></header>`;
  let body;
  if(matchId){
    const match=matches.find(m=>m.id===matchId&&['scheduled','playing','completed'].includes(m.status));
    if(!match)return `${header}<p>Không tìm thấy trận trong nội dung này.</p>${back}`;
    const winner=completedWinner(match);
    body=`<article class="spectator-match-detail"><h1>${esc(match.match_code)}</h1><div class="spectator-detail-teams"><div class="${winner&&winner===match.team1_id?'spectator-winner':''}">${teamLink(match.team1_id)}${winner&&winner===match.team1_id?'<small>✓ THẮNG</small>':''}</div><span>vs</span><div class="${winner&&winner===match.team2_id?'spectator-winner':''}">${teamLink(match.team2_id)}${winner&&winner===match.team2_id?'<small>✓ THẮNG</small>':''}</div></div><strong class="spectator-detail-score">${score(match)}</strong>${courtLabel(match.court_number)?`<p class="spectator-detail-court">${courtLabel(match.court_number)}</p>`:''}<p data-match-state="${esc(match.id)}" data-base-status="${matchStatus(match)}">${matchStatus(match)}</p><div class="public-video-slot spectator-detail-live" data-public-video="${esc(match.id)}" data-video-label="${esc(match.match_code)}"></div><button class="secondary" data-share-match="${esc(match.id)}">CHIA SẺ TRẬN</button></article>`;
  }else{
    if(!names[teamId])return `${header}<p>Không tìm thấy đội trong nội dung này.</p>${back}`;
    body=`<small>HÀNH TRÌNH TẠI GIẢI</small><h1>${esc(names[teamId])}</h1><button class="secondary" data-share-team="${esc(teamId)}">CHIA SẺ HÀNH TRÌNH</button>`;
    const groups=teamJourney(matches,teamId);
    body+=groups.map(group=>`<section class="spectator-journey-stage"><h2>${esc(journeyStage(group.stage))}</h2>${group.matches.map(match=>{
      const reverse=match.team2_id===teamId,opponent=reverse?match.team1_id:match.team2_id,winner=completedWinner(match);
      const result=winner?(winner===teamId?'✓ THẮNG':'✕ THUA'):matchStatus(match);
      return `<article class="spectator-journey-row"><strong class="${winner===teamId?'spectator-winner':''}">${result}</strong><a href="${esc(matchURL(tournament.id,event.id,match.id))}">${esc(match.match_code)}</a><b>${score(match,reverse)}</b><div>vs ${teamLink(opponent)}</div>${courtLabel(match.court_number)?`<small>${courtLabel(match.court_number)}</small>`:''}</article>`;
    }).join('')}</section>`).join('')||'<p>Chưa có trận đấu.</p>';
  }
  return `${header}${body}<p data-share-feedback role="status" aria-live="polite"></p>${back}`;
}

export async function loadSpectatorDetail(client,event){
  const db=competitionClient(client,event);
  const [teams,matches]=await Promise.all([
    db.from('teams').select('id,name').eq('tournament_id',event.tournament_id),
    db.from('matches').select('id,group_id,stage,match_code,status,scheduled_order,team1_id,team2_id,team1_score,team2_score,court_number').eq('tournament_id',event.tournament_id).order('match_code')
  ]);
  if(teams.error||matches.error)throw teams.error||matches.error;
  return {teams:teams.data||[],matches:matches.data||[]};
}
