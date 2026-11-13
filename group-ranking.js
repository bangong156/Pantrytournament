// Resolve only an exact two-team tie on wins. Larger ties retain difference/points.
export function rankGroupRows(rows,matches){
 const counts=new Map();rows.forEach(r=>counts.set(r.w,(counts.get(r.w)||0)+1));
 const fallback=(a,b)=>b.diff-a.diff||b.pf-a.pf;
 return rows.sort((a,b)=>{
  if(a.w!==b.w)return b.w-a.w;
  if(counts.get(a.w)===2){
   const games=matches.filter(m=>m.status==='completed'&&((m.team1_id===a.id&&m.team2_id===b.id)||(m.team1_id===b.id&&m.team2_id===a.id)));
   const balance=games.reduce((s,m)=>s+(m.winner_id===b.id?1:m.winner_id===a.id?-1:0),0);
   if(balance)return balance;
  }
  return fallback(a,b);
 });
}
