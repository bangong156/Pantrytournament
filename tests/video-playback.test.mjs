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
function browser(handler){
  const makeNode=()=>({children:[],textContent:'',append(child){this.children.push(child);},replaceChildren(){this.children=[];this.textContent='';}});
  const slot={...makeNode(),dataset:{publicVideo:id,videoLabel:'A01'}};
  const video={srcObject:null,play:async()=>{}};
  const nodes={'video':video,'p':makeNode(),'[data-retry]':makeNode(),'h2':makeNode(),'.x':makeNode()};
  const panel={querySelector:selector=>nodes[selector],isConnected:true};
  const overlay=makeNode();panel.parentElement=overlay;
  const host={...makeNode(),querySelector:selector=>selector==='.overlay'?overlay:panel};
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
    document:{querySelectorAll:()=>[slot],querySelector:()=>host,createElement:()=>makeNode()},
    setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},
    fetch:async(url,options={})=>{
      calls.push({url,options});
      if(url.startsWith('/.netlify/functions/video-playback?')){
        const response=await handler({httpMethod:'GET',queryStringParameters:Object.fromEntries(new URL(url,'https://pantry.test').searchParams)});
        return {ok:response.statusCode===200,json:async()=>JSON.parse(response.body)};
      }
      assert.equal(url,playback);
      return {status:201,headers:{get:()=>null},text:async()=>'v=0\r\nprovider-answer'};
    }
  });
  vm.runInContext(fs.readFileSync(new URL('../video-playback.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,''),context);
  return {slot,host,nodes,calls,peers,timers,run:code=>vm.runInContext(code,context)};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('public card opens the match-specific inline player through Cloudflare WHEP and removes LIVE after stop',async()=>{
  const f=fixture(),b=browser(f.handler);
  b.run(`mountPublicVideo({tournament_id:'${id}',event_id:'${id}'})`);await settle();
  assert.equal(b.slot.children[0].textContent,'🔴 VIDEO LIVE');
  b.slot.children[0].onclick();await settle();
  assert.match(b.host.innerHTML,/<video controls autoplay muted playsinline>/);
  assert.equal(b.nodes.h2.textContent,'Video LIVE · A01');
  assert.ok(b.calls.some(call=>call.url.includes('match_id='+id)));
  const whep=b.calls.find(call=>call.url===playback);
  assert.equal(whep.options.method,'POST');
  assert.equal(whep.options.headers['Content-Type'],'application/sdp');
  assert.equal(b.peers[0].remoteDescription.sdp,'v=0\r\nprovider-answer');
  f.row.status='ended';
  await b.timers[0]();
  assert.equal(b.slot.children.length,0);
  assert.equal(b.slot.textContent,'Video ngoại tuyến / đã kết thúc');
  b.run('stopPublicVideo()');
  assert.equal(b.peers[0].closed,true);
});
