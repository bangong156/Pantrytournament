import test from 'node:test';
import assert from 'node:assert/strict';
import {linkedTournament,tournamentURL,shareTournament} from '../public-links.js';
const id='11111111-1111-4111-8111-111111111111';
globalThis.location={origin:'https://pantry.test'};
test('shared tournament URLs explicitly select the public info view',()=>{
 assert.equal(tournamentURL(id),`https://pantry.test/?tournament=${id}&view=info`);
 assert.equal(linkedTournament(`?tournament=${id}`),id);
 assert.equal(linkedTournament('?tournament=bad'),null);
});
test('sharing sends tournament name and URL; unsupported browsers copy the URL',async()=>{
 let shared,copied;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{share:async data=>{shared=data},clipboard:{writeText:async text=>{copied=text}}}});
 await shareTournament(id,'Pantry Cup');
 assert.deepEqual(shared,{title:'Pantry Cup',text:'Pantry Cup',url:tournamentURL(id)});
 assert.equal(copied,undefined);
 delete navigator.share;
 assert.equal(await shareTournament(id,'Pantry Cup'),'Đã sao chép link giải');assert.equal(copied,tournamentURL(id));
 copied=undefined;navigator.share=async()=>{throw Object.assign(Error(),{name:'AbortError'})};
 assert.equal(await shareTournament(id,'Pantry Cup'),'');assert.equal(copied,undefined);
 navigator.share=async()=>{throw Error('Unavailable')};
 assert.equal(await shareTournament(id,'Pantry Cup'),'Đã sao chép link giải');assert.equal(copied,tournamentURL(id));
});

test('public info hero places a working share button immediately below match details',async()=>{
 const {readFileSync}=await import('node:fs');
 const vm=await import('node:vm');
 const source=readFileSync(new URL('../src.js',import.meta.url),'utf8');
 const nodes=new Map();const node=key=>{if(!nodes.has(key))nodes.set(key,{textContent:''});return nodes.get(key)};
 const app={innerHTML:'',querySelector:()=>null};let shared,competition;
 const location={search:`?tournament=${id}`};
 const history={replaceState(_state,_title,url){location.search=url}};
 const query={select(){return this},eq(){return this},single:async()=>({data:{id,name:'Cup',start_date:'2026-10-01',start_time:'08:00'}}),maybeSingle:async()=>({data:{content:'Tournament information',prize_information:'Prizes',rules:'Rules',registration_url:'https://pantry.test/register'}})};
 const context=vm.createContext({app,location,history,URLSearchParams,linkedTournament,renderEpoch:0,stopLive(){},supabase:{from:()=>query},posterUrl:()=>'/poster.png',registrationLink:value=>value,
 esc:value=>value||'',eventType:()=>'',eventFormat:()=>'',displayEventDate:()=>'',pantryLogoMarkup:()=>'',document:{querySelector:node},
 publicDashboard(){},publicTournament(tid){competition=tid},shareTournament:async(...args)=>{shared=args;return 'Đã sao chép link giải'}});
 vm.runInContext(source.slice(source.indexOf('async function publicTournamentInfo('),source.indexOf("async function publicTournament(tid")),context);
 // Enter INFO from a competition URL, then reload through the real boot function.
 await vm.runInContext(`publicTournamentInfo('${id}')`,context);
 assert.equal(location.search,`?tournament=${id}&view=info`);
 vm.runInContext(source.slice(source.indexOf('async function boot()'),source.indexOf('\nfunction render()')),context);
 app.innerHTML='';
 await vm.runInContext('boot()',context);
 assert.equal(competition,undefined);
 for(const text of ['poster.png','Cup','08:00','THÔNG TIN GIẢI','Tournament information','Prizes','Rules','ĐĂNG KÝ NGAY'])assert.ok(app.innerHTML.includes(text),text);
 assert.doesNotMatch(app.innerHTML,/data-public-tab|public-hub-view/);
 assert.match(app.innerHTML,/id="infoToHub">XEM CHI TIẾT THI ĐẤU →<\/button><button id="infoShare">CHIA SẺ GIẢI<\/button>/);
 await node('#infoShare').onclick();
 assert.deepEqual(shared,[id,'Cup']);assert.equal(node('#infoShareFeedback').textContent,'Đã sao chép link giải');
 await node('#infoToHub').onclick();assert.equal(competition,id);
});


test('shared links restore info without authentication; plain tournament links retain competition routing',async()=>{
 const {readFileSync}=await import('node:fs');
 const vm=await import('node:vm');
 const source=readFileSync(new URL('../src.js',import.meta.url),'utf8');
 for(const info of [true,false]){
  let opened;
  const context=vm.createContext({URLSearchParams,linkedTournament,location:{search:`?tournament=${id}${info?'&view=info':''}`},
   publicTournamentInfo:async tid=>{opened=['info',tid]},publicTournament:async tid=>{opened=['competition',tid]}});
  vm.runInContext(source.slice(source.indexOf('async function boot()'),source.indexOf('\nfunction render()')),context);
  await vm.runInContext('boot()',context);
  assert.deepEqual(opened,[info?'info':'competition',id]);
 }
});
