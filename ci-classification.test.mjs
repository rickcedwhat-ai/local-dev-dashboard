import {test} from 'node:test';import assert from 'node:assert/strict';
import {classifyChecks,aggregateCi} from './ci-classification.mjs';
const gate={name:'enable-automerge',status:'completed',conclusion:'failure'};
test('REST and GraphQL automerge-only failures have a distinct state',()=>{
 assert.equal(classifyChecks('success',[gate,{name:'Tests',conclusion:'success'}]),'automerge-blocked');
 assert.equal(classifyChecks(null,[{...gate,conclusion:'FAILURE'}],'FAILURE'),'automerge-blocked');
});
test('real failures, unknown failures and timeouts remain failing',()=>{
 assert.equal(classifyChecks(null,[gate,{name:'Tests',conclusion:'failure'}],'FAILURE'),'failing');
 assert.equal(classifyChecks('error',[gate]),'failing');
 assert.equal(classifyChecks(null,[{...gate,conclusion:'timed_out'}]),'failing');
 assert.equal(classifyChecks(null,[{...gate,name:'Other job'}]),'failing');
 assert.equal(classifyChecks(null,[],'FAILURE'),'failing');
});
test('unfinished tests remain running and aggregate priority preserves real failures',()=>{
 assert.equal(classifyChecks(null,[gate,{name:'Tests',status:'IN_PROGRESS'}],'FAILURE'),'running');
 assert.equal(aggregateCi(['passing','automerge-blocked']),'automerge-blocked');
 assert.equal(aggregateCi(['running','automerge-blocked']),'running');
 assert.equal(aggregateCi(['failing','automerge-blocked']),'failing');
});
