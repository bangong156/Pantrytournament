import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHandler} from '../netlify/functions/video-playback.js';

const id='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
const playback='https://customer-test.cloudflarestream.com/input/webRTC/play';
const request={httpMethod:'GET',queryStringParameters:{tournament_id:id,event_id:id}};
function fixture(patch={}){
  const row={id,match_id:id,event_id:id,tournament_id:id,status:'live',input_uid:'a'.repeat(32),
    lease_expires_at:new Date(Date.now()+60000).toISOString(),hard_expires_at:new Date(Date.now()+3600000).toISOString(),
    playback_url:playback,invite_hash:'private',credentials_ciphertext:'private',...patch};
  const repository={eventRows:async()=>[row],get:async()=>row,match:async()=>({id,event_id:id,tournament_id:id})};
  // A provider returning inactive must not veto a connected WHIP heartbeat.
  const handler=createHandler(()=>({repository,stream:{active:async()=>false}}));
  return {row,repository,handler};
}

test('live heartbeat exposes the match and its existing WHEP URL without publishing secrets',async()=>{
  const {handler}=fixture();
  const list=await handler(request);
  assert.equal(list.statusCode,200);
  assert.equal(list.headers['Cache-Control'],'no-store');
  assert.deepEqual(JSON.parse(list.body),{streams:[{match_id:id,session_id:id}]});
  const detail=await handler({...request,queryStringParameters:{...request.queryStringParameters,match_id:id}});
  assert.deepEqual(JSON.parse(detail.body),{streams:[{match_id:id,session_id:id,playback_url:playback}]});
});

test('unstarted, offline, ended and expired sessions are hidden',async()=>{
  for(const patch of [
    ...['creating','ready','publishing','connecting','stopping','ended'].map(status=>({status})),
    {lease_expires_at:new Date(Date.now()-1).toISOString()},
    {hard_expires_at:new Date(Date.now()-1).toISOString()},
    {lease_expires_at:null},{tournament_id:other},{match_id:other}
  ]){
    const {handler}=fixture(patch);
    const response=await handler({...request,queryStringParameters:{...request.queryStringParameters,match_id:id}});
    assert.equal(response.statusCode,200);
    assert.deepEqual(JSON.parse(response.body),{streams:[]},JSON.stringify(patch));
  }
});

test('rechecks stop, expiry, input replacement and match ownership before exposing playback',async()=>{
  for(const patch of [{status:'ended'},{lease_expires_at:null},{hard_expires_at:null},{input_uid:'b'.repeat(32)}]){
    const f=fixture();f.repository.get=async()=>({...f.row,...patch});
    assert.deepEqual(JSON.parse((await f.handler(request)).body),{streams:[]});
  }
  const f=fixture();f.repository.match=async()=>({id,event_id:other,tournament_id:id});
  assert.deepEqual(JSON.parse((await f.handler(request)).body),{streams:[]});
  assert.equal((await f.handler({...request,queryStringParameters:{...request.queryStringParameters,match_id:id}})).statusCode,404);
});

// Run the real browser module with a small DOM/WebRTC harness, without a camera or network.
function browser(handler,intercept=()=>undefined){
  const makeNode=()=>({children:[],textContent:'',append(child){this.children.push(child);},replaceChildren(){this.children=[];this.textContent='';}});
  const slot={...makeNode(),dataset:{publicVideo:id,videoLabel:'A01'}};
  const video={srcObject:null,play:async()=>{}};
  const nodes={'video':video,'p':makeNode(),'[data-retry]':makeNode(),'h2':makeNode(),'.x':makeNode()};
  const panel={querySelector:selector=>nodes[selector],isConnected:true};
  const overlay=makeNode();panel.parentElement=overlay;
  const host={...makeNode(),querySelector:selector=>selector==='.overlay'?overlay:panel};
  const liveCount=makeNode(),state={...makeNode(),dataset:{matchState:id,baseStatus:'SẮP ĐẤU'} };
  const homeCards=makeNode(),homeSection={hidden:true,querySelector:()=>homeCards};
  const calls=[],peers=[],timers=[];
  class Peer{
    constructor(){peers.push(this);this.transceivers=[];}
    addTransceiver(kind,options){this.transceivers.push([kind,options]);}
    async createOffer(){return {type:'offer',sdp:'v=0\r\nviewer-offer'};}
    async setLocalDescription(value){this.localDescription=value;}
    async setRemoteDescription(value){this.remoteDescription=value;}
    close(){this.closed=true;}
  }
  const context=vm.createContext({URLSearchParams,URL,AbortController,Map,RTCPeerConnection:Peer,
    MediaStream:class{getTracks(){return [];}addTrack(){}},
    window:{RTCPeerConnection:Peer,addEventListener(){},removeEventListener(){}},
    document:{querySelectorAll:selector=>selector==='[data-match-state]'?[state]:[slot],querySelector:selector=>selector==='[data-live-count]'?liveCount:selector==='#homepageLive'?homeSection:host,createElement:()=>makeNode()},
    setTimeout:(fn,delay)=>{timers.push({fn,delay,active:true});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].active=false;},
    fetch:async(url,options={})=>{
      calls.push({url,options});
      const intercepted=intercept(url,options);if(intercepted!==undefined)return intercepted;
      if(url.startsWith('/.netlify/functions/video-playback?')){
        const response=await handler({httpMethod:'GET',queryStringParameters:Object.fromEntries(new URL(url,'https://pantry.test').searchParams)});
        return {ok:response.statusCode===200,json:async()=>JSON.parse(response.body)};
      }
      assert.equal(url,playback);
      return {status:201,headers:{get:()=>null},text:async()=>'v=0\r\nprovider-answer'};
    }
  });
  vm.runInContext(fs.readFileSync(new URL('../video-playback.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,''),context);
  return {slot,host,nodes,calls,peers,timers,homeCards,homeSection,liveCount,state,
    tick:delay=>{const timer=timers.find(t=>t.active&&t.delay===delay);assert.ok(timer,'expected pending timer');timer.active=false;return timer.fn();},
    run:code=>vm.runInContext(code,context)};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('public card opens the match-specific inline player through Cloudflare WHEP and removes LIVE after stop',async()=>{
  const f=fixture(),b=browser(f.handler);
  b.run(`mountPublicVideo({tournament_id:'${id}',event_id:'${id}'})`);await settle();
  assert.equal(b.slot.children[0].textContent,'XEM LIVE');
  assert.equal(b.liveCount.textContent,' • 🔴 1 LIVE');
  assert.equal(b.state.textContent,'🔴 ĐANG ĐẤU');
  b.slot.children[0].onclick();await settle();
  assert.match(b.host.innerHTML,/<video controls autoplay muted playsinline>/);
  assert.equal(b.nodes.h2.textContent,'Video LIVE · A01');
  assert.ok(b.calls.some(call=>call.url.includes('match_id='+id)));
  const whep=b.calls.find(call=>call.url===playback);
  assert.equal(whep.options.method,'POST');
  assert.equal(whep.options.headers['Content-Type'],'application/sdp');
  assert.equal(b.peers[0].remoteDescription.sdp,'v=0\r\nprovider-answer');
  f.row.status='ended';
  await b.tick(10000);
  assert.equal(b.slot.children.length,0);
  assert.equal(b.slot.textContent,'');
  assert.equal(b.liveCount.textContent,' • 0 LIVE');
  assert.equal(b.state.textContent,'SẮP ĐẤU');
  b.run('stopPublicVideo()');
  assert.equal(b.peers[0].closed,true);
});

function stalled(signal){
  return new Promise((resolve,reject)=>{
    if(signal.aborted)reject(new Error('Request aborted'));
    else signal.addEventListener('abort',()=>reject(new Error('Request aborted')),{once:true});
  });
}

test('discovery timeout clears the old LIVE button and normal polling recovers',async()=>{
  let hang=false;
  const f=fixture(),b=browser(f.handler,(url,{signal})=>hang?stalled(signal):undefined);
  b.run(`mountPublicVideo({tournament_id:'${id}',event_id:'${id}'})`);await settle();
  assert.equal(b.slot.children[0].textContent,'XEM LIVE');
  assert.equal(b.liveCount.textContent,' • 🔴 1 LIVE');
  assert.equal(b.state.textContent,'🔴 ĐANG ĐẤU');
  hang=true;const refresh=b.tick(10000);await settle();b.tick(12000);await refresh;
  assert.equal(b.slot.textContent,'Chưa xác định trạng thái video');
  hang=false;await b.tick(10000);
  assert.equal(b.slot.children[0].textContent,'XEM LIVE');
  assert.equal(b.liveCount.textContent,' • 🔴 1 LIVE');
  assert.equal(b.state.textContent,'🔴 ĐANG ĐẤU');
  b.run('stopPublicVideo()');
});

test('WHEP header and body timeouts release the player and enable retry',async()=>{
  for(const phase of ['headers','body']){
    let hang=true;
    const f=fixture(),b=browser(f.handler,(url,{signal})=>{
      if(url!==playback||!hang)return;
      if(phase==='headers')return stalled(signal);
      return {status:201,headers:{get:()=>null},text:()=>stalled(signal)};
    });
    b.run(`mountPublicVideo({tournament_id:'${id}',event_id:'${id}'})`);await settle();
    b.slot.children[0].onclick();await settle();
    assert.equal(b.nodes['[data-retry]'].disabled,true);
    b.tick(12000);await settle();
    assert.equal(b.peers[0].closed,true);
    assert.equal(b.nodes.video.srcObject,null);
    assert.equal(b.nodes['[data-retry]'].disabled,false);
    hang=false;b.nodes['[data-retry]'].onclick();await settle();
    assert.equal(b.peers[1].remoteDescription.sdp,'v=0\r\nprovider-answer');
    assert.equal(b.nodes['[data-retry]'].disabled,false);
    b.run('stopPublicVideo()');
  }
});

test('closing the viewer aborts a pending WHEP request and does not restart polling',async()=>{
  const f=fixture(),b=browser(f.handler,(url,{signal})=>url===playback?stalled(signal):undefined);
  b.run(`mountPublicVideo({tournament_id:'${id}',event_id:'${id}'})`);await settle();
  b.slot.children[0].onclick();await settle();
  b.run('stopPublicVideo()');await settle();
  assert.equal(b.peers[0].closed,true);
  assert.equal(b.timers.some(t=>t.active),false);
});

test('homepage discovery supports multiple matches, filters expiry, and returns only public fields',async()=>{
 const f=fixture();
 const second={...f.row,id:other,match_id:other};
 f.repository.liveRows=async()=>[f.row,second,{...f.row,status:'ready'},{...f.row,lease_expires_at:new Date(0).toISOString()}];
 f.repository.get=async key=>key===other?second:f.row;
 f.repository.match=async key=>({id:key,event_id:id,tournament_id:id});
 f.repository.publicMatchDetails=async()=>({tournament_name:'Cup',event_name:'Doubles',match_code:'A01',team_a:'A',team_b:'B'});
 const result=await f.handler({httpMethod:'GET',queryStringParameters:{homepage:'1'}});
 assert.equal(result.statusCode,200);
 const streams=JSON.parse(result.body).streams;
 assert.equal(streams.length,2);
 assert.deepEqual(Object.keys(streams[0]).sort(),['event_id','event_name','match_code','match_id','session_id','team_a','team_b','tournament_id','tournament_name']);
 f.repository.get=async()=>({...f.row,status:'ended'});
 assert.deepEqual(JSON.parse((await f.handler({httpMethod:'GET',queryStringParameters:{homepage:'1'}})).body),{streams:[]});
});


test('homepage cards open the existing WHEP player and disappear when discovery empties',async()=>{
 const f=fixture();let streams=[];
 const b=browser(f.handler,url=>url.includes('homepage=1')?{ok:true,json:async()=>({streams})}:undefined);
 b.run('mountHomepageVideo()');await settle();
 assert.equal(b.homeSection.hidden,true);
 streams=[{tournament_id:id,event_id:id,match_id:id,tournament_name:'Cup',event_name:'Doubles',match_code:'A01',team_a:'Alpha',team_b:'Beta',court_number:3},
 {tournament_id:id,event_id:id,match_id:other,tournament_name:'Cup',event_name:'MLP',match_code:'B01',team_a:'Gamma',team_b:'Delta'}];
 await b.tick(10000);
 assert.equal(b.homeSection.hidden,false);assert.equal(b.homeCards.children.length,2);
 const card=b.homeCards.children[0];
 assert.deepEqual(card.children.map(node=>node.textContent),['● LIVE','Cup','Doubles · A01 • SÂN 3','Alpha vs Beta','XEM LIVE']);
 card.children.at(-1).onclick();await settle();
 assert.equal(b.peers[0].remoteDescription.sdp,'v=0\r\nprovider-answer');
 streams=[];await b.tick(10000);
 assert.equal(b.homeSection.hidden,true);assert.equal(b.homeCards.children.length,0);
 b.run('stopPublicVideo()');assert.equal(b.peers[0].closed,true);
 assert.equal(b.timers.some(timer=>timer.active),false);
});
