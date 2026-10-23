import {test} from 'node:test';
import assert from 'node:assert/strict';
import {feedbackPrompt,feedbackCandidates} from './codex-feedback.mjs';
test('prompt targets the exact PR and requests evidence and in-thread replies',()=>{
 const prompt=feedbackPrompt({repo:'https://github.com/owner/repo'},42);
 assert.match(prompt,/https:\/\/github.com\/owner\/repo\/pull\/42/);
 assert.match(prompt,/Reply in each addressed CR thread/);
 assert.match(prompt,/Do not blindly resolve threads, merge the PR, or trigger CR autofix/);
 for(const repo of ['https://evil.test/owner/repo','javascript:alert(1)'])assert.throws(()=>feedbackPrompt({repo},42));
 assert.throws(()=>feedbackPrompt({repo:'https://github.com/owner/repo'},0));
});
test('candidate selection preserves PR associations without assuming the newest chat',()=>{
 const store={list:()=>[{provider:'codex',id:'new',title:'New chat',updatedAt:'2026-10-18T12:00:00Z'},{provider:'cursor',id:'cursor'}],rows:[{provider:'codex',projectId:'p',id:'older',title:'PR owner',pr:42,updatedAt:'2026-10-18T11:00:00Z'},{provider:'codex',projectId:'other',id:'wrong',pr:42}]};
 const candidates=feedbackCandidates(store,'p',42);
 assert.deepEqual(candidates.map(c=>[c.id,c.matchesPr]),[['new',false],['older',true]]);
 assert.equal(candidates[1].openUrl,'codex://threads/older');
});
