import test from 'node:test';
import assert from 'node:assert/strict';
import {courtLabel} from '../match-courts.js';
import {validMatches,nextMatch,summaryText,matchStatus,eventState} from '../spectator.js';
const teams=[{id:'a'},{id:'b'}];
const match=(id,status,scheduled_order)=>({id,status,scheduled_order,match_code:id,team1_id:'a',team2_id:'b'});
test('counts include valid completed and knockout matches, exclude missing teams and invalid states',()=>{
 const rows=validMatches([match('A01','completed',1),{...match('KO01','scheduled',1),stage:'quarterfinal'},match('bad','cancelled',2),{...match('deleted','scheduled',3),team1_id:'missing'}],teams);
 assert.equal(summaryText(teams,[{id:'g'}],rows,'doubles'),'2 CẶP • 1 BẢNG • 1/2 TRẬN');
 assert.equal(summaryText(teams,[],rows,'mlp'),'2 ĐỘI • 0 BẢNG • 1/2 TRẬN');
});
test('next match excludes completed, playing, and active live matches, with deterministic numeric ordering',()=>{
 const rows=[match('A10','scheduled',2),match('A02','scheduled',2),match('done','completed',0),match('playing','playing',0),match('live','scheduled',1)];
 assert.equal(nextMatch(rows,new Set(['live'])).id,'A02');
 assert.equal(nextMatch([match('done','completed',1)]),null);
 assert.equal(nextMatch([]),null);
});
test('spectator states do not mutate match data',()=>{
 for(const [state,label] of [['scheduled','SẮP ĐẤU'],['playing','🔴 ĐANG ĐẤU'],['completed','✓ KẾT THÚC']])assert.equal(matchStatus(Object.freeze({status:state})),label);
});

import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src.js',import.meta.url),'utf8');
test('public cards render progress and all match stages with spectator labels',()=>{
 const context=vm.createContext({matchStatus,courtLabel,esc:s=>String(s??''),vietnamToday:()=> '2026-09-24',eventCategory:()=> 'live',displayEventDate:s=>s,eventType:()=> 'GIẢI ĐẤU',eventFormat:()=> 'Đánh đôi'});
 vm.runInContext(source.slice(source.indexOf('function discoveryCard('),source.indexOf('async function publicDashboard(')),context);
 vm.runInContext(source.slice(source.indexOf('function publicTeamButton('),source.indexOf('function refereeClaimModal(')),context);
 const card=vm.runInContext("discoveryCard({id:'t',name:'Cup',start_date:'2026-09-24'},true,'<p>Event A: 2 CẶP</p>')",context);
 assert.match(card,/ĐANG DIỄN RA/);assert.match(card,/Event A: 2 CẶP/);assert.match(card,/XEM GIẢI/);
 context.data={t:{},groups:[{id:'g',name:'A'}],teams,teamMap:{a:'Alpha',b:'Beta'},members:{},matches:[{...match('A01','playing',1),court_number:3,group_id:'g',stage:'group'},{...match('KO01','scheduled',1),stage:'quarterfinal'}]};
 const html=vm.runInContext("publicHubContent('matches',data)",context);
 assert.match(html,/🔴 ĐANG ĐẤU/);assert.match(html,/SẮP ĐẤU/);assert.match(html,/KO01/);assert.match(html,/Alpha/);assert.match(html,/SÂN 3/);
});
test('public summary queries are event scoped and mobile compact rules exist',()=>{
 const publicView=source.slice(source.indexOf('async function publicTournament('),source.indexOf('function publicTeamButton('));
 assert.match(publicView,/competitionClient\(supabase,activeEvent\)/);
 assert.match(publicView,/db.from\('matches'\)/);
 assert.match(publicView,/event_id:db.event.id/);
 assert.doesNotMatch(publicView,/eq\('stage','group'\)/);
 const css=fs.readFileSync(new URL('../style.css',import.meta.url),'utf8');
 assert.match(css,/@media\(max-width:600px\)\{.spectator-summary/);
 assert.match(css,/grid-template-columns:1fr auto 1fr/);
});


test('derived event state handles complete, playing, waiting, and empty events',()=>{
 assert.equal(eventState([match('A01','completed',1)]),'✓ ĐÃ HOÀN THÀNH');
 assert.equal(eventState([match('A01','completed',1),match('A02','playing',2)]),'🟢 ĐANG DIỄN RA');
 assert.equal(eventState([match('A01','completed',1),match('A02','scheduled',2)]),'');
 assert.equal(eventState([]),'');
});
test('overview keeps player stats without repeating the tournament hero',()=>{
 const context=vm.createContext({esc:s=>String(s??'')});
 vm.runInContext(source.slice(source.indexOf('function publicHubContent('),source.indexOf('function refereeClaimModal(')),context);
 context.data={t:{name:'Duplicate tournament',start_date:'2026-09-24'},groups:[],teams:[],matches:[],members:{},registeredPlayers:16};
 const html=vm.runInContext("publicHubContent('overview',data)",context);
 assert.match(html,/<strong>16<\/strong><span>VĐV/);
 assert.doesNotMatch(html,/Duplicate tournament|24\/09\/2026|<h2|public-hub-kicker/);
});
test('single-event public view hides event navigation and context',()=>{
 const context=vm.createContext({tournamentEvents:[{id:'one'}],activeEvent:{id:'one'},esc:s=>s});
 vm.runInContext(source.slice(source.indexOf('function publicEventSelector('),source.indexOf('function competitionEventCards(')),context);
 assert.equal(vm.runInContext('publicEventSelector()',context),'');
 context.tournamentEvents.push({id:'two',name:'Event Two'});
 assert.match(vm.runInContext('publicEventSelector()',context),/Event Two/);
 const publicView=source.slice(source.indexOf('async function publicTournament('),source.indexOf('function publicTeamButton('));
 assert.match(publicView,/tournamentEvents.length>1\?`<div class="event-context">/);
});
