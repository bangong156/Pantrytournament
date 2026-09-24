import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createClient} from '@supabase/supabase-js';
import {competitionClient} from '../event-scope.js';
import {courtLabel,courtOptions,assignCourt,courtConflictMessage} from '../match-courts.js';
import {nextMatch} from '../spectator.js';
import {videoRepository} from '../server/video-repository.js';

test('assign, change, remove are event scoped and do not touch scores or match status',async()=>{
 const requests=[];
 const client=createClient('https://example.supabase.co','test',{auth:{persistSession:false},global:{fetch:async(url,init)=>{
  requests.push({url:new URL(url),...init});const row=JSON.parse(init.body);
  return new Response(JSON.stringify({id:'match',court_number:row.court_number}),{headers:{'Content-Type':'application/json'}});
 }}});
 const db=competitionClient(client,{id:'event-b',tournament_id:'cup'});
 for(const value of ['2','5',''])await assignCourt(db,'cup','match',value);
 assert.deepEqual(requests.map(r=>JSON.parse(r.body)),[2,5,null].map(court_number=>({court_number,event_id:'event-b'})));
 for(const r of requests){assert.equal(r.url.searchParams.get('event_id'),'eq.event-b');assert.equal(r.url.searchParams.get('tournament_id'),'eq.cup');assert.equal(new Headers(r.headers).get('x-client-info'),'pantry-event/event-b');}
 for(const value of ['0','-1','1.5','abc'])await assert.rejects(assignCourt(db,'cup','match',value));
 assert.equal(requests.length,3);
});
test('court labels and options handle unassigned and future court numbers',()=>{
 assert.equal(courtLabel(null),'');assert.equal(courtLabel(3),'SÂN 3');
 assert.deepEqual(courtOptions(null),[1,2,3,4,5,6]);assert.ok(courtOptions(9).includes(9));
});
test('unique-index race error resolves occupied court across events in the tournament',async()=>{
 const queries=[];let index=0;
 const client={from(){const q={};queries.push(q);for(const key of ['select','eq','neq','limit'])q[key]=(...args)=>{(q[key+'Args']??=[]).push(args);return q};q.maybeSingle=async()=>({data:index++===0?{tournament_id:'cup',court_number:3}:{match_code:'A07'}});return q;}};
 assert.equal(await courtConflictMessage(client,'match',{code:'23505',message:'matches_playing_court_unique'}),'Sân 3 đang có trận A07.');
 assert.deepEqual(queries[1].eqArgs,[['tournament_id','cup'],['court_number',3],['status','playing']]);
 assert.equal(await courtConflictMessage(client,'match',{message:'Sân 3 đang có trận A07.'}),'Sân 3 đang có trận A07.');
});
const source=fs.readFileSync(new URL('../src.js',import.meta.url),'utf8');
test('actual next-match rendering shows assigned court or waiting, never a time',()=>{
 const node={innerHTML:''};const context=vm.createContext({document:{querySelector:()=>node},nextMatch,courtLabel,Set,esc:s=>s,context:{matches:[{id:'m',match_code:'A07',status:'scheduled',court_number:3,team1_id:'a',team2_id:'b'}]},teamMap:{a:'Alpha',b:'Beta'}});
 const start=source.indexOf('const renderNext=');const end=source.indexOf('\n renderNext();',start);
 vm.runInContext(source.slice(start,end)+'\nrenderNext();',context);
 assert.match(node.innerHTML,/SÂN 3/);assert.match(node.innerHTML,/Alpha/);
 context.context.matches[0].court_number=null;vm.runInContext('renderNext()',context);assert.match(node.innerHTML,/ĐANG CHỜ SÂN/);
 vm.runInContext("renderNext([{match_id:'m'}])",context);assert.equal(node.innerHTML,'');
});
test('homepage metadata selects court separately and retains the video-create lookup columns',async()=>{
 const oldFetch=globalThis.fetch,requests=[];
 globalThis.fetch=async(url)=>{const u=new URL(url);requests.push(u);const table=u.pathname.split('/').at(-1);let data;
  if(table==='matches')data=u.searchParams.get('select')==='court_number'?{court_number:3}:{id:'m',event_id:'e',tournament_id:'t',match_code:'A07',team1_id:'a',team2_id:'b'};
  else if(table==='teams')data=[{id:'a',name:'Alpha'},{id:'b',name:'Beta'}];else data={name:table};
  return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
 };
 try{const repo=videoRepository({url:'https://example.supabase.co',key:'test'});const match=await repo.match('m');const details=await repo.publicMatchDetails(match);
 assert.equal(details.court_number,3);assert.equal(requests[0].searchParams.get('select'),'id,event_id,tournament_id,match_code,team1_id,team2_id');
 const court=requests.find(u=>u.searchParams.get('select')==='court_number');assert.equal(court.searchParams.get('event_id'),'eq.e');
 }finally{globalThis.fetch=oldFetch;}
});
test('court UI stays role gated, serves both scoring formats, and is compact',()=>{
 const ui=source.slice(source.indexOf('function mountCourtSelect('),source.indexOf('async function renderMatches('));
 assert.match(ui,/\['admin','staff'\]/);assert.match(ui,/aria-label/);assert.match(ui,/Chưa xếp sân/);
 assert.match(source,/\[data-save\],\[data-open-mlp\]/);assert.match(source,/data-court-match/);
 const css=fs.readFileSync(new URL('../style.css',import.meta.url),'utf8');assert.match(css,/\.match-court-select\{[^}]*max-width:150px/);assert.match(css,/\.public-court\{display:block/);
});
test('court dropdown saves changes, removes assignment, and restores value on failure',async()=>{
 let select;const alerts=[],saved=[];let fail=false;
 const context=vm.createContext({profile:{role:'staff'},courtOptions,document:{createElement:()=>select={setAttribute(){}}},assignCourt:async(db,tid,id,value)=>{if(fail)throw {message:'Sân 3 đang có trận A07.'};saved.push({db,tid,id,value});return {court_number:value===''?null:Number(value)};},courtConflictMessage:async(client,id,error)=>error.message,supabase:{},alert:message=>alerts.push(message)});
 vm.runInContext(source.slice(source.indexOf('function mountCourtSelect('),source.indexOf('async function renderMatches(')),context);
 context.match={id:'m',match_code:'A01',court_number:2};context.db={event:{id:'e'}};context.host={append(){}};
 vm.runInContext("mountCourtSelect(host,match,db,'cup')",context);
 assert.equal(select.value,'2');select.value='5';await select.onchange();assert.equal(context.match.court_number,5);
 select.value='';await select.onchange();assert.equal(context.match.court_number,null);
 fail=true;select.value='3';await select.onchange();assert.equal(select.value,'');assert.equal(select.disabled,false);assert.deepEqual(alerts,['Sân 3 đang có trận A07.']);
 assert.equal(saved[0].db,context.db);assert.equal(saved[0].tid,'cup');
 context.profile.role='player';select=null;vm.runInContext("mountCourtSelect(host,match,db,'cup')",context);assert.equal(select,null);
});

test('group renderer mounts a court selector for every Admin/Staff match independently of LIVE controls',async()=>{
 for(const role of ['admin','staff','player'])for(const basic of [false,true]){
  const matches=[{id:'uuid-match',group_id:'g',match_code:'A01',court_number:3,status:'scheduled'},
   {id:42,group_id:'g',match_code:'A02',court_number:null,status:'playing'}];
  const hosts=[];const work={set innerHTML(html){
   this.html=html;hosts.splice(0,hosts.length,...[...html.matchAll(/data-group-court="([^"]+)"/g)].map(m=>({dataset:{groupCourt:m[1]},children:[],append(node){this.children.push(node)}})));
  }};
  const db={from(table){const q={select(){return q},eq(){return q},order(){return q},then(resolve){return Promise.resolve({data:table==='matches'?matches:table==='groups'?[{id:'g',name:'A'}]:[]}).then(resolve)}};return q}};
  const context=vm.createContext({profile:{role},courtOptions,competitionClient:()=>db,supabase:{},activeEvent:{},renderEpoch:0,currentTournament:{name:'Cup',format:basic?'mlp':'doubles'},standingsData:async()=>[],getMlpConfig:async()=>({style:'basic'}),fairMatchOrder:m=>m,esc:s=>String(s??''),startLive(){},document:{querySelector:()=>work,querySelectorAll:selector=>selector==='#workcontent [data-group-court]'?hosts:[],createElement:()=>({setAttribute(){}})}});
  vm.runInContext(source.slice(source.indexOf('function mountCourtSelect('),source.indexOf('async function standingsData(')),context);
  await vm.runInContext("renderMatches('cup')",context);
  assert.equal(hosts.length,2);
  assert.match(work.html,basic?/data-open-mlp=/:/data-save=/);
  for(const [i,host] of hosts.entries()){
   assert.equal(host.children.length,role==='player'?0:1);
   if(role==='player')continue;
   const select=host.children[0];assert.equal(select.className,'match-court-select');
   assert.equal(select.value,i===0?'3':'');assert.match(select.innerHTML,/Chưa xếp sân/);
   for(let court=1;court<=6;court++)assert.ok(select.innerHTML.includes(`Sân ${court}</option>`));
  }
 }
});
