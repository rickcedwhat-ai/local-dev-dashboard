import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PrCardLookup} from './pr-card-lookup.mjs';
import './public/pr-card-shared.js';
const projects=[{id:'p',repo:'https://github.com/owner/repo'}];
test('exact PR lookup distinguishes merged/closed, coalesces reads and expires cached state',async()=>{
 let now=1000,calls=0,merged=false;
 const lookup=new PrCardLookup({now:()=>now,ttl:30,fetchPull:async(repo,number)=>{calls++;return {number,html_url:`https://github.com/${repo}/pull/${number}`,title:'Actual title',state:'closed',merged_at:merged?'2026-10-19T14:00:00Z':null};}});
 const results=await Promise.all([lookup.get('owner/repo',114,projects),lookup.get('owner/repo',114,projects)]);
 assert.equal(calls,1);assert.equal(results[0].pr.state,'closed');
 merged=true;now+=31;assert.equal((await lookup.get('owner/repo',114,projects)).pr.state,'merged');assert.equal(calls,2);
 await assert.rejects(lookup.get('other/repo',114,projects),/not registered/);assert.equal(calls,2);
});
test('lookup rejects mismatched identities and does not cache failures',async()=>{
 let calls=0;const lookup=new PrCardLookup({fetchPull:async()=>{calls++;return {number:115,html_url:'https://github.com/owner/repo/pull/115'};}});
 for(let i=0;i<2;i++)await assert.rejects(lookup.get('owner/repo',114,projects),/different PR/);
 assert.equal(calls,2);
});
test('dashboard and widget share human-review gating and terminal display rules',()=>{
 const ui=globalThis.DashboardPrUI;
 const pr={mergeBlock:'review',ci:'passing',cr:{state:'clear'}};
 assert.equal(ui.prPresentation(pr).mergeBlock.label,'Needs your review');
 assert.equal(ui.prPresentation({...pr,ci:'running'}).mergeBlock,null);
 assert.equal(ui.prPresentation({...pr,ci:'running'},{quietCi:true}).mergeBlock.kind,'review');
 assert.equal(ui.prPresentation({...pr,state:'merged'}).mergeBlock,null);
 assert.equal(ui.prPresentation({...pr,state:'merged'}).lifecycle,'Merged');
 assert.equal(ui.prPresentation({...pr,state:'closed'}).lifecycle,'Closed');
});
