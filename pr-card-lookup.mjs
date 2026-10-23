import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export class PrCardLookup {
 constructor({fetchPull,now=Date.now,ttl=30000}={}) {
  this.fetchPull=fetchPull|| (async(repo,number)=>JSON.parse((await exec('gh',['api',`repos/${repo}/pulls/${number}`],{timeout:10000,maxBuffer:1000000})).stdout));
  this.now=now;this.ttl=ttl;this.cache=new Map();this.pending=new Map();
 }
 async get(repository,number,projects) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository)||!Number.isSafeInteger(number)||number<1)throw Error('Invalid PR reference.');
  const slug=repository.toLowerCase();
  const project=projects.find(p=>String(p.repo||'').replace(/\.git\/?$/,'').replace(/\/$/,'').toLowerCase()===`https://github.com/${slug}`);
  if(!project)throw Error('Repository is not registered in the dashboard.');
  const key=`${slug}#${number}`,cached=this.cache.get(key);
  if(cached&&this.now()-cached.at<this.ttl)return {...cached.value,projectId:project.id};
  if(this.pending.has(key))return this.pending.get(key);
  const request=(async()=>{
   const raw=await this.fetchPull(slug,number);
   const expected=`https://github.com/${slug}/pull/${number}`;
   if(raw.number!==number||String(raw.html_url).toLowerCase()!==expected)throw Error('GitHub returned a different PR.');
   const at=this.now(),state=raw.merged_at||raw.merged?'merged':raw.state==='closed'?'closed':'open';
   const value={projectId:project.id,checkedAt:new Date(at).toISOString(),pr:{number,url:raw.html_url,title:raw.title,state,mergedAt:raw.merged_at||null,closedAt:raw.closed_at||null,draft:!!raw.draft,author:{login:raw.user?.login||null},cr:{state:'empty'}}};
   this.cache.set(key,{at,value});if(this.cache.size>256)this.cache.delete(this.cache.keys().next().value);
   return value;
  })();this.pending.set(key,request);
  try{return await request;}finally{this.pending.delete(key);}
 }
}
