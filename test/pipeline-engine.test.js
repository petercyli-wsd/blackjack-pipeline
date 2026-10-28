// Pipeline engine with real processes (a fake game tool), real files and fake generation. No keys or charges.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {setTimeout:delay}=require('node:timers/promises');
const {Engine}=require('../src/pipeline/engine');
const transitions=require('../src/pipeline/transitions');
const {ff}=require('../src/media');

const game=path.join(__dirname,'fixtures','fake-game');
async function setup({rows=3,method='blend',extra={},stages}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pipeline-engine-')),control=path.join(root,'control'),defs=path.join(root,'defs');
  await fs.mkdir(control);await fs.mkdir(defs);process.env.FAKE_CONTROL=control;
  await fs.writeFile(path.join(control,'rows'),String(rows));await fs.writeFile(path.join(control,'method'),method);
  const def={version:1,id:'fake',name:'Fake game',enabled:true,game:{name:'fake',localPath:game,exclude:['work','out']},input:{width:160,height:90,fps:'24',minSeconds:.5,maxSeconds:60},
    stages:stages||[
      {id:'clips',title:'Clips',kind:'command',run:['{node}','tool.js','clips','{input}'],markers:{start:'^\\[run \\] (\\S+)',done:'^\\[done\\] (\\S+)',cached:'^\\[skip\\] (\\S+)'},
        steps:[{id:'a',title:'A',outputs:['work/a.txt']},{id:'b',title:'B',outputs:['work/b.txt']},{id:'c',title:'C',outputs:['work/c.txt','work/plan.csv','work/stubs']}],
        verify:[{exists:'work/c.txt'}],errorHints:[{match:'BOOM at (\\w+)',message:'Exploded at $1',fix:'Remove the bomb'}]},
      {id:'transitions',title:'Transitions',kind:'transitions',csv:'work/plan.csv',sourceRoot:'work/stubs',
        ingest:{run:['{node}','tool.js','ingest','{outputs}'],failed:'^\\s+! ([^:]+): (.*)$',summary:'^SUMMARY: (.*)$'},
        verdict:{run:['{node}','tool.js','verdict','{name}','{value}','{note}']},onReset:[{run:['{node}','tool.js','reset'],if:'work/plan.csv'}],verdicts:'work/verdicts.json',outputs:['work/ingested','work/verdicts.json']},
      {id:'game',title:'Game',kind:'command',run:['{node}','tool.js','build'],outputs:['out'],artifacts:{site:'out'},verify:[{exists:'out/index.html'}],errorHints:[{match:'error TS\\d+',message:'The game code doesn\'t compile.',fix:'Fix it.'}]}],...extra};
  await fs.writeFile(path.join(defs,'fake.json'),JSON.stringify(def));
  const input=path.join(root,'take.mp4');await ff(['-f','lavfi','-i','testsrc2=size=160x90:rate=24:duration=1','-c:v','libx264','-pix_fmt','yuv420p',input]);
  const keys={values:{},get(p){return this.values[p]||'';},status(){return {fal:!!this.values.fal};}};
  const renders=[];
  const hooks={renderVideo:async(o,{dir,signal})=>{renders.push(o);await fs.mkdir(dir,{recursive:true});if(await exists(path.join(control,'slow-render')))while(!await exists(path.join(control,'release-render'))){signal.throwIfAborted();await delay(20);}
    if(await exists(path.join(control,`fail-render-${path.basename(o.a)}`)))throw new Error('Provider exploded');
    const flaky=path.join(control,`flaky-render-${path.basename(o.a)}`),left=Number(await fs.readFile(flaky,'utf8').catch(()=>0));
    if(left){await fs.writeFile(flaky,String(left-1));throw new Error('fal boundary upload (HTTP 500): Error initiating upload');}
    const output=path.join(dir,'result.mp4');await fs.copyFile(o.a,output);return {output,frames:[],duration:1,fps:24,bridgeFrames:7};},retryDelayMs:50};
  const make=()=>new Engine({dataDir:root,definitionsDir:defs,appRoot:root,keys,hooks});
  const engine=make();await engine.init();
  const flag=(name,on=true)=>on?fs.writeFile(path.join(control,name),'1'):fs.rm(path.join(control,name),{force:true});
  async function newRun(options={autoApproveUSD:0}){
    const run=await engine.create('fake',{name:'Test run',options});
    const file=engine.inputPath(run,'take.mp4');await fs.mkdir(path.dirname(file),{recursive:true});await fs.copyFile(input,file);
    await engine.beginInput(run.id);await engine.acceptInput(run,file,'take.mp4');return run;
  }
  return {root,engine,make,keys,flag,newRun,renders,control,input};
}
const exists=f=>fs.access(f).then(()=>true,()=>false);
async function until(engine,id,check,ms=20000){
  const end=Date.now()+ms;
  while(Date.now()<end){const v=engine.view(engine.get(id),{full:true});if(check(v))return v;await delay(25);}
  const v=engine.view(engine.get(id),{full:true});throw new Error(`Timed out; run is ${v.status}: ${JSON.stringify(v.attention)} ${v.stages.map(s=>`${s.id}:${s.status}`).join(' ')}`);
}
const settled=v=>['completed','failed','waiting','paused'].includes(v.status);

test('a run goes input → stages → playable game, with steps, logs, progress and outputs',{timeout:60000},async()=>{
  const t=await setup();
  try{
    const run=await t.newRun();
    assert.equal(run.input.validation.ok,true);assert.match(run.input.validation.info.summary,/160×90/);
    await t.engine.start(run.id);
    const v=await until(t.engine,run.id,settled);
    assert.equal(v.status,'completed',JSON.stringify(v.attention));assert.equal(v.progress,1);
    assert.deepEqual(v.stages.map(s=>s.status),['done','done','done','done']);
    assert.deepEqual(v.stages[1].steps.map(s=>s.status),['done','done','done']);
    assert.ok(v.stages[0].steps.find(s=>s.id==='source').status==='done');
    const ws=t.engine.ws(t.engine.get(run.id));
    assert.match(await fs.readFile(path.join(ws,'work/a.txt'),'utf8'),/done a from take\.mp4/);
    assert.equal((await fs.readdir(path.join(ws,'work/ingested'))).length,3);
    assert.ok(await exists(path.join(ws,'out/index.html')));
    const rows=await t.engine.rows(run.id,{});assert.equal(rows.counts.done,3);assert.equal(rows.registry,'3 generated');
    assert.equal(t.renders[0].fps,'source');assert.equal(t.renders[0].review.mode,'off');
    const log=await t.engine.readLog(run.id,'clips');assert.match(log.text,/\[run \] b/);
    assert.equal((await t.engine.list('fake')).length,1);
    // The source game folder is never written to.
    assert.equal(await exists(path.join(game,'work')),false);
  }finally{await t.engine.close();}
});

test('a failing step explains itself, leaves no partial output, and resume reuses finished steps',{timeout:60000},async()=>{
  const t=await setup();
  try{
    await t.flag('fail-b');const run=await t.newRun();await t.engine.start(run.id);
    let v=await until(t.engine,run.id,settled);
    assert.equal(v.status,'failed');assert.equal(v.attention.kind,'error');assert.equal(v.attention.message,'Exploded at b');assert.equal(v.attention.fix,'Remove the bomb');
    assert.match(v.attention.detail,/RuntimeError: BOOM at b/);
    const clips=v.stages.find(s=>s.id==='clips');assert.equal(clips.status,'failed');assert.deepEqual(clips.steps.map(s=>s.status),['done','failed','pending']);
    const ws=t.engine.ws(t.engine.get(run.id));assert.equal(await exists(path.join(ws,'work/b.txt')),false,'partial output of the failed step is removed');
    await t.flag('fail-b',false);await t.engine.resume(run.id);
    v=await until(t.engine,run.id,settled);assert.equal(v.status,'completed');
    assert.deepEqual(v.stages.find(s=>s.id==='clips').steps.map(s=>s.status),['cached','done','done']);
  }finally{await t.engine.close();}
});

test('redo from a step wipes it and everything after, keeps earlier work, and runs the reset hook',{timeout:180000},async()=>{
  const t=await setup();
  try{
    const run=await t.newRun();await t.engine.start(run.id);await until(t.engine,run.id,settled);
    const ws=t.engine.ws(t.engine.get(run.id)),before=await fs.stat(path.join(ws,'work/a.txt'));
    await t.engine.redo(run.id,'clips','b');
    // Wiped immediately, before it runs again.
    const mid=t.engine.view(t.engine.get(run.id),{full:true});assert.equal(mid.status==='queued'||mid.status==='running',true);
    let v=await until(t.engine,run.id,settled);assert.equal(v.status,'completed');
    assert.deepEqual(v.stages.find(s=>s.id==='clips').steps.map(s=>s.status),['cached','done','done']);
    assert.equal((await fs.stat(path.join(ws,'work/a.txt'))).mtimeMs,before.mtimeMs);
    assert.equal(t.renders.length,3,'transitions whose clips came out the same are reused, not paid for again');
    // Redoing only the transitions runs its reset hook, keeps clips, and rebuilds the game.
    await t.engine.redo(run.id,'transitions');
    v=await until(t.engine,run.id,settled);assert.equal(v.status,'completed');
    assert.equal(await fs.readFile(path.join(ws,'work/reset.txt'),'utf8'),'yes');
    assert.deepEqual(v.stages.find(s=>s.id==='clips').steps.map(s=>s.status),['cached','done','done']);
    // Redo Set up re-copies the game code and starts clean.
    await t.engine.redo(run.id,'prepare');assert.equal(await exists(path.join(ws,'work')),false);
    v=await until(t.engine,run.id,settled);assert.equal(v.status,'completed');
    assert.deepEqual(v.stages.find(s=>s.id==='clips').steps.map(s=>s.status),['done','done','done']);
  }finally{await t.engine.close();}
});

test('pause stops a step at once, removes its partial file, and resume finishes the run',{timeout:60000},async()=>{
  const t=await setup();
  try{
    await t.flag('slow-b');const run=await t.newRun();await t.engine.start(run.id);
    await until(t.engine,run.id,v=>v.stages.find(s=>s.id==='clips').steps[1].status==='running');
    const ws=t.engine.ws(t.engine.get(run.id));assert.equal(await fs.readFile(path.join(ws,'work/b.txt'),'utf8'),'partial');
    assert.deepEqual(await t.engine.pause(run.id),{graceful:false});
    let v=t.engine.view(t.engine.get(run.id),{full:true});
    assert.equal(v.status,'paused');assert.equal(v.stages.find(s=>s.id==='clips').status,'paused');
    assert.equal(await exists(path.join(ws,'work/b.txt')),false);
    await t.flag('release-b');await t.engine.resume(run.id);
    v=await until(t.engine,run.id,settled);assert.equal(v.status,'completed');
  }finally{await t.engine.close();}
});

test('a server restart mid-run resumes the run; a second server on the same folder is refused',{timeout:60000},async()=>{
  const t=await setup();let second;
  try{
    await t.flag('slow-c');const run=await t.newRun();await t.engine.start(run.id);
    await until(t.engine,run.id,v=>v.stages.find(s=>s.id==='clips').steps[2].status==='running');
    await assert.rejects(()=>t.make().init(),e=>e.code==='ELOCKED');
    await t.engine.close();
    assert.equal(JSON.parse(await fs.readFile(path.join(t.root,'pipeline/runs',run.id,'run.json'),'utf8')).status,'queued');
    await t.flag('release-c');
    second=t.make();await second.init();
    const v=await until(second,run.id,settled);assert.equal(v.status,'completed');
    assert.deepEqual(v.stages.find(s=>s.id==='clips').steps.map(s=>s.status),['cached','cached','done']);
    // A crash (no clean shutdown) is recovered the same way.
    const crashed=JSON.parse(await fs.readFile(path.join(t.root,'pipeline/runs',run.id,'run.json'),'utf8'));
    crashed.status='running';crashed.stages[1].status='running';crashed.stages[1].steps[2].status='running';
    await second.close();await fs.writeFile(path.join(t.root,'pipeline/runs',run.id,'run.json'),JSON.stringify(crashed));
    await fs.writeFile(path.join(t.engine.ws(crashed),'work/c.txt'),'partial');
    second=t.make();await second.init();
    const r=await until(second,run.id,settled);assert.equal(r.status,'completed');
    assert.match(await fs.readFile(path.join(second.ws(crashed),'work/c.txt'),'utf8'),/^done c/,'the half-written step output was redone, not trusted');
    assert.ok(r.history.some(h=>/Server restarted mid-run/.test(h.text)));
  }finally{await second?.close();}
});

test('spending waits for approval; skipping generation still builds the game',{timeout:60000},async()=>{
  const t=await setup();
  try{
    let run=await t.newRun({autoApproveUSD:null});await t.engine.start(run.id);
    let v=await until(t.engine,run.id,settled);
    assert.equal(v.status,'waiting');assert.equal(v.attention.kind,'approval');assert.match(v.attention.message,/Approve spending to generate 3 transitions/);
    assert.equal(t.renders.length,0,'nothing is generated before approval');
    const updated=await t.engine.updateCode(run.id);assert.match(updated.message,/Game code updated/);
    v=t.engine.view(t.engine.get(run.id));assert.equal(v.status,'waiting');assert.equal(v.attention.kind,'approval','updating the code keeps the approval question');
    await t.engine.approve(run.id);v=await until(t.engine,run.id,settled);assert.equal(v.status,'completed');assert.equal(t.renders.length,3);
    await t.flag('distinct');run=await t.newRun({autoApproveUSD:null});await t.engine.start(run.id);v=await until(t.engine,run.id,settled);
    assert.match(v.attention.message,/generate 2 transitions.* 1 more is reused from earlier work for free\./);
    await t.engine.approve(run.id,{skip:true});v=await until(t.engine,run.id,settled);
    assert.equal(v.status,'completed');assert.equal(v.stages.find(s=>s.id==='transitions').status,'skipped');assert.equal(v.stages.find(s=>s.id==='transitions').skippedGeneration,true);assert.equal(t.renders.length,3);
  }finally{await t.engine.close();}
});

test('paid transitions are kept and reused after a redo or in a new run; regenerated or rejected ones are made again',{timeout:240000},async()=>{
  const t=await setup({rows:3});
  try{
    await t.flag('distinct');
    let run=await t.newRun();await t.engine.start(run.id);
    let v=await until(t.engine,run.id,settled);assert.equal(v.status,'completed');assert.equal(t.renders.length,3);
    const lib=transitions.libraryDir(t.engine.root),reused=async id=>(await t.engine.rows(id,{})).rows.map(r=>r.reused);
    assert.equal((await fs.readdir(lib)).filter(f=>f.endsWith('.mp4')).length,3,'every finished transition is filed');
    await t.flag('shift-2');await t.engine.redo(run.id,'clips');v=await until(t.engine,run.id,settled);
    assert.equal(v.status,'completed');assert.equal(t.renders.length,4,'only the changed transition is made again');assert.deepEqual(await reused(run.id),[true,true,false]);
    await t.engine.redo(run.id,'transitions',undefined,{fresh:true});v=await until(t.engine,run.id,settled);
    assert.equal(t.renders.length,7,'regenerate-anyway makes them all again');assert.deepEqual(await reused(run.id),[false,false,false]);
    const [first]=(await t.engine.rows(run.id,{})).rows;await t.engine.retryRows(run.id,[first.key]);v=await until(t.engine,run.id,settled);
    assert.equal(t.renders.length,8,'Regenerate never hands back the same video');
    await t.engine.verdict(run.id,'row0.mp4','reject','hand pops');await t.engine.redo(run.id,'clips');v=await until(t.engine,run.id,settled);
    assert.equal(t.renders.length,9,'a rejected transition is made again');assert.deepEqual(await reused(run.id),[false,true,true]);
    await t.engine.remove(run.id);
    run=await t.newRun();await t.engine.start(run.id);v=await until(t.engine,run.id,settled);
    assert.equal(v.status,'completed');assert.equal(t.renders.length,9,'a new run of the same take reuses everything');assert.deepEqual(await reused(run.id),[true,true,true]);
    assert.match(v.stages.find(s=>s.id==='transitions').steps[0].note,/Nothing to generate/);
    // Transitions made before the library existed are filed when their run is redone.
    await fs.rm(lib,{recursive:true,force:true});
    const file=transitions.dirs(t.engine.dir(t.engine.get(run.id))).file,state=JSON.parse(await fs.readFile(file,'utf8'));
    for(const r of state.rows){delete r.fingerprint;delete r.reused;}await fs.writeFile(file,JSON.stringify(state));
    await t.engine.redo(run.id,'clips');v=await until(t.engine,run.id,settled);
    assert.equal(t.renders.length,9);assert.ok(v.history.some(h=>/Kept 3 paid transitions/.test(h.text)));
  }finally{await t.engine.close();}
});

test('a provider server error is retried by itself; one that keeps failing stops on that row only',{timeout:60000},async()=>{
  const t=await setup({rows:3});
  try{
    await fs.writeFile(path.join(t.control,'flaky-render-e1.mp4'),'1');await fs.writeFile(path.join(t.control,'flaky-render-e2.mp4'),'5');
    const run=await t.newRun();await t.engine.start(run.id);
    const v=await until(t.engine,run.id,settled);
    assert.equal(v.status,'waiting');assert.equal(v.attention.kind,'rows');assert.match(v.attention.message,/^1 transition failed/);assert.match(v.attention.detail,/HTTP 500/);
    const rows=(await t.engine.rows(run.id,{})).rows;
    assert.deepEqual(rows.map(r=>r.state),['done','done','failed'],'one hiccup is absorbed; three in a row are reported');
    assert.equal(t.renders.length,1+2+3,'a flaky row is tried three times at most');
  }finally{await t.engine.close();}
});

test('missing provider keys wait, then generation starts by itself when the key arrives',{timeout:60000},async()=>{
  const t=await setup({method:'film'});
  try{
    const run=await t.newRun({autoApproveUSD:100});await t.engine.start(run.id);
    let v=await until(t.engine,run.id,settled);
    assert.equal(v.attention.kind,'keys');assert.deepEqual(v.attention.actions,['fal']);assert.match(v.attention.message,/fal key/);
    t.keys.values.fal='secret';t.engine.keysChanged();
    v=await until(t.engine,run.id,x=>x.status==='completed');assert.equal(t.renders.length,3);
  }finally{await t.engine.close();}
});

test('failed transitions can be retried or skipped; ingest failures and verdicts are surfaced',{timeout:60000},async()=>{
  const t=await setup({rows:3});
  try{
    await t.flag('fail-render-e2.mp4');await t.flag('bad-row');
    const run=await t.newRun();await t.engine.start(run.id);
    let v=await until(t.engine,run.id,settled);
    assert.equal(v.attention.kind,'rows');assert.match(v.attention.message,/1 transition failed/);assert.match(v.attention.detail,/Provider exploded/);
    let rows=await t.engine.rows(run.id,{filter:'failed'});assert.equal(rows.rows.length,1);assert.equal(rows.rows[0].output,'row2.mp4');
    await t.flag('fail-render-e2.mp4',false);
    const retried=await t.engine.retryRows(run.id,'failed');assert.equal(retried.count,1);
    v=await until(t.engine,run.id,settled);
    assert.equal(v.attention.kind,'ingest');assert.match(v.attention.detail,/bad1\.mp4: stubs not found/);
    rows=await t.engine.rows(run.id,{});assert.equal(rows.rows.find(r=>r.output==='bad1.mp4').ingest.ok,false);
    await t.engine.proceed(run.id);v=await until(t.engine,run.id,settled);assert.equal(v.status,'completed');
    await t.engine.verdict(run.id,'row0.mp4','reject','hand pops');
    v=t.engine.view(t.engine.get(run.id),{full:true});
    assert.equal(v.status,'paused');assert.equal(v.attention.kind,'rebuild');assert.equal(v.stages.find(s=>s.id==='game').status,'pending');
    assert.equal(await exists(path.join(t.engine.ws(t.engine.get(run.id)),'out')),false,'the stale build is removed');
    await t.engine.resume(run.id);v=await until(t.engine,run.id,settled);assert.equal(v.status,'completed');
  }finally{await t.engine.close();}
});

test('the game stage reports compile errors in plain words; delete removes everything',{timeout:60000},async()=>{
  const t=await setup();
  try{
    await t.flag('fail-build');const run=await t.newRun();await t.engine.start(run.id);
    const v=await until(t.engine,run.id,settled);
    assert.equal(v.status,'failed');assert.equal(v.attention.stage,'game');assert.equal(v.attention.message,'The game code doesn\'t compile.');assert.match(v.attention.detail,/error TS2304/);
    const dir=t.engine.dir(t.engine.get(run.id));
    await t.engine.remove(run.id);assert.equal(await exists(dir),false);assert.throws(()=>t.engine.get(run.id),/not found/);
  }finally{await t.engine.close();}
});

test('invalid takes are refused with the reason, and disabled pipelines cannot start',{timeout:60000},async()=>{
  const t=await setup();
  try{
    const run=await t.engine.create('fake',{});
    const big=path.join(t.root,'big.mp4');await ff(['-f','lavfi','-i','testsrc2=size=320x180:rate=30:duration=1','-c:v','libx264','-pix_fmt','yuv420p',big]);
    let file=t.engine.inputPath(run,'big.mp4');await fs.mkdir(path.dirname(file),{recursive:true});await fs.copyFile(big,file);
    await t.engine.beginInput(run.id);const checked=await t.engine.acceptInput(run,file,'big.mp4');
    assert.equal(checked.input.validation.ok,false);assert.equal(checked.input.file,null);assert.equal(await exists(file),false);
    const messages=checked.input.validation.errors.map(e=>e.message).join(' ');
    assert.match(messages,/320×180, but this pipeline needs exactly 160×90/);assert.match(messages,/30\.000 fps/);
    await assert.rejects(()=>t.engine.start(run.id),/valid take/);
    file=t.engine.inputPath(run,'notes.txt');await fs.writeFile(file,'not a video');await t.engine.beginInput(run.id);
    assert.match((await t.engine.acceptInput(run,file,'notes.txt')).input.validation.errors[0].message,/isn't a video/);
    await t.engine.beginInput(run.id);await assert.rejects(()=>t.engine.beginInput(run.id),/already uploading/);await t.engine.failInput(run,file);
    await assert.rejects(()=>t.engine.create('missing',{}),/Unknown pipeline/);
  }finally{await t.engine.close();}
});

test('overlapping actions on one run are taken one at a time',{timeout:60000},async()=>{
  const t=await setup();
  try{
    const run=await t.newRun();await t.engine.start(run.id);await until(t.engine,run.id,settled);
    // Two tabs (or a double click) ask for a redo at the same moment, plus a pause in between.
    await Promise.all([t.engine.redo(run.id,'clips','b'),t.engine.pause(run.id).catch(()=>null),t.engine.redo(run.id,'clips','b')]);
    let v=t.engine.view(t.engine.get(run.id),{full:true});
    if(v.status==='paused')await t.engine.resume(run.id);
    v=await until(t.engine,run.id,settled);assert.equal(v.status,'completed',JSON.stringify(v.attention));
    const ws=t.engine.ws(t.engine.get(run.id));
    for(const f of ['a','b','c'])assert.match(await fs.readFile(path.join(ws,`work/${f}.txt`),'utf8'),/^done /);
    assert.equal((await fs.readdir(path.join(ws,'work/ingested'))).length,3);
  }finally{await t.engine.close();}
});
