// Suggestions only: scheduled + assigned means called; referee owns start/finish.
export function suggestMatches({matches,teams,groups=[],courtCount,occupancy=matches}){
 const teamMap=new Map(teams.map(t=>[t.id,t]));
 const validCourt=m=>Number.isInteger(m.court_number)&&m.court_number>=1&&m.court_number<=courtCount;
 const active=occupancy.filter(m=>m.status==='playing');
 const called=occupancy.filter(m=>m.status==='scheduled'&&validCourt(m));
 const busyTeams=new Set([...active,...called].flatMap(m=>[m.team1_id,m.team2_id]).filter(Boolean));
 const occupied=new Set([...active,...called].map(m=>m.court_number).filter(Boolean));
 const last=matches.filter(m=>m.status==='completed'&&m.completed_at).sort((a,b)=>String(b.completed_at).localeCompare(String(a.completed_at))||String(a.id).localeCompare(String(b.id)))[0];
 const justPlayed=new Set(last?[last.team1_id,last.team2_id]:[]);
 const groupOrder=new Map(groups.map((g,i)=>[g.id,g.group_order??i]));
 const candidates=matches.filter(m=>m.status==='scheduled'&&m.team1_id&&m.team2_id&&m.team1_id!==m.team2_id&&!validCourt(m)&&teamMap.has(m.team1_id)&&teamMap.has(m.team2_id)&&(m.stage!=='group'||(teamMap.get(m.team1_id).checked_in&&teamMap.get(m.team2_id).checked_in)))
  .sort((a,b)=>Number(justPlayed.has(a.team1_id)||justPlayed.has(a.team2_id))-Number(justPlayed.has(b.team1_id)||justPlayed.has(b.team2_id))||(a.scheduled_order??Number.MAX_SAFE_INTEGER)-(b.scheduled_order??Number.MAX_SAFE_INTEGER)||(groupOrder.get(a.group_id)??Number.MAX_SAFE_INTEGER)-(groupOrder.get(b.group_id)??Number.MAX_SAFE_INTEGER)||String(a.match_code).localeCompare(String(b.match_code))||String(a.id).localeCompare(String(b.id)));
 const suggestions=new Map();
 for(let court=1;court<=courtCount;court++){
  if(occupied.has(court))continue;
  const match=candidates.find(m=>!busyTeams.has(m.team1_id)&&!busyTeams.has(m.team2_id));
  if(!match)continue;
  suggestions.set(court,match);busyTeams.add(match.team1_id);busyTeams.add(match.team2_id);
 }
 return {suggestions,active,called,occupied};
}
