import fs from 'node:fs';
const FIELDS = ['waiting', 'quietCi', 'quietCr'];
export class PrMarks {
  constructor(file) {
    this.file=file;
    try { const data=JSON.parse(fs.readFileSync(file,'utf8')); this.entries=data && typeof data==='object'&&!Array.isArray(data)?data:{}; } catch { this.entries={}; }
  }
  snapshot(){return Object.fromEntries(Object.entries(this.entries).filter(([,r])=>Object.keys(r.value||{}).length).map(([k,r])=>[k,r.value||{}]));}
  patch(projectId,pr,patch,{importOnly=false}={}){
    if(!projectId || !Number.isSafeInteger(pr)||pr<1)throw Error('Valid projectId and PR number required');
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!FIELDS.includes(k)))throw Error('Invalid PR mark patch');
    const key=`${projectId}#${pr}`;
    if(importOnly && Object.hasOwn(this.entries,key))return;
    const value={...(this.entries[key]?.value||{})};
    for(const [field,v]of Object.entries(patch)){
      if(v===null||v===false){delete value[field];continue;}
      if(field==='waiting'){if(v!==true)throw Error('waiting must be boolean');value.waiting=true;}
      else {
        if(!v||typeof v!=='object'||typeof v.fp!=='string'||v.fp.length>120||!Number.isFinite(Date.parse(v.at)))throw Error('Invalid quiet mark');
        value[field]={at:v.at,fp:v.fp};
      }
    }
    // Keep empty records as tombstones so a stale browser import cannot resurrect a removed mark.
    const next={...this.entries,[key]:{value,updatedAt:new Date().toISOString()}};
    fs.writeFileSync(`${this.file}.tmp`,JSON.stringify(next),{mode:0o600});fs.renameSync(`${this.file}.tmp`,this.file);this.entries=next;
  }
}
