import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PrMarks} from './pr-marks.mjs';
import './public/pr-card-shared.js';
const menu=globalThis.DashboardPrUI.crMenuEntries;

test('shared PR marks persist independent fields; cleared marks cannot be resurrected by import',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pr-marks-')),file=path.join(dir,'marks.json');
 try {
   let marks=new PrMarks(file);marks.patch('p',1,{waiting:true});
   const quiet={at:new Date().toISOString(),fp:'failing'};marks.patch('p',1,{quietCi:quiet});
   marks.patch('p',1,{waiting:false});assert.deepEqual(marks.snapshot()['p#1'],{quietCi:quiet});
   marks.patch('p',1,{quietCi:null});marks=new PrMarks(file);
   marks.patch('p',1,{waiting:true},{importOnly:true});assert.ok(!marks.snapshot()['p#1']?.waiting);
   marks.patch('p',2,{waiting:true},{importOnly:true});assert.equal(marks.snapshot()['p#2'].waiting,true);
   assert.throws(()=>marks.patch('p',2,{arbitrary:true}));
   assert.throws(()=>marks.patch('p',2,{quietCr:{fp:'x',at:'invalid'}}));
   assert.throws(()=>marks.patch('p',0,{waiting:true}));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('shared CR menu honors ownership, workflow state, queue and busy restrictions',()=>{
 const actions=options=>menu(options).filter(e=>e.kind==='action'&&!e.disabled).map(e=>e.action);
 assert.ok(actions({cr:{state:'actionable',actionable:1},mine:true}).includes('autofix'));
 assert.ok(actions({cr:{state:'actionable',actionable:1},mine:false}).includes('mark-waiting'));
 assert.ok(actions({cr:{state:'actionable'},mine:false,marks:{waiting:true}}).includes('clear-waiting'));
 assert.ok(!actions({cr:{state:'clear'},mine:true}).includes('autofix'));
 assert.ok(actions({cr:{state:'limited',queuedReview:{fireAt:new Date().toISOString()}},mine:true}).includes('cancel-queue-review'));
 assert.deepEqual(actions({cr:{state:'autofixing'},mine:true}),[]);
 assert.deepEqual(actions({cr:{state:'reviewing',autofix:{phase:'reviewing'}},mine:true}),[]);
 for(const state of ['pending','ready','reviewing','actionable','leftover','delivery','limited','clear','empty']) {
   for(const mine of [true,false])assert.ok(actions({cr:{state},mine}).includes('open-pr'));
 }
});
