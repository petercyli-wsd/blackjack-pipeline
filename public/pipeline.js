/* Pipelines tab. Runs execute on the server; this page only shows them and sends actions.
   Rendering is keyed by section and skipped when a section's data hasn't changed, so polling
   never resets open menus, scroll positions or a playing video. */
(()=>{
  const $=id=>document.getElementById(id),root=$('pl-root'),dialog=$('pl-dialog');
  const api=(route,method='GET',body)=>window.studio.batchAPI(route,method,body);
  const store=window.Shell?.store||{get:()=>null,set:()=>{}};
  const S={meta:null,pipeline:null,runs:[],runId:null,run:null,mode:'detail',expanded:new Map(),rows:{filter:'all',page:0,data:null,at:0},
    draft:{options:null,upload:null,error:''},seen:new Map(),loadedOnce:false,timers:{},gallery:new Map(),busy:new Set()};

  // ── tiny DOM helpers (text only; nothing from the server is parsed as HTML)
  function h(tag,props,...kids){
    const el=document.createElement(tag);
    for(const [k,v] of Object.entries(props||{})){
      if(v===null||v===undefined||v===false)continue;
      if(k==='class')el.className=v;else if(k==='text')el.textContent=v;else if(k.startsWith('on'))el.addEventListener(k.slice(2),v);
      // CSP forbids style attributes but not CSSOM writes.
      else if(k==='style')el.style.cssText=v;else if(k in el&&k!=='list'&&typeof v!=='string')el[k]=v;else el.setAttribute(k,v===true?'':v);
    }
    for(const kid of kids.flat(Infinity))if(kid!==null&&kid!==undefined&&kid!==false)el.append(kid instanceof Node?kid:document.createTextNode(String(kid)));
    return el;
  }
  const hash=s=>{let n=5381;for(let i=0;i<s.length;i++)n=(n*33)^s.charCodeAt(i);return (n>>>0).toString(36)+s.length;};
  // Keeps a container's keyed children in order, rebuilding only those whose signature changed.
  function sync(container,items){
    const old=new Map([...container.children].filter(c=>c.dataset.key).map(c=>[c.dataset.key,c]));
    const next=items.filter(Boolean).map(({key,sig,build})=>{
      const s=hash(JSON.stringify(sig??null)),el=old.get(key);
      if(el&&el.dataset.sig===s)return el;
      const fresh=build();fresh.dataset.key=key;fresh.dataset.sig=s;
      if(el){el.replaceWith(fresh);old.set(key,fresh);}
      return fresh;
    });
    const current=[...container.children];
    if(current.length!==next.length||current.some((c,i)=>c!==next[i]))container.replaceChildren(...next);
  }
  // ── formatting
  const plural=(n,w,p=w+'s')=>`${n} ${n===1?w:p}`;
  function dur(sec){if(!Number.isFinite(sec))return '';sec=Math.max(0,Math.round(sec));if(sec<60)return `${sec} s`;const m=Math.round(sec/60);if(m<60)return `${m} min`;return `${Math.floor(m/60)} h ${String(m%60).padStart(2,'0')} min`;}
  function ago(iso){if(!iso)return '';const s=(Date.now()-Date.parse(iso))/1000;if(s<45)return 'just now';if(s<3600)return `${Math.round(s/60)} min ago`;if(s<86400)return `${Math.round(s/3600)} h ago`;return new Date(iso).toLocaleDateString(undefined,{day:'numeric',month:'short'});}
  const since=iso=>iso?(Date.now()-Date.parse(iso))/1000:0;
  const money=n=>!Number.isFinite(n)?'?':n<10?`$${n.toFixed(2)}`:`$${Math.round(n)}`;
  const bytes=n=>!Number.isFinite(n)?'':n<1048576?`${Math.round(n/1024)} KB`:n<1073741824?`${Math.round(n/1048576)} MB`:`${(n/1073741824).toFixed(1)} GB`;
  const RUN={draft:'Draft',queued:'Queued',running:'Running',waiting:'Needs you',paused:'Paused',failed:'Failed',completed:'Done'};
  const STAGE={pending:'Not started',running:'Running',done:'Done',failed:'Failed',waiting:'Needs you',paused:'Paused',skipped:'Skipped'};
  const STEP={pending:'',running:'Running',done:'Done',cached:'Reused',failed:'Failed',skipped:'Skipped',waiting:'Needs you'};
  const KEYNAME={fal:'fal',kie:'KIE',runninghub:'RunningHub'};
  const pill=(status,text)=>h('span',{class:`pl-pill s-${status}`},h('span',{class:'pl-dot','aria-hidden':'true'}),text);
  const icon=status=>h('span',{class:`pl-icon s-${status}`,'aria-hidden':'true'});
  const busyButton=(label,fn,props={})=>h('button',{...props,onclick:async e=>{const b=e.currentTarget;if(b.disabled)return;b.disabled=true;const was=b.textContent;b.textContent=props.busy||'Working…';try{await fn();}catch(err){notify(err.message,'error');}finally{if(b.isConnected){b.disabled=false;b.textContent=was;}}}},label);
  function notify(message,kind='warning',target){window.StudioNotice?.show({id:'pipeline',message,kind,target});}
  const def=()=>S.meta?.definitions.find(d=>d.id===S.pipeline);
  // ── routing: #pipelines/<pipeline>[/<run>|/new]
  function route(){
    const parts=location.hash.replace(/^#/,'').split('/');
    if(parts[0]!=='pipelines')return;
    const enabled=S.meta?.definitions||[];
    S.pipeline=enabled.some(d=>d.id===parts[1])?parts[1]:(store.get('bp-pipeline')&&enabled.some(d=>d.id===store.get('bp-pipeline'))?store.get('bp-pipeline'):enabled.find(d=>d.enabled)?.id||enabled[0]?.id||null);
    if(parts[2]==='new'){S.mode='new';S.runId=null;}
    else if(parts[2]){S.mode='detail';if(S.runId!==parts[2]){S.runId=parts[2];S.run=null;S.rows={filter:'all',page:0,data:null,at:0};}}
    else{S.mode='detail';S.runId=null;S.run=null;}
  }
  function go(pipeline,target,{replace=false}={}){
    store.set('bp-pipeline',pipeline);
    const next=`#pipelines/${pipeline}${target?`/${target}`:''}`;
    if(location.hash!==next){if(replace)history.replaceState(null,'',next);else history.pushState(null,'',next);}
    route();render();refreshRun(true);
  }
  window.addEventListener('hashchange',()=>{if(location.hash.startsWith('#pipelines')){route();render();refreshRun(true);}});
  window.addEventListener('popstate',()=>{route();render();refreshRun(true);});
  // ── data
  async function loadMeta(){
    S.meta=await api('/api/pipeline');
    window.Shell?.setPipelines(S.meta.enabled);
  }
  async function refreshRuns(){
    if(!S.meta?.enabled)return;
    const {runs}=await api('/api/pipeline/runs');
    for(const r of runs){
      const before=S.seen.get(r.id);S.seen.set(r.id,r.status);
      if(S.loadedOnce&&before&&before!==r.status)announce(r,before);
    }
    S.runs=runs;S.loadedOnce=true;title();
  }
  async function refreshRun(force){
    if(!S.runId||!S.meta?.enabled){render();return;}
    try{S.run=await api(`/api/pipeline/runs/${encodeURIComponent(S.runId)}`);}
    catch(e){if(e.status===404){S.run=null;S.runId=null;history.replaceState(null,'',`#pipelines/${S.pipeline}`);}else if(force)notify(e.message,'error');}
    if(S.run&&S.run.pipeline!==S.pipeline){S.pipeline=S.run.pipeline;}
    render();
    if(S.run&&S.run.stages.some(s=>s.kind==='transitions'&&(s.rows||s.status!=='pending')))refreshRows();
  }
  async function refreshRows(force){
    if(!S.run||(!force&&Date.now()-S.rows.at<2500))return;
    S.rows.at=Date.now();
    try{S.rows.data=await api(`/api/pipeline/runs/${S.run.id}/rows?filter=${S.rows.filter}&page=${S.rows.page}`);render();}catch{}
  }
  // Polls fast while something is happening, slowly otherwise, and pauses in a hidden tab.
  function schedule(){
    clearTimeout(S.timers.poll);
    const live=S.runs.some(r=>['running','queued'].includes(r.status))||S.draft.upload;
    const visible=document.visibilityState==='visible'&&window.Shell?.current()==='pipelines';
    S.timers.poll=setTimeout(tick,visible?(live?1500:5000):(live?8000:30000));
  }
  async function tick(){try{await refreshRuns();await refreshRun();}catch{}finally{schedule();}}
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')tick();});
  window.addEventListener('shell:tab',e=>{if(e.detail==='pipelines')tick();});
  // ── notifications when a run changes state, even on another tab of the app
  function announce(run,before){
    const text={waiting:`“${run.name}” needs you: ${run.attention?.message||''}`,failed:`“${run.name}” stopped: ${run.attention?.message||''}`,completed:`“${run.name}” is done. The game is ready to play.`}[run.status];
    if(!text||(before==='waiting'&&run.status==='waiting'))return;
    window.StudioNotice?.show({id:`run-${run.id}`,message:text,kind:run.status==='failed'?'error':run.status==='completed'?'success':'warning'});
    if(store.get('bp-notify')==='1'&&'Notification' in window&&Notification.permission==='granted'&&document.visibilityState!=='visible'){
      try{const n=new Notification('Blackjack Pipeline',{body:text,tag:run.id});n.onclick=()=>{window.focus();go(run.pipeline,run.id);};}catch{}
    }
  }
  function title(){
    const need=S.runs.filter(r=>['waiting','failed'].includes(r.status)).length,live=S.runs.find(r=>r.status==='running');
    document.title=need?`(${need}) Needs you · Blackjack Pipeline`:live?`${Math.round(live.progress*100)}% · Blackjack Pipeline`:'Blackjack Pipeline';
  }
  // ── actions
  async function act(action,body={},{confirm:question}={}){
    if(question&&!window.confirm(question))return null;
    const out=await api(`/api/pipeline/runs/${S.run.id}/${action}`,'POST',body);
    S.run=out.run;S.rows.at=0;await refreshRuns().catch(()=>{});render();refreshRows(true);schedule();return out.result;
  }
  async function setKey(provider,value){
    if(!value.trim())throw new Error('Paste the key first.');
    const k=await api('/api/pipeline/keys','POST',{[provider]:value.trim()});
    window.studioUI?.keyStatus?.({...k});S.meta.keys=k;setTimeout(tick,400);return k;
  }
  // ── layout
  function render(){
    if(!S.meta){return;}
    if(!S.meta.enabled){
      sync(root,[{key:'off',sig:S.meta.reason,build:()=>h('div',{class:'pl-off card'},h('h2',{},'Pipelines need a persistent server'),
        h('p',{},S.meta.reason||'Pipelines are turned off here.'),h('p',{class:'help'},'The Transition Studio tab works as before.'),
        h('button',{class:'accent',onclick:()=>window.Shell.show('studio')},'Open Transition Studio'))}]);return;
    }
    sync(root,[
      {key:'intro',sig:1,build:intro},
      {key:'picker',sig:[S.pipeline,S.meta.definitions.map(d=>[d.id,d.enabled,d.runs])],build:picker},
      {key:'body',sig:'body',build:()=>h('div',{class:'pl-layout'},h('aside',{class:'pl-side',id:'pl-side','aria-label':'Runs'}),h('section',{class:'pl-main',id:'pl-main'}))}
    ]);
    const d=def();
    if(!d)return;
    $('pl-side').parentElement.classList.toggle('solo',!d.enabled);
    if(!d.enabled){sync($('pl-side'),[]);$('pl-side').hidden=true;sync($('pl-main'),[{key:'disabled',sig:d,build:()=>disabledView(d)}]);return;}
    $('pl-side').hidden=false;
    sideList(d);
    const main=$('pl-main');
    if(S.mode==='new'||S.run?.status==='draft')sync(main,[{key:`new-${S.run?.id||'fresh'}`,sig:newSig(),build:()=>newRun(d)}]);
    else if(S.run)detail(main,S.run,d);
    else if(S.runId)sync(main,[{key:'loading',sig:1,build:()=>h('p',{class:'pl-loading'},'Loading run…')}]);
    else sync(main,[{key:'empty',sig:[d.id,S.runs.filter(r=>r.pipeline===d.id).length],build:()=>empty(d)}]);
  }
  const intro=()=>h('div',{class:'pl-intro'},h('p',{},'Turn one dealer take into a playable game: ',h('strong',{},'cut the clips'),', ',h('strong',{},'generate the transitions'),' between them, and ',h('strong',{},'build the table'),'. Runs keep going on this computer\'s server after you close the tab.'));
  function picker(){
    return h('div',{class:'pl-picker',role:'radiogroup','aria-label':'Pipeline'},S.meta.definitions.map(d=>h('button',{class:`pl-pick${d.id===S.pipeline?' on':''}${d.enabled?'':' off'}`,role:'radio','aria-checked':String(d.id===S.pipeline),
      onclick:()=>go(d.id)},
      h('span',{class:'pl-pick-top'},h('strong',{},d.name),d.enabled?h('span',{class:'pl-tag'},plural(d.runs,'run')):h('span',{class:'pl-tag soon'},'Coming soon')),
      h('span',{class:'pl-pick-sub'},d.enabled?d.tagline:'Not produced yet'))));
  }
  function disabledView(d){
    return h('div',{class:'pl-disabled card'},h('h2',{},`${d.name} isn't available yet`),h('p',{},d.disabledReason||'This pipeline is turned off.'),
      h('p',{class:'help'},'Planned stages:'),h('ol',{class:'pl-plan'},d.stages.map(s=>h('li',{},h('strong',{},s.title),h('span',{},s.summary)))),
      h('p',{class:'help'},'It becomes available when its pipeline definition is enabled, with its game repo and footage in place.'));
  }
  function empty(d){
    const has=S.runs.some(r=>r.pipeline===d.id);
    return h('div',{class:'pl-empty'},
      h('h2',{},has?'Choose a run on the left':`Start your first ${d.name} run`),
      h('ol',{class:'pl-how'},
        h('li',{},h('span',{class:'pl-how-n'},'1'),h('div',{},h('strong',{},'Add the dealer take'),h('p',{},`It's checked straight away: ${d.input.width}×${d.input.height}, ${(d.input.fps==='24000/1001'?'23.976':d.input.fps)} fps, one continuous take.`))),
        h('li',{},h('span',{class:'pl-how-n'},'2'),h('div',{},h('strong',{},'The server does the work'),h('p',{},'Cuts the clips, generates the transitions (it asks before spending), and builds the game. Close the tab whenever you like.'))),
        h('li',{},h('span',{class:'pl-how-n'},'3'),h('div',{},h('strong',{},'Play and download'),h('p',{},'Play the table in your browser, then download the game or just its clips.')))),
      h('button',{class:'primary',onclick:()=>go(d.id,'new')},'Start a new run'));
  }
  function sideList(d){
    const runs=S.runs.filter(r=>r.pipeline===d.id);
    sync($('pl-side'),[
      {key:'head',sig:[S.mode,store.get('bp-notify')],build:()=>h('div',{class:'pl-side-head'},h('h2',{},'Runs'),
        h('button',{class:`primary small${S.mode==='new'?' on':''}`,onclick:()=>go(d.id,'new')},'+ New run'))},
      {key:'list',sig:[runs.map(r=>[r.id,r.name,r.status,Math.round(r.progress*100),r.current,r.attention?.kind,r.input?.name,Math.floor(since(r.updatedAt)/60)]),S.runId],build:()=>runs.length?
        h('ul',{class:'pl-runs'},runs.map(r=>{const stage=r.stages.find(s=>s.id===r.current);
          return h('li',{},h('a',{href:`#pipelines/${d.id}/${r.id}`,class:`pl-run${r.id===S.runId?' on':''}`,'aria-current':r.id===S.runId?'page':null,onclick:e=>{e.preventDefault();go(d.id,r.id);}},
            h('span',{class:'pl-run-top'},h('strong',{},r.name),pill(r.status,RUN[r.status])),
            r.status==='draft'?h('span',{class:'pl-run-sub'},r.input?.ok?'Ready to start':'Add a take to start'):
            h('span',{class:'pl-run-sub'},['running','queued','paused','waiting','failed'].includes(r.status)&&stage?`${stage.title}${r.status==='queued'?' · waiting its turn':''}`:r.status==='completed'?`Finished ${ago(r.finishedAt)}`:''),
            r.status!=='draft'&&h('span',{class:'pl-bar thin','aria-hidden':'true'},h('span',{style:`width:${Math.round(r.progress*100)}%`,class:`s-${r.status}`}))));}))
        :h('p',{class:'pl-side-empty'},'No runs yet.')},
      {key:'notify',sig:[store.get('bp-notify'),'Notification' in window&&Notification.permission],build:notifyToggle}
    ]);
  }
  function notifyToggle(){
    if(!('Notification' in window))return h('div');
    const on=store.get('bp-notify')==='1'&&Notification.permission==='granted';
    return h('label',{class:'pl-notify check'},h('input',{type:'checkbox',checked:on,onchange:async e=>{
      if(e.target.checked){const p=await Notification.requestPermission();store.set('bp-notify',p==='granted'?'1':'0');if(p!=='granted')notify('Notifications are blocked for this site in your browser settings.');}
      else store.set('bp-notify','0');render();}}),' Desktop alert when a run needs me or finishes');
  }
  // ── new run (also shown for a draft)
  // Only what the user can't be typing into: a rebuild mid-keystroke would steal focus.
  function newSig(){
    const r=S.run?.status==='draft'?S.run:null,o=r?.options||S.draft.options||{},u=S.draft.upload;
    return [r?.id,r?.input,r?.uploading,u&&[u.name,u.phase,Math.round(u.fraction*100)],S.draft.error,o.source,o.stages,S.meta.keys,S.meta.hosted];
  }
  function defaults(d){
    const stages={};for(const s of d.stages)if(s.optional)stages[s.id]=s.default;
    return {source:'local',localPath:d.localPath||'',ref:d.game.ref||'main',stages,review:'generative',maxRedos:1,concurrency:3,autoApproveUSD:'',reviewGate:false};
  }
  function newRun(d){
    const draft=S.run?.status==='draft'?S.run:null,o=draft?{...draft.options,autoApproveUSD:draft.options.autoApproveUSD??''}:(S.draft.options||=defaults(d)),input=draft?.input,up=S.draft.upload;
    const save=patch=>{Object.assign(o,patch);if(draft)debounce('opts',()=>api(`/api/pipeline/runs/${draft.id}`,'PATCH',{options:patch}).then(r=>{S.run=r;}).catch(e=>notify(e.message,'error')),350);else S.draft.options=o;};
    const take=h('section',{class:'pl-new-step'},h('h3',{},h('span',{class:'pl-n'},'1'),' Add the dealer take'),
      h('p',{class:'help'},d.input.help||''),
      h('p',{class:'pl-req'},h('span',{},`${d.input.width}×${d.input.height}`),h('span',{},`${d.input.fps==='24000/1001'?'23.976':d.input.fps} fps`),h('span',{},`${Math.round((d.input.minSeconds||0)/60)}–${Math.round((d.input.maxSeconds||0)/60)} min`),h('span',{},'MP4 or MOV')),
      up?h('div',{class:'pl-upload'},h('div',{class:'pl-upload-top'},h('strong',{},up.name),h('span',{},up.phase==='checking'?'Checking the video…':`${Math.round(up.fraction*100)}% · ${bytes(up.loaded)} of ${bytes(up.total)}`)),
        h('span',{class:'pl-bar'},h('span',{class:'s-running',style:`width:${Math.round((up.phase==='checking'?1:up.fraction)*100)}%`})),
        up.phase!=='checking'&&h('button',{class:'quiet small',onclick:()=>up.controller.abort()},'Cancel upload'))
      :dropZone(d,draft),
      input&&!up?validation(input):null,
      S.draft.error&&!up?h('p',{class:'pl-error-line',role:'alert'},S.draft.error):null);
    const ready=!!input?.ok&&!up;
    const opts=h('section',{class:'pl-new-step'},h('h3',{},h('span',{class:'pl-n'},'2'),' Options'),
      h('div',{class:'pl-fields'},
        h('label',{},'Run name',h('input',{type:'text',value:draft?.name||S.draft.name||'',maxlength:80,placeholder:`${d.name} · ${new Date().toLocaleDateString(undefined,{day:'numeric',month:'short'})}`,
          oninput:e=>{if(draft)debounce('name',()=>api(`/api/pipeline/runs/${draft.id}`,'PATCH',{name:e.target.value}).then(r=>{S.run=r;}),500);else S.draft.name=e.target.value;}})),
        h('fieldset',{class:'pl-choice'},h('legend',{},'Game code'),
          h('label',{class:'check'},h('input',{type:'radio',name:'pl-src',checked:o.source!=='git',onchange:()=>{save({source:'local'});render();}}),' My local folder ',h('span',{class:'muted'},'(includes uncommitted changes)')),
          o.source!=='git'&&!S.meta.hosted&&h('input',{type:'text',class:'pl-path',value:o.localPath||d.localPath||'',spellcheck:false,'aria-label':'Game folder',onchange:e=>save({localPath:e.target.value})}),
          h('label',{class:'check'},h('input',{type:'radio',name:'pl-src',checked:o.source==='git',onchange:()=>{save({source:'git'});render();}}),' A GitHub branch or commit ',h('span',{class:'muted'},d.game.repo?`(${d.game.repo.replace(/^https:\/\/github\.com\//,'').replace(/\.git$/,'')})`:'')),
          o.source==='git'&&h('input',{type:'text',class:'pl-path',value:o.ref||'main',spellcheck:false,'aria-label':'Branch or commit',onchange:e=>save({ref:e.target.value.trim()})})),
        d.stages.some(s=>s.optional)&&h('fieldset',{class:'pl-choice'},h('legend',{},'Optional stages'),
          d.stages.filter(s=>s.optional).map(s=>h('label',{class:'check'},h('input',{type:'checkbox',checked:!!o.stages?.[s.id],onchange:e=>save({stages:{...o.stages,[s.id]:e.target.checked}})}),` ${s.title} `,h('span',{class:'muted'},`— ${s.summary}`),
            s.keys.length&&!s.keys.every(k=>S.meta.keys?.[k])&&o.stages?.[s.id]?h('span',{class:'pl-warn-inline'},` Needs your ${s.keys.map(k=>KEYNAME[k]).join(', ')} key.`):null))),
        d.stages.some(s=>s.kind==='transitions')&&h('fieldset',{class:'pl-choice'},h('legend',{},'Transitions'),
          h('div',{class:'pl-row3'},
            h('label',{},'AI quality review',h('select',{onchange:e=>save({review:e.target.value})},
              [['generative','Generative only (Kling): review + 1 redo'],['all','All rows (FILM rows are flagged, not redone)'],['off','Off']].map(([v,t])=>h('option',{value:v,selected:o.review===v},t)))),
            h('label',{},'Generate in parallel',h('select',{onchange:e=>save({concurrency:Number(e.target.value)})},[1,2,3,4,6,8].map(n=>h('option',{value:n,selected:Number(o.concurrency)===n},String(n))))),
            h('label',{},'Auto-approve up to (USD)',h('input',{type:'number',min:0,step:1,value:o.autoApproveUSD??'',placeholder:'Ask me first',onchange:e=>save({autoApproveUSD:e.target.value===''?null:Number(e.target.value)})}))),
          h('label',{class:'check'},h('input',{type:'checkbox',checked:!!o.reviewGate,onchange:e=>save({reviewGate:e.target.checked})}),' Pause before building the game so I can review the transitions'))));
    const start=h('section',{class:'pl-new-step pl-start'},
      h('div',{},h('h3',{},h('span',{class:'pl-n'},'3'),' Start'),h('p',{class:'help'},ready?'The run starts on the server. You can close this tab; progress is saved at every step.':'Add a valid take to start.')),
      h('div',{class:'actions'},
        draft&&h('button',{class:'quiet',onclick:async()=>{if(!confirm('Discard this draft and its uploaded take?'))return;await api(`/api/pipeline/runs/${draft.id}`,'DELETE');S.draft={options:null,upload:null,error:''};await refreshRuns();go(d.id,null,{replace:true});}},'Discard draft'),
        busyButton('Start run',async()=>{await api(`/api/pipeline/runs/${draft.id}/start`,'POST',{});S.draft={options:null,upload:null,error:''};await refreshRuns();go(d.id,draft.id,{replace:true});},{class:'primary',disabled:!ready,busy:'Starting…'})));
    return h('div',{class:'pl-new'},h('div',{class:'pl-new-head'},h('h2',{},draft?'Finish setting up this run':`New ${d.name} run`),
      h('button',{class:'quiet small',onclick:()=>go(d.id,null)},'Close')),take,opts,start);
  }
  function dropZone(d,draft){
    const file=h('input',{type:'file',accept:'video/*,.mp4,.mov,.mkv',hidden:true,onchange:e=>{const f=e.target.files[0];if(f)upload(d,draft,f);}});
    const zone=h('div',{class:'pl-drop',tabindex:0,role:'button','aria-label':'Choose the dealer take',onclick:()=>file.click(),onkeydown:e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();file.click();}},
      ondragover:e=>{e.preventDefault();zone.classList.add('over');},ondragleave:()=>zone.classList.remove('over'),
      ondrop:e=>{e.preventDefault();zone.classList.remove('over');const f=e.dataTransfer.files[0];if(f)upload(d,draft,f);}},
      file,h('strong',{},draft?.input?'Choose a different take':'Drop the take here, or click to choose it'),h('span',{},'It uploads to the pipeline server and is checked straight away.'));
    if(S.meta.hosted)return zone;
    const path=h('input',{type:'text',placeholder:'…or paste the full path of a video on this computer',spellcheck:false,'aria-label':'Path to the take'});
    return h('div',{},zone,h('div',{class:'pl-path-row'},path,busyButton('Use this file',async()=>{
      if(!path.value.trim())throw new Error('Paste the full path to the take first.');
      const run=draft||await createDraft(d);S.draft.error='';S.draft.upload={name:path.value.split(/[\\/]/).pop(),fraction:1,loaded:0,total:0,phase:'checking',controller:new AbortController()};render();
      try{S.run=await api(`/api/pipeline/runs/${run.id}/input-path`,'POST',{path:path.value});}catch(e){S.draft.error=e.message;}finally{S.draft.upload=null;await refreshRuns();go(d.id,run.id,{replace:true});}
    },{class:'quiet',busy:'Copying…'})));
  }
  async function createDraft(d){
    const o={...(S.draft.options||defaults(d))};if(o.autoApproveUSD==='')o.autoApproveUSD=null;
    const run=await api('/api/pipeline/runs','POST',{pipeline:d.id,name:S.draft.name||'',options:o});
    S.run=run;S.runId=run.id;history.replaceState(null,'',`#pipelines/${d.id}/${run.id}`);S.mode='detail';return run;
  }
  async function upload(d,draft,f){
    if(S.draft.upload)return;
    S.draft.error='';
    try{
      const run=draft||await createDraft(d),controller=new AbortController();
      S.draft.upload={name:f.name,fraction:0,loaded:0,total:f.size,phase:'uploading',controller};render();schedule();
      let last=0;
      S.run=await window.studio.upload(`/api/pipeline/runs/${run.id}/input?name=${encodeURIComponent(f.name)}`,f,{signal:controller.signal,onProgress:(p,l,t)=>{
        Object.assign(S.draft.upload,{fraction:p,loaded:l,total:t,phase:p>=1?'checking':'uploading'});if(Date.now()-last>250||p>=1){last=Date.now();render();}}});
    }catch(e){S.draft.error=e.name==='AbortError'?'Upload cancelled.':e.message;}
    finally{S.draft.upload=null;await refreshRuns().catch(()=>{});if(S.run)S.run=await api(`/api/pipeline/runs/${S.run.id}`).catch(()=>S.run);render();}
  }
  function validation(input){
    const ok=input.ok;
    return h('div',{class:`pl-check ${ok?'ok':'bad'}`,role:ok?'status':'alert'},
      h('div',{class:'pl-check-head'},icon(ok?'done':'failed'),h('strong',{},ok?'This take can be used':'This take can\'t be used'),h('span',{class:'muted'},input.name)),
      input.info?.summary&&h('p',{class:'pl-check-info'},input.info.summary),
      [...input.errors.map(e=>['bad',e]),...input.warnings.map(w=>['warn',w])].map(([k,e])=>h('div',{class:`pl-check-item ${k}`},h('strong',{},e.message),e.fix&&h('span',{},e.fix))));
  }
  // ── run detail
  function detail(main,run,d){
    const keys=S.meta.keys||{};
    sync(main,[
      {key:'head',sig:[run.id,run.name,run.status,run.input?.info?.summary,run.game,run.contract,run.startedAt,run.finishedAt,run.size,Math.floor(since(run.startedAt)/60)],build:()=>head(run,d)},
      {key:'progress',sig:[run.status,Math.round(run.progress*200),run.queuePosition,run.stages.map(s=>[s.status,s.typical]),Math.floor(since(run.startedAt)/30)],build:()=>overall(run)},
      {key:'stepper',sig:run.stages.map(s=>[s.id,s.status,s.off,s.progress?.done,s.progress?.total,s.skippedGeneration]),build:()=>stepper(run)},
      run.attention&&{key:`att-${run.attention.kind}`,sig:[run.attention,keys,run.stages.find(s=>s.id===run.attention.stage)?.estimate],build:()=>attention(run,d)},
      {key:'stages',sig:run.id,build:()=>h('div',{class:'pl-stages',id:'pl-stages'})},
      {key:'history',sig:[run.history?.length,run.history?.at(-1)?.at],build:()=>activity(run)}
    ]);
    sync($('pl-stages'),run.stages.map(s=>({key:`stage-${s.id}`,sig:run.id+s.id,build:()=>h('article',{class:'pl-stage',id:`pl-stage-${s.id}`})})));
    for(const s of run.stages)stageCard($(`pl-stage-${s.id}`),run,s,d);
  }
  function head(run,d){
    const menu=h('details',{class:'pl-menu'},h('summary',{class:'button quiet','aria-label':'More actions'},'More ▾'),h('div',{class:'pl-menu-list',role:'menu'},
      h('button',{role:'menuitem',disabled:['running','queued','draft'].includes(run.status),onclick:async()=>{menu.open=false;try{const r=await act('update-code',{},{confirm:'Copy the latest game code (and this app\'s pipeline definition) into this run?\n\nNothing is rebuilt or deleted. Afterwards, redo the stage your change affects.'});if(r?.message&&S.run?.attention?.kind!=='info')notify(r.message,'success');}catch(e){notify(e.message,'error');}}},
        h('strong',{},'Update game code'),h('span',{},'Copy your latest game code into this run; nothing is deleted')),
      h('button',{role:'menuitem',onclick:()=>{menu.open=false;redoDialog(run,run.stages[0]);}},h('strong',{},'Start over'),h('span',{},'Keep the take, redo every stage')),
      h('button',{role:'menuitem',class:'danger',onclick:async()=>{menu.open=false;
        if(!confirm(`Delete “${run.name}”?\n\nThis removes its take, clips, transitions and game build${run.size?` (${bytes(run.size)})`:''} from this computer. It can't be undone.${S.meta?.library&&run.stages?.find(s=>s.kind==='transitions')?.rows?.done?'\n\nTransitions you paid for stay in the library, so a new run of the same take reuses them for free.':''}${['running','queued'].includes(run.status)?'\n\nThe run is working right now; it will be stopped first.':''}`))return;
        try{await api(`/api/pipeline/runs/${run.id}`,'DELETE');S.run=null;S.runId=null;await refreshRuns();go(d.id,null,{replace:true});}catch(e){notify(e.message,'error');}}},h('strong',{},'Delete run'),h('span',{},'Remove all of its files from this computer'))));
    const live=['running','queued'].includes(run.status),graceful=run.history?.at(-1)?.text?.startsWith('Pausing after');
    const primary=live?busyButton(graceful?'Stop now':'Pause',async()=>{const r=await act('pause',{now:graceful});if(r?.graceful)notify('Pausing after the transitions in progress finish. Choose Stop now to stop them immediately.');},{class:'',busy:'Pausing…'})
      :['paused','failed'].includes(run.status)?busyButton(run.status==='failed'?'Retry':'Resume',()=>act('resume'),{class:'primary',busy:'Resuming…'})
      :run.status==='completed'&&run.stages.some(s=>s.artifacts?.site&&s.status==='done')&&S.meta.previews?busyButton('▶ Play the game',()=>play(run),{class:'primary',busy:'Opening…'}):null;
    const g=run.game;
    return h('header',{class:'pl-run-head'},
      h('div',{class:'pl-run-title'},h('h2',{},run.name),pill(run.status,RUN[run.status])),
      h('div',{class:'pl-run-actions'},primary,menu),
      h('p',{class:'pl-meta'},
        run.input?.info&&h('span',{title:'The take'},`🎞 ${run.input.name} · ${run.input.info.summary}`),
        g&&h('span',{title:'Game code used'},`⌥ ${g.source==='git'?`${g.ref} @ ${g.commit}`:`${g.commit||'local folder'}${g.dirty?` + ${g.dirty} uncommitted`:''}`}${run.contract==='game'?' · game contract':''}`),
        run.startedAt&&h('span',{},run.finishedAt?`Finished ${ago(run.finishedAt)} · took ${dur((Date.parse(run.finishedAt)-Date.parse(run.startedAt))/1000)}`:`Started ${ago(run.startedAt)}`),
        run.size&&h('span',{},`${bytes(run.size)} on disk`)));
  }
  function overall(run){
    const pct=Math.round(run.progress*100),live=run.stages.filter(s=>!s.off);
    let eta='';
    if(run.status==='running'){
      const left=live.filter(s=>!['done','skipped'].includes(s.status)).reduce((n,s)=>{const t=s.typical;if(!t)return NaN;return n+(s.status==='running'?Math.max(t*.1,t-since(s.startedAt)):t);},0);
      eta=Number.isFinite(left)&&left>0?`about ${dur(left)} left`:'';
    }
    const text={queued:run.queuePosition>1?`Queued · ${run.queuePosition-1} run${run.queuePosition>2?'s':''} ahead`:'Starting…',running:`${pct}%${eta?` · ${eta}`:''}`,waiting:`${pct}% · waiting for you`,paused:`${pct}% · paused`,failed:`${pct}% · stopped`,completed:'Complete'}[run.status]||'';
    return h('div',{class:'pl-overall'},h('span',{class:'pl-bar big',role:'progressbar','aria-valuenow':pct,'aria-valuemin':0,'aria-valuemax':100,'aria-label':'Run progress'},h('span',{class:`s-${run.status}`,style:`width:${run.status==='completed'?100:pct}%`})),h('span',{class:'pl-overall-text'},text));
  }
  function stepper(run){
    return h('ol',{class:'pl-stepper'},run.stages.map((s,i)=>h('li',{class:`s-${s.off?'skipped':s.status}`},
      h('button',{class:'pl-step-node',onclick:()=>{S.expanded.set(s.id,true);render();$(`pl-stage-${s.id}`)?.scrollIntoView({behavior:'smooth',block:'start'});}},
        h('span',{class:'pl-step-n'},s.status==='done'?'✓':s.status==='failed'?'!':s.status==='waiting'?'?':String(i+1)),
        h('span',{class:'pl-step-label'},h('strong',{},s.title),h('span',{},s.off?'Off':s.skippedGeneration?'Stand-ins':s.status==='running'&&s.progress?.total?`${s.progress.done}/${s.progress.total}`:STAGE[s.status]))))));
  }
  function attention(run,d){
    const a=run.attention,stage=run.stages.find(s=>s.id===a.stage),kind=a.kind,keys=S.meta.keys||{};
    const tone=kind==='error'||kind==='provider'?'bad':kind==='info'?'info':'warn';
    const titles={approval:'Approve spending',keys:'Add a key to continue',rows:'Some transitions failed',ingest:'Some transitions couldn\'t be brought in',review:'Review the transitions',error:`${stage?.title||'The run'} stopped`,provider:'Generation paused',interrupted:'The server restarted',rebuild:'Rebuild the game',info:'Game code updated'};
    const body=[h('p',{class:'pl-att-msg'},a.message)];
    if(kind==='approval'&&stage?.estimate)body.push(estimateTable(stage.estimate));
    if(a.fix)body.push(h('p',{class:'pl-att-fix'},a.fix));
    if(a.detail&&kind!=='approval')body.push(h('pre',{class:'pl-att-detail'},a.detail));
    const actions=[];
    const need=(kind==='keys'?a.actions:kind==='approval'?neededProviders(stage):[]).filter(p=>!keys[p]);
    if(need.length)body.push(keyInputs(need,kind==='keys'?'It starts as soon as you add it.':'Approving also needs this key; add it before or after.'));
    if(kind==='approval'){actions.push(busyButton('Approve & generate',()=>act('approve',{}),{class:'primary',busy:'Approving…'}),
      busyButton('Skip: use free stand-ins',()=>act('approve',{skip:true},{confirm:'Build the game with the optical-flow stand-ins instead of generated transitions?\n\nIt\'s free and quick, but the moves between clips look less natural. You can generate them later with Redo on Transitions.'}),{class:'quiet',busy:'Skipping…'}));}
    if(kind==='rows'){actions.push(busyButton(`Retry ${run.stages.find(s=>s.kind==='transitions')?.rows?.failed||''} failed`,()=>act('retry-rows',{which:'failed'}),{class:'primary',busy:'Retrying…'}),
      busyButton('Continue without them',()=>act('proceed',{},{confirm:'Continue without the failed transitions? The game plays an optical-flow stand-in for each one. You can retry them later.'}),{class:'quiet'}),
      h('button',{class:'quiet',onclick:()=>{S.rows.filter='failed';S.rows.page=0;S.expanded.set(stage.id,true);refreshRows(true);$(`pl-stage-${stage.id}`)?.scrollIntoView({behavior:'smooth'});}},'See them'));}
    if(kind==='ingest'){actions.push(busyButton('Regenerate them',()=>act('retry-rows',{which:'ingest'}),{class:'primary'}),busyButton('Continue',()=>act('proceed'),{class:'quiet'}));}
    if(kind==='review'){actions.push(busyButton('Build the game',()=>act('proceed'),{class:'primary',busy:'Building…'}),h('button',{class:'quiet',onclick:()=>{S.rows.filter='flagged';S.rows.page=0;S.expanded.set(stage.id,true);refreshRows(true);$(`pl-stage-${stage.id}`)?.scrollIntoView({behavior:'smooth'});}},'Show flagged'));}
    if(['error','provider','interrupted','rebuild'].includes(kind))actions.push(busyButton({error:'Retry this stage',provider:'Resume',interrupted:'Resume',rebuild:'Rebuild the game'}[kind],()=>act('resume'),{class:'primary',busy:'Resuming…'}));
    if(kind==='error'&&stage){actions.push(h('button',{class:'quiet',onclick:()=>redoDialog(run,stage)},'Redo…'),h('button',{class:'quiet',onclick:()=>logDialog(run,stage)},'Open log'));}
    if(kind==='provider'&&/key|401|403/i.test(a.message+a.detail))body.push(keyInputs(['fal'],'Paste a working key, then resume.'));
    if(['info','interrupted'].includes(kind))actions.push(busyButton('Dismiss',()=>act('dismiss'),{class:'quiet'}));
    return h('section',{class:`pl-attention ${tone}`,role:tone==='bad'?'alert':'status'},h('div',{class:'pl-att-head'},icon(tone==='bad'?'failed':tone==='info'?'done':'waiting'),h('h3',{},titles[kind]||'Needs you')),...body,actions.length?h('div',{class:'actions'},actions):null);
  }
  function neededProviders(stage){const set=new Set();for(const g of stage?.estimate?.groups||[]){const m=window.studioUI?.methods().find(x=>x.id===g.method);if(m&&m.provider!=='local')set.add(m.provider);if(g.review!=='off')set.add('fal');}return [...set];}
  function keyInputs(providers,note){
    return h('div',{class:'pl-keys'},providers.map(p=>{const input=h('input',{type:'password',autocomplete:'off',spellcheck:false,placeholder:`Paste your ${KEYNAME[p]} key`,'aria-label':`${KEYNAME[p]} key`});
      return h('div',{class:'pl-key-row'},input,busyButton(`Use ${KEYNAME[p]} key`,async()=>{await setKey(p,input.value);input.value='';notify(`${KEYNAME[p]} key added.`);},{class:'accent',busy:'Saving…'}));}),
      h('p',{class:'help'},note,' Keys stay in this server\'s memory only.'));
  }
  function estimateTable(est){
    return h('div',{class:'pl-estimate'},
      h('div',{class:'pl-est-total'},h('span',{},h('strong',{},`${money(est.cost[0])}–${money(est.cost[1])}`),' estimated'),h('span',{},h('strong',{},`${dur(est.time[0])}–${dur(est.time[1])}`),' at this run\'s parallelism'),h('span',{},h('strong',{},plural(est.rows,'transition')))),
      h('table',{class:'pl-table compact'},h('thead',{},h('tr',{},h('th',{},'Method'),h('th',{},'Rows'),h('th',{},'AI review'),h('th',{},'Cost'))),
        h('tbody',{},est.groups.map(g=>h('tr',{},h('td',{},`${g.method} · ${g.duration}s`),h('td',{},String(g.rows)),h('td',{},g.review==='redo'?'Review + redo':g.review==='review'?'Flag only':'—'),h('td',{},`${money(g.cost[0])}–${money(g.cost[1])}`))))),
      h('p',{class:'help'},`Rough planning ranges from published prices, not a quote. Finished transitions are never paid for twice: not after a restart${S.meta?.library?', and not after a redo that leaves their clips unchanged':''}.`));
  }
  // ── stage cards
  function stageCard(card,run,s,d){
    const open=S.expanded.has(s.id)?S.expanded.get(s.id):['running','failed','waiting','paused'].includes(s.status)||(run.status==='completed'&&s.artifacts)||(run.status==='draft');
    card.className=`pl-stage s-${s.off?'skipped':s.status}${open?' open':''}`;
    const items=[
      {key:'head',sig:[s.status,s.off,s.title,s.elapsed,s.typical,s.skippedGeneration,open,run.status,s.status==='running'?Math.floor(since(s.startedAt)/20):0],build:()=>stageHead(run,s,open)},
    ];
    if(open){
      items.push({key:'summary',sig:[s.summary,s.off,s.error,s.skippedGeneration],build:()=>h('div',{class:'pl-stage-summary'},h('p',{},s.summary),s.off&&h('p',{class:'muted'},'Turned off for this run.'),s.skippedGeneration&&h('p',{class:'muted'},'Skipped: the game plays the free optical-flow stand-ins. Redo this stage to generate them.'))});
      if(s.steps?.length&&!s.off)items.push({key:'steps',sig:[s.steps.map(x=>[x.status,x.note,x.typical]),s.status==='running'?Math.floor(Date.now()/10000):0],build:()=>steps(run,s)});
      if(s.kind==='transitions'&&!s.off&&!s.skippedGeneration&&(s.rows||s.estimate))items.push({key:'rows',sig:[S.rows.data,S.rows.filter,S.rows.page,s.rows,s.status],build:()=>rowsPanel(run,s)});
      if(s.gallery&&s.steps.some(x=>x.id==='review'&&['done','cached'].includes(x.status)))items.push({key:'gallery',sig:[run.id,s.gallery,S.gallery.get(run.id)?.length],build:()=>gallery(run,s)});
      if(s.artifacts&&s.status==='done')items.push({key:'game',sig:[run.id,S.meta.previews,run.stages.find(x=>x.kind==='transitions')?.rows,run.stages.find(x=>x.kind==='transitions')?.skippedGeneration],build:()=>gamePanel(run,s)});
      if(s.tail?.length&&!s.off)items.push({key:'tail',sig:[s.tail.at(-1)?.t,s.tail.length,s.tail.at(-1)?.x],build:()=>tail(run,s)});
    }
    sync(card,items);
  }
  function stageHead(run,s,open){
    const idx=run.stages.indexOf(s),status=s.off?'skipped':s.status;
    const time=s.status==='running'?`${dur(since(s.startedAt))}${s.typical?` of ~${dur(s.typical)}`:''}`:s.elapsed?dur(s.elapsed):s.typical&&s.status==='pending'?`usually ~${dur(s.typical)}`:'';
    const canRedo=run.status!=='draft'&&!s.off&&(s.status!=='pending'||run.stages.slice(idx+1).some(x=>x.status!=='pending'));
    return h('header',{class:'pl-stage-head'},
      h('button',{class:'pl-stage-toggle','aria-expanded':String(open),onclick:()=>{S.expanded.set(s.id,!open);render();}},
        h('span',{class:`pl-stage-n s-${status}`},status==='done'?'✓':status==='failed'?'!':String(idx+1)),
        h('span',{class:'pl-stage-title'},h('strong',{},s.title),h('span',{class:'pl-stage-state'},s.off?'Off for this run':s.skippedGeneration?'Skipped: stand-ins play':STAGE[s.status],time&&h('span',{class:'muted'},` · ${time}`)))),
      h('div',{class:'pl-stage-actions'},
        s.status!=='pending'&&!s.off&&h('button',{class:'quiet small',onclick:()=>logDialog(run,s)},'Log'),
        canRedo&&h('button',{class:'quiet small',onclick:()=>redoDialog(run,s)},'Redo…')));
  }
  function steps(run,s){
    return h('ol',{class:'pl-steps'},s.steps.map(x=>h('li',{class:`s-${x.status}`},icon(x.status),
      h('div',{class:'pl-step-text'},h('strong',{},x.title),x.detail&&h('span',{class:'muted'},x.detail)),
      h('span',{class:'pl-step-meta'},x.status==='running'?`${dur(since(x.startedAt))}${x.typical?` / ~${dur(x.typical)}`:''}`:[STEP[x.status],x.note].filter(Boolean).join(' · ')))));
  }
  function tail(run,s){
    const pre=h('pre',{class:'pl-tail','aria-label':`${s.title} log, latest lines`},s.tail.map(l=>h('span',{class:l.s?'err':''},`${l.t}  ${l.x}\n`)));
    requestAnimationFrame(()=>{pre.scrollTop=pre.scrollHeight;});
    return h('div',{class:'pl-tail-wrap'},pre,h('button',{class:'quiet small',onclick:()=>logDialog(run,s)},'Open full log'));
  }
  async function loadGallery(run,s){
    if(S.gallery.has(run.id))return;S.gallery.set(run.id,[]);
    try{const {images}=await api(`/api/pipeline/runs/${run.id}/gallery?stage=${s.id}`);S.gallery.set(run.id,images);render();}catch{S.gallery.delete(run.id);}
  }
  function gallery(run,s){
    const images=S.gallery.get(run.id);if(!images)loadGallery(run,s);
    return h('div',{class:'pl-gallery'},h('h4',{},'Contact sheets',h('span',{class:'muted'},' — a still of every cut. Check the cuts land on her resting pose.')),
      images?.length?h('div',{class:'pl-thumbs'},images.map(img=>h('button',{class:'pl-thumb',onclick:()=>imageDialog(img,images)},h('img',{src:img.url,alt:img.name,loading:'lazy'})))):h('p',{class:'muted'},'Loading…'));
  }
  function gamePanel(run,s){
    const tx=run.stages.find(x=>x.kind==='transitions'),done=tx?.rows?.done||0;
    return h('div',{class:'pl-game'},
      h('div',{class:'pl-game-copy'},h('h4',{},'Your table is built'),
        h('p',{},tx?.skippedGeneration?'Transitions: the free optical-flow stand-ins.':tx?`Transitions: ${plural(done,'generated transition')}${tx.rows?.skipped?`, ${tx.rows.skipped} using stand-ins`:''}.`:''),
        h('p',{class:'help'},S.meta.previews?'Play it here in a new tab (served from this computer), or download it. The game ZIP is a static site you can host anywhere, e.g. Vercel or Render.':'Download the game; it\'s a static site you can host anywhere.')),
      h('div',{class:'actions'},
        S.meta.previews&&busyButton('▶ Play the game',()=>play(run),{class:'primary',busy:'Opening…'}),
        s.artifacts.site&&h('a',{class:'button',href:`/pipeline-download/${run.id}/site.zip`,download:''},'Download game (ZIP)'),
        s.artifacts.assets&&h('a',{class:'button quiet',href:`/pipeline-download/${run.id}/assets.zip`,download:''},'Download clips only')));
  }
  async function play(run){
    const tab=window.open('about:blank','_blank');
    try{const {url}=await api(`/api/pipeline/runs/${run.id}/preview`,'POST',{});if(tab){tab.location.href=url;}else window.open(url,'_blank');}
    catch(e){tab?.close();throw e;}
  }
  // ── transitions table
  function rowsPanel(run,s){
    const data=S.rows.data,c=data?.counts||{},filters=[['all','All'],['flagged','Flagged'],['failed','Failed'],['running','Running'],['pending','Waiting'],['done','Done'],['skipped','Stand-in']];
    const bar=s.rows?(()=>{const total=Object.entries(s.rows).filter(([k])=>k!=='invalid').reduce((n,[,v])=>n+v,0)||1;
      return h('span',{class:'pl-bar seg','aria-hidden':'true'},['done','skipped','running','failed'].map(k=>s.rows[k]?h('span',{class:`s-${k==='done'?'done':k==='skipped'?'skipped':k}`,style:`width:${100*s.rows[k]/total}%`}):null));})():null;
    return h('div',{class:'pl-rows'},
      s.rows&&h('div',{class:'pl-rows-summary'},bar,h('p',{},[s.rows.done&&`${s.rows.done} done`,s.rows.running&&`${s.rows.running} generating`,s.rows.pending&&`${s.rows.pending} waiting`,s.rows.failed&&`${s.rows.failed} failed`,s.rows.skipped&&`${s.rows.skipped} using stand-ins`,s.rows.invalid&&`${s.rows.invalid} can't run`].filter(Boolean).join(' · '))),
      data?.registry&&h('p',{class:'help'},`In the game: ${data.registry}.`),
      h('div',{class:'pl-filters',role:'tablist','aria-label':'Filter transitions'},filters.filter(([k])=>k==='all'||c[k]).map(([k,label])=>h('button',{role:'tab','aria-selected':String(S.rows.filter===k),class:`pl-filter${S.rows.filter===k?' on':''}`,
        onclick:()=>{S.rows.filter=k;S.rows.page=0;refreshRows(true);}},label,h('span',{class:'pl-count'},String(c[k]||0))))),
      !data?h('p',{class:'muted'},'Loading transitions…'):!data.rows.length?h('p',{class:'muted'},'Nothing here.'):
      h('div',{class:'pl-table-wrap'},h('table',{class:'pl-table'},h('thead',{},h('tr',{},h('th',{},'#'),h('th',{},'Transition'),h('th',{},'Method'),h('th',{},'Status'),h('th',{},h('span',{class:'sr-only'},'Actions')))),
        h('tbody',{},data.rows.map(r=>h('tr',{class:`t-${r.tag}`},
          h('td',{class:'num'},String(r.number)),
          h('td',{},h('span',{class:'pl-tx-name'},r.output.replace(/\.mp4$/,'')),r.phase&&h('span',{class:'pl-tx-phase'},r.phase)),
          h('td',{},`${r.method} · ${r.duration}s`),
          h('td',{},rowStatus(r)),
          h('td',{class:'pl-row-actions'},
            r.hasOutput&&h('button',{class:'quiet small',onclick:()=>rowDialog(run,r),'aria-label':`Watch ${r.output}`},'Watch'),
            ['failed','done'].includes(r.state)&&!['running','queued'].includes(run.status)&&busyButton(r.state==='failed'?'Retry':'Redo',()=>act('retry-rows',{which:[r.key]},{confirm:`${r.state==='failed'?'Retry':'Regenerate'} ${r.output}?${r.state==='done'?' Its current video is replaced.':''} This uses provider credits, and the game is rebuilt afterwards.`}),{class:'quiet small'}))))))),
      data&&data.pages>1&&h('div',{class:'pl-pager'},h('button',{class:'quiet small',disabled:data.page===0,onclick:()=>{S.rows.page--;refreshRows(true);}},'← Previous'),h('span',{},`Page ${data.page+1} of ${data.pages}`),h('button',{class:'quiet small',disabled:data.page>=data.pages-1,onclick:()=>{S.rows.page++;refreshRows(true);}},'Next →')));
  }
  function rowStatus(r){
    const bits=[];
    if(r.state==='failed')bits.push(h('span',{class:'pl-tag bad',title:r.error},'Failed'),h('span',{class:'pl-row-err'},r.error.slice(0,140)));
    else if(r.state==='running')bits.push(h('span',{class:'pl-tag run'},'Generating'));
    else if(r.state==='pending')bits.push(h('span',{class:'pl-tag'},'Waiting'));
    else if(r.state==='skipped')bits.push(h('span',{class:'pl-tag'},'Stand-in'));
    else if(r.state==='invalid')bits.push(h('span',{class:'pl-tag bad',title:r.error},'Can\'t run'));
    else{
      if(r.verdict==='reject')bits.push(h('span',{class:'pl-tag bad',title:r.verdictNote},'Rejected'));
      else if(r.review?.verdict==='needs_review')bits.push(h('span',{class:'pl-tag warn',title:r.review.summary},'AI: check it'));
      else if(r.review?.verdict==='pass')bits.push(h('span',{class:'pl-tag ok',title:r.review.summary},'AI: passed'));
      else bits.push(h('span',{class:'pl-tag ok'},'Done'));
      if(r.reused)bits.push(h('span',{class:'pl-tag',title:'Made earlier from identical clips; reused without charge.'},'Reused'));
      const flags=[...(r.quality?.flags||[]),...(r.ingest?.flags||[])];
      if(r.ingest&&!r.ingest.ok)bits.push(h('span',{class:'pl-tag bad',title:r.ingest.reason},'Not in game'));
      else if(flags.length)bits.push(h('span',{class:'pl-tag warn',title:flags.join(', ')},`Check: ${[...new Set(flags)].slice(0,2).join(', ')}`));
      if(r.review?.redoCount)bits.push(h('span',{class:'pl-tag'},`${plural(r.review.redoCount,'redo')}`));
    }
    return h('span',{class:'pl-row-status'},bits);
  }
  // ── dialogs
  function openDialog(title,content,{wide=false,onClose}={}){
    dialog.className=`pl-dialog${wide?' wide':''}`;
    dialog.replaceChildren(h('div',{class:'pl-dialog-head'},h('h2',{id:'pl-dialog-title'},title),h('button',{class:'quiet small','aria-label':'Close',onclick:()=>dialog.close()},'Close')),content);
    dialog.onclose=()=>{for(const v of dialog.querySelectorAll('video'))v.pause();clearInterval(S.timers.log);onClose?.();};
    if(!dialog.open)dialog.showModal();
  }
  function redoDialog(run,stage){
    const idx=run.stages.indexOf(stage),later=run.stages.slice(idx+1).filter(s=>!s.off&&s.status!=='pending');
    const steps=stage.steps?.length>1&&stage.kind==='command'?stage.steps:[];
    let from='',fresh=false;
    const what=h('div',{class:'pl-redo-what'});
    function describe(){
      const stepIdx=from?steps.findIndex(s=>s.id===from):0,wiped=from?steps.slice(stepIdx):steps,kept=from?steps.slice(0,stepIdx):[];
      const tx=run.stages.find(s=>s.kind==='transitions'),paid=tx&&(tx===stage||later.includes(tx))&&tx.rows?.done;
      what.replaceChildren(...[
        h('p',{},h('strong',{},'Deletes: '),[stage.kind==='prepare'?'everything this run has made (the take is kept)':`${stage.title}${from?` from “${steps[stepIdx].title}”`:''}`,...later.map(s=>s.title)].join(', ')+'.'),
        kept.length?h('p',{},h('strong',{},'Keeps: '),kept.map(s=>s.title).join(', '),' (reused, not redone).'):null,
        paid&&!S.meta?.library?h('p',{class:'pl-warn-inline'},`This deletes ${plural(paid,'generated transition')} you paid for. They'll be generated (and charged) again.`):null,
        paid&&S.meta?.library?h('div',{class:fresh?'pl-warn-inline':'help'},h('p',{},fresh?`All ${plural(paid,'transition')} will be generated (and charged) again.`:`The ${plural(paid,'transition')} you paid for are kept. Any whose clips come out the same are reused for free; only changed ones are generated and charged.`),
          h('label',{class:'check'},h('input',{type:'checkbox',checked:fresh,onchange:e=>{fresh=e.target.checked;describe();}}),' Regenerate them all anyway (pays again)')):null,
        stage.kind==='prepare'?h('p',{class:'help'},'Your latest game code is copied in again first.'):null].filter(Boolean));
    }
    describe();
    const choices=steps.length?h('fieldset',{class:'pl-choice'},h('legend',{},'Redo from'),
      [['','The whole stage'],...steps.filter(s=>['done','cached','failed'].includes(s.status)).map(s=>[s.id,s.title])].map(([id,t])=>h('label',{class:'check'},h('input',{type:'radio',name:'pl-redo',checked:id===from,onchange:()=>{from=id;describe();}}),` ${t}`))):null;
    openDialog(`Redo ${stage.title}?`,h('div',{class:'pl-dialog-body'},
      h('p',{},stage.kind==='prepare'?'Start this run over with the same take.':'Use this when something in this stage looks wrong, or after changing how it works in the game repo (use More ▾ › Update game code first).'),
      choices,what,
      ['running','queued'].includes(run.status)&&h('p',{class:'pl-warn-inline'},'The run is working right now; it will be stopped first.'),
      h('div',{class:'actions end'},h('button',{class:'quiet',onclick:()=>dialog.close()},'Cancel'),
        busyButton('Delete & redo',async()=>{await act('redo',{stage:stage.id,step:from||undefined,fresh:fresh||undefined});dialog.close();S.expanded.set(stage.id,true);},{class:'danger',busy:'Redoing…'}))));
  }
  async function logDialog(run,stage){
    const pre=h('pre',{class:'pl-log'},'Loading…');let offset=0,first=true;
    const load=async()=>{
      try{const r=await api(`/api/pipeline/runs/${run.id}/log?stage=${stage.id}&offset=${first?0:offset}`);
        const atEnd=pre.scrollHeight-pre.scrollTop-pre.clientHeight<40;
        if(first){pre.textContent=r.truncated?'… (earlier lines omitted)\n'+r.text:r.text||'(empty)';first=false;}else if(r.text)pre.append(r.text);
        offset=r.offset;if(atEnd)pre.scrollTop=pre.scrollHeight;}catch(e){pre.textContent=e.message;}
    };
    openDialog(`${stage.title} log`,h('div',{class:'pl-dialog-body'},pre,h('div',{class:'actions end'},h('a',{class:'button quiet',href:'#',onclick:e=>{e.preventDefault();const blob=new Blob([pre.textContent],{type:'text/plain'}),a=h('a',{href:URL.createObjectURL(blob),download:`${run.name}-${stage.id}.log`});a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000);}},'Save log'),h('button',{class:'quiet',onclick:()=>dialog.close()},'Close'))),{wide:true});
    await load();requestAnimationFrame(()=>{pre.scrollTop=pre.scrollHeight;});
    clearInterval(S.timers.log);S.timers.log=setInterval(()=>{if(dialog.open&&['running','queued'].includes(S.run?.status))load();},1500);
  }
  function imageDialog(img,all){
    let i=all.indexOf(img);
    const pic=h('img',{class:'pl-full',src:img.url,alt:img.name}),label=h('span',{class:'muted'},`${i+1} of ${all.length}`);
    const show=d=>{i=(i+d+all.length)%all.length;pic.src=all[i].url;pic.alt=all[i].name;label.textContent=`${i+1} of ${all.length}`;};
    openDialog('Contact sheet',h('div',{class:'pl-dialog-body',onkeydown:e=>{if(e.key==='ArrowRight')show(1);if(e.key==='ArrowLeft')show(-1);}},pic,h('div',{class:'actions end'},h('button',{class:'quiet',onclick:()=>show(-1)},'← Previous'),label,h('button',{class:'quiet',onclick:()=>show(1)},'Next →'),h('a',{class:'button quiet',href:img.url,target:'_blank',rel:'noopener'},'Open full size'))),{wide:true});
  }
  function rowDialog(run,r){
    const video=h('video',{src:`/pipeline-files/${run.id}/transitions/${encodeURIComponent(r.output)}`,controls:true,loop:true,autoplay:true,muted:true,playsInline:true,class:'pl-video'});
    const speed=h('div',{class:'pl-speed',role:'group','aria-label':'Playback speed'},[1,.5,.25].map(v=>h('button',{class:`quiet small${v===1?' on':''}`,onclick:e=>{video.playbackRate=v;for(const b of e.target.parentNode.children)b.classList.toggle('on',b===e.target);}},`${v}×`)));
    const note=h('input',{type:'text',placeholder:'What\'s wrong? (optional, saved with a rejection)',maxlength:300});
    const ingested=!!S.rows.data?.ingestedAt&&r.ingest?.ok!==false;
    const details=[
      ['Plays in the game',r.plays?(r.plays.rejected?'Stand-in (rejected)':r.plays.source==='tool'?'This generated transition':'Optical-flow stand-in'):'—'],
      ['From → to',`${r.first} → ${r.second}`],['Method',`${r.method}, ${r.duration} s`],
      ['AI review',r.review?`${r.review.verdict==='pass'?'Passed':'Needs a look'}: ${r.review.summary}`:'Not reviewed'],
      ['Checks',[...new Set([...(r.quality?.flags||[]),...(r.ingest?.flags||[])])].join(', ')||'No flags'],
      ['Provider requests',`${r.requests.join(', ')||'—'}${r.reused?' (from earlier work, reused free)':''}`]];
    openDialog(r.output.replace(/\.mp4$/,''),h('div',{class:'pl-dialog-body'},
      h('p',{class:'help'},'Each video is the clip it leaves, the generated move, and the clip it lands in. Watch the two joins.'),
      video,speed,
      h('dl',{class:'pl-dl'},details.map(([k,v])=>[h('dt',{},k),h('dd',{},v)])),
      r.review?.issues?.length?h('ul',{class:'pl-issues'},r.review.issues.map(i=>h('li',{},`${i.severity} ${i.category} at ${i.time.toFixed(2)}s: ${i.evidence}`))):null,
      ingested?h('div',{class:'pl-verdict'},note,h('div',{class:'actions'},
        busyButton(r.verdict==='reject'?'Rejected — update note':'Reject: play a stand-in',async()=>{await act('verdict',{output:r.output,value:'reject',note:note.value});dialog.close();},{class:'danger'}),
        r.verdict==='reject'&&busyButton('Accept it again',async()=>{await act('verdict',{output:r.output,value:'ok'});dialog.close();},{class:'quiet'}),
        !['running','queued'].includes(run.status)&&busyButton('Regenerate',async()=>{await act('retry-rows',{which:[r.key]},{confirm:`Regenerate ${r.output}? This uses provider credits, and the game is rebuilt afterwards.`});dialog.close();},{class:'quiet'})),
        h('p',{class:'help'},'Rejecting or regenerating marks the game for a rebuild; make all your changes, then rebuild once.')):
        h('p',{class:'help'},'You can reject or regenerate a transition once it\'s been brought into the game.')),{wide:true});
  }
  function activity(run){
    return h('details',{class:'pl-history'},h('summary',{},'Activity'),h('ol',{},[...(run.history||[])].reverse().map(e=>h('li',{},h('time',{datetime:e.at,title:new Date(e.at).toLocaleString()},new Date(e.at).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})),' ',e.text))));
  }
  const debounce=(key,fn,ms)=>{clearTimeout(S.timers[key]);S.timers[key]=setTimeout(fn,ms);};
  // ── start
  async function boot(){
    try{await loadMeta();}catch(e){root.replaceChildren(h('p',{class:'pl-error-line'},`Couldn't load pipelines: ${e.message}`));return;}
    if(!location.hash.startsWith('#pipelines')&&window.Shell?.current()==='pipelines')history.replaceState(null,'','#pipelines');
    route();await refreshRuns().catch(()=>{});
    if(S.meta.enabled&&!S.runId&&S.mode!=='new'){const r=S.runs.find(x=>x.pipeline===S.pipeline&&['running','waiting','failed','queued','paused'].includes(x.status))||S.runs.find(x=>x.pipeline===S.pipeline);if(r)go(r.pipeline,r.id,{replace:true});}
    render();await refreshRun(true);schedule();
    setInterval(()=>{if(S.run&&['running','queued'].includes(S.run.status))render();},10000);
  }
  window.addEventListener('studio:keys',e=>{if(S.meta){S.meta.keys={...S.meta.keys,...e.detail};render();}});
  boot();
})();
