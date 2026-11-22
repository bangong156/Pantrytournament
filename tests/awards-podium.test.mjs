import assert from 'node:assert/strict';
import {test} from 'node:test';
import {knockoutPodium} from '../awards-podium.js';

const teams = ['A','B','C','D'].map(id => ({id,name:id}));
const match = (stage, team1_id, team2_id, winner_id, match_code = stage) =>
  ({stage, team1_id, team2_id, winner_id, match_code, status:'completed'});
const bracket = [match('semifinal','A','C','A','SF-1'),match('semifinal','B','D','B','SF-2'),match('final','A','B','B')];

test('completed bracket supplies champion, runner-up and both semifinal losers', () => {
  assert.deepEqual(knockoutPodium(bracket, teams, {B:['An','Bình']}).map(a=>[a.placement,a.placement_slot,a.team_id,a.player_names]), [[1,1,'B','An\nBình'],[2,1,'A',''],[3,1,'C',''],[3,2,'D','']]);
  assert.deepEqual(knockoutPodium([...bracket,match('third_place','C','D','D')],teams).map(a=>a.team_id),['B','A','D']);
});

test('an unfinished match or missing winner suppresses the automatic podium', () => {
  for (const partial of [{status:'playing'},{winner_id:null}]) {
    assert.deepEqual(knockoutPodium([...bracket.slice(0,2),{...bracket[2],...partial}],teams),[]);
  }
});
