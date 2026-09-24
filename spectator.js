// Presentation only: all callers supply data from one immutable event scope.
export function validMatches(matches, teams) {
  const ids=new Set(teams.map(t=>t.id));
  return matches.filter(m=>m.id && ['scheduled','playing','completed'].includes(m.status) && m.team1_id!==m.team2_id && ids.has(m.team1_id) && ids.has(m.team2_id));
}
export function nextMatch(matches, liveIds=new Set()) {
  return matches.filter(m=>m.status==='scheduled'&&!liveIds.has(m.id)).sort((a,b)=>(a.scheduled_order??Infinity)-(b.scheduled_order??Infinity)||String(a.match_code).localeCompare(String(b.match_code),'vi',{numeric:true})||a.id.localeCompare(b.id))[0]||null;
}
export function matchStatus(match) {
  return match.status==='completed'?'✓ KẾT THÚC':match.status==='playing'?'🔴 ĐANG ĐẤU':'SẮP ĐẤU';
}
export function summaryText(teams,groups,matches,format) {
  return `${teams.length} ${format==='mlp'?'ĐỘI':'CẶP'} • ${groups.length} BẢNG • ${matches.filter(m=>m.status==='completed').length}/${matches.length} TRẬN`;
}

export function eventState(matches) {
  if(matches.length && matches.every(m=>m.status==='completed'))return '✓ ĐÃ HOÀN THÀNH';
  return matches.some(m=>m.status==='playing')?'🟢 ĐANG DIỄN RA':'';
}
