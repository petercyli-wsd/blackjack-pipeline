const fs=require('node:fs/promises');
const {createWriteStream}=require('node:fs');
const path=require('node:path');
const definitions=require('./definitions');
const {StageError,runProcess,expandArgs,expandEnv,describe,verify}=require('./command');
const workspace=require('./workspace');
const transitions=require('./transitions');
const {inspect}=require('./input');
const util=require('./util');

// Runs live on disk (runs/<id>/run.json) and execute on the server, one at a time, whether or
// not a browser is watching. A stopped or crashed server picks up where it left off.
const PREPARE_STEPS=[
  {id:'space',title:'Check disk space'},
  {id:'source',title:'Copy the game code',detail:'Your working copy (or a GitHub branch), without its output folders'},
  {id:'python',title:'Python tools',detail:'Installed once per lockfile and shared by runs'},
  {id:'node',title:'Node tools',detail:'Installed once per lockfile and shared by runs'},
  {id:'carry',title:'Reuse cached files'},
  {id:'input',title:'Check the take opens',detail:'Reads the first and last frames the way the pipeline will'}];
const TRANSITION_STEPS=[
  {id:'approve',title:'Approve spending',detail:'Shows the estimate before anything is charged'},
  {id:'generate',title:'Generate transitions',detail:'On the server, several at a time, each checkpointed'},
  {id:'ingest',title:'Bring into the game',detail:'Cut each bridge out, check it and decide what plays'}];
const DEFAULT_WEIGHT={prepare:2,clips:12,scene:2,mattes:6,transitions:12,game:2};
const HELD=new Set();
const SECRET_ENV=/^(FAL_KEY|FAL_API_KEY|KIE_API_KEY|KIE_KEY|RUNNINGHUB_API_KEY|TEAM_PASSWORD|GITHUB_TOKEN|GH_TOKEN)$/i;
const now=()=>new Date().toISOString();
const clone=v=>JSON.parse(JSON.stringify(v));
const httpError=(status,message)=>Object.assign(new Error(message),{status});
const stopped=e=>e?.aborted||e?.name==='AbortError'||/^(Stopped|Paused|Cancelled|This operation was aborted)$/.test(e?.message||'');

class Engine{
  constructor({dataDir,definitionsDir,appRoot,keys,hooks={},autoResume=true,hosted=false}){
    Object.assign(this,{root:path.join(dataDir,'pipeline'),definitionsDir,appRoot,keys,hooks,autoResume,hosted});
    this.runsDir=path.join(this.root,'runs');this.runs=new Map();this.active=null;this.timers=new Map();this.logs=new Map();this.closing=false;this.sizes=new Map();
    this.defs=definitions.load(definitionsDir);this.stats={};
    // One action per run at a time: a double-clicked Redo, or two open tabs, must never wipe files
    // while an earlier action has already restarted the run.
    // A run that has just stopped (waiting, failed, paused) is still the active one until its last
    // save lands; an action in that moment waits for it, or a key arriving then would be ignored.
    for(const name of ['update','start','pause','resume','redo','approve','proceed','retryRows','verdict','updateCode','dismiss','remove']){
      const fn=this[name].bind(this);this[name]=(id,...args)=>util.withLock(`run:${id}`,async()=>{
        const a=this.active;if(a?.run.id===id&&a.run.status!=='running')await a.promise;
        return fn(id,...args);
      });
    }
  }
  // Two servers on one data folder would both "recover" and execute the same runs.
  async lock(){
    const file=path.join(this.root,'server.lock');
    if(HELD.has(file))throw Object.assign(new Error(`Another pipeline engine in this process is already using ${this.root}.`),{code:'ELOCKED'});
    for(let attempt=0;attempt<2;attempt++){
      try{const h=await fs.open(file,'wx');await h.writeFile(String(process.pid));await h.close();this.lockFile=file;HELD.add(file);return;}
      catch(e){
        if(e.code!=='EEXIST')throw e;
        const pid=Number(await fs.readFile(file,'utf8').catch(()=>''));
        // Our own pid without an in-process holder is a leftover from a crash that reused the pid.
        let alive=false;try{if(pid&&pid!==process.pid){process.kill(pid,0);alive=true;}}catch(err){alive=err.code==='EPERM';}
        if(alive)throw Object.assign(new Error(`Another Blackjack Pipeline server (process ${pid}) is already using ${this.root}.`),{code:'ELOCKED'});
        await fs.rm(file,{force:true});
      }
    }
    throw new Error(`Couldn't take the lock on ${this.root}.`);
  }
  async init(){
    await fs.mkdir(this.runsDir,{recursive:true});
    await this.lock();
    this.stats=await util.readJSON(path.join(this.root,'stats.json'),{});
    for(const entry of await fs.readdir(this.runsDir,{withFileTypes:true})){
      if(!entry.isDirectory())continue;
      const run=await util.readJSON(path.join(this.runsDir,entry.name,'run.json'));
      if(!run?.id||run.id!==entry.name)continue;
      this.runs.set(run.id,run);
      if(run.status==='running')await this.interrupted(run);
      // Runs from before the transition library existed get their paid transitions filed once.
      else if(['completed','paused','failed','waiting'].includes(run.status)&&await this.archive(run).catch(()=>0))await this.save(run);
    }
    this.schedule();
  }
  // A stage caught mid-step by a crash may have half-written that step's outputs, and the game's
  // own caching would trust them; delete them so the step runs again from scratch.
  async interrupted(run){
    for(const stage of run.stages){
      if(stage.status!=='running')continue;
      const spec=this.spec(run,stage.id);
      for(const step of stage.steps)if(step.status==='running'){await this.wipeStep(run,spec,step.id).catch(()=>{});step.status='pending';}
      stage.status='paused';
    }
    run.status=this.autoResume?'queued':'paused';run.queuedAt=now();
    run.attention=this.autoResume?null:{kind:'interrupted',message:'The server stopped while this run was working.',fix:'Resume to continue from the last finished step.'};
    this.history(run,this.autoResume?'Server restarted mid-run; resuming from the last finished step.':'Server restarted mid-run.');
    await this.save(run);
  }
  reloadDefinitions(){try{this.defs=definitions.load(this.definitionsDir);}catch(e){throw httpError(500,`A pipeline definition is invalid: ${e.message}`);}}
  definitionList(){return [...this.defs.values()].map(d=>({...definitions.publicView(d),runs:[...this.runs.values()].filter(r=>r.pipeline===d.id).length,localPath:d.game?.localPath?path.resolve(this.appRoot,d.game.localPath):null}));}
  dir(run){return path.join(this.runsDir,run.id);}
  ws(run){return path.join(this.dir(run),'game');}
  spec(run,id){return run.def.stages.find(s=>s.id===id);}
  get(id){const run=this.runs.get(id);if(!run)throw httpError(404,'Run not found. It may have been deleted.');return run;}
  history(run,text){(run.history||=[]).push({at:now(),text});if(run.history.length>200)run.history.shift();}
  save(run){
    clearTimeout(this.timers.get(run.id));this.timers.delete(run.id);
    if(!this.runs.has(run.id))return Promise.resolve();
    run.updatedAt=now();const file=path.join(this.dir(run),'run.json');
    return util.withLock(file,()=>this.runs.has(run.id)?util.atomicWrite(file,JSON.stringify(run,null,1)):null);
  }
  saveSoon(run){if(!this.timers.has(run.id))this.timers.set(run.id,setTimeout(()=>this.save(run).catch(()=>{}),400));}
  // Stage and step objects keep their identity across a definition change (a game contract
  // loaded during Set up), so the running loop and its error handling update the live state.
  stages(def,previous=[]){
    const prep={id:'prepare',title:'Set up',kind:'prepare',summary:'Copy the game code and get its tools ready.',
      steps:PREPARE_STEPS.filter(s=>(s.id!=='python'||def.toolchains?.python)&&(s.id!=='node'||def.toolchains?.node)&&(s.id!=='input'||def.input?.opencvCheck))};
    return [prep,...def.stages].map(s=>{
      const stage=previous.find(p=>p.id===s.id)||{status:'pending'};
      const steps=(s.kind==='transitions'?TRANSITION_STEPS:s.steps||[]).map(st=>Object.assign((stage.steps||[]).find(p=>p.id===st.id)||{status:'pending'},{id:st.id,title:st.title,detail:st.detail||''}));
      return Object.assign(stage,{id:s.id,title:s.title,kind:s.kind,summary:s.summary||'',optional:!!s.optional,keys:s.keys||[],gallery:(s.steps||[]).find(x=>x.gallery)?.gallery||null,artifacts:s.artifacts||null,steps});
    });
  }
  options(def,o={}){
    const stages={};for(const s of def.stages)if(s.optional)stages[s.id]=typeof o.stages?.[s.id]==='boolean'?o.stages[s.id]:s.default!==false;
    const n=(v,lo,hi,d)=>Number.isFinite(Number(v))&&v!==''&&v!==null?Math.max(lo,Math.min(hi,Math.round(Number(v)))):d;
    const usd=o.autoApproveUSD===''||o.autoApproveUSD===null||o.autoApproveUSD===undefined?null:Number(o.autoApproveUSD);
    if(usd!==null&&(!Number.isFinite(usd)||usd<0))throw httpError(400,'Auto-approve must be a dollar amount of 0 or more, or blank.');
    if(o.source==='git'&&o.ref!==undefined&&!/^[\w./-]{1,120}$/.test(o.ref))throw httpError(400,'Branch or commit name has unexpected characters.');
    return {source:o.source==='git'||(this.hosted&&o.source!=='local')?'git':'local',localPath:typeof o.localPath==='string'&&o.localPath.trim()?o.localPath.trim():path.resolve(this.appRoot,def.game?.localPath||'.'),
      ref:o.ref||def.game?.ref||'main',stages,review:['generative','all','off'].includes(o.review)?o.review:'generative',appearance:o.appearance==='reskin'?'reskin':'strict',
      maxRedos:n(o.maxRedos,0,2,1),concurrency:n(o.concurrency,1,8,3),autoApproveUSD:usd,reviewGate:!!o.reviewGate};
  }
  async create(pipelineId,{name,options}={}){
    this.reloadDefinitions();
    const def=this.defs.get(pipelineId);if(!def)throw httpError(404,'Unknown pipeline.');
    if(!def.enabled)throw httpError(400,def.disabledReason||`${def.name} isn't available yet.`);
    const id=util.shortId(),stamp=new Date().toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    const run={id,pipeline:def.id,name:String(name||'').trim().slice(0,80)||`${def.name} · ${stamp}`,createdAt:now(),updatedAt:now(),status:'draft',
      options:this.options(def,options),input:null,def:clone(def),contract:'built-in',stages:[],history:[]};
    run.stages=this.stages(run.def);this.history(run,'Created');
    await fs.mkdir(this.dir(run),{recursive:true});this.runs.set(id,run);await this.save(run);return run;
  }
  async update(id,{name,options}){
    const run=this.get(id);
    if(name!==undefined)run.name=String(name).trim().slice(0,80)||run.name;
    if(options){
      if(run.status!=='draft')throw httpError(409,'Options are fixed once a run starts. Start a new run to change them.');
      run.options=this.options(run.def,{...run.options,...options,stages:{...run.options.stages,...options.stages}});
    }
    await this.save(run);return run;
  }
  inputPath(run,name){
    const safe=(String(name||'take.mp4').replace(/[^\w.@-]+/g,'_').replace(/^\.+/,'').slice(-120))||'take.mp4';
    return path.join(this.dir(run),'input',/\.[a-z0-9]{2,5}$/i.test(safe)?safe:`${safe}.mp4`);
  }
  async beginInput(id){
    const run=this.get(id);
    if(run.status!=='draft')throw httpError(409,'The take is fixed once a run starts. Start a new run for another take.');
    if(run.uploading)throw httpError(409,'A take is already uploading to this run.');
    run.uploading=true;return run;
  }
  async acceptInput(run,file,name,signal){
    try{
      if(run.input?.file&&path.join(this.dir(run),run.input.file)!==file)await util.remove(this.dir(run),path.join(this.dir(run),run.input.file)).catch(()=>{});
      const result=await inspect(file,run.def.input||{},{signal,name});
      if(!result.ok)await util.remove(this.dir(run),file).catch(()=>{});
      run.input={name,file:result.ok?path.relative(this.dir(run),file).split(path.sep).join('/'):null,validation:result,checkedAt:now()};
      this.history(run,result.ok?`Take added: ${name}`:`Take rejected: ${name}`);
      await this.save(run);return run;
    }finally{delete run.uploading;}
  }
  async failInput(run,file){delete run.uploading;await util.remove(this.dir(run),file).catch(()=>{});}
  async start(id){
    const run=this.get(id);
    if(run.status!=='draft')throw httpError(409,'This run has already started.');
    if(!run.input?.file||!run.input.validation?.ok)throw httpError(400,'Add a valid take before starting.');
    const def=this.defs.get(run.pipeline);if(!def?.enabled)throw httpError(400,'This pipeline is disabled.');
    run.status='queued';run.queuedAt=now();run.attention=null;this.history(run,'Started');
    await this.save(run);this.schedule();return run;
  }
  schedule(){
    if(this.active||this.closing)return;
    const next=[...this.runs.values()].filter(r=>r.status==='queued').sort((a,b)=>String(a.queuedAt).localeCompare(String(b.queuedAt)))[0];
    if(next)this.execute(next);
  }
  execute(run){
    const controller=new AbortController(),active={run,controller,graceful:false,reason:null};this.active=active;
    active.promise=(async()=>{
      run.status='running';run.attention=null;run.startedAt||=now();
      let stage=null;
      // Everything awaited sits inside the try: a rejection here would otherwise be unhandled and end the server.
      try{
        await this.save(run);
        for(let i=0;i<run.stages.length;i++){
          stage=run.stages[i];
          if(['done','skipped'].includes(stage.status))continue;
          if(stage.optional&&!run.options.stages?.[stage.id]){stage.status='skipped';stage.off=true;await this.save(run);continue;}
          await this.runStage(run,stage,controller.signal,active);
          if(active.graceful)throw Object.assign(new Error('Paused'),{aborted:true});
        }
        stage=null;run.status='completed';run.finishedAt=now();this.history(run,'Completed');
      }catch(e){
        if(stage?.status==='running'){stage.endedAt=now();}
        if(stopped(e)||controller.signal.aborted){
          if(stage?.status==='running')stage.status='paused';
          run.status=active.reason==='shutdown'?'queued':'paused';
          if(active.reason!=='delete')this.history(run,active.reason==='shutdown'?'Server stopping; will resume on next start.':`Paused${stage?` during ${stage.title}`:''}.`);
        }else if(e instanceof StageError&&e.kind!=='error'){
          stage.status='waiting';run.status='waiting';
          run.attention={kind:e.kind,stage:stage.id,message:e.message,fix:e.fix,detail:e.detail,actions:e.actions||null};
          this.history(run,`Waiting: ${e.message}`);
        }else{
          if(stage){stage.status='failed';stage.error={message:e.message,fix:e.fix||'',detail:e.detail||''};}
          run.status='failed';
          run.attention={kind:'error',stage:stage?.id,message:e instanceof StageError?e.message:`${stage?.title||'The run'} stopped unexpectedly.`,
            fix:e.fix||'Check the log, then retry this stage.',detail:e instanceof StageError?e.detail:e.message};
          if(stage)this.log(run,stage,`ERROR: ${e.message}${e.detail?` — ${e.detail}`:''}`,'stderr');
          if(!(e instanceof StageError)&&stage)this.log(run,stage,e.stack||String(e),'stderr');
          this.history(run,`Failed at ${stage?.title||'start'}: ${e.message}`);
        }
      }finally{
        for(const s of run.stages)this.closeLog(run,s);
        if(this.runs.has(run.id))await this.save(run).catch(()=>{});
        if(this.active===active)this.active=null;
        this.schedule();
      }
    })();
  }
  context(run,stage,signal,active){
    const ws=this.ws(run),runDir=this.dir(run),self=this;
    const env={};for(const [k,v] of Object.entries(process.env))if(!SECRET_ENV.test(k))env[k]=v;
    Object.assign(env,{PYTHONUNBUFFERED:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',FORCE_COLOR:'0',NO_COLOR:'1'});
    return {run,stage,signal,root:this.root,appRoot:this.appRoot,runDir,ws,input:run.input?.file?path.join(runDir,run.input.file):null,
      get def(){return run.def;},get spec(){return self.spec(run,stage.id);},keys:this.keys,hooks:this.hooks,env,
      vars:{input:run.input?.file?path.join(runDir,run.input.file):'',workspace:ws,run:runDir,node:process.execPath,python:run.toolchains?.python||null,npm:run.toolchains?.npm||null},
      log:(line,stream)=>this.log(run,stage,line,stream),
      step:(id,status,note)=>{
        const step=stage.steps.find(s=>s.id===id);if(!step)return;
        if(status==='running'&&step.status!=='running'){step.startedAt=now();step.endedAt=null;}
        if(['done','cached','failed','skipped'].includes(status)){step.endedAt=now();if(step.startedAt&&['done'].includes(status))this.stat(run,`${stage.id}/${id}`,(Date.parse(step.endedAt)-Date.parse(step.startedAt))/1000);}
        step.status=status;if(note!==undefined)step.note=note;this.saveSoon(run);
      },
      progress:p=>{stage.progress=p;this.saveSoon(run);},
      rowsChanged:state=>{const c={};for(const r of state.rows)c[r.state]=(c[r.state]||0)+1;stage.rows=c;this.saveSoon(run);},
      setDefinition:(def,source)=>{run.def=clone(def);run.contract=source;run.stages=this.stages(run.def,run.stages);},
      graceful:()=>!!active?.graceful,save:()=>this.save(run)};
  }
  async runStage(run,stage,signal,active){
    Object.assign(stage,{status:'running',startedAt:now(),endedAt:null,error:null,progress:null});run.current=stage.id;
    this.log(run,stage,`── ${stage.title} ──`);await this.save(run);
    const ctx=this.context(run,stage,signal,active);
    if(stage.kind==='prepare'){
      await workspace.prepare(ctx,this.defs.get(run.pipeline)||run.def);
      await this.toolchains(run,ctx,{quiet:true});
    }else if(stage.kind==='command')await this.command(run,stage,ctx);
    else if(stage.kind==='transitions'){await this.toolchains(run,ctx,{quiet:true});await transitions.run(ctx);}
    else throw new StageError(`Unknown stage kind ${stage.kind}.`);
    Object.assign(stage,{status:'done',endedAt:now(),progress:null});
    stage.elapsed=(Date.parse(stage.endedAt)-Date.parse(stage.startedAt))/1000;this.stat(run,stage.id,stage.elapsed);
    this.history(run,`${stage.title} done`);await this.save(run);
  }
  // Toolchains are checked before every stage that needs one, so a cleared cache heals itself.
  async toolchains(run,ctx,{quiet=false}={}){
    run.toolchains||={};
    if(run.def.toolchains?.python){const t=await workspace.ensurePython(ctx,{quiet});run.toolchains.python=t.python;ctx.vars.python=t.python;}
    if(run.def.toolchains?.node){const t=await workspace.ensureNode(ctx,{quiet});if(t){run.toolchains.npm=t.npm;ctx.vars.npm=t.npm;}}
  }
  async wipeStep(run,spec,stepId){const step=(spec?.steps||[]).find(s=>s.id===stepId);if(step?.outputs)await util.wipe(this.ws(run),step.outputs);}
  async command(run,stage,ctx){
    const spec=ctx.spec;
    await this.toolchains(run,ctx,{quiet:false});
    const missing=(spec.keys||[]).filter(k=>!this.keys.get(k));
    if(missing.length)throw new StageError(`Add your ${missing.map(k=>({fal:'fal',kie:'KIE',runninghub:'RunningHub'})[k]||k).join(' and ')} key for ${stage.title}.`,{kind:'keys',fix:'The stage starts as soon as the key is added.',actions:missing});
    for(const step of stage.steps)if(['running','failed'].includes(step.status)){await this.wipeStep(run,spec,step.id);step.status='pending';}
    const markers=Object.fromEntries(Object.entries(spec.markers||{}).map(([k,v])=>[k,new RegExp(v)]));
    let current=null;
    const result=await runProcess({argv:expandArgs(spec.run,ctx.vars),cwd:path.join(ctx.ws,spec.cwd||'.'),env:{...ctx.env,...expandEnv(spec.env,ctx.vars,this.keys)},
      signal:ctx.signal,timeoutMs:(spec.timeoutMinutes||360)*60000,onLine:(line,stream)=>{
        ctx.log(line,stream);
        for(const [kind,re] of Object.entries(markers)){
          const m=re.exec(line);if(!m)continue;
          if(kind==='start'){if(current&&current!==m[1])ctx.step(current,'done');current=m[1];ctx.step(m[1],'running');}
          else{ctx.step(m[1],kind==='cached'?'cached':'done');if(current===m[1])current=null;}
          const steps=stage.steps,done=steps.filter(s=>['done','cached'].includes(s.status)).length;
          ctx.progress({done,total:steps.length,label:steps.find(s=>s.status==='running')?.title||''});
        }
      }}).catch(e=>{if(e.code==='ENOENT')throw new StageError(`Couldn't start ${spec.run[0]}.`,{fix:'Redo from Set up to reinstall the tools.'});throw e;});
    if(result.aborted||result.code!==0){
      // The step that was running may have left a partial file the game's caching would trust.
      for(const step of stage.steps)if(step.status==='running'){await this.wipeStep(run,spec,step.id).catch(()=>{});step.status=result.aborted?'pending':'failed';}
      if(result.aborted)throw Object.assign(new Error('Stopped'),{aborted:true});
      throw describe(result,{title:stage.title,hints:spec.errorHints||[]});
    }
    for(const step of stage.steps)if(['pending','running'].includes(step.status))ctx.step(step.id,'done');
    await verify(ctx.ws,spec.verify);
  }
  // ── logs and stats
  logFile(run,stage){return path.join(this.dir(run),'logs',`${stage.id}.log`);}
  log(run,stage,line,stream='stdout'){
    const text=String(line).slice(0,4000),t=new Date().toTimeString().slice(0,8),key=`${run.id}/${stage.id}`;
    let out=this.logs.get(key);
    if(!out){const file=this.logFile(run,stage);require('node:fs').mkdirSync(path.dirname(file),{recursive:true});out=createWriteStream(file,{flags:'a'});out.on('error',()=>{});this.logs.set(key,out);}
    out.write(`${t} ${stream==='stderr'?'!':' '} ${text}\n`);
    (stage.tail||=[]).push({t,s:stream==='stderr'?1:0,x:text});if(stage.tail.length>40)stage.tail.shift();
    this.saveSoon(run);
  }
  closeLog(run,stage){const key=`${run.id}/${stage.id}`,out=this.logs.get(key);if(out){out.end();this.logs.delete(key);}}
  async readLog(id,stageId,offset=0){
    const run=this.get(id),stage=run.stages.find(s=>s.id===stageId);if(!stage)throw httpError(404,'No such stage.');
    const file=this.logFile(run,stage),stat=await fs.stat(file).catch(()=>null);if(!stat)return {text:'',offset:0,size:0};
    const start=Math.max(0,Math.min(Number(offset)||0,stat.size)),from=stat.size-start>2*1024**2?stat.size-2*1024**2:start;
    const handle=await fs.open(file);try{const buf=Buffer.alloc(stat.size-from);await handle.read(buf,0,buf.length,from);return {text:buf.toString('utf8'),offset:stat.size,size:stat.size,truncated:from>start};}finally{await handle.close();}
  }
  stat(run,key,seconds){
    if(!(seconds>0))return;const list=((this.stats[run.pipeline]||={})[key]||=[]);list.push(Math.round(seconds));if(list.length>5)list.shift();
    clearTimeout(this.statTimer);this.statTimer=setTimeout(()=>util.atomicWrite(path.join(this.root,'stats.json'),JSON.stringify(this.stats)).catch(()=>{}),1000);this.statTimer.unref?.();
  }
  typical(run,key){const l=this.stats[run.pipeline]?.[key];if(!l?.length)return null;const s=[...l].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];}
  // ── views
  view(run,{full=false}={}){
    const stages=run.stages.map(s=>{
      const off=s.optional&&!run.options.stages?.[s.id];
      const v={id:s.id,title:s.title,kind:s.kind,summary:s.summary,optional:s.optional,off,status:off&&s.status==='pending'?'skipped':s.status,startedAt:s.startedAt||null,endedAt:s.endedAt||null,elapsed:s.elapsed||null,
        typical:this.typical(run,s.id),progress:s.progress||null,error:s.error||null,rows:s.rows||null,estimate:s.estimate||null,approval:s.approval||null,skippedGeneration:!!s.skippedGeneration,
        gallery:s.gallery,artifacts:s.artifacts,keys:s.keys||[]};
      if(full)Object.assign(v,{tail:s.tail||[],steps:s.steps.map(st=>({...st,typical:this.typical(run,`${s.id}/${st.id}`)}))});
      return v;
    });
    const live=stages.filter(s=>!s.off);
    const weight=s=>this.typical(run,s.id)||DEFAULT_WEIGHT[s.id]*60||300;
    const total=live.reduce((n,s)=>n+weight(s),0)||1;
    const part=s=>['done','skipped'].includes(s.status)?1:s.progress?.total?s.progress.done/s.progress.total:0;
    const progress=Math.min(1,live.reduce((n,s)=>n+weight(s)*part(s),0)/total);
    return {id:run.id,pipeline:run.pipeline,name:run.name,status:run.status,createdAt:run.createdAt,updatedAt:run.updatedAt,startedAt:run.startedAt||null,finishedAt:run.finishedAt||null,
      attention:run.attention||null,input:run.input?{name:run.input.name,ok:!!run.input.validation?.ok,info:run.input.validation?.info||null,errors:run.input.validation?.errors||[],warnings:run.input.validation?.warnings||[]}:null,
      uploading:!!run.uploading,options:run.options,game:run.game||null,contract:run.contract,current:run.current||null,progress,stages,
      queuePosition:run.status==='queued'?[...this.runs.values()].filter(r=>r.status==='queued'&&String(r.queuedAt)<=String(run.queuedAt)).length+(this.active?1:0):null,
      ...(full?{history:(run.history||[]).slice(-40),size:this.sizes.get(run.id)?.bytes??null}:{})};
  }
  list(pipelineId){return [...this.runs.values()].filter(r=>!pipelineId||r.pipeline===pipelineId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(r=>this.view(r));}
  async detail(id){
    const run=this.get(id),cached=this.sizes.get(id);
    if(!cached||Date.now()-cached.at>20000){this.sizes.set(id,{at:Date.now(),bytes:cached?.bytes??null});util.dirSize(this.dir(run)).then(bytes=>this.sizes.set(id,{at:Date.now(),bytes})).catch(()=>{});}
    return this.view(run,{full:true});
  }
  // ── actions. Each one settles the active run first so state is never edited under a running stage.
  async stopActive(reason){const a=this.active;if(!a)return;a.reason=reason;a.controller.abort();await a.promise;}
  async idle(run,reason='pause'){if(this.active?.run===run)await this.stopActive(reason);}
  async pause(id,{now:immediately=false}={}){
    const run=this.get(id);
    if(this.active?.run===run){
      const kind=run.stages.find(s=>s.status==='running')?.kind;
      if(kind==='transitions'&&!immediately&&!this.active.graceful){this.active.graceful=true;this.history(run,'Pausing after the transitions in progress finish.');await this.save(run);return {graceful:true};}
      await this.stopActive('pause');return {graceful:false};
    }
    if(run.status==='queued'){run.status='paused';this.history(run,'Paused before it started.');await this.save(run);return {graceful:false};}
    throw httpError(409,'This run isn\'t running.');
  }
  async resume(id){
    const run=this.get(id);
    if(this.active?.run===run){if(this.active.graceful){this.active.graceful=false;this.history(run,'Pause cancelled.');await this.save(run);}return run;}
    if(!['paused','failed','waiting'].includes(run.status))throw httpError(409,run.status==='completed'?'This run is complete. Use Redo on a stage to run it again.':'This run can\'t be resumed right now.');
    for(const s of run.stages)if(['failed','paused','waiting','running'].includes(s.status)){s.status='pending';s.error=null;}
    run.attention=null;run.status='queued';run.queuedAt=now();this.history(run,'Resumed');await this.save(run);this.schedule();return run;
  }
  // Redo wipes the chosen stage (or step) and everything after it, then queues the run.
  async redo(id,stageId,stepId,{fresh=false}={}){
    const run=this.get(id);if(run.status==='draft')throw httpError(409,'Start the run first.');
    const index=run.stages.findIndex(s=>s.id===stageId);if(index<0)throw httpError(404,'No such stage.');
    const first=run.stages[index];
    if(stepId&&!first.steps.some(s=>s.id===stepId))throw httpError(404,'No such step.');
    await this.idle(run);
    if(run.stages.findIndex(s=>s.kind==='transitions')>=index)await this.archive(run,{fresh});
    if(first.kind==='prepare'){
      await workspace.unlinkModules(path.join(this.ws(run),run.def.toolchains?.node?.dir||'app','node_modules'));
      await util.remove(this.dir(run),this.ws(run));
      await util.remove(this.dir(run),path.join(this.dir(run),'transitions'));
      this.reloadDefinitions();run.def=clone(this.defs.get(run.pipeline)||run.def);run.contract='built-in';run.stages=this.stages(run.def,run.stages);
    }else{
      for(const stage of run.stages.slice(index)){
        const spec=this.spec(run,stage.id)||{},from=stage===first&&stepId?stage.steps.findIndex(s=>s.id===stepId):0;
        for(const step of (spec.steps||[]).slice(from))if(step.outputs)await util.wipe(this.ws(run),step.outputs);
        if(!(stage===first&&from>0)&&spec.outputs)await util.wipe(this.ws(run),spec.outputs);
        if(stage.kind==='transitions')await util.remove(this.dir(run),path.join(this.dir(run),'transitions'));
      }
      // Resetting a stage can need the game to rewrite what earlier stages left (e.g. which bridges play).
      for(const hook of this.spec(run,first.id)?.onReset||[]){
        if(hook.if&&!await util.exists(path.join(this.ws(run),hook.if)))continue;
        try{const ctx=this.context(run,first,new AbortController().signal);await this.toolchains(run,ctx,{quiet:true});
          const r=await runProcess({argv:expandArgs(hook.run,ctx.vars),cwd:path.join(ctx.ws,hook.cwd||'.'),env:ctx.env,onLine:l=>this.log(run,first,l)});
          if(r.code!==0)this.history(run,`Reset step for ${first.title} reported an error; see its log.`);
        }catch(e){this.history(run,`Reset step for ${first.title} couldn't run: ${e.message}`);}
        finally{this.closeLog(run,first);}
      }
    }
    for(const stage of run.stages.slice(index)){
      const fromStep=stage===first&&stepId?stage.steps.findIndex(s=>s.id===stepId):0;
      stage.steps.forEach((st,i)=>{if(i>=fromStep)Object.assign(st,{status:'pending',note:'',startedAt:null,endedAt:null});});
      Object.assign(stage,{status:'pending',error:null,progress:null,rows:null,estimate:null,approval:null,ingestAccepted:false,reviewApproved:false,skippedGeneration:false,elapsed:null,startedAt:null,endedAt:null,off:false});
      if(stage!==first||!stepId)stage.tail=[];
    }
    this.hooks.onRedo?.(run);
    run.attention=null;run.status='queued';run.queuedAt=now();run.finishedAt=null;
    this.history(run,`Redo from ${first.title}${stepId?` › ${first.steps.find(s=>s.id===stepId).title}`:''}`);
    await this.save(run);this.schedule();return run;
  }
  waitingStage(run,kinds){
    if(run.status!=='waiting'||!kinds.includes(run.attention?.kind))throw httpError(409,'This run isn\'t waiting for that.');
    return run.stages.find(s=>s.id===run.attention.stage);
  }
  async approve(id,{skip=false}={}){
    const run=this.get(id),stage=this.waitingStage(run,['approval']);
    if(skip){
      stage.status='skipped';stage.skippedGeneration=true;for(const st of stage.steps)st.status='skipped';
      this.history(run,`Skipped generating ${stage.title.toLowerCase()}; the optical-flow stand-ins will play.`);
    }else{stage.approval={at:now(),auto:false,maxUSD:stage.estimate?.cost?.[1]??null};this.history(run,`Approved spending for ${stage.title}`);}
    await this.save(run);return Engine.prototype.resume.call(this,id);
  }
  async proceed(id){
    const run=this.get(id),stage=this.waitingStage(run,['rows','ingest','review']),kind=run.attention.kind;
    if(kind==='rows'){const n=await transitions.reset(this.dir(run),r=>r.state==='failed',{to:'skipped'});this.history(run,`Continuing without ${n} failed transition${n===1?'':'s'}; stand-ins play for them.`);}
    if(kind==='ingest'){stage.ingestAccepted=true;this.history(run,'Continuing; stand-ins play for transitions that couldn\'t be brought in.');}
    if(kind==='review'){stage.reviewApproved=true;this.history(run,'Transitions reviewed; building the game.');}
    await this.save(run);return Engine.prototype.resume.call(this,id);
  }
  // Re-runs chosen transition rows and invalidates everything built from them.
  async retryRows(id,which){
    const run=this.get(id),index=run.stages.findIndex(s=>s.kind==='transitions');
    if(index<0)throw httpError(404,'This pipeline has no transitions.');
    const select=which==='failed'?r=>r.state==='failed':which==='ingest'?r=>r.ingest&&!r.ingest.ok:Array.isArray(which)?r=>which.includes(r.key):null;
    if(!select)throw httpError(400,'Choose which transitions to retry.');
    await this.idle(run);
    const n=await transitions.reset(this.dir(run),select,{to:'pending',root:this.root});
    if(!n)throw httpError(409,'None of those transitions can be retried.');
    await this.invalidateAfter(run,index);
    const stage=run.stages[index];Object.assign(stage,{status:'pending',error:null,ingestAccepted:false,reviewApproved:false});
    for(const st of stage.steps)if(st.id!=='approve')st.status='pending';
    if(stage.skippedGeneration){stage.skippedGeneration=false;stage.approval=null;stage.steps[0].status='pending';}
    run.attention=null;run.status='queued';run.queuedAt=now();this.history(run,`Retrying ${n} transition${n===1?'':'s'}`);
    await this.save(run);this.schedule();return {run,count:n};
  }
  async invalidateAfter(run,index){
    for(const stage of run.stages.slice(index+1)){
      if(stage.status==='pending'||(stage.optional&&!run.options.stages?.[stage.id]))continue;
      const spec=this.spec(run,stage.id)||{};
      for(const step of spec.steps||[])if(step.outputs)await util.wipe(this.ws(run),step.outputs);
      if(spec.outputs)await util.wipe(this.ws(run),spec.outputs);
      for(const st of stage.steps)st.status='pending';
      Object.assign(stage,{status:'pending',error:null,progress:null,elapsed:null});
    }
    this.hooks.onRedo?.(run);
  }
  async verdict(id,output,value,note=''){
    const run=this.get(id),index=run.stages.findIndex(s=>s.kind==='transitions'),stage=run.stages[index],spec=stage&&this.spec(run,stage.id);
    if(!spec?.verdict)throw httpError(400,'This pipeline doesn\'t support verdicts on transitions.');
    if(!['ok','reject'].includes(value))throw httpError(400,'Verdict must be ok or reject.');
    if(!(await transitions.load(this.dir(run)))?.ingestedAt)throw httpError(409,'Transitions are judged after they\'ve been brought into the game.');
    await this.idle(run);
    const ctx=this.context(run,stage,new AbortController().signal);await this.toolchains(run,ctx,{quiet:true});
    let message='';
    const r=await runProcess({argv:expandArgs(spec.verdict.run,{...ctx.vars,name:output,value,note:String(note).slice(0,300)}),cwd:path.join(ctx.ws,spec.verdict.cwd||'.'),env:ctx.env,onLine:(l,s)=>{this.log(run,stage,l,s);if(s==='stderr'&&l.trim())message=l;}});
    this.closeLog(run,stage);
    if(r.code!==0)throw httpError(400,message||'The game\'s verdict command failed; see the Transitions log.');
    await this.archive(run).catch(()=>{});
    await this.invalidateAfter(run,index);
    if(run.status==='completed'||run.status==='paused'){run.status='paused';run.attention={kind:'rebuild',stage:run.stages[index+1]?.id,message:'Your transition changes take effect when the game is rebuilt.',fix:'Resume to rebuild the game. Make all your changes first; it only rebuilds once.'};}
    this.history(run,`${value==='reject'?'Rejected':'Approved'} ${output}${note?`: ${note}`:''}`);
    await this.save(run);return run;
  }
  // Picks up new game code (and this app's latest definition) without touching any outputs.
  async updateCode(id){
    const run=this.get(id);if(run.status==='draft')throw httpError(409,'The code is copied when the run starts.');
    if(this.active?.run===run)throw httpError(409,'Pause the run before updating its code.');
    if(!await util.exists(this.ws(run)))throw httpError(409,'This run has no copy of the game code yet. Resume or redo Set up.');
    this.reloadDefinitions();
    const stage=run.stages.find(s=>s.id==='prepare'),ctx=this.context(run,stage,new AbortController().signal);
    const before=run.stages.map(s=>s.id).join();
    try{
      run.game=await workspace.snapshot(ctx);
      const {def,source}=await workspace.contract(ctx,this.defs.get(run.pipeline)||run.def);run.def=clone(def);run.contract=source;run.stages=this.stages(run.def,run.stages);
      run.game.carried=await workspace.carry(ctx);
    }finally{this.closeLog(run,stage);}
    const changedStages=before!==run.stages.map(s=>s.id).join();
    const message=`Game code updated: ${run.game.changed} file${run.game.changed===1?'':'s'} copied, ${run.game.deleted} removed${run.game.carried?`, ${run.game.carried} shared asset folder${run.game.carried===1?'':'s'} refreshed`:''}.${changedStages?' The stage list changed too.':''}`;
    // A run waiting on a decision (approval, keys, failed rows...) keeps that question on screen.
    const gate=run.status==='waiting'&&run.stages.some(s=>s.id===run.attention?.stage);
    if(run.status==='waiting'&&!gate)run.status='paused';
    if(!gate)run.attention={kind:'info',message,fix:'Nothing was rebuilt. Redo the stage your change affects; for game code only, redo Game.'};
    if(run.status==='completed'&&changedStages&&run.stages.some(s=>s.status==='pending')){run.status='paused';}
    this.history(run,`Game code updated (${run.game.changed} copied, ${run.game.deleted} removed)`);
    await this.save(run);return {run,message};
  }
  async dismiss(id){const run=this.get(id);if(['info','interrupted'].includes(run.attention?.kind)){run.attention=null;await this.save(run);}return run;}
  async remove(id){
    const run=this.get(id);
    await this.idle(run,'delete');
    await this.archive(run).catch(()=>{});
    this.runs.delete(id);clearTimeout(this.timers.get(id));this.timers.delete(id);this.sizes.delete(id);
    for(const s of run.stages)this.closeLog(run,s);
    this.hooks.onRedo?.(run);
    await workspace.unlinkModules(path.join(this.ws(run),run.def.toolchains?.node?.dir||'app','node_modules')).catch(()=>{});
    await util.remove(this.runsDir,this.dir(run));
    this.schedule();
  }
  // Files this run's finished transitions in the shared library (see transitions.js).
  async archive(run,{fresh=false}={}){
    const stage=run.stages.find(s=>s.kind==='transitions');if(!stage)return 0;
    const n=await transitions.archive({root:this.root,runDir:this.dir(run),ws:this.ws(run),spec:this.spec(run,stage.id),runId:run.id},{fresh});
    if(n)this.history(run,`Kept ${n} paid transition${n===1?'':'s'} in the library for reuse.`);
    return n;
  }
  async rows(id,query){
    const run=this.get(id),stage=run.stages.find(s=>s.kind==='transitions');
    return transitions.rows(this.dir(run),{...query,ws:this.ws(run),spec:stage&&this.spec(run,stage.id)});
  }
  keysChanged(){
    for(const run of this.runs.values()){
      if(run.status!=='waiting'||!['keys','provider'].includes(run.attention?.kind))continue;
      const need=run.attention.actions||[];
      if(run.attention.kind==='keys'&&need.every(p=>this.keys.get(p)))this.resume(run.id).catch(()=>{});
    }
  }
  file(id,rel){
    const run=this.get(id),clean=String(rel||'').replace(/\\/g,'/');
    const roots={game:this.ws(run),transitions:path.join(this.dir(run),'transitions','outputs')},[root,...rest]=clean.split('/');
    if(!roots[root]||!rest.length||rest.some(p=>!p||p==='..'||p==='.'))throw httpError(404,'Not found.');
    const full=path.join(roots[root],...rest);if(!util.inside(roots[root],full))throw httpError(404,'Not found.');
    return full;
  }
  artifactDir(id,name){
    const run=this.get(id),stage=run.stages.find(s=>s.artifacts?.[name]);
    if(!stage||stage.status!=='done')throw httpError(409,'Build the game first.');
    const dir=path.join(this.ws(run),stage.artifacts[name]);if(!util.inside(this.ws(run),dir))throw httpError(404,'Not found.');
    return {run,dir};
  }
  async close(){
    this.closing=true;
    if(this.active)await this.stopActive('shutdown');
    for(const [id,t] of this.timers){clearTimeout(t);const run=this.runs.get(id);if(run)await this.save(run).catch(()=>{});}
    for(const out of this.logs.values())out.end();this.logs.clear();
    clearTimeout(this.statTimer);await util.atomicWrite(path.join(this.root,'stats.json'),JSON.stringify(this.stats)).catch(()=>{});
    if(this.lockFile){HELD.delete(this.lockFile);await fs.rm(this.lockFile,{force:true}).catch(()=>{});}
  }
}
module.exports={Engine,PREPARE_STEPS,TRANSITION_STEPS};
