import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {qualify,buildBracket} from '../knockout-engine.js';
let db;
const actor=randomUUID(),tournament=randomUUID();
const sql=(s,args=[])=>db.query(s,args);
const one=async(s,args=[]) => (await sql(s,args)).rows[0];
before(async()=>{
 db=new PGlite();await db.exec(await readFile(new URL('./fixtures/knockout-schema.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../proposals/20260926115031_knockout_preparation.sql',import.meta.url),'utf8'));
 const file=(await readdir(new URL('../supabase/migrations/',import.meta.url))).find(f=>f.endsWith('_pantry_knockout_engine.sql'));
 await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
 await sql('insert into auth.users values ($1)',[actor]);
 await sql("select set_config('request.jwt.claim.sub',$1,false),set_config('test.staff','true',false)",[actor]);
});
after(async()=>{await db?.close()});
async function scope(event){await sql("select set_config('test.event',$1,false)",[event])}
async function fixture(n=4,format='doubles',tie=false){
 const event=randomUUID();await sql('insert into tournament_events values ($1,$2,$3,$4)',[event,tournament,format,'group']);
 const standings=[];
 for(let i=0;i<n;i++){
  const group={id:randomUUID(),name:String.fromCharCode(65+i)},ids=[randomUUID(),randomUUID(),randomUUID()];
  await sql('insert into groups values ($1,$2,$3,$4,$5)',[group.id,event,tournament,group.name,i+1]);
  for(let j=0;j<3;j++){
   await sql('insert into teams values ($1,$2,$3)',[ids[j],event,`${group.name}${j+1}`]);
   await sql('insert into group_teams(event_id,group_id,team_id,position) values ($1,$2,$3,$4)',[event,group.id,ids[j],j+1]);
  }
  // A beats B and C; B beats C. Third metrics differ by group unless testing a draw.
  const thirdPoints=tie?2:i+1;
  for(const [a,b,s1,s2] of [[0,1,11,5],[0,2,11,thirdPoints],[1,2,11,thirdPoints]])await sql("insert into matches(event_id,tournament_id,group_id,match_code,stage,team1_id,team2_id,team1_score,team2_score,winner_id,status) values ($1,$2,$3,$4,'group',$5,$6,$7,$8,$5,'completed')",[event,tournament,group.id,`${group.name}-${a}-${b}`,ids[a],ids[b],s1,s2]);
  standings.push({group,rows:[{id:ids[0],w:2,pf:22,diff:17-thirdPoints},{id:ids[1],w:1,pf:16,diff:5-thirdPoints},{id:ids[2],w:0,pf:2*thirdPoints,diff:2*thirdPoints-22}]});
 }
 await scope(event);return {event,standings};
}
async function preview(f,draws=[]){const result=qualify(f.standings,draws);result.snapshot.input_state=(await one('select public.pantry_knockout_inputs($1) as inputs',[f.event])).inputs;return result}
async function generate(f,revision=0,confirm=false,result=null){const q=result||await preview(f);return one('select public.pantry_knockout_generate($1,$2,$3,$4,$5) as revision',[f.event,revision,confirm,JSON.stringify(q.snapshot),JSON.stringify(buildBracket(q))])}
async function matches(f){return (await sql("select * from matches where event_id=$1 and stage<>'group' order by scheduled_order",[f.event])).rows}
async function score(f,m,a=11,b=3){return sql('select public.pantry_knockout_score($1,$2,$3,$4,$5,$6)',[f.event,m.id,1,m.score_version,a,b])}
for(const n of [4,5,6,7,8])test(`SQL generates complete ${n}-group graph with exact membership`,async()=>{
 const f=await fixture(n);assert.equal((await generate(f)).revision,1);
 const b=await matches(f);assert.equal(b.length,n===4?7:n===5?10:15);
 const decision=await one('select * from knockout_decisions where event_id=$1',[f.event]);assert.equal(decision.state,'generated');assert.equal(decision.match_ids.length,b.length);
});
test('SQL persisted wildcard draw, unresolved cutoff rejection, stale preview rejection',async()=>{
 const f=await fixture(7,'doubles',true),q=await preview(f);
 assert.equal(q.unresolved.length,1);
 // Cannot bypass the engine's tie rejection by calling the DB directly.
 const guessed={...q,unresolved:[]};await assert.rejects(()=>generate(f,0,false,guessed),/Unresolved wildcard/);
 assert.equal((await matches(f)).length,0);
 const tie=q.unresolved[0],draw={group_position:3,point_difference:tie.point_difference,points_scored:tie.points_scored,ordered_team_ids:tie.teams.map(t=>t.team_id).reverse(),method:'admin_draw'};
 const resolved=await preview(f,[draw]);
 const saved=await one('select public.pantry_knockout_resolve($1,0,$2) as revision',[f.event,JSON.stringify(resolved.snapshot)]);assert.equal(saved.revision,1);
 assert.equal((await matches(f)).length,0);
 const persisted=await one('select snapshot,state from knockout_decisions where event_id=$1',[f.event]);assert.equal(persisted.state,'resolved');
 await generate(f,1,false,await preview(f,persisted.snapshot.draws));
 assert.deepEqual((await one('select snapshot from knockout_decisions where event_id=$1',[f.event])).snapshot.draws,[draw]);
 const other=await fixture(),stale=await preview(other);
 await sql("update matches set team1_score=12 where event_id=$1 and match_code='A-0-1'",[other.event]);
 await assert.rejects(()=>generate(other,0,false,stale),/changed since preview/);
});
test('winner advancement and correction are atomic; started downstream conflicts roll back',async()=>{
 const f=await fixture();await generate(f);let b=await matches(f),qf=b[0];
 await score(f,qf);b=await matches(f);let sf=b.find(m=>m.stage==='semifinal');assert.equal(sf.team1_id,qf.team1_id);
 qf=b[0];await score(f,qf,3,11);b=await matches(f);assert.equal(b.find(m=>m.id===sf.id).team1_id,qf.team2_id);
 await score(f,b[1]);b=await matches(f);sf=b.find(m=>m.id===sf.id);await score(f,sf);
 qf=(await matches(f))[0];await assert.rejects(()=>score(f,qf,11,3),e=>e.code==='PT409'&&/downstream/i.test(e.message));
 const unchanged=(await matches(f))[0];assert.equal(unchanged.winner_id,qf.team2_id);assert.equal(unchanged.score_version,qf.score_version);
 await assert.rejects(()=>generate(f,1,true),/started/i);
});
test('PLAYING downstream blocks correction; stale score cannot overwrite',async()=>{
 const f=await fixture();await generate(f);let b=await matches(f);await score(f,b[0]);await score(f,b[1]);
 b=await matches(f);const sf=b.find(m=>m.stage==='semifinal');await sql("update matches set status='playing' where id=$1",[sf.id]);
 await assert.rejects(()=>score(f,b[0],2,11),/downstream/i);
 await assert.rejects(()=>score(f,{...b[0],score_version:0}),/Score changed/);
});
test('event isolation, staff authorization and explicit regeneration',async()=>{
 const a=await fixture(),b=await fixture();await scope(a.event);await generate(a);
 const prior=await matches(a);await assert.rejects(()=>generate(a,1,false),/confirmation/i);
 await generate(a,1,true);assert.notEqual((await matches(a))[0].id,prior[0].id);assert.equal((await matches(b)).length,0);
 await scope(b.event);await generate(b);const bm=(await matches(b))[0];await scope(a.event);
 await assert.rejects(()=>sql('select public.pantry_knockout_score($1,$2,2,0,11,3)',[a.event,bm.id]),/outside this managed event/);
 await assert.rejects(()=>generate(b,1,true),e=>e.code==='42501');
 await sql("select set_config('test.staff','false',false)");await assert.rejects(()=>generate(a,2,true),e=>e.code==='42501');await sql("select set_config('test.staff','true',false)");
});
test('managed MLP remains gated; legacy MLP subgames stay writable',async()=>{
 const f=await fixture(4,'mlp');await assert.rejects(()=>generate(f),e=>e.code==='0A000');
 const row=await one("insert into matches(event_id,tournament_id,stage,match_code,status) values($1,$2,'quarterfinal','LEGACY','scheduled') returning id",[f.event,tournament]);
 await sql('insert into mlp_games(event_id,match_id) values($1,$2)',[f.event,row.id]);
 assert.equal((await one('select count(*)::int as n from mlp_games where match_id=$1',[row.id])).n,1);
});

test('authenticated wrappers authorize; direct helper execution remains denied',async()=>{
 const f=await fixture(),q=await preview(f);
 await db.exec('set role authenticated');
 try{
  const r=await generate(f,0,false,q);assert.equal(r.revision,1);
  await assert.rejects(()=>sql('select pantry_knockout.lock_event($1)',[f.event]),/permission denied/);
  await assert.rejects(()=>sql('select pantry_knockout.validate_snapshot($1,$2)',[f.event,JSON.stringify(q.snapshot)]),/permission denied/);
 }finally{await db.exec('reset role')}
});
