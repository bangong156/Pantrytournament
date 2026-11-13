import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rankGroupRows} from '../group-ranking.js';
const row=(id,w,diff,pf=30)=>({id,w,diff,pf});
const game=(a,b,winner,status='completed')=>({team1_id:a,team2_id:b,winner_id:winner,status});
test('exactly two tied teams use head-to-head over point difference',()=>{
 assert.deepEqual(rankGroupRows([row('B',2,20),row('C',1,30),row('A',2,-5)],[game('B','A','A')]).map(r=>r.id),['A','B','C']);
});
test('win count takes precedence and unfinished head-to-head is ignored',()=>{
 assert.deepEqual(rankGroupRows([row('B',1,20),row('A',2,-5)],[game('B','A','B')]).map(r=>r.id),['A','B']);
 assert.deepEqual(rankGroupRows([row('B',2,20),row('A',2,-5)],[game('B','A','A','playing')]).map(r=>r.id),['B','A']);
});
test('three tied teams keep difference then points; no non-transitive pairwise ranking',()=>{
 assert.deepEqual(rankGroupRows([row('A',2,5,30),row('B',2,10,20),row('C',2,10,40)],[game('A','B','A'),game('B','C','B'),game('C','A','C')]).map(r=>r.id),['C','B','A']);
});
test('two-team tie applies to second/third and independent tie clusters',()=>{
 assert.deepEqual(rankGroupRows([row('A',3,0),row('B',2,20),row('C',2,0),row('D',1,20),row('E',1,0)],[game('B','C','C'),game('D','E','E')]).map(r=>r.id),['A','C','B','E','D']);
});
