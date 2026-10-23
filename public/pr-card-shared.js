// Shared by the dashboard and the Arc PR widget. No browser or network side effects.
(function(root){
const mergeBlockUI = {
      review: { label: 'Needs your review', tip: 'Checks and CodeRabbit are done — GitHub is waiting on an approving review', path: '/files' },
      changes: { label: 'Changes requested', tip: 'A reviewer requested changes — re-review or dismiss to unblock merge', path: '' },
      behind: { label: 'Behind base', tip: 'Branch must be up to date with the base branch before merging', path: '' },
      conflicts: { label: 'Conflicts', tip: 'Merge conflicts with the base branch', path: '/conflicts' },
      blocked: { label: 'Blocked', tip: 'GitHub is blocking merge (ruleset or required check) — open the PR for details', path: '' }
    };
function mergeBlockKind(pr,marks={}) {
 const kind=pr?.mergeBlock;
 if(!kind||!mergeBlockUI[kind]||pr.draft||pr.soak||pr.mergeable||['merged','closed'].includes(pr.state))return null;
 if(kind==='conflicts')return kind;
 const ciOk=marks.quietCi||!pr.ci||pr.ci==='passing';
 const crState=pr.cr?.state||pr.review?.state||'empty';
 return ciOk&&(marks.quietCr||crState==='clear'||crState==='empty')?kind:null;
}
function prPresentation(pr,marks={}) {
 const state=pr.state||'open';
 const kind=mergeBlockKind(pr,marks);
 return {state,terminal:state==='merged'||state==='closed',lifecycle:state==='merged'?'Merged':state==='closed'?'Closed':null,mergeBlock:kind?{kind,...mergeBlockUI[kind]}:null};
}
function ciLabel(state) {
 return {running:'CI running',failing:'CI failing',passing:'CI passing','automerge-blocked':'Automerge blocked'}[state]||'No CI signal';
}
function formatClock(value) { return new Date(value).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}); }
function crMenuEntries({cr={},mine=false,marks={},busy=false}) {
 const state=cr.state||'empty';
 if(busy || state==='autofixing' || (state==='reviewing' && cr.autofix?.phase==='reviewing'))return [];
 const items=[];
 const pushItem = item => items.push({kind:'action',...item});
 if(['actionable','leftover'].includes(state))pushItem({action:'fix-codex',title:'Fix with Codex…',desc:'Copy instructions and open the right chat'});


      if (state === 'pending' || state === 'ready') {
        items.push({kind:'hint', text:'Suggested'});
        if (mine) {
          pushItem({ action: 'review', title: 'Review', desc: '@coderabbitai review — start a review on HEAD', primary: true });
          items.push({kind:'separator'});
          pushItem({ action: 'autofix', title: 'Autofix', desc: 'No actionable threads yet', disabled: true });
        } else {
          pushItem({ action: 'open-pr', title: 'Open on GitHub', desc: 'Collaborator PR — review there', primary: true });
          pushItem({ action: 'review', title: 'CR Review', desc: '@coderabbitai review on HEAD' });
        }
      } else if (state === 'actionable') {
        items.push({kind:'hint',text:cr.freshAfterReview?'New findings after re-review':'Suggested'});
        if (mine) {
          pushItem({
            action: 'autofix',
            title: 'Autofix',
            desc: cr.freshAfterReview
              ? '@coderabbitai autofix — new threads from re-review (not stale leftovers)'
              : '@coderabbitai autofix — let CR patch threads',
            primary: true
          });
          if ((Number(cr.leftoverCount) || 0) > 0) {
            pushItem({
              action: 'resolve-leftovers',
              title: `Resolve leftovers (${cr.leftoverCount})`,
              desc: 'Close only threads from before Autofix completed — new findings stay'
            });
          }
          pushItem({ action: 'review', title: 'Review', desc: 'Re-review HEAD (no autofix)' });
        } else if (!!marks.waiting) {
          pushItem({
            action: 'clear-waiting',
            title: 'Clear waiting on author',
            desc: 'Dashboard only — ball is back with you',
            primary: true
          });
          pushItem({ action: 'review', title: 'CR Review', desc: 'Re-review HEAD (no autofix)' });
          items.push({kind:'separator'});
          pushItem({
            action: 'autofix',
            title: 'Autofix',
            desc: cr.freshAfterReview
              ? 'New threads from re-review — Autofix if you want CR patching'
              : 'Only if you want CR patching their branch'
          });
        } else {
          pushItem({
            action: 'mark-waiting',
            title: 'Waiting on author',
            desc: 'Dashboard only — ball is in their court',
            primary: true
          });
          pushItem({ action: 'review', title: 'CR Review', desc: 'Re-review HEAD (no autofix)' });
          items.push({kind:'separator'});
          pushItem({
            action: 'autofix',
            title: 'Autofix',
            desc: cr.freshAfterReview
              ? 'New threads from re-review — Autofix if you want CR patching'
              : 'Only if you want CR patching their branch'
          });
        }
      } else if (state === 'leftover') {
        items.push({kind:'hint', text:'Suggested'});
        if (mine) {
          const n = Number(cr.leftoverCount) || Number(cr.actionable) || 0;
          pushItem({
            action: 'resolve-leftovers',
            title: n > 0 ? `Resolve leftovers (${n})` : 'Resolve leftovers',
            desc: 'Autofix completed — close the threads it didn’t resolve',
            primary: true
          });
          pushItem({ action: 'review', title: 'Review', desc: 'Re-check HEAD instead' });
          pushItem({ action: 'autofix', title: 'Autofix again', desc: 'Retry autofix if the leftover is still real' });
        } else if (!!marks.waiting) {
          pushItem({
            action: 'clear-waiting',
            title: 'Clear waiting on author',
            desc: 'Dashboard only — ball is back with you',
            primary: true
          });
          pushItem({ action: 'review', title: 'CR Review', desc: 'Re-check HEAD' });
          items.push({kind:'separator'});
          pushItem({ action: 'autofix', title: 'Autofix again', desc: 'Only if you want CR patching their branch' });
        } else {
          pushItem({
            action: 'mark-waiting',
            title: 'Waiting on author',
            desc: 'Dashboard only — ball is in their court',
            primary: true
          });
          pushItem({ action: 'review', title: 'CR Review', desc: 'Re-check HEAD' });
          items.push({kind:'separator'});
          pushItem({ action: 'autofix', title: 'Autofix again', desc: 'Only if you want CR patching their branch' });
        }
      } else if (state === 'delivery') {
        items.push({kind:'hint', text:'Suggested'});
        if (cr.taskUrl) {
          pushItem({ action: 'open-task', title: 'Open CR task', desc: 'Push failed — finish or retry in CodeRabbit', primary: true, danger: true });
          items.push({kind:'separator'});
        }
        if (mine) {
          pushItem({ action: 'autofix', title: 'Autofix again', desc: 'Retry only if the delivery issue is fixed', primary: !cr.taskUrl });
          pushItem({ action: 'review', title: 'Review', desc: 'Re-review current HEAD' });
        } else if (!!marks.waiting) {
          pushItem({
            action: 'clear-waiting',
            title: 'Clear waiting on author',
            desc: 'Dashboard only — ball is back with you',
            primary: !cr.taskUrl
          });
          pushItem({ action: 'review', title: 'CR Review', desc: 'Re-review current HEAD' });
          items.push({kind:'separator'});
          pushItem({ action: 'autofix', title: 'Autofix again', desc: 'Only if you want CR patching their branch' });
        } else {
          pushItem({
            action: 'mark-waiting',
            title: 'Waiting on author',
            desc: 'Dashboard only — ball is in their court',
            primary: !cr.taskUrl
          });
          pushItem({ action: 'review', title: 'CR Review', desc: 'Re-review current HEAD' });
          items.push({kind:'separator'});
          pushItem({ action: 'autofix', title: 'Autofix again', desc: 'Only if you want CR patching their branch' });
        }
      } else if (state === 'clear') {
        items.push({kind:'hint', text:'Optional'});
        pushItem({ action: 'review', title: 'Review again', desc: '@coderabbitai review on latest HEAD' });
        items.push({kind:'separator'});
        pushItem({ action: 'autofix', title: 'Autofix', desc: 'Nothing actionable', disabled: true });
      } else if (state === 'limited') {
        items.push({kind:'hint', text:'Rate limited'});
        const queued = cr.queuedReview;
        if (queued?.fireAt) {
          pushItem({
            action: 'queue-review',
            title: 'Review queued',
            desc: `Fires ~${formatClock(queued.fireAt)} (capacity + 60s)`,
            primary: true,
            disabled: true
          });
          pushItem({
            action: 'cancel-queue-review',
            title: 'Cancel queued review',
            desc: 'Don’t auto-review when capacity returns',
            nested: true
          });
          pushItem({
            action: 'review',
            title: 'Review now',
            desc: 'Try anyway — may hit rate limit again',
            nested: true
          });
        } else {
          const fireAtMs = cr.limitedUntil
            ? new Date(cr.limitedUntil).getTime() + 60000
            : null;
          const fireLabel = fireAtMs && Number.isFinite(fireAtMs)
            ? `Auto-review ~${formatClock(new Date(fireAtMs).toISOString())} (capacity + 60s)`
            : 'Auto-review 60s after capacity returns';
          pushItem({
            action: 'queue-review',
            title: 'Queue review',
            desc: fireLabel,
            primary: true
          });
          pushItem({ action: 'review', title: 'Review now', desc: 'Try anyway — may hit rate limit again' });
        }
      } else if (!busy) {
        // other — still allow review nudge
        items.push({kind:'hint', text:'Optional'});
        pushItem({ action: 'review', title: 'Review', desc: '@coderabbitai review on HEAD' });
      }

      // Open on GitHub always available (skip duplicate if already primary above)
      const hasOpenPr = items.some(item => item.action === 'open-pr');
      if (!hasOpenPr) {
        if (items.length) items.push({kind:'separator'});
        pushItem({ action: 'open-pr', title: 'Open on GitHub', desc: 'Focus this PR' });
      }

      // Waiting on author stays on CR menu for collaborator PRs (workflow, not quiet).
      if (!mine) {
        const hasWaiting = items.some(item => ['mark-waiting','clear-waiting'].includes(item.action));
        if (!hasWaiting) {
          items.push({kind:'separator'});
          if (!!marks.waiting) {
            pushItem({
              action: 'clear-waiting',
              title: 'Clear waiting on author',
              desc: 'Ball is back with you'
            });
          } else if (state === 'actionable' || state === 'leftover' || state === 'reviewing' || state === 'autofixing' || state === 'delivery' || state === 'pending') {
            pushItem({
              action: 'mark-waiting',
              title: 'Waiting on author',
              desc: 'Ball is in their court'
            });
          }
        }
      }


 return items;
}
function crChip(cr={}) {
 const state=cr.state||'empty', actionable=Number(cr.actionable)||0;
 let label='CR',badge='';
 const fresh=cr.freshAfterReview ? [Number(cr.newCount)>0?`${cr.newCount} new`:'',Number(cr.leftoverCount)>0?`${cr.leftoverCount} leftover`:''].filter(Boolean).join(' - ') : '';
 if(state==='leftover')label='CR leftover';else if(fresh)label=fresh;else if(state==='ready')label='CR ready';else if(state==='limited')label=cr.queuedReview?'CR queued':'CR limited';else if(state==='autofixing')label='CR autofix';else if(state==='delivery')label='CR delivery';
 if(!fresh){if(['actionable','leftover','delivery'].includes(state)&&actionable>0)badge=String(actionable);else if(['reviewing','autofixing'].includes(state))badge='…';else if(state==='clear')badge='✓';}
 return {state,label,badge,busy:state==='autofixing'||(state==='reviewing'&&cr.autofix?.phase==='reviewing')};
}
    const CI_COMET_LAP_MS = 3500;
    const CI_COMET_TRAIL = 0.26;
    const CI_COMET_PALETTES = {
      failing: {
        head: '#ffc8c3',
        mid: '#f85149',
        soft: 'rgba(248,81,73,0.55)',
        faint: 'rgba(248,81,73,0.22)',
        base: '#30363d',
        reduced: 'rgba(248,81,73,0.75)'
      },
      running: {
        head: '#ffe8a3',
        mid: '#e3b341',
        soft: 'rgba(227,179,65,0.55)',
        faint: 'rgba(210,153,34,0.28)',
        base: '#30363d',
        reduced: 'rgba(227,179,65,0.75)'
      }
    };

    function pointOnPerimeter(t, w, h) {
      const hw = w / 2;
      const hh = h / 2;
      const perim = 2 * (w + h);
      let s = ((t % 1) + 1) % 1 * perim;
      if (s < hw) return { x: s, y: -hh };
      s -= hw;
      if (s < h) return { x: hw, y: -hh + s };
      s -= h;
      if (s < w) return { x: hw - s, y: hh };
      s -= w;
      if (s < h) return { x: -hw, y: hh - s };
      s -= h;
      return { x: -hw + s, y: -hh };
    }

    function angleFromTop(x, y) {
      let deg = Math.atan2(x, -y) * (180 / Math.PI);
      if (deg < 0) deg += 360;
      return deg;
    }

    function ccwFrom(headDeg, pointDeg) {
      return (headDeg - pointDeg + 360) % 360;
    }

    function paintCiComet(card, t) {
      const kind = card.classList.contains('ci-running') ? 'running' : 'failing';
      const pal = CI_COMET_PALETTES[kind];
      const fill = card.dataset?.widget ? 'var(--pr-bg, #0d1117)' : card.classList.contains('side-item') && card.classList.contains('active')
        ? '#1c2b3f'
        : '#0d1117';
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        card.style.background =
          `linear-gradient(${fill}, ${fill}) padding-box,` +
          `linear-gradient(${pal.reduced}, ${pal.reduced}) border-box`;
        return;
      }
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      if (w < 2 || h < 2) return;

      const head = pointOnPerimeter(t, w, h);
      const headDeg = angleFromTop(head.x, head.y);
      const trailFrac = CI_COMET_TRAIL;
      const samples = [
        { d: 0, color: pal.head },
        { d: trailFrac * 0.08, color: pal.mid },
        { d: trailFrac * 0.28, color: pal.soft },
        { d: trailFrac * 0.58, color: pal.faint },
        { d: trailFrac, color: pal.base }
      ].map((s) => {
        const p = pointOnPerimeter(t - s.d, w, h);
        return { ang: ccwFrom(headDeg, angleFromTop(p.x, p.y)), color: s.color };
      });

      const stops = [`${pal.base} 0deg`];
      const farthest = samples[samples.length - 1].ang;
      stops.push(`${pal.base} ${Math.max(0, 360 - farthest - 0.01)}deg`);
      for (let i = samples.length - 1; i >= 0; i--) {
        stops.push(`${samples[i].color} ${360 - samples[i].ang}deg`);
      }

      card.style.background =
        `linear-gradient(${fill}, ${fill}) padding-box,` +
        `conic-gradient(from ${headDeg}deg, ${stops.join(', ')}) border-box`;
    }


    function paintReviewComet(el, t) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.style.border = '1.5px solid transparent';
        el.style.background =
          'linear-gradient(#2a2416, #2a2416) padding-box,' +
          'linear-gradient(#5a4a22, #5a4a22) border-box';
        return;
      }
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w < 2 || h < 2) return;
      const trail = 0.14;
      const head = pointOnPerimeter(t, w, h);
      const headDeg = angleFromTop(head.x, head.y);
      const samples = [
        { d: 0, color: '#ffe8a3' },
        { d: trail * 0.08, color: '#e3b341' },
        { d: trail * 0.28, color: 'rgba(227,179,65,0.55)' },
        { d: trail * 0.58, color: 'rgba(210,153,34,0.28)' },
        { d: trail, color: 'rgba(210,153,34,0.22)' }
      ].map((s) => {
        const p = pointOnPerimeter(t - s.d, w, h);
        return { ang: ccwFrom(headDeg, angleFromTop(p.x, p.y)), color: s.color };
      });
      const stops = ['rgba(210,153,34,0.22) 0deg'];
      const far = samples[samples.length - 1].ang;
      stops.push(`rgba(210,153,34,0.22) ${Math.max(0, 360 - far - 0.01)}deg`);
      for (let i = samples.length - 1; i >= 0; i--) {
        stops.push(`${samples[i].color} ${360 - samples[i].ang}deg`);
      }
      el.style.border = '1.5px solid transparent';
      el.style.background =
        `linear-gradient(#2a2416, #2a2416) padding-box,` +
        `conic-gradient(from ${headDeg}deg, ${stops.join(', ')}) border-box`;
    }


root.DashboardPrUI=Object.freeze({ciLabel,mergeBlockUI,mergeBlockKind,prPresentation,crMenuEntries,crChip,pointOnPerimeter,angleFromTop,ccwFrom,paintCiComet,paintReviewComet});
})(globalThis);
