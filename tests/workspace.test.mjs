import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {competitionClient} from '../event-scope.js';
import {parseRosterRows} from '../roster-import.js';

// Exercise the existing competition algorithms with two events sharing labels.
// No remote requests and no SQL are executed by this test harness.
function harness({rpcHandler,beforeRequest}={}){
 const tid='tournament',events=[{id:'a',tournament_id:tid,name:'Newbie',format:'doubles',is_default:true,status:'draft',sort_order:0},{id:'b',tournament_id:tid,name:'MLP',format:'mlp',is_default:false,status:'draft',sort_order:1}];
 const tables={tournaments:[{id:tid,name:'Cup',format:'doubles',start_date:'2026-10-10',start_time:'08:00'}],tournament_events:events,
  teams:[],groups:[],group_teams:[],matches:[],mlp_configs:[{event_id:'b',tournament_id:tid,style:'mini',members_per_team:3}],mlp_slots:[1,2,3].map(slot_order=>({event_id:'b',tournament_id:tid,slot_order})),tournament_awards:[],team_members:[],players:[],player_flags:[]};
 for(const event of events){
  tables.groups.push({id:`${event.id}-group`,tournament_id:tid,event_id:event.id,name:'A',group_order:1});
  for(let i=0;i<4;i++){tables.teams.push({id:`${event.id}-${i}`,tournament_id:tid,event_id:event.id,name:`Team ${i}`,registration_order:i});tables.group_teams.push({group_id:`${event.id}-group`,team_id:`${event.id}-${i}`,event_id:event.id});}
  tables.matches.push({id:`${event.id}-match`,tournament_id:tid,event_id:event.id,group_id:`${event.id}-group`,match_code:'A01',stage:'group',status:'completed',team1_id:`${event.id}-0`,team2_id:`${event.id}-1`,team1_score:11,team2_score:5,winner_id:`${event.id}-0`});
 }
 const requests=[];let next=0;
 const client={from(table){let method='select',payload,conflictKeys=[],filters=[],single=false;const q={
  select(){return q},insert(rows){method='insert';payload=rows;return q},upsert(rows,options={}){method='upsert';payload=rows;conflictKeys=(options.onConflict||'id').split(',');return q},update(row){method='update';payload=row;return q},delete(){method='delete';return q},
  eq(k,v){filters.push(r=>r[k]===v);return q},neq(k,v){filters.push(r=>r[k]!==v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},order(){return q},limit(){return q},setHeader(){return q},single(){single=true;return q},maybeSingle(){single=true;return q},
  then(resolve,reject){return Promise.resolve().then(async()=>{requests.push({table,method,payload});const intercepted=await beforeRequest?.({table,method,payload});if(intercepted)return intercepted;const data=tables[table]??=[];const matched=data.filter(r=>filters.every(f=>f(r)));let result=matched;
   if(method==='delete')tables[table]=data.filter(r=>!matched.includes(r));
   if(method==='update')matched.forEach(r=>Object.assign(r,payload));
   if(method==='insert'){result=(Array.isArray(payload)?payload:[payload]).map(r=>({id:`new-${++next}`,...r}));data.push(...result)}
   if(method==='upsert'){result=(Array.isArray(payload)?payload:[payload]).map(r=>{const existing=data.find(old=>conflictKeys.every(k=>old[k]===r[k]));if(existing){Object.assign(existing,r);return existing}const added={id:`new-${++next}`,...r};data.push(added);return added})}
   return {data:single?(result[0]||null):structuredClone(result),error:null};}).then(resolve,reject)}
 };return q},async rpc(name,args){requests.push({rpc:name,args});return rpcHandler?rpcHandler(name,args):{data:[],error:null}}};
 const storage=new Map();
 const nodes=new Map();function node(selector){if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',textContent:'',style:{},dataset:{},elements:{format:{value:'doubles'}},formValues:{},querySelector:child=>node(selector+' '+child),querySelectorAll:()=>[],addEventListener(){}});return nodes.get(selector)}
 const context=vm.createContext({testClient:client,competitionClient,parseRosterRows,console,URL,Intl,Date,Math,Set,Map,Object,Promise,Array,JSON,String,Number,Error,structuredClone,
  pantryLogo:'logo',document:{querySelector:node,querySelectorAll:()=>[],activeElement:null},FormData:class {constructor(form){this.values=form.formValues}get(key){return this.values[key]??null}},localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,alert(){},confirm:()=>true});
 let source=fs.readFileSync(new URL('../src.js',import.meta.url),'utf8').replace(/^import .*\n/gm,'').replace(/const supabase=createClient\([^\n]+/,'const supabase=testClient').replace(/\nboot\(\)\s*$/,'');
 vm.runInContext(source,context);
 const run=code=>vm.runInContext(code,context);
 run("activeEvent={id:'a',tournament_id:'tournament',format:'doubles'};currentTournament={id:'tournament',name:'Cup',format:'doubles'};profile={role:'admin'}");
 return {tables,requests,run,nodes,node,storage};
}
test('standings for identical group/match labels never merge events',async()=>{
 const h=harness();const standings=await h.run("standingsData('tournament')");
 assert.equal(standings.length,1);assert.equal(standings[0].group.id,'a-group');
 assert.equal(standings[0].rows.find(r=>r.id==='a-0').w,1);
 assert.ok(standings[0].rows.every(row=>row.id.startsWith('a-')));
});
test('redistributing and scheduling event A leaves event B operational records unchanged',async()=>{
 const h=harness();const before=JSON.stringify(Object.fromEntries(['teams','groups','group_teams','matches'].map(k=>[k,h.tables[k].filter(r=>r.event_id==='b')])));
 await h.run("saveGroupDistribution('tournament',2,['a-0','a-1','a-2','a-3'],false)");
 await h.run("createGroupSchedule('tournament')");
 const after=JSON.stringify(Object.fromEntries(['teams','groups','group_teams','matches'].map(k=>[k,h.tables[k].filter(r=>r.event_id==='b')])));
 assert.equal(after,before);assert.equal(h.tables.matches.filter(r=>r.event_id==='a').length,2);
 assert.ok(h.tables.matches.filter(r=>r.event_id==='a').every(r=>r.team1_id.startsWith('a-')&&r.team2_id.startsWith('a-')));
 assert.equal(h.tables.tournament_events.find(e=>e.id==='a').status,'group_stage');
 assert.equal(h.tables.tournament_events.find(e=>e.id==='b').status,'draft');
});
test('workspace defaults automatically, switches event format, and opens overview without undefined handlers',async()=>{
 const h=harness();await h.run("workspace('tournament')");
 assert.equal(h.run('activeEvent.id'),'a');assert.match(h.nodes.get('#app').innerHTML,/NỘI DUNG GIẢI/);
 assert.equal(typeof h.nodes.get('#excel').onchange,'function');
 await h.run("workspace('tournament','overview','b')");
 assert.equal(h.run('currentTournament.format'),'mlp');
 assert.match(h.nodes.get('#workcontent').innerHTML,/MLP Mini/);
 assert.match(h.nodes.get('#app').innerHTML,/Cup → MLP/);
});
test('public hub uses event roster RPC, shows multi-event selection and hides it for single event',async()=>{
 const h=harness();await h.run("publicTournament('tournament','teams','b')");
 assert.equal(h.run('activeEvent.id'),'b');assert.match(h.nodes.get('#app').innerHTML,/data-public-event="a"/);
 assert.ok(h.requests.some(r=>r.rpc==='public_event_roster'&&r.args.p_event_id==='b'));
 h.tables.tournament_events.splice(1);await h.run("publicTournament('tournament','teams')");
 assert.doesNotMatch(h.nodes.get('#app').innerHTML,/data-public-event=/);
});
test('event metadata screens escape names and do not allow removing the last event',async()=>{
 const h=harness();h.tables.tournament_events.splice(1);h.tables.tournament_events[0].name='<script>bad</script>';
 await h.run("workspace('tournament')");const html=h.nodes.get('#app').innerHTML;
 assert.match(html,/&lt;script&gt;/);assert.match(html,/data-delete-event="a" disabled/);
});
test('knockout replacement is isolated to the selected event',async()=>{
 const h=harness();
 // Existing knockout algorithm needs eight qualifiers; keep its rules intact.
 for(let i=4;i<8;i++)h.tables.teams.push({id:`a-${i}`,event_id:'a',tournament_id:'tournament',name:`A${i}`});
 h.tables.groups=h.tables.groups.filter(g=>g.event_id!=='a');h.tables.group_teams=h.tables.group_teams.filter(g=>g.event_id!=='a');
 for(let i=0;i<4;i++){
  h.tables.groups.push({id:`a-g${i}`,event_id:'a',tournament_id:'tournament',name:String(i)});
  for(let j=0;j<2;j++)h.tables.group_teams.push({group_id:`a-g${i}`,team_id:`a-${i*2+j}`,event_id:'a'});
 }
 h.tables.matches.push({id:'b-ko',event_id:'b',tournament_id:'tournament',stage:'quarterfinal',match_code:'KO01'});
 await h.run("createKnockout('tournament')");
 assert.equal(h.tables.matches.filter(m=>m.event_id==='a'&&m.stage==='quarterfinal').length,4);
 assert.ok(h.tables.matches.some(m=>m.id==='b-ko'));
});
test('referee console derives its event from the authorized group, overriding previous selection',async()=>{
 const h=harness();
 await h.run("refereeConsole('tournament','token',{session_token:'token',group_id:'b-group',referee_name:'Ref'},true)");
 assert.equal(h.run('activeEvent.id'),'b');
 assert.match(h.nodes.get('#app').innerHTML,/Cup → MLP/);
 assert.doesNotMatch(h.nodes.get('#app').innerHTML,/a-match/);
});
test('create form has native start time and planning count, without courts input',()=>{
 const h=harness();h.run('createModal()');const html=h.nodes.get('#modal').innerHTML;
 assert.match(html,/name="start_time" type="time"/);
 assert.match(html,/Số cặp VĐV dự kiến/);
 assert.doesNotMatch(html,/name="courts"|Số sân/);
});


test('creation submits the installed atomic RPC with optional planning values and MLP Mini style',async()=>{
 const h=harness({rpcHandler:async()=>({data:'created-tournament',error:null})});
 h.run("workspace=async(...args)=>{globalThis.openedWorkspace=args};createModal()");
 const form=h.node('#create');
 form.formValues={name:'  New Cup  ',event_type:'tournament',start_date:'2026-10-10',start_time:'08:30',format:'mlp',expected_team_count:'12',mlp_style:'mini'};
 await form.onsubmit({preventDefault(){}});
 assert.deepEqual(structuredClone(h.requests.find(r=>r.rpc).args),{p_name:'New Cup',p_event_type:'tournament',p_start_date:'2026-10-10',p_start_time:'08:30',p_format:'mlp',p_expected_team_count:12,p_style:'mini'});
 assert.equal(h.requests[0].rpc,'create_competition_tournament');
 assert.equal(h.run('openedWorkspace[0]'),'created-tournament');
 assert.equal(h.requests.filter(r=>r.table).length,0);
 h.run('createModal()');form.formValues={name:'Doubles',event_type:'minigame',start_date:'2026-10-11',format:'doubles'};
 await form.onsubmit({preventDefault(){}});
 assert.equal(h.requests[1].args.p_start_time,null);
 assert.equal(h.requests[1].args.p_expected_team_count,null);
});

test('default selection uses is_default rather than the first event or a different tournament selection',async()=>{
 const h=harness();h.tables.tournament_events[0].is_default=false;h.tables.tournament_events[1].is_default=true;
 h.run("activeEvent={id:'elsewhere',tournament_id:'another-tournament'}");
 await h.run("workspace('tournament')");
 assert.equal(h.run('activeEvent.id'),'b');assert.equal(h.run('currentTournament.format'),'mlp');
});

test('event editing offers Mini when converting doubles, preserves existing MLP style controls, and uses the event RPC',async()=>{
 const h=harness({rpcHandler:async()=>({data:'a',error:null})});
 h.run("workspace=async(...args)=>{globalThis.openedWorkspace=args};competitionEventModal(currentTournament,{id:'a',format:'doubles',name:'Doubles'})");
 const form=h.node('#competitionEventForm');form.elements.format.value='mlp';form.elements.format.onchange();
 assert.match(h.node('#competitionEventForm #eventMlpStyle').innerHTML,/value="mini"/);
 form.formValues={name:'Mini event',format:'mlp',style:'mini',expected_team_count:'8',start_time:'10:00'};
 await form.onsubmit({preventDefault(){}});
 assert.deepEqual(structuredClone(h.requests[0]),{rpc:'save_competition_event',args:{p_tournament_id:'tournament',p_event_id:'a',p_name:'Mini event',p_start_time:'10:00',p_format:'mlp',p_expected_team_count:8,p_style:'mini'}});
 h.run("competitionEventModal(currentTournament,{id:'b',format:'mlp',name:'Existing Mini'})");
 assert.equal(h.node('#competitionEventForm #eventMlpStyle').innerHTML,'');
});

test('failed event save stays on the form and displays the server guard error',async()=>{
 const h=harness({rpcHandler:async()=>({data:null,error:{message:'Cannot change populated event format'}})});
 h.run('competitionEventModal(currentTournament)');const form=h.node('#competitionEventForm');
 form.formValues={name:'New',format:'doubles'};await form.onsubmit({preventDefault(){}});
 assert.equal(h.node('#competitionEventForm #eventFormError').textContent,'Cannot change populated event format');
 assert.equal(h.node('#competitionEventForm .wide').disabled,false);
 assert.equal(h.run('activeEvent.id'),'a');
});

test('delayed event save cannot reopen its event after the user navigates elsewhere',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve});
 const h=harness({rpcHandler:()=>pending});h.run('competitionEventModal(currentTournament)');
 const form=h.node('#competitionEventForm');form.formValues={name:'New',format:'doubles'};
 const saving=form.onsubmit({preventDefault(){}});
 await h.run("workspace('tournament','overview','b')");
 release({data:'a',error:null});await saving;
 assert.equal(h.run('activeEvent.id'),'b');assert.match(h.node('#app').innerHTML,/Cup → MLP/);
});

test('visiting another event retains an existing valid referee login until a new claim succeeds',async()=>{
 const session={session_token:'existing-token',tournament_id:'tournament',group_id:'a-group',referee_name:'Ref'};
 const h=harness({rpcHandler:async(name)=>({data:name==='get_referee_session'?[session]:[],error:null})});
 h.storage.set('pantry_ref_tournament',JSON.stringify(session));
 await h.run("publicTournament('tournament','teams','b')");
 await h.node('#beReferee').onclick();
 assert.equal(JSON.parse(h.storage.get('pantry_ref_tournament')).session_token,'existing-token');
 assert.match(h.node('#modal').innerHTML,/b-group/);
 assert.doesNotMatch(h.node('#modal').innerHTML,/a-group/);
});

test('scheduling stops when existing matches cannot be deleted',async()=>{
 const h=harness({beforeRequest:async({table,method})=>table==='matches'&&method==='delete'?{error:{message:'Protected match history'}}:null});
 const original=structuredClone(h.tables.matches);
 await assert.rejects(h.run("createGroupSchedule('tournament')"),{message:'Protected match history'});
 assert.deepEqual(h.tables.matches,original);
 assert.equal(h.requests.some(r=>r.table==='matches'&&r.method==='insert'),false);
 assert.equal(h.tables.tournament_events[0].status,'draft');
});


test('an award save remains in its captured event and cannot repaint a newly selected event',async()=>{
 let release,started;const pending=new Promise(resolve=>{release=resolve});const entered=new Promise(resolve=>{started=resolve});
 const h=harness({beforeRequest:async({table,method})=>{if(table==='tournament_awards'&&method==='upsert'){started();await pending}}});
 h.run("session={user:{id:'admin'}}");
 await h.run("renderAwards('tournament',[],{})");
 const card={hidden:false,dataset:{awardCard:'1-1'},querySelector:selector=>({value:selector==='[data-award-team]'?'Event A winner':selector==='[data-award-players]'?'A player':''})};
 h.node('#workcontent').querySelectorAll=selector=>selector==='[data-award-card]'?[card]:[];
 const saving=h.node('#workcontent #saveAwards').onclick();await entered;
 await h.run("workspace('tournament','overview','b')");
 const newContent=h.node('#workcontent').innerHTML;
 release();await saving;
 assert.equal(h.tables.tournament_awards[0].event_id,'a');
 assert.equal(h.run('activeEvent.id'),'b');
 assert.equal(h.node('#workcontent').innerHTML,newContent);
});


test('reading legacy Mini configuration normalizes display without rewriting stored settings',async()=>{
 const h=harness();h.tables.mlp_configs[0].style='basic';
 h.run("activeEvent={id:'b',tournament_id:'tournament',format:'mlp'};currentTournament.format='mlp'");
 const config=await h.run("getMlpConfig('tournament')");
 assert.equal(config.style,'mini');assert.equal(h.tables.mlp_configs[0].style,'basic');
 assert.ok(h.requests.every(r=>r.method==='select'));
});

test('MLP slot editing loads saved values and preserves row IDs and other events',async()=>{
 const h=harness();
 h.tables.mlp_slots=[{id:'a-slot',event_id:'a',tournament_id:'tournament',slot_order:1,slot_name:'Other',gender:'male',max_rating:4},
  ...[1,2,3].map(slot_order=>({id:`b-slot-${slot_order}`,event_id:'b',tournament_id:'tournament',slot_order,slot_name:`Saved ${slot_order}`,gender:'female',max_rating:3.5}))];
 h.run("activeEvent={id:'b',tournament_id:'tournament',format:'mlp'};currentTournament.format='mlp'");
 await h.run('slotsModal(currentTournament)');
 assert.match(h.node('#modal').innerHTML,/value="Saved 1"/);
 assert.match(h.node('#modal').innerHTML,/value="female" selected/);
 assert.match(h.node('#modal').innerHTML,/value="3.5"/);
 const form=h.node('#slotform');for(let i=0;i<3;i++)Object.assign(form.formValues,{['name'+i]:`Updated ${i+1}`,['gender'+i]:'female',['rating'+i]:'3.7'});
 await form.onsubmit({preventDefault(){}});
 assert.equal(h.tables.mlp_slots.length,4);
 assert.equal(h.tables.mlp_slots.find(s=>s.id==='a-slot').slot_name,'Other');
 assert.deepEqual(h.tables.mlp_slots.filter(s=>s.event_id==='b').map(s=>s.id),['b-slot-1','b-slot-2','b-slot-3']);
 assert.equal(h.tables.mlp_slots.find(s=>s.id==='b-slot-1').slot_name,'Updated 1');
 assert.equal(h.requests.some(r=>r.table==='mlp_slots'&&r.method==='delete'),false);
});
