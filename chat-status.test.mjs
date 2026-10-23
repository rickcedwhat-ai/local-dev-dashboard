import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lifecycleStatus, readLifecycleStatus, activityStatus } from './chat-status.mjs';
const now = Date.now();
const event = (type, age = 0, extra = {}) => JSON.stringify({ timestamp: new Date(now-age).toISOString(), type:'event_msg', payload:{type, turn_id:'t', ...extra} });
const item = (type, extra = {}) => JSON.stringify({ timestamp:new Date(now).toISOString(), type:'response_item', payload:{type,...extra} });

test('turn lifecycle separates active, finished, interrupted and stale chats',()=>{
  assert.equal(lifecycleStatus([event('task_started')],now).state,'working');
  assert.equal(lifecycleStatus([event('task_started'),event('task_complete')],now).state,'idle');
  assert.equal(lifecycleStatus([event('task_complete'),event('task_started')],now).state,'working');
  assert.equal(lifecycleStatus([event('task_started'),event('turn_aborted')],now).state,'paused');
  assert.equal(lifecycleStatus([event('task_started',180000)],now).state,'unknown');
  assert.equal(lifecycleStatus(['bad json'],now).state,'unknown');
});
test('blocking user input/approval differs from async questions and resolved prompts',()=>{
  const start=event('task_started');
  const ask=item('function_call',{name:'functions.request_user_input',call_id:'q'});
  assert.equal(lifecycleStatus([start,ask],now).reason,'input');
  assert.equal(lifecycleStatus([start,ask,item('function_call_output',{call_id:'q'})],now).state,'working');
  assert.equal(lifecycleStatus([start,item('function_call',{name:'functions.request_user_input_async',call_id:'q'})],now).state,'waiting');
  assert.equal(lifecycleStatus([start,item('function_call',{name:'functions.request_permissions',call_id:'q'})],now).reason,'approval');
  assert.equal(lifecycleStatus([start,ask,event('task_complete')],now).state,'idle');
});
test('bounded file tail handles incomplete lines and refreshes after append',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-status-'));const file=path.join(dir,'session.jsonl');
 try {
   fs.writeFileSync(file,'x'.repeat(70000)+'\n'+event('task_started')+'\n');
   assert.equal(readLifecycleStatus(file,now).state,'working');
   fs.appendFileSync(file,event('task_complete')+'\n');
   assert.equal(readLifecycleStatus(file,now).state,'idle');
   assert.equal(readLifecycleStatus(file+'missing',now).state,'unknown');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('editor-neutral reports expire instead of remaining working forever',()=>{
 const row={updatedAt:new Date(now).toISOString(),phase:'start'};
 assert.equal(activityStatus(row,now).state,'working');
 assert.equal(activityStatus({...row,chatStatus:'waiting'},now).state,'waiting');
 assert.equal(activityStatus({...row,phase:'finish'},now).state,'idle');
 assert.equal(activityStatus(row,now+46*60000).state,'unknown');
});

test('async question stays pending after completion until a user message arrives',()=>{
 const ask=item('function_call',{name:'functions.request_user_input_async',call_id:'q'});
 const output=item('function_call_output',{call_id:'q'});
 const waiting=[event('task_started'),ask,output,event('task_complete')];
 assert.equal(lifecycleStatus(waiting,now).state,'waiting');
 assert.equal(lifecycleStatus([...waiting,event('task_started'),event('user_message'),event('task_complete')],now).state,'idle');
});
