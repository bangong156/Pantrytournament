import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import {competitionClient,competitionTables} from '../event-scope.js';
import {parseRosterRows} from '../roster-import.js';

function recordingClient(){
 const requests=[];
 const client=createClient('https://example.supabase.co','test-key',{
  auth:{persistSession:false,autoRefreshToken:false},
  global:{fetch:async(url,init)=>{requests.push({url:new URL(url),...init});return new Response('[]',{status:200,headers:{'Content-Type':'application/json'}})}}});
 return {client,requests};
}
const event={id:'event-a',tournament_id:'tournament-a'};
test('every operational table scopes reads, updates and deletes; privacy/global tables are excluded',async()=>{
 const {client,requests}=recordingClient();const db=competitionClient(client,event);
 for(const table of competitionTables){
  await db.from(table).select('*');await db.from(table).update({name:'changed'}).eq('id','row');await db.from(table).delete();
 }
 assert.equal(requests.length,competitionTables.size*3);
 for(const request of requests){assert.equal(request.url.searchParams.get('event_id'),'eq.event-a');assert.equal(new Headers(request.headers).get('x-client-info'),'pantry-event/event-a');}
 for(const table of ['players','player_flags','tournaments','tournament_info'])assert.throws(()=>db.from(table),/not event scoped/);
 assert.throws(()=>competitionClient(client,null),/Chưa chọn/);
});
test('inserts and award upserts include event ownership with event-specific conflict target',async()=>{
 const {client,requests}=recordingClient(),db=competitionClient(client,event);
 await db.from('teams').insert([{name:'One',tournament_id:'tournament-a'},{name:'Two'}]);
 await db.from('tournament_awards').upsert({placement:1,placement_slot:1,team_name:'Winner'},{onConflict:'event_id,placement,placement_slot'});
 assert.deepEqual(JSON.parse(requests[0].body).map(row=>row.event_id),['event-a','event-a']);
 assert.equal(JSON.parse(requests[1].body).event_id,'event-a');
 assert.equal(requests[1].url.searchParams.get('on_conflict'),'event_id,placement,placement_slot');
 assert.throws(()=>db.from('teams').insert({event_id:'event-b'}),/Sai nội dung/);
 assert.throws(()=>db.from('teams').insert({tournament_id:'tournament-b'}),/Sai giải/);
});
test('in-flight screens retain their captured event after selection changes',async()=>{
 const {client,requests}=recordingClient();const selection={...event},a=competitionClient(client,selection);
 selection.id='event-b';const b=competitionClient(client,selection);
 await Promise.all([a.from('matches').delete().eq('stage','group'),b.from('matches').select('*')]);
 assert.equal(requests[0].url.searchParams.get('event_id'),'eq.event-a');
 assert.equal(requests[1].url.searchParams.get('event_id'),'eq.event-b');
});
test('spreadsheet parsing preserves global player names and supports doubles/MLP styles',()=>{
 assert.deepEqual(parseRosterRows([['VĐV 1','VĐV 2'],['An','Bình']],'doubles'),[{name:'An - Bình',names:['An','Bình']}]);
 assert.equal(parseRosterRows([['Cặp VĐV'],['An - Bình']],'doubles')[0].names.length,2);
 assert.equal(parseRosterRows([['Tên đội','VĐV 1','VĐV 2','VĐV 3'],['Mini','An','Bình','Chi']],'mlp',3)[0].names.length,3);
 assert.equal(parseRosterRows([['Basic','An','Bình','Chi','Dung']],'mlp',4)[0].names.length,4);
 assert.throws(()=>parseRosterRows([['Incomplete','An']],'mlp',4),/cần đủ/);
});
