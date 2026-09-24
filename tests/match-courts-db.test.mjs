// Optional isolated PostgreSQL integration test. Never point at production.
// COURT_TEST_CONTAINER=pantry-court-test node --test tests/match-courts-db.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
const container=process.env.COURT_TEST_CONTAINER;
const args=['exec','-i',container,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-At'];
const sql=statement=>spawnSync('docker',args,{input:statement,encoding:'utf8'});
const ok=statement=>{const result=sql(statement);assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
const fails=(statement,pattern)=>{const result=sql(statement);assert.notEqual(result.status,0);assert.match(result.stderr,pattern);};
test('court migration: constraints, role grants, event conflicts, and concurrent starts', {skip:!container},async()=>{
 ok(`create role anon;create role authenticated;create role service_role;
 create table public.matches(id integer primary key,tournament_id integer not null,event_id integer not null,match_code text,status text);
 alter table public.matches enable row level security;
 create policy public_read on public.matches for select using(true);
 create policy staff_write on public.matches for update to authenticated using(current_setting('test.staff',true)='yes' and event_id=current_setting('test.event',true)::integer);
 grant select on public.matches to anon,authenticated;
 grant select(id,event_id,tournament_id,match_code) on public.matches to service_role;
 insert into public.matches values(1,1,10,'A07','scheduled'),(2,1,20,'B01','scheduled'),(3,2,30,'C01','scheduled'),(4,1,10,'A08','scheduled');`);
 const migration=fs.readFileSync(new URL('../pantry-match-courts.sql',import.meta.url),'utf8');
 ok(migration);ok(migration); // safe to rerun
 assert.equal(ok('select count(*) from matches where court_number is null'),'4');
 fails('update matches set court_number=0 where id=1',/matches_court_number_positive/);
 fails('update matches set court_number=-2 where id=1',/matches_court_number_positive/);
 fails('update matches set court_number=2147483648 where id=1',/out of range/);
 for(const court of ['2','5','null'])ok(`set role authenticated;set test.staff='yes';set test.event='10';update matches set court_number=${court} where id=1;`);
 assert.equal(ok('select count(*) from matches where id=1 and court_number is null'),'1');
 ok("set role authenticated;set test.staff='no';set test.event='10';update matches set court_number=6 where id=1;");
 assert.equal(ok('select count(*) from matches where id=1 and court_number is null'),'1');
 ok("set role authenticated;set test.staff='yes';set test.event='20';update matches set court_number=6 where id=1;");
 assert.equal(ok('select count(*) from matches where id=1 and court_number is null'),'1');
 fails('set role anon;update matches set court_number=3 where id=1',/permission denied/);
 fails('set role service_role;select status from matches',/permission denied/);
 ok('set role service_role;select court_number from matches where id=1');
 ok('update matches set court_number=3'); // future matches may share courts
 ok("update matches set status='playing' where id=1");
 fails("update matches set status='playing' where id=2",/Sân 3 đang có trận A07/); // other event
 ok("update matches set status='playing' where id=3"); // other tournament
 ok("update matches set court_number=null,status='playing' where id=4"); // optional assignment
 fails('update matches set court_number=3 where id=4',/Sân 3 đang có trận A07/);
 ok("update matches set status='completed' where id=1;update matches set status='playing' where id=2;");
 ok("update matches set status='scheduled',court_number=4 where id in (1,2)");
 const first=spawn('docker',args,{stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>first.on('close',resolve));
 await new Promise((resolve,reject)=>{
  first.on('error',reject);first.stdout.on('data',chunk=>{if(chunk.toString().includes('court_locked'))resolve();});
  first.stdin.end("begin;update matches set status='playing' where id=1;select 'court_locked';select pg_sleep(2);commit;");
 });
 fails("update matches set status='playing' where id=2",/matches_playing_court_unique/);
 assert.equal(await closed,0);
 assert.equal(ok("select count(*) from matches where tournament_id=1 and court_number=4 and status='playing'"),'1');
});
