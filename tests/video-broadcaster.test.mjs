import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness(){
  const nodes=Object.fromEntries(['video','#camera','#broadcast','#stopBroadcast','#broadcastMessage'].map(key=>[key,{play:async()=>{}}]));
  const intervals=[],requests=[],pending=[];let peer;
  class Peer{
    constructor(){peer=this;this.connectionState='new';this.iceGatheringState='complete';}
    addTransceiver(){}
    async createOffer(){return {type:'offer',sdp:'v=0'};}
    async setLocalDescription(value){this.localDescription=value;}
    async setRemoteDescription(){this.connectionState='connecting';}
  }
  const context=vm.createContext({URLSearchParams,AbortController,Date,
    location:{hash:'#session=11111111-1111-4111-8111-111111111111&token='+'a'.repeat(43)},
    window:{isSecureContext:true,RTCPeerConnection:Peer,addEventListener(){}},RTCPeerConnection:Peer,
    navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{}]})}},
    setInterval:(callback,delay)=>{intervals.push({callback,delay});return 1;},clearInterval(){},setTimeout:()=>1,clearTimeout(){},
    fetch:async(url,options)=>{
      const body=JSON.parse(options.body);requests.push(body);
      if(body.action==='heartbeat')return new Promise(resolve=>pending.push(resolve));
      return {ok:true,json:async()=>({sdp:'v=0',hard_expires_at:new Date(Date.now()+3600000).toISOString()})};
    },app:{querySelector:key=>nodes[key]}
  });
  vm.runInContext(fs.readFileSync(new URL('../video-ui.js',import.meta.url),'utf8').replace(/^import .*\n/gm,'').replace(/export /g,''),context);
  vm.runInContext('renderBroadcaster(app)',context);
  return {nodes,intervals,requests,
    async start(){await nodes['#camera'].onclick();await nodes['#broadcast'].onclick();},
    transition(state){peer.connectionState=state;peer.onconnectionstatechange();},
    reply(status=200){pending.shift()({ok:status===200,status,json:async()=>status===200?{lease_expires_at:new Date(Date.now()+60000).toISOString()}:{error:'Heartbeat failed'}});},
    message:()=>nodes['#broadcastMessage'].textContent
  };
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('connected callback sends heartbeat immediately and waits for acknowledgement before LIVE',async()=>{
  const h=harness();await h.start();
  assert.deepEqual(h.requests.map(r=>r.action),['start']);
  h.transition('connected');
  assert.deepEqual(h.requests.map(r=>r.action),['start','heartbeat']);
  assert.equal(h.requests[1].session_id,h.requests[0].session_id);
  assert.equal(h.message(),'Đang kết nối LIVE…');
  h.transition('connected');
  assert.equal(h.requests.length,2,'pending heartbeat is not duplicated');
  h.reply();await settle();
  assert.equal(h.message(),'● Đang LIVE');
  assert.equal(h.intervals.length,1);
  assert.equal(h.intervals[0].delay,15000);
  const renewal=h.intervals[0].callback();
  assert.equal(h.requests[2].action,'heartbeat');
  h.reply();await renewal;
  assert.equal(h.message(),'● Đang LIVE');
});

test('failed startup heartbeat never announces LIVE and the existing interval retries',async()=>{
  const h=harness();await h.start();h.transition('connected');
  h.reply(503);await settle();
  assert.equal(h.message(),'Không gửi được tín hiệu LIVE. Đang thử lại…');
  const retry=h.intervals[0].callback();
  assert.notEqual(h.message(),'● Đang LIVE');
  h.reply();await retry;
  assert.equal(h.message(),'● Đang LIVE');
});

test('heartbeat acknowledgement after disconnect does not overwrite disconnected status with LIVE',async()=>{
  const h=harness();await h.start();h.transition('connected');h.transition('disconnected');
  h.reply();await settle();
  assert.equal(h.message(),'Mạng gián đoạn. Đang chờ kết nối lại…');
});
