import test from 'node:test';
import assert from 'node:assert/strict';
import {linkedTournament,tournamentURL,shareTournament} from '../public-links.js';
const id='11111111-1111-4111-8111-111111111111';
globalThis.location={origin:'https://pantry.test'};
test('tournament URLs contain only the public UUID',()=>{
 assert.equal(tournamentURL(id),`https://pantry.test/?tournament=${id}`);
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
 const app={innerHTML:'',querySelector:()=>null};let shared;
 const query={select(){return this},eq(){return this},single:async()=>({data:{id,name:'Cup'}}),maybeSingle:async()=>({data:{}})};
 const context=vm.createContext({app,renderEpoch:0,stopLive(){},supabase:{from:()=>query},posterUrl:()=>null,registrationLink:()=>null,
 esc:value=>value||'',eventType:()=>'',eventFormat:()=>'',displayEventDate:()=>'',pantryLogoMarkup:()=>'',document:{querySelector:node},
 publicDashboard(){},publicTournament(){},shareTournament:async(...args)=>{shared=args;return 'Đã sao chép link giải'}});
 vm.runInContext(source.slice(source.indexOf('async function publicTournamentInfo('),source.indexOf("async function publicTournament(tid")),context);
 await vm.runInContext(`publicTournamentInfo('${id}')`,context);
 assert.match(app.innerHTML,/id="infoToHub">XEM CHI TIẾT THI ĐẤU →<\/button><button id="infoShare">CHIA SẺ GIẢI<\/button>/);
 await node('#infoShare').onclick();
 assert.deepEqual(shared,[id,'Cup']);assert.equal(node('#infoShareFeedback').textContent,'Đã sao chép link giải');
});
