import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../quick-roundrobin.js',import.meta.url),'utf8');
const ctx=vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function shuffle('),source.indexOf('function generate(')).replace(/\$\('rrMode'\)\.onchange=renderMode;[\s\S]*$/,''),ctx);
test('Fixpair schedules every pair once with no simultaneous double booking, 2–32 teams',()=>{
 for(let n=2;n<=32;n++){
  const games=ctx.scheduleFixed(Array.from({length:n}));
  assert.equal(games.length,n*(n-1)/2);
  const seen=new Set(),rounds=new Map();
  for(const m of games){
   assert.equal(m.a.length,1);assert.equal(m.b.length,1);
   const [a,b]=[m.a[0],m.b[0]].sort((a,b)=>a-b),key=a+':'+b;
   assert.ok(!seen.has(key));seen.add(key);
   const busy=rounds.get(m.round)||new Set();assert.ok(!busy.has(a)&&!busy.has(b));busy.add(a);busy.add(b);rounds.set(m.round,busy);
  }
 }
});
test('Fixpair requires two athletes and defaults blank team name to their names',()=>{
 const makeRow=(name,a,b)=>({querySelector:sel=>({value:({'[data-team-name]':name,'[data-player-one]':a,'[data-player-two]':b})[sel]})});
 let rows=[makeRow('','Lân','Thịnh'),makeRow('Pantry','A','B')];ctx.$=()=>({children:rows});
 assert.equal(ctx.readFixedTeams()[0].name,'Lân - Thịnh');assert.equal(ctx.readFixedTeams()[1].name,'Pantry');
 rows=[makeRow('','A',''),makeRow('','B','C')];assert.throws(()=>ctx.readFixedTeams(),/2 VĐV/);
});
