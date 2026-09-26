import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spectatorDetail,teamJourney,completedWinner,loadSpectatorDetail} from '../spectator-detail.js';
import {linkedTournament,publicRoute,competitionURL,matchURL,teamURL} from '../public-links.js';
import {competitionClient} from '../event-scope.js';
const tid='11111111-1111-4111-8111-111111111111',e1='22222222-2222-4222-8222-222222222222',e2='33333333-3333-4333-8333-333333333333',mid='44444444-4444-4444-8444-444444444444',a='55555555-5555-4555-8555-555555555555',b='66666666-6666-4666-8666-666666666666';
globalThis.location={origin:'https://pantry.test'};
const tournament={id:tid,name:'Pantry Cup'},event={id:e2,tournament_id:tid,name:'Event Two',format:'doubles'};
const teams=[{id:a,name:'Alpha'},{id:b,name:'Beta'}];
const match=(patch={})=>({id:mid,tournament_id:tid,event_id:e2,team1_id:a,team2_id:b,stage:'group',match_code:'A07',status:'scheduled',court_number:3,scheduled_order:1,...patch});
const render=m=>spectatorDetail({tournament,event,teams,matches:[m],matchId:mid});
test('completed match shows final score and winner; playing and waiting never claim a result',()=>{
 const html=render(match({status:'completed',team1_score:11,team2_score:7}));
 for(const text of ['Pantry Cup','Event Two','A07','Alpha','Beta','11–7','✓ THẮNG','✓ KẾT THÚC','SÂN 3','CHIA SẺ TRẬN','← XEM TOÀN BỘ GIẢI'])assert.ok(html.includes(text),text);
 assert.match(html,/class="spectator-winner"/);
 assert.match(render(match({status:'playing',team1_score:2,team2_score:1})),/2–1/);
 assert.match(render(match({status:'playing'})),/🔴 ĐANG ĐẤU/);
 assert.doesNotMatch(render(match({status:'playing',team1_score:11,team2_score:7})),/✓ THẮNG/);
 assert.match(render(match()),/SẮP ĐẤU/);
 assert.doesNotMatch(render(match({court_number:null})),/SÂN/);
 assert.equal(completedWinner(match({status:'completed',team1_score:null,team2_score:7})),null);
 assert.equal(completedWinner(match({status:'completed',team1_score:7,team2_score:7})),null);
 assert.match(render(match({team2_id:null})),/TBD/);
});
test('detail uses existing event-scoped LIVE slot and links to team journeys',()=>{
 const html=render(match({status:'playing'}));
 assert.ok(html.includes(`data-public-video="${mid}"`));assert.match(html,/data-video-label="A07"/);
 assert.ok(html.includes(`event=${e2}&amp;team=${a}`));
 assert.doesNotMatch(html,/<video|RTCPeerConnection/);
});
test('journey selects actual matches, orders stages and scheduled order, and never invents rounds',()=>{
 const rows=[match({id:'final',stage:'final'}),match({id:'g2',match_code:'A10',scheduled_order:2,status:'completed',team1_score:7,team2_score:11}),match({id:'other',team1_id:b,team2_id:'c'}),match({id:'semi',stage:'semifinal'}),match({id:'g1',match_code:'A02',scheduled_order:1}),match({id:'quarter',stage:'quarterfinal'}),match({id:'cancelled',status:'cancelled'})];
 const groups=teamJourney(rows,a);
 assert.deepEqual(groups.map(g=>g.stage),['group','quarterfinal','semifinal','final']);
 assert.deepEqual(groups[0].matches.map(m=>m.id),['g1','g2']);
 const html=spectatorDetail({tournament,event,teams,matches:rows,teamId:a});
 for(const text of ['HÀNH TRÌNH TẠI GIẢI','VÒNG BẢNG','TỨ KẾT','BÁN KẾT','CHUNG KẾT','✕ THUA','SẮP ĐẤU','SÂN 3','CHIA SẺ HÀNH TRÌNH'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/VÒNG 1\/16|cancelled/);
 const groupOnly=spectatorDetail({tournament,event,teams,matches:[match()],teamId:a});
 assert.doesNotMatch(groupOnly,/TỨ KẾT|BÁN KẾT|CHUNG KẾT/);
});
test('MLP journey renders each parent match once, from the selected team perspective',()=>{
 const html=spectatorDetail({tournament,event:{...event,format:'mlp'},teams,matches:[match({status:'completed',team1_score:1,team2_score:3})],teamId:b});
 assert.equal((html.match(/spectator-journey-row/g)||[]).length,1);
 assert.match(html,/3–1/);assert.match(html,/✓ THẮNG/);assert.doesNotMatch(html,/G1|G2|G3|G4|G5/);
});
const source=fs.readFileSync(new URL('../src.js',import.meta.url),'utf8');
function harness(search,{failure=false}={}){
 const requests=[],nodes=new Map(),app={innerHTML:''},live=[];
 const tables={tournaments:[tournament],tournament_events:[{id:e1,tournament_id:tid,name:'Default',is_default:true},event],teams:teams.map(t=>({...t,event_id:e2,tournament_id:tid})),matches:[match(),match({id:'other-event',event_id:e1,match_code:'WRONG'})]};
 const client={from(table){const filters=[],request={table,filters};requests.push(request);const q={select(columns){request.columns=columns;return q},eq(key,value){filters.push([key,value]);return q},order(){return q},setHeader(key,value){request.header=[key,value];return q},single(){request.single=true;return q},then(resolve){const data=tables[table].filter(row=>filters.every(([k,v])=>row[k]===v));return Promise.resolve({data:request.single?data[0]:data,error:failure&&table==='matches'?{code:'42501'}:null}).then(resolve)}};return q}};
 const location={origin:'https://pantry.test',search};
 const node=key=>{if(!nodes.has(key))nodes.set(key,{});return nodes.get(key)};
 const context=vm.createContext({app,location,URLSearchParams,linkedTournament,publicRoute,competitionURL,matchURL,teamURL,competitionClient,loadSpectatorDetail,spectatorDetail,supabase:client,renderEpoch:0,activeEvent:null,tournamentEvents:[],esc:s=>String(s??''),stopLive(){},startLive(view,refresh){live.push({view,refresh})},mountPublicVideo(scope){live.push(scope)},document:{querySelectorAll:()=>[],querySelector:node},history:{replaceState(_a,_b,url){location.search=new URL(url,location.origin).search}},publicDashboard(){throw Error('unexpected dashboard')},render(){},publicTournamentInfo(){throw Error('unexpected info')}});
 vm.runInContext(source.slice(source.indexOf('async function boot()'),source.indexOf('\nfunction render()')),context);
 vm.runInContext(source.slice(source.indexOf('async function publicTournament(tid'),source.indexOf('function publicTeamButton(')),context);
 vm.runInContext(source.slice(source.indexOf('async function loadCompetitionEvents('),source.indexOf('function publicEventSelector(')),context);
 return {context,app,requests,location,live,nodes,boot:()=>vm.runInContext('boot()',context)};
}
test('direct match load and full refresh select the explicit non-default event before authentication',async()=>{
 const search=new URL(matchURL(tid,e2,mid)).search;
 const h=harness(search);await h.boot();
 assert.match(h.app.innerHTML,/A07/);assert.match(h.app.innerHTML,/Event Two/);assert.doesNotMatch(h.app.innerHTML,/WRONG/);
 assert.deepEqual({...h.live.at(-1)},{tournament_id:tid,event_id:e2});
 for(const req of h.requests.filter(r=>['matches','teams'].includes(r.table))){assert.ok(req.filters.some(([k,v])=>k==='event_id'&&v===e2));assert.ok(req.filters.some(([k,v])=>k==='tournament_id'&&v===tid));assert.deepEqual(req.header,['x-client-info',`pantry-event/${e2}`]);assert.notEqual(req.columns,'*');}
 const refreshed=harness(h.location.search);await refreshed.boot();assert.match(refreshed.app.innerHTML,/A07/);
 await h.live[0].refresh();assert.equal(h.location.search,search);
});
test('missing, invalid, or mismatched event and match links never show a default-event match',async()=>{
 for(const search of [`?tournament=${tid}&match=${mid}`,`?tournament=${tid}&event=bad&match=${mid}`,`?tournament=${tid}&event=${a}&match=${mid}`,`?tournament=${tid}&event=${e1}&match=${mid}`]){
  const h=harness(search);await h.boot();assert.doesNotMatch(h.app.innerHTML,/<h1>A07/);assert.match(h.app.innerHTML,/Không tìm thấy/);
 }
});
test('journey direct load is event scoped and read failures remain errors, not empty history',async()=>{
 const h=harness(new URL(teamURL(tid,e2,a)).search);await h.boot();assert.match(h.app.innerHTML,/HÀNH TRÌNH TẠI GIẢI/);assert.doesNotMatch(h.app.innerHTML,/WRONG/);
 const error=harness(new URL(matchURL(tid,e2,mid)).search,{failure:true});await error.boot();assert.match(error.app.innerHTML,/Không thể tải dữ liệu/);assert.doesNotMatch(error.app.innerHTML,/Chưa có trận đấu/);
});
test('mobile detail styles wrap names, keep compact rows, and expose a prominent existing LIVE button',()=>{
 const css=fs.readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/@media\(max-width:600px\)\{.spectator-detail/);
 assert.match(css,/\.spectator-journey-row>div\{grid-column:1\/-1\}/);
 assert.match(css,/\.spectator-detail-live .public-video-button::before\{content:'🔴 '\}/);
 assert.match(css,/\.spectator-detail-teams>div\{min-width:0;overflow-wrap:anywhere\}/);
});

test('real 32-team and 16-team stages are ordered and labeled by bracket size',()=>{
 const html=spectatorDetail({tournament,event,teams,teamId:a,matches:[match({id:'r16',stage:'round_of_16'}),match({id:'r32',stage:'round_of_32'})]});
 assert.ok(html.indexOf('VÒNG 1/16')<html.indexOf('VÒNG 1/8'));
 assert.doesNotMatch(html,/TỨ KẾT|BÁN KẾT|CHUNG KẾT/);
});
test('unavailable matches and incomplete participants do not claim upcoming status or winners',()=>{
 assert.match(render(match({status:'cancelled'})),/Không tìm thấy trận/);
 assert.equal(completedWinner(match({status:'completed',team2_id:null,team1_score:11,team2_score:0})),null);
 assert.equal(completedWinner(match({status:'completed',team2_id:a,team1_score:11,team2_score:0})),null);
 const html=spectatorDetail({tournament,event,teams,teamId:a,matches:[match({status:'playing',team1_score:11,team2_score:7})]});
 assert.match(html,/🔴 ĐANG ĐẤU/);assert.doesNotMatch(html,/✓ THẮNG|✕ THUA/);
});
