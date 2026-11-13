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
 await db.exec(`create schema pantry_knockout;
 create table public.knockout_decisions (event_id uuid, group_count integer constraint knockout_decisions_group_count_check check(group_count between 4 and 8));`);
 const original=await readFile(new URL('../supabase/migrations/20260927082138_pantry_knockout_engine.sql',import.meta.url),'utf8');
 await db.exec(original.slice(original.indexOf('create function pantry_knockout.inputs('),original.indexOf('create function pantry_knockout.read_inputs(')));
 await db.exec(await readFile(new URL('../supabase/migrations/20261113042715_three_group_knockout.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261113081416_two_team_head_to_head.sql',import.meta.url),'utf8'));
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

test('SQL accepts three-group qualification and rejects a substituted third',async()=>{
 {
  const f=await fixture(3),q=qualify(f.standings);
  q.snapshot.input_state=(await one('select pantry_knockout.inputs($1) inputs',[f.event])).inputs;
  assert.equal((await one('select pantry_knockout.validate_snapshot($1,$2) n',[f.event,JSON.stringify(q.snapshot)])).n,3);
  const wildcard=q.snapshot.qualifiers.find(x=>x.group_position===3);
  wildcard.team_id=f.standings[0].rows[2].id;
  await assert.rejects(()=>sql('select pantry_knockout.validate_snapshot($1,$2)',[f.event,JSON.stringify(q.snapshot)]),/Incorrect qualified/);
 }
});

test('SQL accepts head-to-head winner with worse difference and rejects reversed qualification',async()=>{
 const f=await fixture(3),g=f.standings[0],ids=[...g.rows.map(r=>r.id),randomUUID()];
 await sql('insert into teams values ($1,$2,$3)',[ids[3],f.event,'D']);
 await sql('insert into group_teams(event_id,group_id,team_id,position) values ($1,$2,$3,4)',[f.event,g.group.id,ids[3]]);
 await sql('delete from matches where group_id=$1',[g.group.id]);
 for(const [a,b,s1,s2] of [[0,1,11,10],[0,2,0,11],[0,3,11,10],[1,2,11,0],[1,3,11,0],[2,3,0,11]]){
  await sql("insert into matches(event_id,tournament_id,group_id,match_code,stage,team1_id,team2_id,team1_score,team2_score,winner_id,status) values ($1,$2,$3,$4,'group',$5,$6,$7,$8,$9,'completed')",[f.event,tournament,g.group.id,`${a}-${b}`,ids[a],ids[b],s1,s2,s1>s2?ids[a]:ids[b]]);
 }
 g.rows=[{id:ids[0],w:2,pf:22,diff:-9},{id:ids[1],w:2,pf:32,diff:21},{id:ids[3],w:1,pf:21,diff:-1},{id:ids[2],w:1,pf:11,diff:-11}];
 const q=qualify(f.standings);q.snapshot.input_state=(await one('select pantry_knockout.inputs($1) inputs',[f.event])).inputs;
 assert.equal((await one('select pantry_knockout.validate_snapshot($1,$2) n',[f.event,JSON.stringify(q.snapshot)])).n,3);
 const rows=q.snapshot.standings[0].rows;[rows[0],rows[1]]=[rows[1],rows[0]];rows.forEach((r,i)=>r.group_position=i+1);
 await assert.rejects(()=>sql('select pantry_knockout.validate_snapshot($1,$2)',[f.event,JSON.stringify(q.snapshot)]),/head-to-head first/);
});
