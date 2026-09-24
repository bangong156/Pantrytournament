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
    activeMatch:async()=>null,
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

function staleFixture(patch={}){
  const f=fixture();
  let old={id:'22222222-2222-4222-8222-222222222222',match_id:id,status:'live',version:4,input_uid:'b'.repeat(32),
    lease_expires_at:new Date(Date.now()-1000).toISOString(),hard_expires_at:new Date(Date.now()+3600000).toISOString(),
    credentials_ciphertext:'private',playback_url:'old-url',...patch};
  const steps=[],cas=f.repository.cas,insert=f.repository.insert;
  f.repository.activeMatch=async matchId=>{assert.equal(matchId,id);return old.status==='ended'?null:{...old};};
  f.repository.cas=async(current,change)=>{
    if(current.id!==old.id)return cas(current,change);
    if(current.version!==old.version||current.status!==old.status)return null;
    steps.push(change.status);old={...old,...change,version:old.version+1};return {...old};
  };
  f.repository.insert=async value=>{assert.equal(old.status,'ended');steps.push('insert');return insert(value);};
  f.stream.remove=async uid=>{assert.equal(uid,old.input_uid);assert.equal(old.status,'stopping');steps.push('delete');};
  return {...f,old:()=>old,steps,renew:()=>{old={...old,version:old.version+1,lease_expires_at:new Date(Date.now()+60000).toISOString()};}};
}

test('expires stale sessions for the requested match before replacement, deleting known inputs first',async()=>{
  const past=new Date(Date.now()-1000).toISOString();
  for(const patch of [ {},{status:'connecting'}, {status:'ready',invite_expires_at:past},
    {status:'creating',cleanup_after:past,input_uid:null},{status:'publishing',cleanup_after:past},
    {status:'stopping',cleanup_after:past},{lease_expires_at:new Date(Date.now()+60000).toISOString(),hard_expires_at:past}]){
    const f=staleFixture(patch);
    assert.equal((await f.handler(request)).statusCode,201);
    assert.deepEqual(f.steps,patch.input_uid===null?['stopping','ended','insert']:['stopping','delete','ended','insert']);
    assert.equal(f.old().credentials_ciphertext,null);
    assert.equal(f.old().playback_url,null);
  }
});

test('does not replace unexpired sessions or delete a session renewed during cleanup',async()=>{
  const future=new Date(Date.now()+60000).toISOString();
  for(const patch of [{lease_expires_at:future},{status:'ready',invite_expires_at:future},
    {status:'creating',cleanup_after:future},{status:'publishing',cleanup_after:future}]){
    const f=staleFixture(patch);
    assert.equal((await f.handler(request)).statusCode,409);
    assert.deepEqual(f.steps,[]);assert.equal(f.creates(),0);
  }
  const f=staleFixture(),read=f.repository.activeMatch;
  f.repository.activeMatch=async matchId=>{const row=await read(matchId);f.renew();return row;};
  assert.equal((await f.handler(request)).statusCode,409);
  assert.deepEqual(f.steps,[]);assert.equal(f.creates(),0);
});

test('failed deletion retains the slot and can be retried on the next creation attempt',async()=>{
  const f=staleFixture(),remove=f.stream.remove;
  f.stream.remove=async()=>{throw Error('provider unavailable');};
  assert.equal((await f.handler(request)).statusCode,503);
  assert.equal(f.old().status,'stopping');assert.equal(f.creates(),0);
  f.stream.remove=remove;
  assert.equal((await f.handler(request)).statusCode,201);
});

test('failed cleanup finalization never creates a replacement',async()=>{
  const f=staleFixture(),cas=f.repository.cas;
  f.repository.cas=async(row,patch)=>patch.status==='ended'?null:cas(row,patch);
  assert.equal((await f.handler(request)).statusCode,409);
  assert.equal(f.old().status,'stopping');assert.equal(f.creates(),0);
});
