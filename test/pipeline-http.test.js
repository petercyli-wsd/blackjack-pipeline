// Pipeline HTTP API end to end through createStudio, with the fake game and fake generation.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {setTimeout:delay}=require('node:timers/promises');
const {createStudio}=require('../server');
const {ff}=require('../src/media');

async function fixture(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pipeline-http-')),defs=path.join(root,'defs'),control=path.join(root,'control');
  await fs.mkdir(defs);await fs.mkdir(control);process.env.FAKE_CONTROL=control;await fs.writeFile(path.join(control,'rows'),'2');await fs.writeFile(path.join(control,'method'),'blend');
  const stage=(id,extra)=>({id,title:id,kind:'command',...extra});
  await fs.writeFile(path.join(defs,'fake.json'),JSON.stringify({version:1,id:'fake',name:'Fake',enabled:true,game:{name:'fake',localPath:path.join(__dirname,'fixtures','fake-game'),exclude:['work','out']},
    input:{width:160,height:90,fps:'24',minSeconds:.5,maxSeconds:60},stages:[
      stage('clips',{run:['{node}','tool.js','clips','{input}'],markers:{start:'^\\[run \\] (\\S+)',done:'^\\[done\\] (\\S+)'},steps:[{id:'a',title:'A',outputs:['work/a.txt']},{id:'b',title:'B',outputs:['work/b.txt']},{id:'c',title:'C',outputs:['work/c.txt'],gallery:'work/*.txt'}]}),
      {id:'transitions',title:'Transitions',kind:'transitions',csv:'work/plan.csv',sourceRoot:'work/stubs',ingest:{run:['{node}','tool.js','ingest','{outputs}'],summary:'^SUMMARY: (.*)$'}},
      stage('game',{run:['{node}','tool.js','build'],outputs:['out'],artifacts:{site:'out',assets:'work'}})]}));
  await fs.writeFile(path.join(defs,'later.json'),JSON.stringify({version:1,id:'later',name:'Later',enabled:false,disabledReason:'Not produced yet.',stages:[{id:'x',title:'X',kind:'command',run:[]}]}));
  const input=path.join(root,'take.mp4');await ff(['-f','lavfi','-i','testsrc2=size=160x90:rate=24:duration=1','-c:v','libx264','-pix_fmt','yuv420p',input]);
  const renderVideo=async(o,{dir})=>{await fs.mkdir(dir,{recursive:true});const output=path.join(dir,'result.mp4');await fs.copyFile(o.a,output);return {output,frames:[],duration:1,fps:24,bridgeFrames:7};};
  return {root,defs,input,renderVideo};
}
async function client(app){
  const s=await fetch(app.url+'/api/session'),{token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,'X-Studio-Token':token};
  const request=(route,method='GET',body,extra={})=>fetch(app.url+route,{method,headers:{...headers,...(body!==undefined&&!(body instanceof Buffer)?{'Content-Type':'application/json'}:{}),...extra},body:body===undefined?undefined:body instanceof Buffer?body:JSON.stringify(body)});
  const api=async(...a)=>{const r=await request(...a),d=await r.json();assert.ok(r.ok,`${a[0]}: ${JSON.stringify(d)}`);return d;};
  return {request,api,cookie};
}

test('pipeline API: create, upload, run, browse files, download, play, delete',{timeout:90000},async()=>{
  const f=await fixture(),app=await createStudio({dataDir:path.join(f.root,'data'),definitionsDir:f.defs,appRoot:f.root,pipelineHooks:{renderVideo:f.renderVideo}});
  try{
    const c=await client(app);
    const meta=await c.api('/api/pipeline');
    assert.equal(meta.enabled,true);assert.equal(meta.previews,true);assert.deepEqual(meta.definitions.map(d=>[d.id,d.enabled]),[['fake',true],['later',false]]);
    assert.equal((await c.request('/api/pipeline/runs','POST',{pipeline:'later'})).status,400);
    assert.equal((await c.request('/api/pipeline/runs','POST',{pipeline:'fake',options:{autoApproveUSD:-5}})).status,400);
    let run=await c.api('/api/pipeline/runs','POST',{pipeline:'fake',name:'HTTP run'});
    assert.equal(run.status,'draft');assert.equal(run.options.source,'local');
    // A bad upload is refused with the reason and leaves the draft usable.
    run=await c.api(`/api/pipeline/runs/${run.id}/input?name=notes.txt`,'POST',Buffer.from('hello'));
    assert.equal(run.input.ok,false);assert.match(run.input.errors[0].message,/isn't a video/);
    assert.equal((await c.request(`/api/pipeline/runs/${run.id}/start`,'POST',{})).status,400);
    run=await c.api(`/api/pipeline/runs/${run.id}/input-path`,'POST',{path:`"${f.input}"`});
    assert.equal(run.input.ok,true);assert.match(run.input.info.summary,/160×90 · 24\.000 fps/);
    run=await c.api(`/api/pipeline/runs/${run.id}`,'PATCH',{options:{autoApproveUSD:0,concurrency:2}});assert.equal(run.options.concurrency,2);
    await c.api(`/api/pipeline/runs/${run.id}/start`,'POST',{});
    assert.equal((await c.request(`/api/pipeline/runs/${run.id}`,'PATCH',{options:{concurrency:4}})).status,409,'options freeze at start');
    for(let i=0;i<400;i++){run=await c.api(`/api/pipeline/runs/${run.id}`);if(['completed','failed','waiting'].includes(run.status))break;await delay(50);}
    assert.equal(run.status,'completed',JSON.stringify(run.attention));
    assert.ok(run.stages.every(s=>s.tail&&s.steps),'detail view carries steps and log tails');
    assert.equal((await c.api('/api/pipeline/runs?pipeline=fake')).runs.length,1);
    const rows=await c.api(`/api/pipeline/runs/${run.id}/rows?filter=done`);assert.equal(rows.rows.length,2);assert.equal(rows.registry,'2 generated');
    const log=await c.api(`/api/pipeline/runs/${run.id}/log?stage=clips`);assert.match(log.text,/\[done\] c/);
    const gallery=await c.api(`/api/pipeline/runs/${run.id}/gallery?stage=clips`);assert.equal(gallery.images.length,3);
    // Files: cookie only (a <video> can't send headers), with ranges; nothing outside the run.
    const video=await fetch(app.url+`/pipeline-files/${run.id}/transitions/row0.mp4`,{headers:{Cookie:c.cookie,Range:'bytes=0-15'}});
    assert.equal(video.status,206);assert.equal((await video.arrayBuffer()).byteLength,16);assert.equal(video.headers.get('content-type'),'video/mp4');
    assert.equal((await fetch(app.url+gallery.images[0].url,{headers:{Cookie:c.cookie}})).status,200);
    for(const bad of ['game/../../run.json','game/..%2F..%2Frun.json','secrets/x','game'])assert.equal((await fetch(app.url+`/pipeline-files/${run.id}/${bad}`,{headers:{Cookie:c.cookie}})).status,404,bad);
    assert.equal((await fetch(app.url+`/pipeline-files/${run.id}/transitions/row0.mp4`)).status,403,'no session, no files');
    const download=await fetch(app.url+`/pipeline-download/${run.id}/site.zip`,{headers:{Cookie:c.cookie}});
    assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/http-run-game\.zip/);
    const zipped=Buffer.from(await download.arrayBuffer());assert.equal(zipped.length,Number(download.headers.get('content-length')));assert.equal(zipped.readUInt32LE(0),0x04034b50);
    const {url}=await c.api(`/api/pipeline/runs/${run.id}/preview`,'POST',{});
    assert.match(url,/^http:\/\/127\.0\.0\.1:\d+\/$/);assert.match(await (await fetch(url)).text(),/<title>game<\/title>/);
    assert.equal((await fetch(url+'clips/a.txt')).status,200);assert.equal((await fetch(url+'../../run.json')).status,404);
    // Redo closes the stale preview; delete removes everything.
    await c.api(`/api/pipeline/runs/${run.id}/redo`,'POST',{stage:'game'});
    await assert.rejects(()=>fetch(url),'preview of a wiped build is closed');
    for(let i=0;i<400;i++){run=await c.api(`/api/pipeline/runs/${run.id}`);if(run.status==='completed')break;await delay(50);}
    assert.equal(run.status,'completed');
    assert.equal((await c.request(`/api/pipeline/runs/${run.id}/redo`,'POST',{stage:'nope'})).status,404);
    await c.api(`/api/pipeline/runs/${run.id}`,'DELETE');
    assert.equal((await c.request(`/api/pipeline/runs/${run.id}`)).status,404);
    assert.equal((await c.request('/api/pipeline/runs/..%2F..%2Fetc')).status,404);
    // Keys entered for pipelines locally also reach this browser's Studio session.
    assert.deepEqual(await c.api('/api/pipeline/keys','POST',{runninghub:'rh-key'}),{fal:false,kie:false,runninghub:true});
    assert.equal((await c.api('/api/init')).pipelineKeys.runninghub,true);
    await c.api('/api/keys','POST',{fal:'fal-key'});assert.equal(app.keys.get('fal'),'fal-key');
    await c.api('/api/keys','DELETE');assert.equal(app.keys.get('fal'),'');assert.equal(app.keys.get('runninghub'),'');
  }finally{await app.close();}
});

test('hosted servers keep pipelines off unless enabled, and never share Studio keys with pipelines',{timeout:30000},async()=>{
  const f=await fixture();
  const http=require('node:http');
  const raw=(app,route,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const req=http.request(app.localURL+route,{method,headers:{Host:'studio.example',Authorization:'Basic '+Buffer.from('team:test-team-password-123456').toString('base64'),...headers}},res=>{const parts=[];res.on('data',x=>parts.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,json:()=>JSON.parse(Buffer.concat(parts))}));});req.on('error',reject);req.end(body);});
  const app=await createStudio({dataDir:path.join(f.root,'hosted'),hosted:true,publicOrigin:'https://studio.example',teamPassword:'test-team-password-123456',definitionsDir:f.defs});
  try{
    assert.equal(app.engine,null);
    const s=await raw(app,'/api/session'),cookie=s.headers['set-cookie'][0].split(';')[0],{token}=s.json(),h={Cookie:cookie,'X-Studio-Token':token,'Content-Type':'application/json'};
    const meta=(await raw(app,'/api/pipeline',{headers:h})).json();assert.equal(meta.enabled,false);assert.match(meta.reason,/persistent server/);
    assert.equal((await raw(app,'/api/pipeline/runs',{headers:h})).status,404);
    await raw(app,'/api/keys',{method:'POST',headers:h,body:JSON.stringify({fal:'team-member-key'})});
    assert.equal(app.keys.get('fal'),'','a teammate\'s Studio key never funds shared pipelines');
  }finally{await app.close();}
  const on=await createStudio({dataDir:path.join(f.root,'hosted-on'),hosted:true,publicOrigin:'https://studio.example',teamPassword:'test-team-password-123456',definitionsDir:f.defs,pipelines:true});
  try{
    const s=await raw(on,'/api/session'),cookie=s.headers['set-cookie'][0].split(';')[0],{token}=s.json(),h={Cookie:cookie,'X-Studio-Token':token,'Content-Type':'application/json'};
    const meta=(await raw(on,'/api/pipeline',{headers:h})).json();assert.equal(meta.enabled,true);assert.equal(meta.previews,false);
    const run=(await raw(on,'/api/pipeline/runs',{method:'POST',headers:h,body:JSON.stringify({pipeline:'fake'})})).json();assert.equal(run.options.source,'git','no local folders on a host');
    assert.equal((await raw(on,`/api/pipeline/runs/${run.id}/input-path`,{method:'POST',headers:h,body:JSON.stringify({path:f.input})})).status,403);
  }finally{await on.close();}
});
