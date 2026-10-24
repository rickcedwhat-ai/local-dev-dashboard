import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reconcileCrSummary} from './pr-cr-status.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
const context={CR_AUTHOR:/^coderabbitai(\[bot\])?$/i,rateLimitMemory:new Map()};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function isCrAuthor'),source.indexOf('function classifyCiFromCommit')),context);
const thread=resolved=>({isResolved:resolved,comments:{nodes:[{author:{login:'coderabbitai'}}]}});
test('resolved #529 threads replace the stale summary even with a pending sibling',()=>{
 const fresh=context.classifyPullRequestCr({number:529,url:'https://github.com/o/r/pull/529',reviewThreads:{nodes:[thread(true),thread(true)]}},false);
 assert.equal(fresh.state,'clear');assert.equal(fresh.actionable,0);
 const result=reconcileCrSummary({prNumber:529,state:'actionable',actionable:2,openPrs:2},[fresh,{prNumber:157,state:'pending',actionable:0}]);
 assert.equal(result.state,'clear');assert.equal(result.actionable,0);assert.equal(result.openPrs,2);
});
test('partial resolution retains only genuinely unresolved findings; missing PR data preserves summary',()=>{
 const fresh=context.classifyPullRequestCr({number:529,reviewThreads:{nodes:[thread(true),thread(false)]}},false);
 assert.equal(fresh.actionable,1);assert.equal(fresh.state,'actionable');
 const old={prNumber:529,actionable:2};assert.equal(reconcileCrSummary(old,[{prNumber:157}]),old);
 assert.equal(reconcileCrSummary(old,[fresh]).actionable,1);
});
