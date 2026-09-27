import test from 'node:test';
import assert from 'node:assert/strict';
import {qualify,buildBracket,compareWildcard,knockoutRPC,sourceLabel} from '../knockout-engine.js';
import {publicBracket} from '../knockout-ui.js';
import {teamJourney} from '../spectator-detail.js';
const standings=n=>Array.from({length:n},(_,i)=>({group:{id:`g${i}`,name:String.fromCharCode(65+i)},rows:Array.from({length:3},(_,j)=>({id:`${String.fromCharCode(65+i)}${j+1}`,name:`Team ${i}-${j}`,w:3-j,pf:50-i-j,diff:20-i-j}))}));
const nodes=n=>buildBracket(qualify(standings(n)));
test('8-group historical mapping and downstream paths',()=>{
 const b=nodes(8);assert.equal(b.length,15);assert.equal(sourceLabel(b[8],2,b,{}),'Thắng R16-2');
 assert.deepEqual(b.slice(0,8).map(m=>`${m.team1_id}-${m.team2_id}`),['A1-B2','C1-D2','E1-F2','G1-H2','H1-G2','F1-E2','D1-C2','B1-A2']);
 assert.deepEqual(b.slice(8,12).map(m=>[m.team1_source_code,m.team2_source_code]),[['R16-1','R16-2'],['R16-3','R16-4'],['R16-5','R16-6'],['R16-7','R16-8']]);
 assert.deepEqual(b.at(-1),{match_code:'F-1',stage:'final',scheduled_order:15,team1_id:null,team2_id:null,team1_source_code:'SF-1',team2_source_code:'SF-2'});
});
for(const [n,count] of [[7,2],[6,4]])test(`${n}-group wildcard count, deterministic first-round protection`,()=>{
 const q=qualify(standings(n)),b=buildBracket(q);assert.equal(q.qualifiers.length,16);assert.equal(q.qualifiers.filter(x=>x.group_position===3).length,count);
 assert.equal(b.filter(x=>x.stage==='round_of_16').length,8);assert.deepEqual(b,buildBracket(q));
 const groups=Object.fromEntries(q.qualifiers.map(x=>[x.team_id,x.group_id]));
 for(const m of b.slice(0,8))assert.notEqual(groups[m.team1_id],groups[m.team2_id]);
 for(const winner of q.qualifiers.filter(x=>x.group_position===1)){
  const half=b.slice(0,8).findIndex(m=>[m.team1_id,m.team2_id].includes(winner.team_id))>>2;
  for(const mate of q.qualifiers.filter(x=>x.group_id===winner.group_id&&x!==winner))assert.notEqual(b.slice(0,8).findIndex(m=>[m.team1_id,m.team2_id].includes(mate.team_id))>>2,half);
 }
});
test('5-group playoff: five direct QF entrants, no BYEs, protect both possible playoff winners',()=>{
 const b=nodes(5),po=b.filter(x=>x.stage==='playoff'),qf=b.filter(x=>x.stage==='quarterfinal');
 assert.equal(b.length,10);assert.equal(po.length,3);assert.equal(qf.length,4);
 assert.equal(qf.flatMap(m=>[m.team1_id,m.team2_id]).filter(Boolean).length,5);
 for(const m of po)assert.notEqual(m.team1_id[0],m.team2_id[0]);
 for(const m of qf){const direct=m.team1_id||m.team2_id,source=m.team1_source_code||m.team2_source_code;if(!source)continue;const upstream=po.find(p=>p.match_code===source);for(const id of [upstream.team1_id,upstream.team2_id])assert.notEqual(id[0],direct[0]);}
});
test('4-group direct QF only',()=>{const b=nodes(4);assert.equal(b.length,7);assert.equal(b[0].stage,'quarterfinal');assert.equal(b.filter(x=>x.team1_id&&x.team2_id).length,4)});
test('wildcards ignore wins and group size; exact cutoff ties require persisted full draw',()=>{
 const st=standings(7);st[0].rows[2].w=0;st[1].rows[2].w=99;
 st[1].rows[2].diff=st[2].rows[2].diff=10;st[1].rows[2].pf=st[2].rows[2].pf=30;
 st.slice(3).forEach(s=>s.rows[2].diff=-5);
 const q=qualify(st);assert.equal(q.unresolved.length,1);assert.throws(()=>buildBracket(q));
 const draw={group_position:3,point_difference:10,points_scored:30,ordered_team_ids:['C3','B3'],method:'admin_draw'};
 const resolved=qualify(st,[draw]);assert.deepEqual(resolved.qualifiers.filter(x=>x.group_position===3).map(x=>x.team_id),['A3','C3']);assert.deepEqual(resolved.snapshot.draws,[draw]);
 assert.equal(qualify(st,[{...draw,ordered_team_ids:['C3','C3']}]).unresolved.length,1);
 st[2].rows[2].pf++;assert.equal(qualify(st,[draw]).snapshot.draws.length,0);
 assert.ok(compareWildcard({point_difference:8,points_scored:1},{point_difference:7,points_scored:999})<0);
});
test('every possible 6/7 wildcard group set avoids first-round rematches',()=>{
 for(const n of [6,7])for(let mask=0;mask<(1<<n);mask++){
  const k=n===6?4:2;if([...Array(n)].filter((_,i)=>mask&(1<<i)).length!==k)continue;
  const st=standings(n);st.forEach((g,i)=>g.rows[2].diff=(mask&(1<<i)?100:0)+i);
  const b=buildBracket(qualify(st));for(const m of b.slice(0,8))assert.notEqual(m.team1_id[0],m.team2_id[0]);
 }
});
test('event-scoped RPC cannot be redirected through args; conflicts are visible',async()=>{
 let captured;const client={rpc:(name,args)=>({setHeader:async(header,value)=>{captured={name,args,header,value};return {data:1}}})};
 await knockoutRPC(client,{id:'event-a'},'pantry_knockout_generate',{p_event:'event-b'});assert.equal(captured.args.p_event,'event-a');assert.equal(captured.value,'pantry-event/event-a');
 await assert.rejects(()=>knockoutRPC({rpc:()=>({setHeader:async()=>({error:{code:'PT409',message:'Downstream started'}})})},{id:'a'},'score'),/Xung đột Admin/);
});
test('public sources and existing LIVE hooks; journey includes only reached stages',()=>{
 const matches=nodes(5).map(m=>({...m,id:m.match_code,status:'scheduled',team1_source_match_id:m.team1_source_code,team2_source_match_id:m.team2_source_code}));
 const names=Object.fromEntries(standings(5).flatMap(s=>s.rows).map(r=>[r.id,r.name]));
 assert.equal(sourceLabel(matches.at(-1),1,matches,names),'Thắng SF-1');
 const html=publicBracket(matches,names);assert.match(html,/Thắng PO-1/);assert.match(html,/data-public-video=/);assert.doesNotMatch(html,/>1\/16</);
 const journey=teamJourney(matches,'A2');assert.deepEqual(journey.map(x=>x.stage),['playoff']);assert.equal(new Set(journey.flatMap(s=>s.matches.map(m=>m.id))).size,1);
});

test('5-group routing protects against every possible wildcard origin',()=>{
 for(let k=0;k<5;k++){
  const st=standings(5);st[k].rows[2].diff=999;const b=buildBracket(qualify(st)),po=b.filter(m=>m.stage==='playoff');
  for(const m of po)assert.notEqual(m.team1_id[0],m.team2_id[0]);
  for(const m of b.filter(m=>m.stage==='quarterfinal')){
   const source=m.team1_source_code||m.team2_source_code;if(!source)continue;
   const direct=m.team1_id||m.team2_id,p=po.find(x=>x.match_code===source);
   for(const id of [p.team1_id,p.team2_id])assert.notEqual(id[0],direct[0]);
  }
 }
});
