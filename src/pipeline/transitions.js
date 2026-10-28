const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {METHODS,DEFAULT_PROMPT,getMethod}=require('../models');
const {probe}=require('../media');
const {runValidated}=require('../validation');
const {generate,resume}=require('../providers');
const BatchFormat=require('../../public/batch-format');
const BatchSettings=require('../../public/batch-settings');
const BatchEstimates=require('../../public/batch-estimates');
const {StageError,runProcess,expandArgs,describe}=require('./command');
const {atomicWrite,readJSON,exists,remove,inside,retry,withLock}=require('./util');
const {setTimeout:delay}=require('node:timers/promises');

// The game repo plans the transitions as a CSV in the Studio's batch format; this stage runs
// every row on the server with the Studio's own engine (FILM/RIFE/Kling/Seedance, AI review and
// bounded redos), checkpointing each row so a restart never pays twice for finished work.
// A provider's own server error or a dropped connection is usually gone a moment later.
const TRANSIENT=/\bHTTP 5\d\d\b|\b(502|503|504) |ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|other side closed/i;
const FATAL=/\b(401|403|429|forbidden|unauthori[sz]ed|insufficient|credits|balance|quota|rate.?limit)\b/i;
const generative=m=>m.provider!=='local'&&m.kind!=='interpolation';
function policyFor(method,options={}){
  const m=getMethod(method),mode=options.review||'generative',appearance=options.appearance||'strict';
  if(mode==='off')return {mode:'off',maxRetries:0,appearance};
  if(generative(m))return {mode:'redo',maxRetries:Number.isInteger(options.maxRedos)?options.maxRedos:1,appearance};
  return mode==='all'?{mode:'review',maxRetries:0,appearance}:{mode:'off',maxRetries:0,appearance};
}
const dirs=runDir=>({root:path.join(runDir,'transitions'),file:path.join(runDir,'transitions','rows.json'),outputs:path.join(runDir,'transitions','outputs'),work:path.join(runDir,'transitions','work')});
async function load(runDir){return readJSON(dirs(runDir).file);}
// Serialised, and stringified inside the lock, so the file always ends on the newest state:
// a row recorded as done must never be lost, or a restart would pay for it again.
function save(runDir,state){const file=dirs(runDir).file;return withLock(file,()=>atomicWrite(file,JSON.stringify(state)));}
async function init(ctx,spec){
  const d=dirs(ctx.runDir),existing=await load(ctx.runDir);if(existing)return existing;
  const csvFile=path.join(ctx.ws,spec.csv),text=await fs.readFile(csvFile,'utf8').catch(()=>null);
  if(text===null)throw new StageError(`The transition plan (${spec.csv}) wasn't found.`,{fix:'Redo the stage that plans transitions.'});
  let records;try{records=BatchFormat.parseCSV(text);}catch(e){
    if(/no data rows/i.test(e.message)){records=[];}else throw new StageError(`The transition plan (${spec.csv}) can't be read.`,{fix:'Check the game\'s planning step.',detail:e.message});}
  const prepared=records.length?BatchFormat.prepare(records,'',''):[],panel={method:'film',duration:.4};
  const rows=[];
  for(const r of prepared){
    const row={key:`r${String(r.number).padStart(4,'0')}`,number:r.number,first:r.a||r.first,second:r.b||r.second,output:r.name||r.output,state:r.state,error:r.error||''};
    if(row.state!=='invalid'){
      try{const s=BatchSettings.resolve(r,panel,METHODS);Object.assign(row,{method:s.method,duration:s.duration,provider:s.provider});}catch(e){row.state='invalid';row.error=e.message;}
    }
    if(row.state!=='invalid')for(const f of [row.first,row.second])if(!await exists(path.join(ctx.ws,spec.sourceRoot,f))){row.state='invalid';row.error=`Missing source clip: ${f}`;break;}
    rows.push(row);
  }
  const state={version:1,csv:spec.csv,createdAt:new Date().toISOString(),ingestNeeded:false,rows};
  await fs.mkdir(d.outputs,{recursive:true});await save(ctx.runDir,state);
  const invalid=rows.filter(r=>r.state==='invalid');
  ctx.log(`Planned ${rows.length} transitions${invalid.length?`; ${invalid.length} can't run (${invalid[0].error})`:''}.`);
  return state;
}
function estimate(rows,options={}){
  const todo=rows.filter(r=>['pending','failed'].includes(r.state)),groups=BatchSettings.groups(todo.map(r=>({csvMethod:r.method,csvDuration:String(r.duration)})),{method:'film',duration:.4},METHODS);
  const parts=groups.map(g=>BatchEstimates.aggregate([g],{review:policyFor(g.method,options),workflow:'generate'}).parts[0]);
  const lanes=Math.max(1,Math.min(8,options.concurrency||3));
  return {rows:todo.length,cost:[0,1].map(i=>parts.reduce((n,p)=>n+p.cost[i],0)),time:[0,1].map(i=>parts.reduce((n,p)=>n+p.time[i],0)/lanes),
    groups:parts.map(p=>({method:p.method,duration:p.duration,rows:p.rows,cost:p.cost,review:policyFor(p.method,options).mode})),reused:rows.filter(r=>r.state==='done'&&r.reused).length,basis:[...new Set(parts.map(p=>p.basis))].join(' ')};
}
function neededKeys(rows,options){
  const set=new Set();
  for(const r of rows.filter(r=>['pending','failed'].includes(r.state))){const m=getMethod(r.method);if(m.provider!=='local')set.add(m.provider);if(policyFor(r.method,options).mode!=='off')set.add('fal');}
  return [...set];
}
// A finished attempt is reused as-is after a restart; an attempt that was waiting on its provider
// reconnects to that same request instead of submitting (and paying for) another.
function caching(ctx){
  const renderVideo=ctx.hooks.renderVideo,reviewVideo=ctx.hooks.reviewVideo,falClientFactory=ctx.hooks.falClientFactory;
  return {
    renderVideo:async(o,c)=>{
      const cache=path.join(c.dir,'render.json'),cached=await readJSON(cache);
      if(cached?.output&&await exists(cached.output)){c.log('Reusing the finished render from before the interruption.');return cached;}
      const previous=(await readJSON(path.join(c.dir,'job.json')))?.job;
      const generator=async(m,frames,opts,key,signal,log,record)=>{
        if(previous?.requestId&&previous.provider===m.provider){
          try{const url=await resume(m,previous,key,signal,log,falClientFactory?{falClientFactory}:{});await record(previous);return url;}
          catch(e){if(!e.gone)throw e;log(`${e.message}; submitting a new request.`);}
        }
        return generate(m,frames,opts,key,signal,log,record,falClientFactory?{falClientFactory}:{});
      };
      const result=await renderVideo(o,{...c,generator});
      await atomicWrite(cache,JSON.stringify(result));return result;
    },
    reviewVideo:async(result,o,c)=>{
      const cache=path.join(c.dir,'assessment.json'),cached=await readJSON(cache);
      if(cached)return cached;
      const assessment=await reviewVideo(result,o,falClientFactory?{...c,falClientFactory}:c);
      await atomicWrite(cache,JSON.stringify(assessment));return assessment;
    }
  };
}
// Paid work outlives the run that made it: every finished transition is kept in a library under
// what it was made from (both clips' bytes, method, length, prompt), so a redo that leaves its
// clips unchanged, or a new run of the same take, reuses it instead of paying again.
const libraryDir=root=>path.join(root,'library','transitions');
async function fingerprint(ws,spec,row){
  const h=crypto.createHash('sha256').update(JSON.stringify(['v1',row.method,Number(row.duration),DEFAULT_PROMPT]));
  for(const f of [row.first,row.second]){const data=await fs.readFile(path.join(ws,spec.sourceRoot,f)).catch(()=>null);if(!data)return null;h.update(`${data.length}:`);h.update(data);}
  return h.digest('hex').slice(0,32);
}
const entry=(root,fp)=>({video:path.join(libraryDir(root),`${fp}.mp4`),meta:path.join(libraryDir(root),`${fp}.json`)});
async function keep(root,row,file,runId){
  if(!row.fingerprint)return;
  const e=entry(root,row.fingerprint);await fs.mkdir(path.dirname(e.video),{recursive:true});
  await remove(libraryDir(root),e.video).catch(()=>{});
  await fs.link(file,e.video).catch(()=>retry(()=>fs.copyFile(file,e.video)));
  await atomicWrite(e.meta,JSON.stringify({output:row.output,method:row.method,duration:row.duration,frames:row.frames??null,review:row.review||null,
    providerJobs:(row.providerJobs||[]).filter(j=>j.phase!=='review'),run:runId,keptAt:new Date().toISOString()}));
}
async function forget(root,fp){if(!fp)return;const e=entry(root,fp);await remove(libraryDir(root),e.meta).catch(()=>{});await remove(libraryDir(root),e.video).catch(()=>{});}
// Pending rows already in the library become done before anything is estimated or charged.
async function reuse(ctx,state,d){
  let n=0;
  for(const row of state.rows){
    if(row.state!=='pending'||row.fresh)continue;
    row.fingerprint||=await fingerprint(ctx.ws,ctx.spec,row);if(!row.fingerprint)continue;
    const e=entry(ctx.root,row.fingerprint),meta=await readJSON(e.meta);
    if(!meta||!await exists(e.video))continue;
    const dest=path.join(d.outputs,row.output);if(!inside(d.outputs,dest))continue;
    await fs.mkdir(path.dirname(dest),{recursive:true});
    await remove(d.root,`${dest}.part`).catch(()=>{});await fs.link(e.video,`${dest}.part`).catch(()=>retry(()=>fs.copyFile(e.video,`${dest}.part`)));await retry(()=>fs.rename(`${dest}.part`,dest));
    Object.assign(row,{state:'done',phase:null,error:'',elapsed:0,frames:meta.frames,review:meta.review,providerJobs:meta.providerJobs||[],ingest:null,reused:{run:meta.run,at:meta.keptAt},finishedAt:new Date().toISOString()});
    state.ingestNeeded=true;n++;
  }
  if(n){await save(ctx.runDir,state);ctx.rowsChanged(state);ctx.log(`Reused ${n} transition${n===1?'':'s'} already made from identical clips (no charge).`);}
  return n;
}
// Before a redo or delete wipes this run's transitions, file every finished one the game didn't
// reject; with fresh, drop them instead so they're all made again.
async function archive({root,runDir,ws,spec,runId},{fresh=false}={}){
  const state=await load(runDir);if(!state||!spec)return 0;
  const verdicts=spec.verdicts?await readJSON(path.join(ws,spec.verdicts),{}):{},d=dirs(runDir);let n=0,found=0;
  for(const row of state.rows){
    if(row.state!=='done')continue;
    if(!row.fingerprint&&(row.fingerprint=await fingerprint(ws,spec,row)))found++;
    if(!row.fingerprint)continue;
    if(fresh||verdicts[row.output]?.verdict==='reject'){await forget(root,row.fingerprint);continue;}
    const file=path.join(d.outputs,row.output);
    if(await exists(entry(root,row.fingerprint).meta)||!await exists(file))continue;
    await keep(root,row,file,runId).then(()=>n++,()=>{});
  }
  if(found)await save(runDir,state);
  return n;
}
function compactReview(review){
  if(!review)return null;
  return {verdict:review.verdict,summary:review.summary,redoCount:review.redoCount,selectedAttempt:review.selectedAttempt,pauseBatch:!!review.pauseBatch,
    issues:(review.attempts||[]).flatMap(a=>(a.assessment?.issues||[]).map(i=>({attempt:a.attempt,...i}))).slice(0,20),
    errors:(review.attempts||[]).map(a=>a.generationError||(a.assessment?.error?a.assessment.summary:null)).filter(Boolean)};
}
async function generateRows(ctx,state,d){
  const {signal}=ctx,options=ctx.run.options,lanes=Math.max(1,Math.min(8,options.concurrency||3)),cached=caching(ctx);
  const queue=state.rows.filter(r=>r.state==='pending');let halt=null,lastSave=0;
  // Forced saves mark state changes and must succeed; throttled ones only refresh progress.
  const persist=force=>{if(!force&&Date.now()-lastSave<500)return Promise.resolve();lastSave=Date.now();const p=save(ctx.runDir,state).then(()=>ctx.rowsChanged(state));return force?p:p.catch(()=>{});};
  const progress=()=>{const done=state.rows.filter(r=>['done','skipped'].includes(r.state)).length,all=state.rows.filter(r=>r.state!=='invalid').length;ctx.progress({done,total:all,label:`${done} of ${all} transitions`});};
  async function one(row){
    const dir=path.join(d.work,row.key),wait=(row.retryAt||0)-Date.now();
    if(wait>0)await delay(wait,null,{signal}).catch(()=>{});
    if(signal.aborted)return;
    Object.assign(row,{state:'running',phase:'Starting',error:'',startedAt:Date.now()});row.tries=(row.tries||0)+1;await persist(true);
    try{
      row.fingerprint||=await fingerprint(ctx.ws,ctx.spec,row);
      const a=path.join(ctx.ws,ctx.spec.sourceRoot,row.first),b=path.join(ctx.ws,ctx.spec.sourceRoot,row.second),m=getMethod(row.method);
      const info=await probe(a,signal);
      const o={a,b,aEnd:info.duration,bStart:0,method:row.method,duration:row.duration,fps:'source',prompt:DEFAULT_PROMPT,mute:true,review:policyFor(row.method,options)};
      const result=await runValidated(o,{dir,key:m.provider==='local'?'':ctx.keys.get(m.provider),reviewKey:ctx.keys.get('fal'),signal,outputOnly:true,...cached,
        log:msg=>{row.phase=String(msg).slice(0,200);ctx.log(`[${row.output}] ${msg}`);persist();},
        onProviderJob:j=>{(row.providerJobs||=[]).push({...j,at:new Date().toISOString()});persist(true);}});
      const dest=path.join(d.outputs,row.output);
      if(!inside(d.outputs,dest))throw new Error('Output name points outside the outputs folder.');
      await fs.mkdir(path.dirname(dest),{recursive:true});
      await retry(()=>fs.copyFile(result.output,`${dest}.part`));await retry(()=>fs.rename(`${dest}.part`,dest));
      Object.assign(row,{state:'done',phase:null,error:'',retryAt:null,elapsed:(Date.now()-row.startedAt)/1000,frames:result.bridgeFrames??null,review:compactReview(result.review),ingest:null,fresh:false,reused:null,finishedAt:new Date().toISOString()});
      state.ingestNeeded=true;
      await keep(ctx.root,row,dest,ctx.run.id).catch(e=>ctx.log(`[${row.output}] Couldn't file it in the library: ${e.message}`));
      await persist(true);await remove(d.root,dir).catch(()=>{});
      if(result.review?.pauseBatch&&!halt)halt=`Quality review couldn't finish for ${row.output}: ${row.review.errors[0]||result.review.summary} The video was kept and flagged.`;
    }catch(e){
      if(signal.aborted){Object.assign(row,{state:'pending',phase:null,error:'',interrupted:true});return;}
      if(FATAL.test(e.message)){halt||=e.message;Object.assign(row,{state:'pending',phase:null,error:e.message});return;}
      // Tried again by itself, twice at most; its work folder stays, so a request that was already
      // submitted is reconnected to rather than paid for again.
      if(TRANSIENT.test(e.message)&&(row.autoRetries||0)<2){
        row.autoRetries=(row.autoRetries||0)+1;const wait=(ctx.hooks.retryDelayMs??15000)*row.autoRetries;
        Object.assign(row,{state:'pending',phase:`Provider error; trying again in ${Math.round(wait/1000)} s`,error:e.message,retryAt:Date.now()+wait});
        ctx.log(`[${row.output}] ${e.message}. Trying again in ${Math.round(wait/1000)} s.`);queue.push(row);return;
      }
      Object.assign(row,{state:'failed',phase:null,error:e.message,elapsed:(Date.now()-row.startedAt)/1000});
    }finally{await persist(true);progress();}
  }
  progress();
  await Promise.all(Array.from({length:lanes},async()=>{
    while(!signal.aborted&&!halt&&!ctx.graceful()){const row=queue.shift();if(!row)return;await one(row);}
  }));
  if(signal.aborted)throw Object.assign(new Error('Stopped'),{aborted:true});
  if(halt)throw new StageError(/\b(401|403|unauthori[sz]ed|forbidden)\b/i.test(halt)?'The provider rejected your key.':/\b(insufficient|credits|balance|quota)\b/i.test(halt)?'Your provider account is out of credits.':/\b(429|rate.?limit)\b/i.test(halt)?'The provider is rate-limiting requests.':'Generation paused to protect your credits.',
    {kind:'provider',fix:/429|rate/i.test(halt)?'Wait a few minutes, then resume. Finished transitions are kept.':'Fix the key or top up credits, then resume. Finished transitions are kept and nothing is charged twice.',detail:halt});
  if(ctx.graceful()&&queue.length)throw Object.assign(new Error('Paused'),{aborted:true});
}
function writeReport(state,d){
  const rows=state.rows.filter(r=>r.state==='done').map(r=>{const gen=(r.providerJobs||[]).filter(j=>j.phase!=='review').at(-1);return [r.output,r.method,r.duration,gen?.requestId||''];});
  return atomicWrite(path.join(d.outputs,'batch-report.csv'),BatchFormat.csv([['output','method','duration','provider_request_id'],...rows]));
}
async function ingest(ctx,state,d){
  const spec=ctx.spec.ingest;if(!spec)return;
  ctx.log('Bringing the transitions into the game…');
  await writeReport(state,d);
  const argv=expandArgs(spec.run,{...ctx.vars,outputs:d.outputs});
  const failed=spec.failed&&new RegExp(spec.failed),flagged=spec.flagged&&new RegExp(spec.flagged),summary=spec.summary&&new RegExp(spec.summary);
  const byName=new Map(state.rows.map(r=>[r.output,r]));let result=null;
  for(const r of state.rows)if(r.state==='done')r.ingest={ok:true,flags:[]};
  const res=await runProcess({argv,cwd:path.join(ctx.ws,spec.cwd||'.'),env:ctx.env,signal:ctx.signal,onLine:line=>{
    ctx.log(line);let m;
    if(failed&&(m=failed.exec(line))){const r=byName.get(m[1].trim());if(r)r.ingest={ok:false,reason:m[2].trim()};}
    else if(flagged&&(m=flagged.exec(line))){const r=byName.get(m[1].trim());if(r)r.ingest={ok:true,flags:m[2].split(',').map(s=>s.trim()).filter(Boolean)};}
    else if(summary&&(m=summary.exec(line)))result=m[1];
  }});
  if(res.aborted)throw Object.assign(new Error('Stopped'),{aborted:true});
  if(res.code!==0)throw describe(res,{title:'Bringing transitions into the game',hints:ctx.spec.errorHints||[]});
  state.ingestNeeded=false;state.ingestedAt=new Date().toISOString();state.registry=result;
  await save(ctx.runDir,state);ctx.rowsChanged(state);
  return state.rows.filter(r=>r.ingest&&!r.ingest.ok);
}
const money=n=>`$${n<10?n.toFixed(2):n.toFixed(0)}`,span=s=>s<3600?`${Math.max(1,Math.round(s/60))} min`:`${(s/3600).toFixed(1)} h`;
async function run(ctx){
  const spec=ctx.spec,d=dirs(ctx.runDir),stage=ctx.stage,options=ctx.run.options;
  ctx.step('approve','running');
  const state=await init(ctx,spec);
  // Rows caught mid-flight by a stop or restart go back in the queue; their work folder keeps
  // the finished render or the provider request to reconnect to.
  for(const r of state.rows)if(r.state==='running')Object.assign(r,{state:'pending',phase:null,interrupted:true});
  await reuse(ctx,state,d);
  const est=estimate(state.rows,options);stage.estimate=est;
  if(!stage.approval){
    if(!est.rows)stage.approval={at:new Date().toISOString(),auto:true,note:'Nothing to generate'};
    else if(Number.isFinite(options.autoApproveUSD)&&est.cost[1]<=options.autoApproveUSD)stage.approval={at:new Date().toISOString(),auto:true,maxUSD:est.cost[1],note:`Within your auto-approve limit of ${money(options.autoApproveUSD)}`};
    else{ctx.step('approve','waiting');throw new StageError(`Approve spending to generate ${est.rows} transition${est.rows===1?'':'s'}: about ${money(est.cost[0])}–${money(est.cost[1])}, roughly ${span(est.time[0])}–${span(est.time[1])}.${est.reused?` ${est.reused} more ${est.reused===1?'is':'are'} reused from earlier work for free.`:''}`,{kind:'approval',fix:'Or skip generation and build the game with the optical-flow stand-ins (free, lower quality).'});}
  }
  ctx.step('approve','done',stage.approval.auto?stage.approval.note:'approved');
  ctx.step('generate','running');
  const missing=neededKeys(state.rows,options).filter(p=>!ctx.keys.get(p));
  if(missing.length){ctx.step('generate','waiting');throw new StageError(`Add your ${missing.map(p=>({fal:'fal',kie:'KIE',runninghub:'RunningHub'})[p]||p).join(' and ')} key to generate the transitions.`,{kind:'keys',fix:'Generation starts as soon as the key is added. Keys stay in this server\'s memory only.',actions:missing});}
  await generateRows(ctx,state,d);
  const failed=state.rows.filter(r=>r.state==='failed');
  if(failed.length){ctx.step('generate','failed');throw new StageError(`${failed.length} transition${failed.length===1?'':'s'} failed to generate.`,{kind:'rows',fix:'Retry them, or continue without them: the game plays an optical-flow stand-in for each one.',detail:failed[0].error});}
  const count=f=>state.rows.filter(f).length,done=count(r=>r.state==='done'&&!r.reused),reused=count(r=>r.state==='done'&&r.reused),skipped=count(r=>r.state==='skipped');
  ctx.step('generate','done',[`${done} generated`,reused&&`${reused} reused`,skipped&&`${skipped} skipped`].filter(Boolean).join(', '));
  ctx.step('ingest','running');
  if(state.ingestNeeded||!state.ingestedAt){
    const bad=await ingest(ctx,state,d)||[];
    if(bad.length&&!stage.ingestAccepted){ctx.step('ingest','failed');throw new StageError(`${bad.length} transition${bad.length===1?'':'s'} couldn't be brought into the game.`,{kind:'ingest',fix:'Regenerate them, or continue: the game plays a stand-in for each one.',detail:`${bad[0].output}: ${bad[0].ingest.reason}`});}
  }
  ctx.step('ingest','done',state.registry||'');
  if(options.reviewGate&&!stage.reviewApproved)throw new StageError('Review the transitions before the game is built.',{kind:'review',fix:'Play any that look off, reject or regenerate them, then build the game.'});
}
async function rows(runDir,{filter='all',page=0,size=50,ws,spec}={}){
  const state=await load(runDir);if(!state)return {rows:[],total:0,counts:{},page:0,pages:0};
  const quality=spec?.quality?await readJSON(path.join(ws,spec.quality),{}):{},registry=spec?.registry?await readJSON(path.join(ws,spec.registry),{}):{};
  const plays=new Map((registry.bridges||[]).map(b=>[b.name,b])),verdicts=spec?.verdicts?await readJSON(path.join(ws,spec.verdicts),{}):{};
  const counts={all:state.rows.length};
  const tag=r=>r.state==='done'&&(r.review?.verdict==='needs_review'||r.ingest?.flags?.length||quality[r.output]?.flags?.length||verdicts[r.output]?.verdict==='reject')?'flagged':r.state;
  for(const r of state.rows){const t=tag(r);counts[t]=(counts[t]||0)+1;if(t==='flagged')counts.done=(counts.done||0)+1;}
  const list=state.rows.filter(r=>filter==='all'||tag(r)===filter||(filter==='done'&&tag(r)==='flagged'));
  const pages=Math.max(1,Math.ceil(list.length/size));page=Math.max(0,Math.min(page,pages-1));
  return {counts,total:list.length,page,pages,ingestedAt:state.ingestedAt||null,registry:state.registry||null,rows:list.slice(page*size,page*size+size).map(r=>{
    const p=plays.get(r.output),gen=(r.providerJobs||[]).filter(j=>j.phase!=='review');
    return {key:r.key,number:r.number,output:r.output,first:r.first,second:r.second,method:r.method,duration:r.duration,state:r.state,tag:tag(r),phase:r.phase||null,error:r.error||'',elapsed:r.elapsed||null,tries:r.tries||0,
      review:r.review,ingest:r.ingest||null,quality:quality[r.output]?{flags:quality[r.output].flags||[]}:null,verdict:verdicts[r.output]?.verdict||null,verdictNote:verdicts[r.output]?.note||'',
      plays:p?{source:p.source,rejected:!!p.rejected}:null,requests:gen.map(j=>j.requestId).filter(Boolean),reviews:(r.providerJobs||[]).filter(j=>j.phase==='review').length,reused:!!r.reused,hasOutput:r.state==='done'};
  })};
}
// Resets rows to run again; their old outputs are deleted so nothing stale gets ingested, and a
// finished one being made again leaves the library so it can't come back.
async function reset(runDir,select,{to='pending',root}={}){
  const state=await load(runDir);if(!state)throw new Error('This run has no transitions yet.');
  const d=dirs(runDir);let n=0;
  for(const r of state.rows){
    if(!select(r))continue;
    if(to==='pending'){await remove(d.root,path.join(d.outputs,r.output)).catch(()=>{});await remove(d.root,path.join(d.work,r.key)).catch(()=>{});(r.history||=[]).push({state:r.state,error:r.error,review:r.review,requests:(r.providerJobs||[]).map(j=>j.requestId),at:new Date().toISOString()});
      if(r.state==='done'){if(root)await forget(root,r.fingerprint);r.fresh=true;}
      Object.assign(r,{state:'pending',error:'',review:null,ingest:null,providerJobs:[],phase:null,interrupted:false,reused:null,autoRetries:0,retryAt:null});state.ingestNeeded=true;}
    else Object.assign(r,{state:to});
    n++;
  }
  await save(runDir,state);return n;
}
module.exports={run,rows,reset,load,estimate,policyFor,neededKeys,dirs,caching,archive,fingerprint,libraryDir};
