import test from 'node:test';import assert from 'node:assert/strict';import {createArenaHandler,hashToken,pkceChallenge} from '../server/arena-access.js';
function fixture(){
 const tables={profiles:[{id:'u',role:'admin'}],organizer_accounts:[],arena_access_codes:[],arena_access_sessions:[]};let banned=false,seq=0;
 const server={auth:{getUser:async token=>token==='good'?{data:{user:{id:'u'}}}:{error:Error('bad')},admin:{getUserById:async()=>({data:{user:{id:'u',banned_until:banned?'2099-01-01':null}}})}},from(name){let filters=[],operation='select',payload,head=false;const table=tables[name];const q={select(_,opts){head=opts?.head;return q},insert(v){operation='insert';payload=v;return q},delete(){operation='delete';return q},eq(k,v){filters.push(x=>x[k]===v);return q},gt(k,v){filters.push(x=>x[k]>v);return q},lte(k,v){filters.push(x=>x[k]<=v);return q},maybeSingle(){return q.then(r=>({...r,data:r.data?.[0]||null}))},then(resolve){if(operation==='insert'){table.push({...payload,created_at:new Date(1000000).toISOString()});return Promise.resolve({error:null,data:null}).then(resolve)}const rows=table.filter(x=>filters.every(f=>f(x)));if(operation==='delete')tables[name]=table.filter(x=>!rows.includes(x));return Promise.resolve({error:null,data:head?null:rows,count:rows.length}).then(resolve)}};return q}};
 const handler=createArenaHandler({makeServer:()=>server,now:()=>1000000,random:()=>String(++seq).padStart(43,'A')});
 const call=async(body,headers={})=>{const r=await handler({httpMethod:'POST',body:JSON.stringify(body),headers});return{status:r.statusCode,...JSON.parse(r.body)}};
 return {tables,call,ban:()=>{banned=true}};
}
test('authorization requires valid source identity and current creation rights',async()=>{
 const f=fixture(),challenge=pkceChallenge('V'.repeat(43));
 assert.equal((await f.call({action:'authorize',challenge})).status,403);
 assert.equal((await f.call({action:'authorize',challenge},{origin:'https://giaipantry.com'})).status,401);
 assert.equal((await f.call({action:'authorize',challenge},{origin:'https://giaipantry.com',authorization:'Bearer bad'})).status,401);
 f.tables.profiles[0].role='organizer';
 assert.equal((await f.call({action:'authorize',challenge},{origin:'https://giaipantry.com',authorization:'Bearer good'})).status,403);
});
test('wrong PKCE cannot consume code, right PKCE redeems exactly once; revoked accounts lose sessions',async()=>{
 const f=fixture(),verifier='V'.repeat(43),challenge=pkceChallenge(verifier);
 const grant=await f.call({action:'authorize',challenge},{origin:'https://giaipantry.com',authorization:'Bearer good'});assert.equal(grant.status,200);assert.equal(f.tables.arena_access_codes[0].code_hash,hashToken(grant.code));assert(!JSON.stringify(f.tables).includes(grant.code));
 assert.equal((await f.call({action:'redeem',code:grant.code,verifier:'W'.repeat(43)})).status,401);
 const session=await f.call({action:'redeem',code:grant.code,verifier});assert.equal(session.status,200);
 assert.equal((await f.call({action:'redeem',code:grant.code,verifier})).status,401);
 assert.equal((await f.call({action:'session',token:session.token})).status,200);
 f.tables.profiles[0].role='spectator';assert.equal((await f.call({action:'session',token:session.token})).status,401);
});
test('expired codes and banned identities cannot create sessions',async()=>{
 const f=fixture(),verifier='V'.repeat(43),challenge=pkceChallenge(verifier);
 let grant=await f.call({action:'authorize',challenge},{origin:'https://giaipantry.com',authorization:'Bearer good'});f.tables.arena_access_codes[0].expires_at=new Date(999999).toISOString();assert.equal((await f.call({action:'redeem',code:grant.code,verifier})).status,401);
 grant=await f.call({action:'authorize',challenge},{origin:'https://giaipantry.com',authorization:'Bearer good'});f.ban();assert.equal((await f.call({action:'redeem',code:grant.code,verifier})).status,403);
});
