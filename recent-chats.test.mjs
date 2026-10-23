import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecentChats, chatLink, discoverCodexChats } from './recent-chats.mjs';

test('recent chats deduplicate, sort, isolate projects and survive restart', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recent-chats-'));
  try {
    const file=path.join(dir,'chats.json'); const store=new RecentChats(file);
    for(let i=1;i<=4;i++) store.record('p',{agent:'codex',chatId:String(i),chatTitle:`Chat ${i}`,phase:'start'},i*1000);
    store.record('other',{agent:'codex',chatId:'5'},5000);
    store.record('p',{agent:'codex',chatId:'1',phase:'finish'},6000);
    assert.deepEqual(store.list('p').map(r=>r.id),['1','4','3']);
    assert.equal(store.list('p')[0].title,'Chat 1');
    assert.equal(store.list('p')[0].phase,'finish');
    assert.deepEqual(new RecentChats(file).list('p'),store.list('p'));
    store.discovered.set('p',[{provider:'codex',id:'1',title:'Old',updatedAt:new Date(1000).toISOString()}]);
    assert.equal(store.list('p')[0].title,'Chat 1');
    store.record('p',{agent:'cursor',chatId:'1',chatTitle:'Cursor chat'},7000);
    assert.equal(store.list('p')[0].provider,'cursor');
    assert.equal(store.list('p')[0].openUrl,null);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('opening links use provider allowlist and encode IDs',()=>{
  assert.equal(chatLink('codex','a/b','javascript:alert(1)'),'codex://threads/a%2Fb');
  assert.equal(chatLink('cursor','id','javascript:alert(1)'),null);
  assert.equal(chatLink('antigravity','id','cursor://chat/1'),null);
  assert.equal(chatLink('cursor','id','cursor://chat/1'),'cursor://chat/1');
});
test('missing Codex executable fails promptly', async()=>{
  await assert.rejects(discoverCodexChats([{id:'p',directory:'/tmp'}],{binary:'/nonexistent/codex',timeout:1000}));
});

test('finishing one chat preserves another; legacy clients can still finish', async()=>{
  const {default:vm}=await import('node:vm');
  const source=fs.readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('function getAgentActivity(');
  const end=source.indexOf('\nsetInterval(',start);
  const ctx=vm.createContext({agentActivityByProject:new Map(),AGENT_IDLE_MS:2700000,AGENT_PROTOCOL_VERSION:2,recentChats:{record(){}}});
  vm.runInContext(source.slice(start,end),ctx);
  const update=body=>ctx.setAgentActivity('p',body);
  update({phase:'start',agent:'codex',chatId:'a',summary:'A'});
  update({phase:'start',agent:'codex',chatId:'b',summary:'B'});
  update({phase:'finish',agent:'codex',chatId:'a'});
  assert.equal(ctx.getAgentActivity('p').summary,'B');
  update({phase:'start',agent:'cursor',summary:'Legacy'});
  update({phase:'finish'});
  assert.equal(ctx.getAgentActivity('p').summary,'B');
  update({phase:'finish',agent:'codex',chatId:'b'});
  assert.equal(ctx.getAgentActivity('p'),null);
});
