import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../netlify/functions/video-create.js';
import {VideoError,secretBox,matchesToken} from '../server/video-security.js';

const id='11111111-1111-4111-8111-111111111111';
function fixture(){
  let row,creates=0,removes=0;
  const match={id,event_id:id,tournament_id:id};
  const repository={
    staff:async()=>id,rate:async()=>{},match:async()=>match,
    insert:async value=>(row={...value,version:0}),get:async()=>row,
    cas:async(current,patch)=>(row={...current,...patch,version:current.version+1})
  };
  const stream={create:async()=>{creates++;return {uid:'a'.repeat(32),publish:'private-publish-url',playback:'playback-url'};},remove:async()=>{removes++;}};
  const box=secretBox(Buffer.alloc(32,1).toString('base64'));
  return {repository,stream,box,handler:createHandler(()=>({repository,stream,box})),row:()=>row,creates:()=>creates,removes:()=>removes};
}
const request={httpMethod:'POST',headers:{authorization:'Bearer staff-token'},body:JSON.stringify({match_id:id,event_id:'untrusted'})};

test('creation derives ownership and stores encrypted credentials and hashed invitation',async()=>{
  const f=fixture(),response=await f.handler(request),body=JSON.parse(response.body);
  assert.equal(response.statusCode,201);
  assert.equal(f.row().event_id,id);
  assert.equal(f.row().status,'ready');
  assert.ok(matchesToken(body.invite_token,f.row().invite_hash));
  assert.deepEqual(f.box.open(f.row().credentials_ciphertext),{publish:'private-publish-url'});
  assert.deepEqual(Object.keys(body).sort(),['broadcaster_url','invite_expires_at','invite_token','session_id','status']);
  assert.equal(response.headers['Cache-Control'],'no-store');
});

test('rejects unauthorized, missing, invalid and duplicate matches before provider creation',async()=>{
  for(const [status,change] of [
    [403,f=>{f.repository.staff=async()=>{throw new VideoError(403,'Denied');};}],
    [404,f=>{f.repository.match=async()=>null;}],
    [409,f=>{f.repository.insert=async()=>{throw new VideoError(409,'Duplicate');};}]
  ]){
    const f=fixture();change(f);
    assert.equal((await f.handler(request)).statusCode,status);
    assert.equal(f.creates(),0);
  }
  const f=fixture();
  assert.equal((await f.handler({...request,headers:{}})).statusCode,401);
  assert.equal((await f.handler({...request,body:'{}'})).statusCode,400);
  assert.equal((await f.handler({...request,httpMethod:'GET'})).statusCode,405);
  assert.equal(f.creates(),0);
});

test('removes provider input when ownership changes during creation',async()=>{
  const f=fixture();let reads=0;
  f.repository.match=async()=>({id,event_id:++reads===1?id:'22222222-2222-4222-8222-222222222222',tournament_id:id});
  assert.equal((await f.handler(request)).statusCode,409);
  assert.equal(f.removes(),1);
  assert.equal(f.row().status,'ended');
});

test('retains input for cleanup if finalization and provider deletion fail',async()=>{
  const f=fixture(),cas=f.repository.cas;
  f.repository.cas=async(row,patch)=>{if(patch.status==='ready')throw Error('database unavailable');return cas(row,patch);};
  f.stream.remove=async()=>{throw Error('provider unavailable');};
  assert.equal((await f.handler(request)).statusCode,503);
  assert.equal(f.row().status,'stopping');
  assert.equal(f.row().input_uid,'a'.repeat(32));
});
