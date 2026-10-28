/* Human review of flagged batch outputs: watch every clip the AI review could not approve,
   decide Fine or Redo one by one or from the grid, then apply. Fine moves the clip from
   needs-review/ to approved/; Redo moves it to rejected/ and queues the row again with the
   chosen redo method, reviewed by the AI again. Decisions are checkpointed with the row. */
(()=>{
  const $=id=>document.getElementById(id),batch=window.studioBatch;
  const PAD=.6; // seconds of source shown either side of the bridge when looping the join
  const SPEEDS=[1,.5,.25];
  let root=null,filter='todo',focus=-1,speed=0,loopJoin=true,observer=null;
  const urls=new Map(); // row id -> object URL
  const q=()=>batch.queue;
  const flagged=()=>(q()?.rows||[]).filter(r=>['saved','buffered'].includes(r.state)&&r.result?.review?.verdict==='needs_review'&&!r.humanReview);
  const decided=r=>r.humanDecision;
  const visible=()=>flagged().filter(r=>filter==='all'||(filter==='todo'?!decided(r):decided(r)===filter));
  const inPlace=()=>q()?.destination==='replace';
  const canRedo=()=>(q()?.workflow||'generate')==='generate';
  const short=(text,n)=>!text?'':text.length>n?text.slice(0,n-1).trimEnd()+'…':text;
  function issues(row){
    const review=row.result.review,attempt=review.attempts?.find(a=>a.attempt===(review.selectedAttempt??0))??review.attempts?.at(-1);
    return (attempt?.assessment?.issues||[]).slice().sort((a,b)=>(b.severity==='major')-(a.severity==='major'));
  }
  function joinWindow(row){
    const r=row.result,start=Number(r?.joinStart),len=Number(r?.bridgeDuration);
    return Number.isFinite(start)&&Number.isFinite(len)?[Math.max(0,start-PAD),start+len+PAD]:null;
  }

  // ---- where the clips are
  function folder(){
    if(root)return root;
    const d=batch.destination;return d&&q()?.destination!=='zip'?d:null;
  }
  async function clipFile(row){
    const held=batch.buffered.find(x=>x.id===row.id);if(held)return held.blob;
    const dir=folder();if(!dir)return null;
    try{return await (await BatchReplace.handle(dir,row.savedName||row.name)).getFile();}catch(e){if(e.name==='NotFoundError')return null;throw e;}
  }
  async function clipURL(row){
    if(urls.has(row.id))return urls.get(row.id);
    const file=await clipFile(row);if(!file)return null;
    const url=URL.createObjectURL(file);urls.set(row.id,url);return url;
  }
  function forget(){for(const url of urls.values())URL.revokeObjectURL(url);urls.clear();}
  async function dirOf(base,path,create){let dir=base;for(const s of path)dir=await dir.getDirectoryHandle(s,{create});return dir;}
  async function exists(base,path){try{await BatchReplace.handle(base,path);return true;}catch(e){if(e.name==='NotFoundError'||e.name==='TypeMismatchError')return false;throw e;}}
  async function free(base,path){
    // never overwrite: clip.mp4, clip (2).mp4, clip (3).mp4 ...
    if(!await exists(base,path))return path;
    const m=path.match(/^(.*?)(\.[^./]+)?$/);
    for(let n=2;n<1000;n++){const p=`${m[1]} (${n})${m[2]||''}`;if(!await exists(base,p))return p;}
    throw new Error(`No free filename for ${path}.`);
  }
  async function move(base,from,to){
    const src=await BatchReplace.handle(base,from),file=await src.getFile(),target=await free(base,to);
    const parts=target.split('/'),name=parts.pop(),dir=await dirOf(base,parts,true);
    const out=await dir.getFileHandle(name,{create:true}),writable=await out.createWritable();
    try{await writable.write(file);await writable.close();}catch(e){await writable.abort?.().catch(()=>{});await dir.removeEntry(name).catch(()=>{});throw e;}
    const fromParts=from.split('/'),fromName=fromParts.pop();
    await (await dirOf(base,fromParts,false)).removeEntry(fromName);
    return target;
  }
  const swapFolder=(path,to)=>path.replace(/^needs-review\//,'')===path?`${to}/${path}`:`${to}/${path.slice('needs-review/'.length)}`;

  // ---- redo settings
  function redoSettings(row){
    const methods=window.studioUI.methods(),choice=$('hr-redo-method').value,frozen=row.resolvedSettings||batch.resolve(row);
    const id=choice==='auto'?({film:'rife',rife:'film'}[frozen.method]||frozen.method):choice;
    const m=methods.find(x=>x.id===id);if(!m)throw new Error(`Unknown redo method: ${id}.`);
    const whole=m.provider!=='local'&&m.kind!=='interpolation';
    const fits=frozen.duration>=m.min&&frozen.duration<=m.max&&(!whole||Number.isInteger(frozen.duration));
    return {method:id,duration:fits?frozen.duration:m.defaultDuration,provider:m.provider,methodSource:'human redo',durationSource:fits?'human redo':'method default',settingSource:'human redo'};
  }

  // ---- decisions
  async function decide(row,value){
    const current=q()?.rows.find(r=>r.id===row.id);if(!current)return;
    if(value==='redo'&&(!canRedo()||inPlace()))return batch.message('Redo needs a "Generate from source clips" batch. Mark it Fine, or regenerate it from a new CSV.',true);
    if(value)current.humanDecision=value;else delete current.humanDecision;
    try{await batch.checkpoint({row:current});}catch(e){batch.message(`Decision not saved: ${e.message}`,true);}
    render();
  }
  async function markRest(){
    const rows=flagged().filter(r=>!decided(r));if(!rows.length)return;
    if(!confirm(`Mark all ${rows.length} undecided clip${rows.length===1?'':'s'} as Fine?`))return;
    for(const r of rows)r.humanDecision='pass';
    try{await batch.checkpoint({rows});}catch(e){batch.message(`Decisions not saved: ${e.message}`,true);}
    render();
  }

  // ---- apply: runs under the batch's exclusive lease, on rows re-read from the checkpoint
  async function apply(){
    const queue=q(),rows=flagged().filter(decided),pass=rows.filter(r=>r.humanDecision==='pass'),redo=rows.filter(r=>r.humanDecision==='redo');
    if(!rows.length)return;
    const dir=folder(),onDisk=rows.filter(r=>r.state==='saved'&&!inPlace());
    if(onDisk.length&&!dir)throw new Error('Choose the results folder first, so approved and rejected clips can be moved.');
    if(redo.length){
      const s=redoSettings(redo[0]),methods=[...new Set(redo.map(r=>redoSettings(r).method))].join(', ');
      if(!confirm(`Apply ${rows.length} decision${rows.length===1?'':'s'}?\n\n${pass.length} Fine → moved to approved/.\n${redo.length} Redo → moved to rejected/ and generated again with ${methods} (${s.duration}s where it fits), then AI-reviewed again. This uses provider credits.\n\nThe batch starts right after.`))return;
    }
    const at=new Date().toISOString(),changed=[],remove=[],add=[];let moved=0;
    for(const row of pass){
      const next={...row,humanReview:{verdict:'pass',at,from:row.savedName}};delete next.humanDecision;
      if(inPlace()){/* the original stays where it is */}
      else if(row.state==='buffered'){
        const item=batch.buffered.find(x=>x.id===row.id);
        if(item){next.savedName=swapFolder(row.savedName,'approved');add.push({...item,name:next.savedName});}
      }else if(await exists(dir,row.savedName)){next.savedName=await move(dir,row.savedName,swapFolder(row.savedName,'approved'));moved++;}
      next.humanReview.to=next.savedName;changed.push(next);
    }
    for(const row of redo){
      const settings=redoSettings(row);let rejected=row.savedName;
      if(row.state==='buffered'){remove.push(row.id);rejected=null;}
      else if(await exists(dir,row.savedName)){rejected=await move(dir,row.savedName,swapFolder(row.savedName,'rejected'));moved++;}
      const next=batch.requeue(row);
      next.history.at(-1).human={verdict:'redo',at,rejected,method:settings.method,duration:settings.duration};
      next.resolvedSettings=settings;next.humanRedos=(row.humanRedos||0)+1;delete next.humanDecision;delete next.humanReview;
      changed.push(next);
    }
    const byId=new Map(changed.map(r=>[r.id,r]));queue.rows=queue.rows.map(r=>byId.get(r.id)||r);
    await batch.checkpoint({rows:changed,remove,add});
    for(const item of add)batch.setBuffered(item.id,item);for(const id of remove)batch.setBuffered(id,null);
    forget();
    batch.message(`Applied: ${pass.length} marked Fine${moved&&pass.length?' (moved to approved/)':''}, ${redo.length} queued for redo${redo.length?' (old clips moved to rejected/)':''}.${redo.length&&!batch.hasSources()?' Select the source folder in step 1, then Start / resume batch.':''}`);
    if(redo.length&&batch.hasSources())batch.startAfterLease();
  }

  // ---- grid
  function card(row){
    const el=document.createElement('article');el.className='hr-card';el.dataset.id=row.id;
    const d=decided(row);if(d)el.dataset.decision=d;
    const top=issues(row)[0],note=top?`${top.severity==='major'?'Major':'Minor'} · ${top.category.replace('_',' ')}: ${top.evidence}`:row.result.review.summary;
    el.innerHTML=`<button class="hr-thumb" aria-label="Open ${row.name} in the review player"><video muted playsinline preload="none"></video><span class="hr-num">#${row.number}</span></button>
      <div class="hr-meta"><code title="${row.name}"></code><p></p></div>
      <div class="hr-choice" role="group" aria-label="Decision for ${row.name}"><button data-v="pass" aria-pressed="${d==='pass'}">Fine</button><button data-v="redo" aria-pressed="${d==='redo'}" ${canRedo()&&!inPlace()?'':'disabled'}>Redo</button></div>`;
    el.querySelector('code').textContent=row.name;el.querySelector('p').textContent=short(note,150);
    el.querySelector('.hr-thumb').onclick=()=>open(row.id);
    for(const b of el.querySelectorAll('[data-v]'))b.onclick=()=>decide(row,decided(row)===b.dataset.v?null:b.dataset.v);
    return el;
  }
  async function wake(el){
    const row=q()?.rows.find(r=>r.id===el.dataset.id),video=el.querySelector('video');if(!row||!video)return;
    if(!video.src){const url=await clipURL(row).catch(()=>null);if(!url){el.classList.add('hr-missing');return;}video.src=url;loop(video,row);}
    Promise.resolve(video.play?.()).catch(()=>{});
  }
  function loop(video,row){
    const w=joinWindow(row);
    video.onloadedmetadata=()=>{if(w&&loopJoin)video.currentTime=w[0];};
    video.ontimeupdate=()=>{const win=joinWindow(row);if(loopJoin&&win&&(video.currentTime>win[1]||video.currentTime<win[0]-.05))video.currentTime=win[0];};
    video.onended=()=>{video.currentTime=loopJoin&&w?w[0]:0;Promise.resolve(video.play?.()).catch(()=>{});};
  }
  function renderGrid(){
    const grid=$('hr-grid'),rows=visible();
    observer?.disconnect();
    grid.replaceChildren(...rows.map(card));
    $('hr-empty').hidden=!!rows.length;
    $('hr-empty').textContent=flagged().length?'Nothing in this view.':'';
    if(!('IntersectionObserver' in window)){for(const el of grid.children)el.addEventListener('pointerenter',()=>wake(el),{once:true});return;}
    observer=new IntersectionObserver(entries=>{for(const e of entries){if(e.isIntersecting)wake(e.target);else e.target.querySelector('video')?.pause?.();}},{rootMargin:'200px'});
    for(const el of grid.children)observer.observe(el);
  }

  // ---- focus player
  function open(id){
    const list=visible();focus=Math.max(0,list.findIndex(r=>r.id===id));
    const dialog=$('hr-dialog');if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}
    show();
  }
  function close(){const dialog=$('hr-dialog');$('hr-video').pause?.();if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');render();}
  async function show(){
    const list=visible();
    if(!list.length){close();return;}
    focus=Math.min(Math.max(focus,0),list.length-1);
    const row=list[focus],review=row.result.review,s=row.resolvedSettings||{},video=$('hr-video');
    $('hr-position').textContent=`${focus+1} / ${list.length}`;
    $('hr-name').textContent=row.name;
    $('hr-facts').textContent=`Row ${row.number} · ${s.method||row.csvMethod||'?'} ${s.duration??row.csvDuration}s · AI: needs review${review.redoCount?` after ${review.redoCount} redo${review.redoCount===1?'':'s'}`:''}${row.humanRedos?` · your redos: ${row.humanRedos}`:''}`;
    $('hr-summary').textContent=review.summary||'';
    $('hr-issues').replaceChildren(...issues(row).map(i=>{
      const li=document.createElement('li'),b=document.createElement('button');
      b.className='hr-time';b.textContent=`${Number(i.time).toFixed(2)}s`;b.title='Jump to this moment and pause';
      b.onclick=()=>{loopJoin=false;syncToggles();video.pause();video.currentTime=Number(i.time)||0;};
      const t=document.createElement('span');t.textContent=` ${i.severity==='major'?'Major':'Minor'} · ${i.category.replace('_',' ')}: ${i.evidence}`;
      li.className=i.severity==='major'?'major':'';li.append(b,t);return li;
    }));
    const d=decided(row);
    $('hr-pass').setAttribute('aria-pressed',String(d==='pass'));$('hr-redo').setAttribute('aria-pressed',String(d==='redo'));
    $('hr-redo').disabled=!canRedo()||inPlace();
    $('hr-prev').disabled=focus===0;$('hr-next').disabled=focus===list.length-1;
    const url=await clipURL(row).catch(()=>null);
    $('hr-missing').hidden=!!url;
    if(video.dataset.id!==row.id){video.dataset.id=row.id;video.src=url||'';loop(video,row);}
    video.playbackRate=SPEEDS[speed];syncToggles();
    if(url)Promise.resolve(video.play?.()).catch(()=>{});
  }
  function syncToggles(){
    $('hr-loop').setAttribute('aria-pressed',String(loopJoin));
    $('hr-speed').textContent=`${SPEEDS[speed]}×`;
  }
  async function choose(value){
    const list=visible(),row=list[focus];if(!row)return;
    const before=list.length;await decide(row,value);
    // a decided clip leaves the "to decide" view, so the same index is the next clip
    if(visible().length===before)focus++;
    if(focus>=visible().length)focus=0;
    show();
  }
  function step(n){$('hr-video').pause();$('hr-video').currentTime=Math.max(0,$('hr-video').currentTime+n/24);}
  function keys(e){
    if(!$('hr-dialog').open||e.target.closest?.('select,input,textarea'))return;
    const v=$('hr-video'),k=e.key.toLowerCase();
    const map={f:()=>choose('pass'),r:()=>choose('redo'),u:()=>choose(null),arrowright:()=>{focus++;show();},arrowleft:()=>{focus--;show();},j:()=>{focus++;show();},k:()=>{focus--;show();},
      ' ':()=>v.paused?v.play():v.pause(),l:()=>{loopJoin=!loopJoin;syncToggles();},s:()=>{speed=(speed+1)%SPEEDS.length;v.playbackRate=SPEEDS[speed];syncToggles();},',':()=>step(-1),'.':()=>step(1)};
    if(map[k]){e.preventDefault();map[k]();}
  }

  // ---- section
  function render(){
    const section=$('human-review');if(!section)return;
    methods();
    const all=flagged(),done=(q()?.rows||[]).filter(r=>r.humanReview).length;
    section.hidden=!all.length&&!done;
    if(section.hidden)return;
    const pass=all.filter(r=>decided(r)==='pass').length,redo=all.filter(r=>decided(r)==='redo').length,todo=all.length-pass-redo;
    $('hr-count').textContent=`${all.length} clip${all.length===1?'':'s'} flagged by AI review`;
    $('hr-tally').textContent=`${todo} to decide · ${pass} fine · ${redo} redo${done?` · ${done} already approved by you`:''}`;
    for(const b of document.querySelectorAll('#hr-filter [data-f]')){
      const n={todo,pass,redo,all:all.length}[b.dataset.f];b.setAttribute('aria-pressed',String(b.dataset.f===filter));b.querySelector('span').textContent=n;
    }
    const dir=folder(),needsDir=all.some(r=>r.state==='saved');
    $('hr-folder').textContent=dir?`Clips from: ${dir.name}`:needsDir?'Choose the folder your results were saved or unzipped to, to watch the clips.':'Clips are still in this browser (ZIP part not yet downloaded).';
    $('hr-pick').textContent=dir?'Change results folder':'Choose results folder';
    $('hr-pick').hidden=!needsDir&&!dir;
    const busy=batch.running;
    $('hr-open').disabled=!visible().length;
    $('hr-rest').disabled=!todo;
    $('hr-apply').disabled=busy||!(pass+redo);
    $('hr-apply').textContent=pass+redo?`Apply ${pass+redo} decision${pass+redo===1?'':'s'}${redo?' & start redos':''}`:'Apply decisions';
    $('hr-apply-help').textContent=busy?'Decide now; apply once the batch pauses or finishes.':
      inPlace()?'Fine keeps the original in place and records your approval in the row report.':
      `Fine moves the clip from needs-review/ to approved/. Redo moves it to rejected/, generates it again and sends it through AI review again.${redo&&!batch.hasSources()?' Redo needs the source folder from step 1.':''}`;
    $('hr-redo-wrap').hidden=!canRedo()||inPlace();
    const ids=visible().map(r=>r.id).join();
    if($('hr-grid').dataset.ids!==ids){$('hr-grid').dataset.ids=ids;renderGrid();}
    else for(const el of $('hr-grid').children){const r=q().rows.find(x=>x.id===el.dataset.id),d=r&&decided(r);if(d)el.dataset.decision=d;else delete el.dataset.decision;for(const b of el.querySelectorAll('[data-v]'))b.setAttribute('aria-pressed',String(d===b.dataset.v));}
  }
  function methods(){
    const sel=$('hr-redo-method');if(sel.options.length>1||!window.studioUI.methods().length)return;
    for(const m of window.studioUI.methods().filter(m=>m.id!=='dissolve')){const o=document.createElement('option');o.value=m.id;o.textContent=m.name;sel.append(o);}
  }
  $('hr-filter').onclick=e=>{const b=e.target.closest('[data-f]');if(!b)return;filter=b.dataset.f;render();};
  $('hr-open').onclick=()=>{const list=visible();if(list.length)open(list[0].id);};
  $('hr-rest').onclick=markRest;
  $('hr-pick').onclick=async()=>{try{root=await window.showDirectoryPicker({mode:'readwrite',id:'studio-batch-review',...(folder()?{startIn:folder()}:{})});batch.adoptDestination(root);forget();$('hr-grid').dataset.ids='';render();}catch(e){if(e.name!=='AbortError')batch.message(e.message,true);}};
  $('hr-apply').onclick=batch.exclusive(apply);
  $('hr-pass').onclick=()=>choose('pass');$('hr-redo').onclick=()=>choose('redo');
  $('hr-prev').onclick=()=>{focus--;show();};$('hr-next').onclick=()=>{focus++;show();};
  $('hr-close').onclick=close;$('hr-dialog').addEventListener('close',()=>{$('hr-video').pause?.();render();});
  $('hr-loop').onclick=()=>{loopJoin=!loopJoin;syncToggles();};
  $('hr-speed').onclick=()=>{speed=(speed+1)%SPEEDS.length;$('hr-video').playbackRate=SPEEDS[speed];syncToggles();};
  document.addEventListener('keydown',keys);
  window.addEventListener('studio:ready',()=>{methods();render();});
  window.BatchReview={render,apply,decide};
})();
