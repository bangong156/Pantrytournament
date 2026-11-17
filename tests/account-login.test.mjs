import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeUsername,usernameEmail,loginEmail,accountLogin} from '../account-login.js';
test('creation and login map the same normalized username to one account',()=>{
 for(const name of ['Pantry123','lan.lan','BTC_01','team-a']){
  assert.equal(loginEmail(' '+name.toUpperCase()+' '),usernameEmail(name));
  assert.equal(accountLogin(usernameEmail(name)),normalizeUsername(name));
 }
});
test('reject invalid names before attempting auth or account creation',()=>{
 for(const name of ['', 'ab','a'.repeat(41),'lan lan','lân','foo@example.com','<admin>','a/b'])assert.throws(()=>usernameEmail(name));
});
test('existing email accounts retain login and visible account identifier',()=>{
 assert.equal(loginEmail(' owner@example.com '),'owner@example.com');
 assert.equal(accountLogin('owner@example.com'),'owner@example.com');
});
