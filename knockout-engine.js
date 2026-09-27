// Pure qualification/assignment. Group rows arrive in existing Pantry standings order.
export const knockoutStages=['playoff','round_of_16','quarterfinal','semifinal','final'];
export const knockoutLabel=stage=>({playoff:'Playoff',round_of_16:'1/16',quarterfinal:'Tứ kết',semifinal:'Bán kết',final:'Chung kết'}[stage]||stage);
export const compareWildcard=(a,b)=>b.point_difference-a.point_difference||b.points_scored-a.points_scored;
const key=q=>String(q.team_id);
const sameSet=(a,b)=>a.length===b.length&&new Set(a).size===a.length&&[...a].sort().join(',')===[...b].sort().join(',');
export function qualify(standings,draws=[]){
  const n=standings.length;
  if(n<4||n>8)throw new Error('Knockout hỗ trợ 4–8 bảng.');
  const normalized=standings.map(({group,rows})=>({group_id:group.id,rows:rows.map((r,i)=>({team_id:r.id,group_position:i+1,wins:r.w,point_difference:r.diff,points_scored:r.pf}))}));
  const candidates=standings.flatMap(({group,rows})=>rows.slice(0,3).map((r,i)=>({team_id:r.id,group_id:group.id,group_name:group.name,name:r.name,group_position:i+1,point_difference:r.diff,points_scored:r.pf,qualification_type:['group_winner','runner_up','wildcard_third'][i],entry_stage:n===4?'quarterfinal':n===5?(i===0?'quarterfinal':'playoff'):'round_of_16'})));
  if(standings.some(s=>s.rows.length<2)||new Set(candidates.map(key)).size!==candidates.length)throw new Error('Mỗi bảng cần ít nhất 2 đội và không được trùng đội.');
  const thirds=candidates.filter(q=>q.group_position===3).sort((a,b)=>compareWildcard(a,b)||key(a).localeCompare(key(b)));
  const count=({4:0,5:1,6:4,7:2,8:0})[n];
  if(thirds.length<count)throw new Error('Không đủ đội hạng 3 cho thể thức này.');
  const unresolved=[],usedDraws=[];
  for(let i=0;i<thirds.length;){
    let j=i+1;while(j<thirds.length&&!compareWildcard(thirds[i],thirds[j]))j++;
    const tied=thirds.slice(i,j),draw=draws.find(d=>d.group_position===3&&d.point_difference===tied[0].point_difference&&d.points_scored===tied[0].points_scored&&sameSet(d.ordered_team_ids,tied.map(key))&&d.method==='admin_draw');
    if(draw){thirds.splice(i,j-i,...draw.ordered_team_ids.map(id=>tied.find(t=>key(t)===id)));usedDraws.push(draw)}
    else if(i<count&&j>count)unresolved.push({teams:tied,slots:count-i,point_difference:tied[0].point_difference,points_scored:tied[0].points_scored});
    i=j;
  }
  const qualifiers=[...candidates.filter(q=>q.group_position<3),...thirds.slice(0,count)];
  return {group_count:n,qualifiers,unresolved,snapshot:{standings:normalized,qualifiers,wildcard_candidates:thirds,draws:usedDraws}};
}
const permutations=(items,visit,prefix=[])=>{if(!items.length){visit(prefix);return}items.forEach((x,i)=>permutations(items.filter((_,j)=>j!==i),visit,[...prefix,x]))};
// Lexicographic priorities encoded with separated magnitudes: first encounter,
// winner protection across halves, other same-group halves, then quarters.
function pairCost(a,b,i,j){
  if(!a||!b)return 0;
  const overlap=a.origins.some(x=>b.origins.includes(x));
  if(!overlap)return 0;
  const winner=a.rank===1||b.rank===1;
  if((i>>1)===(j>>1))return 1000000;
  return ((i>>3)===(j>>3)?(winner?10000:1000):0)+((i>>2)===(j>>2)?(winner?100:10):0);
}
const entrant=q=>({team_id:q.team_id,rank:q.group_position,origins:[q.group_id]});
function assign16(qualifiers){
  const winners=qualifiers.filter(q=>q.group_position===1).map(entrant);
  const rest=qualifiers.filter(q=>q.group_position!==1).map(entrant);
  const slots=Array(16).fill(null),anchors=[0,14,2,12,4,10,6,8];
  winners.forEach((w,i)=>slots[anchors[i]]=w);
  const holes=slots.flatMap((x,i)=>x?[]:[i]);let best=null,bestCost=Infinity;
  const search=(depth,left,cost)=>{
    if(cost>=bestCost)return;
    if(depth===holes.length){bestCost=cost;best=[...slots];return}
    const i=holes[depth];
    const choices=left.map((q,k)=>({q,k,cost:slots.reduce((s,x,j)=>s+pairCost(q,x,i,j),0)})).sort((a,b)=>a.cost-b.cost||key(a.q).localeCompare(key(b.q)));
    for(const c of choices){slots[i]=c.q;search(depth+1,left.filter((_,k)=>k!==c.k),cost+c.cost);slots[i]=null}
  };
  search(0,rest,0);return best;
}
export function buildBracket(result){
  if(result.unresolved.length)throw new Error('Cần lưu quyết định bốc thăm vé vớt.');
  const n=result.group_count,q=result.qualifiers,nodes=[];
  const round=(stage,prefix,slots)=>{
    const codes=[];
    for(let i=0;i<slots.length;i+=2){const a=slots[i],b=slots[i+1],code=`${prefix}-${i/2+1}`;nodes.push({match_code:code,stage,scheduled_order:nodes.length+1,team1_id:a.team_id||null,team2_id:b.team_id||null,team1_source_code:a.source||null,team2_source_code:b.source||null});codes.push({source:code})}return codes;
  };
  let next;
  if(n===8){const get=(g,p)=>entrant(q.find(x=>x.group_id===result.snapshot.standings[g].group_id&&x.group_position===p));next=round('round_of_16','R16',[[0,1,1,2],[2,1,3,2],[4,1,5,2],[6,1,7,2],[7,1,6,2],[5,1,4,2],[3,1,2,2],[1,1,0,2]].flatMap(([a,p,b,r])=>[get(a,p),get(b,r)]));}
  else if(n>=6)next=round('round_of_16','R16',assign16(q));
  else if(n===4){const get=(g,p)=>entrant(q.find(x=>x.group_id===result.snapshot.standings[g].group_id&&x.group_position===p));next=[get(0,1),get(1,2),get(2,1),get(3,2),get(3,1),get(2,2),get(1,1),get(0,2)];}
  else {
    const winners=q.filter(x=>x.group_position===1).map(entrant),others=q.filter(x=>x.group_position!==1).map(entrant);
    let best=Infinity,playoffs,qf;
    // All pairings and all placements in a canonical QF layout; five winners
    // necessarily include one winner/winner QF. Consider both possible playoff origins.
    const pairings=(left,pairs=[])=>{
      if(left.length){for(let i=1;i<left.length;i++)pairings(left.filter((_,j)=>j!==0&&j!==i),[...pairs,[left[0],left[i]]]);return}
      const first=pairs.reduce((s,[a,b])=>s+(a.origins[0]===b.origins[0]?10000000:0),0);
      const sources=pairs.map((p,i)=>({source:`PO-${i+1}`,rank:2,origins:p.flatMap(x=>x.origins)}));
      permutations(winners.slice(1),ws=>permutations(sources,ss=>{
        const slots=[winners[0],ss[0],ws[0],ss[1],ws[1],ss[2],ws[2],ws[3]];
        let cost=first;
        // Actual first QF matchup must consider BOTH possible playoff winners.
        cost=first;
        for(let i=0;i<8;i++)for(let j=0;j<i;j++){
          if(!slots[i].origins.some(g=>slots[j].origins.includes(g)))continue;
          cost+=(i>>1)===(j>>1)?1000000:(i>>2)===(j>>2)?(slots[i].rank===1||slots[j].rank===1?10000:1000):0;
        }
        if(cost<best){best=cost;playoffs=pairs.flat();qf=slots}
      }));
    };
    pairings(others);round('playoff','PO',playoffs);next=qf;
  }
  next=round('quarterfinal','QF',next);next=round('semifinal','SF',next);round('final','F',next);return nodes;
}
export function sourceLabel(match,side,matches,teamNames){
  return teamNames[match[`team${side}_id`]]||`Thắng ${match[`team${side}_source_code`]||(match[`team${side}_source_match_id`]&&matches.find(m=>m.id===match[`team${side}_source_match_id`])?.match_code)||'chưa xác định'}`;
}
export async function knockoutRPC(client,event,name,args={}){
  if(!event?.id)throw new Error('Chưa chọn nội dung thi đấu.');
  const {data,error}=await client.rpc(name,{...args,p_event:event.id}).setHeader('x-client-info',`pantry-event/${event.id}`);
  if(error){const e=new Error(['PT409','40001'].includes(error.code)?`Xung đột Admin: ${error.message}. Tải lại để kiểm tra trước khi thử lại.`:error.code==='PGRST202'?'Chưa cài RPC Knockout. Cần áp dụng migration engine.':error.message);e.code=error.code;throw e}return data;
}
