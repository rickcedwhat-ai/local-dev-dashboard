// Automation policy failures are distinct from build/test failures.
export function classifyChecks(statusState,runs=[],rollup=null) {
 let busy=false,failed=false,ok=false,automergeBlocked=false;
 for(const run of runs){
  const conclusion=String(run.conclusion||'').toLowerCase(),status=String(run.status||'').toLowerCase();
  if(conclusion==='failure'&&/(?:^|\/)\s*enable[-_]automerge\s*$/i.test(run.name||''))automergeBlocked=true;
  else if(['failure','timed_out','startup_failure','action_required'].includes(conclusion))failed=true;
  else if(!conclusion&&['queued','in_progress','waiting','pending','requested'].includes(status))busy=true;
  else if(['success','neutral','skipped'].includes(conclusion))ok=true;
 }
 const state=String(statusState||'').toLowerCase();
 if(failed||['failure','error'].includes(state))return 'failing';
 if(busy)return 'running';
 if(automergeBlocked)return 'automerge-blocked';
 if(['FAILURE','ERROR'].includes(rollup))return 'failing';
 if(ok||state==='success'||rollup==='SUCCESS')return 'passing';
 if(['pending','expected'].includes(state)||['PENDING','EXPECTED'].includes(rollup))return 'running';
 return null;
}
export function aggregateCi(values){
 const states=[...values];return ['failing','running','automerge-blocked','passing'].find(state=>states.includes(state))||null;
}
