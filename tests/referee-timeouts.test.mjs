import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {timeoutSeconds} from '../referee-timeouts.js';
test('countdown uses an absolute deadline and stops at zero',()=>{
 const end='2026-11-13T05:00:59Z',start=Date.parse('2026-11-13T05:00:00Z');
 assert.equal(timeoutSeconds(end,start),59);assert.equal(timeoutSeconds(end,start+58500),1);
 assert.equal(timeoutSeconds(end,start+60000),0);
});
test('server persists one timeout per side; duplicate taps cannot restart; unauthorized writes fail',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon; create role authenticated;create table public.matches(id uuid primary key,stage text);
 create function public.referee_match_state(uuid,uuid) returns jsonb language sql as $$select case when $1='00000000-0000-0000-0000-000000000001' then jsonb_build_object('match_id',$2,'can_control',true,'status','playing') else null end$$;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261113050342_referee_timeouts.sql',import.meta.url),'utf8'));
 const match='00000000-0000-0000-0000-000000000002',token='00000000-0000-0000-0000-000000000001';
 await db.query("insert into matches values ($1,'group')",[match]);
 const call=async(side,t=token)=>(await db.query('select referee_match_timeouts($1,$2,$3) data',[t,match,side])).rows[0].data;
 assert.equal((await call(null)).timeouts.length,0);
 const first=await call(1);assert.equal(first.timeouts.length,1);
 assert.deepEqual((await call(1)).timeouts,first.timeouts);
 assert.equal((await call(2)).timeouts.length,2);
 await assert.rejects(()=>call(1,match),/Phiên trọng tài/);
 await assert.rejects(()=>call(3),/Đội không hợp lệ/);
 await db.exec("create or replace function public.referee_match_state(uuid,uuid) returns jsonb language sql as $$select jsonb_build_object('match_id',$2,'can_control',false,'status','playing')$$;");
 await assert.rejects(()=>call(1),/Chỉ trọng tài/);
 assert.equal((await call(null)).timeouts.length,2);
 }finally{await db.close()}
});
