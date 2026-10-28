// DOM + IndexedDB integration tests. No real browser, keys, or provider charges.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const {IDBFactory,IDBObjectStore}=require('fake-indexeddb');
const {METHODS,DEFAULT_PROMPT}=require('../src/models');
const {DECISION_POLICY}=require('../src/validation');
const {memoryFolder}=require('./helpers/memory-folder');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const publicDir=path.join(__dirname,'../public');
async function until(check){for(let i=0;i<300;i++){if(await check())return;await delay(10);}throw new Error('Condition timed out');}
function environment(){
  const env={indexedDB:new IDBFactory(),workspace:null,jobs:new Map(),calls:0,submissions:[],uploads:0,keys:{fal:true,kie:true},lostResponse:false,pending:false,downloads:[],locked:false};
  env.fetch=async(url,options={})=>{
    const route=new URL(url,'http://studio.test'),method=options.method||'GET',value=typeof options.body==='string'?JSON.parse(options.body):{};
    const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
    if(route.pathname==='/api/session')return json({token:'session-token'});
    if(route.pathname==='/api/init'){if(env.initDelay)await delay(env.initDelay);return json({methods:METHODS,prompt:DEFAULT_PROMPT,keys:env.keys,maxUploadBytes:512*1048576,hosted:true});}
    if(route.pathname==='/api/keys')return json(env.keys);
    if(route.pathname==='/api/results'&&method==='DELETE'){if(env.clearError)return json({error:env.clearError},409);env.cleared=(env.cleared||0)+1;return json({cleared:true});}
    if(route.pathname==='/api/batch')return json(env.workspace||{});
    if(route.pathname==='/api/batch/row'){env.workspace={rowId:value.rowId,uploads:{},jobId:null};return json({rowId:value.rowId});}
    if(route.pathname==='/api/batch/upload'){env.uploads++;env.workspace.uploads[route.searchParams.get('slot')]={duration:1};return json({duration:1});}
    if(route.pathname==='/api/batch/process'){
      if(env.workspace.jobId)return json({id:env.workspace.jobId},202);
      env.calls++;env.submissions.push(value);const id=`job-${env.calls}`;env.workspace.jobId=id;
      env.jobs.set(id,{id,state:env.failed?'failed':env.pending?'running':'complete',error:env.failed,messages:['Working'],providerJob:{provider:'fal',requestId:`provider-${env.calls}`},result:{url:'/media/'+id,bridgeDuration:Math.round(value.duration*24)/24,bridgeFrames:Math.round(value.duration*24),fpsRational:'24/1'}});
      if(env.review){env.jobs.get(id).result.review=typeof env.review==='function'?env.review(env.calls):env.review;env.jobs.get(id).providerJobs=[{provider:'fal',requestId:'review-request',phase:'review'}];}
      if(env.lostResponse){env.lostResponse=false;throw new TypeError('Network disconnected after submission');}
      return json({id},202);
    }
    if(route.pathname.startsWith('/api/jobs/'))return env.jobs.has(route.pathname.split('/').at(-1))?json(env.jobs.get(route.pathname.split('/').at(-1))):json({error:'Job lost'},404);
    if(route.pathname==='/api/batch/release'){env.workspace=null;return json({});}
    if(route.pathname==='/api/batch/cancel'){const job=env.jobs.get(env.workspace?.jobId);if(job){job.state='failed';job.error='Cancelled locally';}return json({});}
    if(route.pathname.startsWith('/media/'))return new Response(method==='HEAD'?null:'test-video',{headers:{'Content-Length':'10','Content-Type':'video/mp4'}});
    throw new Error('Unexpected route '+route.pathname);
  };
  return env;
}
async function browser(env,{folder}={}){
  const dom=new JSDOM(fs.readFileSync(path.join(publicDir,'index.html'),'utf8'),{url:'http://studio.test',runScripts:'outside-only'}),w=dom.window,$=id=>w.document.getElementById(id);
  Object.assign(w,{indexedDB:env.indexedDB,fetch:env.fetch,Blob,TextEncoder,TextDecoder,structuredClone,confirm:()=>true,alert:()=>{}});
  Object.defineProperty(w.crypto,'subtle',{value:require('node:crypto').webcrypto.subtle});
  w.navigator.locks={request:async(name,options,fn)=>{if(env.locked)return fn(null);env.locked=true;try{return await fn({name});}finally{env.locked=false;}}};
  w.URL.createObjectURL=blob=>{env.downloads.push(blob);return 'blob:test';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=()=>{};
  w.HTMLMediaElement.prototype.pause=()=>{};w.HTMLMediaElement.prototype.load=()=>{};
  if(folder)w.showDirectoryPicker=async()=>folder;
  // Avoid 1.5-second polling waits; preserve asynchronous ordering.
  const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timeout(fn,ms===1500||ms===5000?1:ms,...args);
  for(const name of ['notices.js','browser.js','frame-rate.js','renderer.js','batch-format.js','batch-settings.js','batch-zip.js','batch-estimates.js','batch-replace.js','batch.js','batch-review.js'])w.eval(fs.readFileSync(path.join(publicDir,name),'utf8'));
  await until(()=>$('method').options.length===METHODS.length&&!$('batch-csv').disabled).catch(e=>{throw new Error(`${e.message}: ${$('batch-status').textContent}; ${$('status').textContent}; methods=${$('method').options.length}`);});
  const selectFiles=()=>{
    Object.defineProperty($('batch-folder'),'files',{configurable:true,value:['a.mp4','b.mp4'].map(name=>({name,size:10,lastModified:1,webkitRelativePath:'videos/'+name}))});$('batch-folder').onchange();
  };
  const load=async(csv,name='pairs.csv')=>{selectFiles();Object.defineProperty($('batch-csv'),'files',{configurable:true,value:[{name,size:csv.length,text:async()=>csv}]});await $('batch-csv').onchange();};
  const state=async()=>new Promise((resolve,reject)=>{const request=env.indexedDB.open('dealer-transition-batches',1);request.onsuccess=()=>{const db=request.result,tx=db.transaction(['meta','rows']),r=tx.objectStore('meta').get('queue'),rows=tx.objectStore('rows').getAll();tx.oncomplete=()=>{db.close();resolve(r.result?{...r.result,rows:rows.result.sort((a,b)=>a.number-b.number)}:null);};tx.onerror=()=>reject(tx.error);};});
  return {w,$,load,selectFiles,state,close:()=>w.close()};
}

async function setupRepair(b,csv){
  b.$('batch-workflow').value='existing';b.$('batch-workflow').onchange();
  b.$('quality-mode').value='redo';b.$('quality-retries').value='1';
  b.$('batch-destination').value='replace';b.$('batch-destination').onchange();
  await b.$('batch-output-folder').onclick();await b.load(csv);
}

function failedInitialReview(){
  const summary='Review could not complete: Quality review (HTTP 400): Reasoning is mandatory for this endpoint and cannot be disabled.';
  return {verdict:'needs_review',summary,pauseBatch:true,selectedAttempt:0,redoCount:0,attempts:[{attempt:0,source:'existing',assessment:{verdict:'uncertain',confidence:0,summary,issues:[],error:true}}]};
}

test('new work defaults to one automatic redo; restoring an explicit off checkpoint keeps it off',async()=>{
  const env=environment();let b=await browser(env);
  try{
    assert.equal(b.$('quality-mode').value,'redo');assert.equal(b.$('quality-retries').value,'1');
    b.$('batch-workflow').value='existing';b.$('batch-workflow').onchange();assert.equal(b.$('quality-mode').value,'redo');
    b.$('batch-workflow').value='generate';b.$('batch-workflow').onchange();b.$('quality-mode').value='off';
    await b.load('a.mp4,b.mp4,one.mp4');await b.$('batch-start').onclick();const before=await b.state();
    b.close();env.initDelay=100;b=await browser(env);
    assert.equal(b.$('quality-mode').value,'off');assert.deepEqual(await b.state(),before);assert.equal(env.calls,1);
    assert.equal(b.$('batch-enable-repairs').hidden,true);
  }finally{b.close();}
});

test('review-only repair batch enables redos for flagged and pending rows without repeating approvals',async()=>{
  const folder=memoryFolder({'clean.mp4':'clean-original','flawed.mp4':'flawed-original','error.mp4':'error-original','pending.mp4':'pending-original'}),env=environment(),put=IDBObjectStore.prototype.put;
  const approved={verdict:'pass',summary:'Clean',selectedAttempt:0,redoCount:0,pauseBatch:false,attempts:[{attempt:0,source:'existing',assessment:{verdict:'pass',confidence:.8,issues:[]}}]};
  env.review=n=>n===1?approved:n===3?failedInitialReview():{...approved,verdict:'needs_review',summary:'Unnecessary sweep.',attempts:[{attempt:0,source:'existing',assessment:{verdict:'fail',confidence:.95,issues:[{category:'motion',severity:'major',time:.5,evidence:'Arm sweeps across the table.'}]}}]};
  let b=await browser(env,{folder:folder.root});
  try{
    await setupRepair(b,'first_half,second_half,output,method,duration\na.mp4,b.mp4,clean.mp4,kling-fal,3\na.mp4,b.mp4,flawed.mp4,kling-fal,3\na.mp4,b.mp4,error.mp4,kling-fal,3\na.mp4,b.mp4,pending.mp4,kling-fal,3');
    b.$('quality-mode').value='review';await b.$('batch-start').onclick();const before=await b.state(),writes=folder.writes.length;
    assert.equal(env.calls,3);assert.equal(before.settings.review.mode,'review');
    b.close();b=await browser(env,{folder:folder.root});
    assert.equal(b.$('quality-mode').value,'review');assert.equal(b.$('batch-enable-repairs').hidden,false);assert.match(b.$('batch-enable-repairs-help').textContent,/recheck 2 flagged original\(s\) and continue 1 pending/);
    b.$('batch-repair-retries').value='2';b.w.confirm=()=>false;await b.$('batch-enable-redos').onclick();assert.deepEqual(await b.state(),before);
    b.w.confirm=()=>true;env.locked=true;await b.$('batch-enable-redos').onclick();assert.match(b.$('batch-status').textContent,/another tab/);assert.deepEqual(await b.state(),before);env.locked=false;
    IDBObjectStore.prototype.put=function(value,...args){if(this.name==='rows'&&value.state==='pending')throw new Error('Storage unavailable');return put.call(this,value,...args);};
    await b.$('batch-enable-redos').onclick();assert.deepEqual(await b.state(),before);assert.match(b.$('batch-status').textContent,/Storage unavailable/);assert.equal(b.$('batch-enable-repairs').hidden,false);
    IDBObjectStore.prototype.put=put;b.w.confirm=text=>{assert.match(text,/up to 2 extra generations/);assert.match(text,/Recheck 2 flagged originals/);assert.match(text,/use credits/);return true;};
    await b.$('batch-enable-redos').onclick();let q=await b.state();
    assert.equal(q.id,before.id);assert.equal(q.csvName,before.csvName);assert.deepEqual(q.rows[0],before.rows[0]);assert.deepEqual(q.rows[3],before.rows[3]);
    assert.deepEqual(q.settings,{...before.settings,review:{...before.settings.review,mode:'redo',maxRetries:2}});
    assert.deepEqual(q.rows.map(r=>r.state),['saved','pending','pending','pending']);
    for(const i of [1,2]){assert.deepEqual(q.rows[i].history[0].review,before.rows[i].result.review);assert.deepEqual(q.rows[i].history[0].providerJobs,before.rows[i].providerJobs);assert.equal(q.rows[i].originalDigest,before.rows[i].originalDigest);assert.deepEqual(q.rows[i].resolvedSettings,before.rows[i].resolvedSettings);}
    assert.equal(env.calls,3);assert.equal(folder.writes.length,writes);assert.equal(b.$('batch-enable-repairs').hidden,true);
    // Persist the change before starting work; refreshing does not reset the limit.
    b.close();b=await browser(env,{folder:folder.root});assert.equal(b.$('quality-mode').value,'redo');assert.equal(b.$('quality-retries').value,'2');
    env.review=n=>n===4?{...approved,selectedAttempt:1,redoCount:1}:approved;
    b.selectFiles();await b.$('batch-output-folder').onclick();await b.$('batch-start').onclick();q=await b.state();
    assert.equal(env.calls,6);assert.ok(env.submissions.slice(3).every(s=>s.review.mode==='redo'&&s.review.maxRetries===2));
    assert.equal(await folder.text('clean.mp4'),'clean-original');assert.equal(await folder.text('flawed.mp4'),'test-video');assert.equal(await folder.text(q.rows[1].backupPath),'flawed-original');assert.equal(await folder.text('error.mp4'),'error-original');assert.equal(await folder.text('pending.mp4'),'pending-original');
    assert.equal(q.rows[1].savedName,'flawed.mp4');assert.deepEqual(q.rows[0],before.rows[0]);
  }finally{IDBObjectStore.prototype.put=put;b.close();}
});

test('restored review rows explain low confidence separately from service errors',async()=>{
  const folder=memoryFolder({'one.mp4':'one','two.mp4':'two','error.mp4':'error'}),env=environment();
  env.review=n=>n===3?failedInitialReview():{verdict:'needs_review',summary:'No visible continuity defect.',selectedAttempt:0,redoCount:0,pauseBatch:false,attempts:[{attempt:0,source:'existing',assessment:{verdict:'uncertain',confidence:n===1?.75:.8,summary:'No visible continuity defect.',issues:[]}}]};
  let b=await browser(env,{folder:folder.root});
  try{
    await setupRepair(b,'a.mp4,b.mp4,one.mp4\na.mp4,b.mp4,two.mp4\na.mp4,b.mp4,error.mp4');await b.$('batch-start').onclick();assert.equal(env.calls,3);
    const before=await b.state();b.close();b=await browser(env,{folder:folder.root});
    const rows=b.$('batch-rows').children;assert.match(rows[0].textContent,/Confidence 75% is below the 85% threshold/);assert.match(rows[1].textContent,/Confidence 80% is below the 85% threshold/);
    assert.match(rows[0].textContent,/earlier 85% policy/);assert.match(rows[1].textContent,/earlier 85% policy/);
    assert.match(rows[2].textContent,/Review error \(not a visual verdict\)/);assert.doesNotMatch(rows[2].textContent,/Confidence 0%/);
    assert.match(b.$('batch-metrics').textContent,/2 need human review \| 1 review\/redo errors/);assert.deepEqual(await b.state(),before);assert.equal(env.calls,3);
    assert.equal(await folder.text('one.mp4'),'one');assert.equal(await folder.text('two.mp4'),'two');assert.equal(await folder.text('error.mp4'),'error');
  }finally{b.close();}
});

test('prototype review results survive refresh without applying the old approval gate or rewriting originals',async()=>{
  const folder=memoryFolder({'clean.mp4':'clean-original','uncertain.mp4':'uncertain-original'}),env=environment();
  env.review=n=>({decisionPolicy:DECISION_POLICY,verdict:n===1?'pass':'needs_review',summary:n===1?'No distracting defect.':'Card occlusion is unresolved.',selectedAttempt:0,redoCount:0,pauseBatch:false,attempts:[{attempt:0,source:'existing',assessment:{verdict:n===1?'pass':'uncertain',modelVerdict:n===1?'pass':'uncertain',confidence:.8,issues:[]}}]});
  let b=await browser(env,{folder:folder.root});
  try{
    await setupRepair(b,'a.mp4,b.mp4,clean.mp4\na.mp4,b.mp4,uncertain.mp4');await b.$('batch-start').onclick();
    const before=await b.state();b.close();b=await browser(env,{folder:folder.root});
    const rows=b.$('batch-rows').children;assert.match(rows[0].textContent,/Approved: No distracting defect/);assert.match(rows[1].textContent,/Needs review: Card occlusion is unresolved/);
    assert.doesNotMatch(b.$('batch-rows').textContent,/85%|below.*threshold/);
    assert.match(b.$('batch-metrics').textContent,/1 approved \| 1 need human review/);assert.deepEqual(await b.state(),before);assert.equal(env.calls,2);
    assert.equal(await folder.text('clean.mp4'),'clean-original');assert.equal(await folder.text('uncertain.mp4'),'uncertain-original');
  }finally{b.close();}
});

test('failed initial reviews recover after refresh without clearing the CSV or repeating completed reviews',async()=>{
  const folder=memoryFolder({'clean.mp4':'clean-original','retry.mp4':'retry-original','pending.mp4':'pending-original'}),env=environment();
  env.review=n=>n===2?failedInitialReview():{verdict:'pass',summary:'Passed',selectedAttempt:0,redoCount:0,attempts:[]};
  let b=await browser(env,{folder:folder.root});
  try{
    await setupRepair(b,'first_half,second_half,output,method,duration\na.mp4,b.mp4,clean.mp4,film,0.33\na.mp4,b.mp4,retry.mp4,film,0.33\na.mp4,b.mp4,pending.mp4,film,0.33');
    assert.equal(b.$('batch-review-recovery').hidden,true);
    await b.$('batch-start').onclick();const before=await b.state(),writes=folder.writes.length;
    assert.equal(env.calls,2);assert.deepEqual(before.rows.map(r=>r.state),['saved','saved','pending']);
    assert.match(b.$('batch-status').textContent,/HTTP 400.*Reasoning is mandatory/);assert.match(b.$('notifications').textContent,/Retry failed reviews/);
    assert.equal(b.$('batch-review-recovery').hidden,false);assert.match(b.$('batch-review-recovery-help').textContent,/1 original video has not been reviewed/);
    b.close();b=await browser(env,{folder:folder.root});assert.equal(b.$('batch-review-recovery').hidden,false);
    b.w.confirm=()=>false;await b.$('batch-retry-reviews').onclick();assert.deepEqual(await b.state(),before);assert.equal(env.calls,2);
    b.w.confirm=text=>{assert.match(text,/1 failed review/);assert.match(text,/incur a charge/);return true;};
    await b.$('batch-retry-reviews').onclick();let q=await b.state();
    assert.equal(q.id,before.id);assert.equal(q.csvName,before.csvName);assert.deepEqual(q.rows[0],before.rows[0]);assert.deepEqual(q.rows.map(r=>r.state),['saved','pending','pending']);
    assert.equal(q.rows[1].result,undefined);assert.equal(q.rows[1].history[0].review.summary,before.rows[1].result.review.summary);
    assert.deepEqual(q.rows[1].history[0].providerJobs,before.rows[1].providerJobs);assert.equal(q.rows[1].originalDigest,before.rows[1].originalDigest);
    assert.equal(env.calls,2);assert.equal(folder.writes.length,writes);assert.equal(b.$('batch-review-recovery').hidden,true);
    // The reset is persisted even if another refresh happens before resuming.
    b.close();b=await browser(env,{folder:folder.root});b.selectFiles();await b.$('batch-output-folder').onclick();await b.$('batch-start').onclick();q=await b.state();
    assert.equal(env.calls,4);assert.ok(q.rows.every(r=>r.state==='saved'&&r.result.review.verdict==='pass'));assert.equal(q.id,before.id);
    assert.equal(await folder.text('clean.mp4'),'clean-original');assert.equal(await folder.text('retry.mp4'),'retry-original');assert.equal(await folder.text('pending.mp4'),'pending-original');
    b.$('batch-report').onclick();assert.match(await env.downloads.at(-1).text(),/Reasoning is mandatory/);assert.match(await env.downloads.at(-1).text(),/review-request/);
  }finally{b.close();}
});

test('review recovery excludes visual verdicts and attempted redos, and rolls back failed checkpoints',async()=>{
  const folder=memoryFolder({'one.mp4':'original'}),env=environment(),b=await browser(env,{folder:folder.root}),put=IDBObjectStore.prototype.put;
  try{
    for(const review of [
      {...failedInitialReview(),pauseBatch:false,attempts:[{attempt:0,source:'existing',assessment:{verdict:'uncertain',error:false}}]},
      {...failedInitialReview(),redoCount:1,attempts:[...failedInitialReview().attempts,{attempt:1,generationError:'Redo failed'}]}
    ]){
      env.review=review;await setupRepair(b,'a.mp4,b.mp4,one.mp4');await b.$('batch-start').onclick();
      assert.equal(b.$('batch-review-recovery').hidden,true);assert.equal(b.$('batch-retry-reviews').disabled,true);
      const before=await b.state(),calls=env.calls;await b.$('batch-retry-reviews').onclick();assert.deepEqual(await b.state(),before);assert.equal(env.calls,calls);
      await b.$('batch-reset').onclick();
    }
    env.review=failedInitialReview();await setupRepair(b,'a.mp4,b.mp4,one.mp4');await b.$('batch-start').onclick();const before=await b.state(),calls=env.calls;
    env.locked=true;await b.$('batch-retry-reviews').onclick();assert.match(b.$('batch-status').textContent,/another tab/);assert.deepEqual(await b.state(),before);env.locked=false;
    IDBObjectStore.prototype.put=function(value,...args){if(this.name==='rows'&&value.state==='pending')throw new Error('Storage unavailable');return put.call(this,value,...args);};
    await b.$('batch-retry-reviews').onclick();assert.deepEqual(await b.state(),before);assert.equal(b.$('batch-review-recovery').hidden,false);assert.equal(b.$('batch-retry-reviews').disabled,false);assert.match(b.$('batch-status').textContent,/Storage unavailable/);assert.equal(env.calls,calls);
    IDBObjectStore.prototype.put=put;await b.$('batch-retry-reviews').onclick();assert.equal((await b.state()).rows[0].state,'pending');assert.equal(env.calls,calls);assert.equal(await folder.text('one.mp4'),'original');
  }finally{IDBObjectStore.prototype.put=put;b.close();}
});

test('in-place batch reviews every row and replaces only passed redos, preserving names, originals and reports',async()=>{
  const folder=memoryFolder({'clean.mp4':'clean-original','sub/repair.mp4':'flawed-original','uncertain.mp4':'uncertain-original'}),env=environment(),b=await browser(env,{folder:folder.root});
  env.review=n=>({verdict:n===3?'needs_review':'pass',selectedAttempt:n===2?1:0,summary:'Assessment',redoCount:n===2?1:0,attempts:[]});
  try{
    await setupRepair(b,'first_half,second_half,output,method,duration\na.mp4,b.mp4,clean.mp4,kling-fal,3\na.mp4,b.mp4,sub/repair.mp4,kling-fal,3\na.mp4,b.mp4,uncertain.mp4,kling-fal,3');
    let confirmations=0;b.w.confirm=message=>{assert.match(message,/Only approved repairs/);confirmations++;return true;};
    await b.$('batch-start').onclick();const q=await b.state();
    assert.equal(env.calls,3);assert.equal(env.uploads,9);assert.equal(confirmations,1);assert.ok(q.rows.every(r=>r.state==='saved'));
    assert.equal(await folder.text('clean.mp4'),'clean-original');assert.equal(await folder.text('uncertain.mp4'),'uncertain-original');assert.equal(await folder.text('sub/repair.mp4'),'test-video');
    assert.equal(await folder.text(q.rows[1].backupPath),'flawed-original');assert.equal(q.rows[1].savedName,'sub/repair.mp4');
    assert.match(q.rows[0].fileAction,/unchanged/);assert.match(q.rows[2].fileAction,/original kept/);
    assert.equal(b.$('batch-existing-picker').hidden,true);assert.equal(b.$('batch-destination').disabled,true);assert.match(b.$('batch-metrics').textContent,/1 replaced/);
    b.$('batch-report').onclick();assert.match(await env.downloads.at(-1).text(),/file_action/);assert.match(await env.downloads.at(-1).text(),/_bridge-backups/);
    await b.$('batch-start').onclick();assert.equal(env.calls,3);assert.equal(confirmations,1);
  }finally{b.close();}
});

test('repair batch declined confirmation and missing outputs submit no paid work',async()=>{
  const folder=memoryFolder({'one.mp4':'original'}),env=environment(),b=await browser(env,{folder:folder.root});
  try{
    await setupRepair(b,'first_half,second_half,output,method,duration\na.mp4,b.mp4,one.mp4,kling-fal,3');
    b.w.confirm=()=>false;await b.$('batch-start').onclick();assert.equal(env.calls,0);assert.equal(env.uploads,0);assert.equal((await b.state()).settings,undefined);assert.equal(folder.writes.length,0);
    b.w.confirm=()=>true;await b.$('batch-reset').onclick();await b.load('first_half,second_half,output,method,duration\na.mp4,b.mp4,missing.mp4,kling-fal,3');
    await b.$('batch-start').onclick();assert.equal(env.calls,0);assert.equal((await b.state()).rows[0].state,'invalid');assert.match((await b.state()).rows[0].error,/Missing existing output/);
  }finally{b.close();}
});

test('in-place saving survives reload and lost server without another generation, and rejects a different folder',async()=>{
  const folder=memoryFolder({'one.mp4':'original'}),env=environment();env.review={verdict:'pass',selectedAttempt:1,summary:'Repaired',redoCount:1,attempts:[]};
  let b=await browser(env,{folder:folder.root});
  try{
    await setupRepair(b,'first_half,second_half,output,method,duration\na.mp4,b.mp4,one.mp4,kling-fal,3');
    folder.options.failWrite=path=>path==='one.mp4';await b.$('batch-start').onclick();
    let q=await b.state();assert.equal(q.rows[0].state,'saving');assert.equal(env.calls,1);assert.equal(await folder.text('one.mp4'),'original');assert.ok(q.rows[0].replacement.digest);
    b.close();env.workspace=null;env.jobs.clear();folder.options.failWrite=null;
    b=await browser(env,{folder:memoryFolder({'one.mp4':'original'}).root});await b.$('batch-output-folder').onclick();await b.$('batch-start').onclick();
    assert.match(b.$('batch-status').textContent,/Wrong folder/);assert.equal(env.calls,1);
    b.w.showDirectoryPicker=async()=>folder.root;await b.$('batch-output-folder').onclick();await b.$('batch-start').onclick();
    q=await b.state();assert.equal(q.rows[0].state,'saved');assert.equal(await folder.text('one.mp4'),'test-video');assert.equal(env.calls,1);assert.equal(await folder.text(q.rows[0].backupPath),'original');
  }finally{b.close();}
});

test('cancelling while staging a repair pauses saving and resume reuses the reviewed result',async()=>{
  const folder=memoryFolder({'one.mp4':'original'}),env=environment();env.review={verdict:'pass',selectedAttempt:1,summary:'Repaired',redoCount:1,attempts:[]};
  const b=await browser(env,{folder:folder.root});
  try{
    await setupRepair(b,'first_half,second_half,output,method,duration\na.mp4,b.mp4,one.mp4,kling-fal,3');
    let cancelOnce=true;folder.options.beforeClose=async path=>{if(path.includes('/repairs/')&&cancelOnce){cancelOnce=false;b.$('batch-cancel').onclick();}};
    await b.$('batch-start').onclick();assert.equal((await b.state()).rows[0].state,'saving');assert.equal(await folder.text('one.mp4'),'original');
    await b.$('batch-start').onclick();assert.equal((await b.state()).rows[0].state,'saved');assert.equal(env.calls,1);assert.equal(await folder.text('one.mp4'),'test-video');
  }finally{b.close();}
});

test('batch failures are visible as dismissible notifications and link back to their context without changing the queue',async()=>{
  const env=environment(),b=await browser(env);env.keys={fal:false,kie:false};
  try{
    await b.load('a.mp4,b.mp4,out.mp4');await b.$('batch-start').onclick();
    let toast=b.$('notifications').querySelector('[data-notice="batch"]');assert.match(toast.textContent,/Quality review needs your fal key/);
    assert.equal(env.uploads,0);const id=(await b.state()).id;
    await b.$('batch-start').onclick();assert.equal(b.$('notifications').children.length,1);
    toast=b.$('notifications').firstElementChild;toast.querySelector('button').click();
    assert.equal(b.$('batch-panel').hidden,false);assert.equal(b.w.document.activeElement.id,'batch-status');assert.equal(b.$('notifications').children.length,0);assert.equal((await b.state()).id,id);
    env.clearError='Cannot clear <script>bad()</script>';await b.$('clear-results').onclick();
    assert.match(b.$('notifications').textContent,/<script>bad/);assert.equal(b.$('notifications').querySelector('script'),null);
    b.$('notifications').querySelector('[aria-label="Dismiss notification"]').click();assert.equal(b.$('notifications').children.length,0);assert.match(b.$('status').textContent,/Cannot clear/);
    env.keys={fal:true,kie:true};await b.$('batch-start').onclick();assert.match(b.$('notifications').textContent,/remaining ZIP part/);
  }finally{b.close();}
});

test('changing a frozen task pauses first and discards the checkpoint only after confirmation',async()=>{
  const env=environment(),b=await browser(env);env.pending=true;
  try{
    await b.load('a.mp4,b.mp4,one.mp4\na.mp4,b.mp4,two.mp4');assert.equal(b.$('batch-task-lock').hidden,true);
    const running=b.$('batch-start').onclick();await until(()=>env.calls===1);
    assert.equal(b.$('batch-task-lock').hidden,false);assert.equal(b.$('batch-workflow').disabled,true);assert.equal(b.$('batch-change-task').disabled,false);
    assert.match(b.$('batch-change-task').textContent,/Pause to change/);b.$('batch-change-task').onclick();env.jobs.get('job-1').state='complete';await running;
    assert.equal(env.calls,1);assert.match(b.$('batch-task-lock-copy').textContent,/2 CSV rows \(1 unfinished\) and 1 buffered video\./);
    b.w.confirm=()=>false;await b.$('batch-change-task').onclick();assert.ok(await b.state());assert.equal(b.$('batch-workflow').disabled,true);
    b.w.confirm=text=>{assert.match(text,/Discard this batch/);assert.match(text,/files already saved to your computer are kept/);return true;};
    await b.$('batch-change-task').onclick();assert.equal(await b.state(),null);assert.equal(b.$('batch-workflow').disabled,false);assert.equal(b.$('batch-task-lock').hidden,true);assert.equal(b.$('batch-csv').hidden,false);
    b.$('batch-workflow').value='existing';b.$('batch-workflow').onchange();assert.equal(b.$('batch-existing-wrap').hidden,false);assert.equal(env.calls,1);assert.equal(env.downloads.length,0);
  }finally{b.close();}
});

test('existing-folder review matches the CSV, uploads three files, uses only fal for review and checkpoints classified results',async()=>{
  const env=environment();env.keys={fal:true,kie:false};env.review={verdict:'pass',summary:'No major issues',redoCount:0,attempts:[]};let b=await browser(env);
  try{
    b.$('batch-workflow').value='existing';b.$('batch-workflow').onchange();b.$('quality-mode').value='review';assert.equal(b.$('batch-existing-wrap').hidden,false);
    await b.load('first_half,second_half,output,method,duration\na.mp4,b.mp4,sub/one.mp4,kling-kie,3');
    await b.$('batch-start').onclick();assert.match(b.$('batch-status').textContent,/existing output folder/);assert.equal(env.uploads,0);
    Object.defineProperty(b.$('batch-existing-folder'),'files',{configurable:true,value:[{name:'one.mp4',size:10,lastModified:1,webkitRelativePath:'old/sub/one.mp4'}]});b.$('batch-existing-folder').onchange();
    await b.$('batch-validate').onclick();await b.$('batch-start').onclick();
    const q=await b.state();assert.equal(env.uploads,3);assert.equal(q.workflow,'existing');assert.equal(q.rows[0].state,'buffered');assert.equal(q.rows[0].savedName,'approved/sub/one.mp4');assert.equal(env.submissions[0].review.mode,'review');assert.equal(env.submissions[0].workflow,'existing');
    b.$('batch-report').onclick();const report=await env.downloads.at(-1).text();assert.match(report,/quality_verdict/);assert.match(report,/approved\/sub\/one.mp4/);assert.match(report,/review-request/);
    b.close();b=await browser(env);assert.equal(b.$('batch-workflow').value,'existing');assert.equal(b.$('batch-workflow').disabled,true);await b.$('batch-start').onclick();assert.equal(env.calls,1);
  }finally{b.close();}
});

test('review errors preserve the completed video in needs-review and pause before the next row',async()=>{
  const env=environment(),b=await browser(env);env.review={verdict:'needs_review',summary:'Reviewer service unavailable',redoCount:0,attempts:[],pauseBatch:true};
  try{
    b.$('quality-mode').value='redo';b.$('quality-retries').value='2';
    await b.load('a.mp4,b.mp4,one.mp4\na.mp4,b.mp4,two.mp4');await b.$('batch-start').onclick();
    let q=await b.state();assert.equal(q.rows[0].state,'buffered');assert.equal(q.rows[0].savedName,'needs-review/one.mp4');assert.equal(q.rows[1].state,'pending');assert.equal(env.calls,1);assert.equal(env.workspace,null);assert.match(b.$('batch-status').textContent,/Result saved under needs-review/);
    env.review={verdict:'pass',summary:'Fine',redoCount:0,attempts:[]};b.$('quality-mode').value='off';b.$('quality-retries').value='0';await b.$('batch-start').onclick();
    assert.equal(env.calls,2);assert.equal(env.submissions[1].review.mode,'redo');assert.equal(env.submissions[1].review.maxRetries,2);q=await b.state();assert.ok(q.rows.every(r=>r.state==='buffered'));assert.match(b.$('batch-metrics').textContent,/1 approved \| 1 need human review/);
  }finally{b.close();}
});

test('review requires a fal key even for local generation and existing candidate changes are rejected before submission',async()=>{
  const env=environment(),b=await browser(env);env.keys={fal:false,kie:true};
  try{
    b.$('method').value='blend';b.$('method').dispatchEvent(new b.w.Event('change'));b.$('quality-mode').value='review';await b.load('a.mp4,b.mp4,one.mp4');await b.$('batch-start').onclick();assert.equal(env.uploads,0);assert.match(b.$('batch-status').textContent,/fal key/);
    env.keys.fal=true;b.$('batch-workflow').value='existing';b.$('batch-workflow').onchange();
    const file={name:'one.mp4',size:10,lastModified:1,webkitRelativePath:'old/one.mp4'};Object.defineProperty(b.$('batch-existing-folder'),'files',{value:[file]});b.$('batch-existing-folder').onchange();await b.$('batch-validate').onclick();file.lastModified=2;await b.$('batch-start').onclick();
    assert.equal(env.calls,0);assert.equal((await b.state()).rows[0].state,'invalid');assert.match((await b.state()).rows[0].error,/changed/);
  }finally{b.close();}
});

test('batch estimates show before starting and respond to settings; single-result clearing and prompt restore work',async()=>{
  const env=environment(),b=await browser(env);
  try{
    await b.load('a.mp4,b.mp4,out.mp4');
    assert.match(b.$('batch-estimate').textContent,/provider cost \$/);assert.match(b.$('batch-estimate').textContent,/before starting/);assert.equal(env.calls,0);
    b.$('method').value='seedance';b.$('method').dispatchEvent(new b.w.Event('change'));
    assert.match(b.$('batch-estimate').textContent,/seedance, 4s/);
    b.$('duration').value=8;b.$('duration').dispatchEvent(new b.w.Event('input'));
    assert.match(b.$('batch-estimate').textContent,/seedance, 8s/);
    b.$('prompt').value='custom';b.$('method').value='kling-fal';b.$('method').dispatchEvent(new b.w.Event('change'));assert.equal(b.$('prompt').value,'custom');
    b.$('restore-prompt').onclick();assert.equal(b.$('prompt').value,DEFAULT_PROMPT);
    assert.match(DEFAULT_PROMPT,/occlusion/);assert.ok(DEFAULT_PROMPT.length<2000);
    b.w.studio.latestResult=async()=>({id:'prior',frames:['/media/start','/media/end'],url:'/media/full',preview:'/media/preview',noBridgeUrl:'/media/cut',noBridgePreview:'/media/cut-preview',duration:4,noBridgeDuration:1,width:1280,height:720});
    await b.$('latest-result').onclick();assert.equal(b.$('result').hidden,false);assert.equal(b.$('export').disabled,false);
    env.clearError='Wait for the current render to finish';await b.$('clear-results').onclick();assert.match(b.$('status').textContent,/Wait for the current render/);assert.equal(b.$('result').hidden,false);assert.equal(b.$('export').disabled,false);
    delete env.clearError;
    b.w.confirm=()=>false;await b.$('clear-results').onclick();assert.equal(env.cleared,undefined);
    b.w.confirm=()=>true;await b.$('clear-results').onclick();assert.equal(env.cleared,1);
    assert.equal(b.$('result-status').textContent,'RESULTS CLEARED');assert.ok(await b.state());
    assert.equal(b.$('result').hasAttribute('src'),false);assert.equal(b.$('export').disabled,true);assert.equal(b.$('anchors').hidden,true);
  }finally{b.close();}
});

test('unstarted checkpoint gets upfront estimates when server init arrives after browser storage',async()=>{
  const env=environment();let b=await browser(env);
  try{
    await b.load('a.mp4,b.mp4,out.mp4');b.close();env.initDelay=150;b=await browser(env);
    assert.match(b.$('batch-estimate').textContent,/Selected: film, 0.4s/);assert.match(b.$('batch-estimate').textContent,/provider cost \$/);assert.equal(env.calls,0);
  }finally{b.close();}
});

test('discarding a ZIP part needs confirmation, survives reload and never reruns discarded rows',async()=>{
  const env=environment();let b=await browser(env);
  try{
    await b.load(Array.from({length:21},(_,i)=>`a.mp4,b.mp4,${i}.mp4`).join('\n'));
    await b.$('batch-start').onclick();assert.equal(env.calls,20);
    assert.equal(b.$('batch-zip-actions').hidden,false);assert.equal(b.$('batch-more').open,false);
    b.w.confirm=()=>false;await b.$('batch-discard').onclick();assert.equal((await b.state()).rows[0].state,'buffered');
    b.w.confirm=()=>true;await b.$('batch-discard').onclick();
    assert.equal(env.downloads.length,0);assert.equal(b.$('batch-zip-actions').hidden,true);
    assert.equal((await b.state()).rows.filter(r=>r.state==='discarded').length,20);
    b.close();b=await browser(env);b.selectFiles();await b.$('batch-start').onclick();
    assert.equal(env.calls,21);assert.equal((await b.state()).rows.filter(r=>r.state==='discarded').length,20);
    assert.equal((await b.state()).rows.at(-1).state,'buffered');
  }finally{b.close();}
});

test('failed ZIP clear checkpoints keep buffered files and row states',async()=>{
  const env=environment(),b=await browser(env),original=IDBObjectStore.prototype.delete,originalClear=IDBObjectStore.prototype.clear;
  try{
    await b.load('a.mp4,b.mp4,out.mp4');await b.$('batch-start').onclick();
    IDBObjectStore.prototype.delete=function(...args){if(this.name==='outputs')throw new Error('Storage unavailable');return original.apply(this,args);};
    await b.$('batch-discard').onclick();
    assert.equal((await b.state()).rows[0].state,'buffered');assert.equal(b.$('batch-download').disabled,false);assert.match(b.$('batch-status').textContent,/Storage unavailable/);
    await b.$('batch-download').onclick();await b.$('batch-ack').onclick();
    assert.equal((await b.state()).rows[0].state,'buffered');assert.equal((await b.state()).part,1);assert.match(b.$('batch-metrics').textContent,/1 \/ 1 outputs saved or buffered/);
    IDBObjectStore.prototype.clear=function(...args){if(this.name==='outputs')throw new Error('Storage unavailable');return originalClear.apply(this,args);};
    await b.$('batch-reset').onclick();assert.ok(await b.state());assert.equal(b.$('batch-download').disabled,false);
  }finally{IDBObjectStore.prototype.delete=original;IDBObjectStore.prototype.clear=originalClear;b.close();}
});

test('CSV filename and row count survive reload; clearing and invalid imports show the picker again',async()=>{
  const env=environment();let b=await browser(env);
  try{
    assert.equal(b.$('batch-reset').hidden,true);
    await b.load('a.mp4,b.mp4,out.mp4','dealer-pairs.csv');
    assert.equal(b.$('batch-csv').hidden,true);
    assert.equal(b.$('batch-reset').hidden,false);assert.equal(b.$('batch-reset').textContent,'Clear CSV');assert.equal(b.$('batch-reset').closest('#batch-more'),null);
    assert.match(b.$('batch-csv-info').textContent,/Loaded: dealer-pairs\.csv \(1 row\)/);
    assert.equal((await b.state()).csvName,'dealer-pairs.csv');
    b.close();b=await browser(env);
    assert.equal(b.$('batch-csv').hidden,true);
    assert.match(b.$('batch-csv-info').textContent,/dealer-pairs\.csv \(1 row\)/);
    b.w.confirm=()=>false;await b.$('batch-reset').onclick();assert.equal((await b.state()).csvName,'dealer-pairs.csv');
    b.w.confirm=()=>true;
    await b.$('batch-reset').onclick();
    assert.equal(b.$('batch-csv').hidden,false);assert.equal(b.$('batch-csv-info').textContent,'');
    assert.equal(b.$('batch-reset').hidden,true);assert.equal(await b.state(),null);
    b.close();b=await browser(env);assert.equal(b.$('batch-csv').hidden,false);assert.equal(b.$('batch-reset').hidden,true);
    await b.load('"unterminated','bad.csv');
    assert.equal(b.$('batch-csv').hidden,false);assert.equal(b.$('batch-csv-info').textContent,'');
    assert.match(b.$('batch-status').textContent,/Unclosed quoted field/);assert.equal(await b.state(),null);
    await b.load('a.mp4,b.mp4,first.mp4\na.mp4,b.mp4,second.mp4','replacement.csv');
    assert.match(b.$('batch-csv-info').textContent,/replacement\.csv \(2 rows\)/);
    assert.equal(env.calls,0);
  }finally{b.close();}
});

test('browser batch pauses at 20 ZIP files, restores across reload, acknowledges parts and never repeats saved rows',async()=>{
  const env=environment();let b=await browser(env);
  try{
    await b.load('first_half,second_half,output\n'+Array.from({length:22},(_,i)=>`a.mp4,b.mp4,outputs/${i}.mp4`).join('\n')+'\nmissing.mp4,b.mp4,missing.mp4');
    await b.$('batch-start').onclick();let q=await b.state();assert.equal(env.calls,20);assert.equal(q.rows.filter(r=>r.state==='buffered').length,20);assert.equal(q.rows.at(-1).state,'invalid');
    assert.match(b.$('batch-status').textContent,/ZIP part ready/);assert.ok(!JSON.stringify(q).includes('session-token'));
    b.close();b=await browser(env);assert.equal(b.$('batch-download').disabled,false);b.selectFiles();
    await b.$('batch-download').onclick();assert.ok(env.downloads.at(-1).size>200);await b.$('batch-ack').onclick();
    await b.$('batch-start').onclick();q=await b.state();assert.equal(env.calls,22);assert.equal(q.rows.filter(r=>r.state==='saved').length,20);assert.equal(q.rows.filter(r=>r.state==='buffered').length,2);
    await b.$('batch-start').onclick();assert.equal(env.calls,22);assert.match(b.$('batch-status').textContent,/finished/);
  }finally{b.close();}
});

test('lost submission response reconnects to the same job; lost server workspace requires explicit review',async()=>{
  const env=environment();env.lostResponse=true;let b=await browser(env);
  try{
    await b.load('a.mp4,b.mp4,out.mp4');await b.$('batch-start').onclick();assert.equal(env.calls,1);assert.equal((await b.state()).rows[0].state,'submitting');
    b.close();b=await browser(env);b.selectFiles();await b.$('batch-start').onclick();assert.equal(env.calls,1);assert.equal((await b.state()).rows[0].state,'buffered');
    await b.$('batch-reset').onclick();await b.load('a.mp4,b.mp4,second.mp4');env.lostResponse=true;await b.$('batch-start').onclick();assert.equal(env.calls,2);
    env.workspace=null;env.jobs.clear();await b.$('batch-start').onclick();assert.equal(env.calls,2);assert.equal((await b.state()).rows[0].state,'uncertain');
    await b.$('batch-start').onclick();assert.equal(env.calls,2);assert.match(b.$('batch-status').textContent,/Review interrupted/);
    await b.$('batch-retry').onclick();await b.$('batch-start').onclick();assert.equal(env.calls,3);assert.equal((await b.state()).rows[0].state,'buffered');
  }finally{b.close();}
});

test('folder save refuses existing outputs and resumes saving without another generation',async()=>{
  const env=environment(),outputs=new Map([['out.mp4',Buffer.from('existing')]]);
  const folder={name:'results',getFileHandle:async(name,{create=false}={})=>{
    if(!outputs.has(name)&&!create)throw Object.assign(new Error('Not found'),{name:'NotFoundError'});
    if(create)outputs.set(name,Buffer.alloc(0));
    return {createWritable:async()=>new WritableStream({write:chunk=>outputs.set(name,Buffer.concat([outputs.get(name),Buffer.from(chunk)]))})};
  },removeEntry:async name=>outputs.delete(name)};
  let b=await browser(env,{folder});
  try{
    await b.load('a.mp4,b.mp4,out.mp4');b.$('batch-destination').value='folder';b.$('batch-destination').onchange();await b.$('batch-output-folder').onclick();
    assert.equal(b.$('batch-destination-info').textContent,'results');assert.match(b.$('batch-destination-detail').textContent,/does not share the full path/);
    b.$('batch-path-label').value='C:\\Videos\\results';b.$('batch-path-label').oninput();assert.match(b.$('batch-destination-detail').textContent,/Path label \(provided by you\): C:\\Videos\\results/);
    await b.$('batch-start').onclick();assert.equal(env.calls,1);assert.equal((await b.state()).rows[0].state,'saving');assert.equal(outputs.get('out.mp4').toString(),'existing');
    assert.equal((await b.state()).destinationPathLabel,'C:\\Videos\\results');assert.ok(!JSON.stringify(env.submissions).includes('Videos'));
    b.close();b=await browser(env,{folder});assert.equal(b.$('batch-destination-info').textContent,'results');assert.match(b.$('batch-destination-label').textContent,/Reselect/);assert.equal(b.$('batch-path-label').disabled,true);
    await b.$('batch-start').onclick();assert.match(b.$('batch-status').textContent,/Choose an output folder/);assert.equal(env.calls,1);
    await b.$('batch-output-folder').onclick();assert.equal(b.$('batch-path-label').value,'');
    outputs.delete('out.mp4');await b.$('batch-start').onclick();assert.equal(env.calls,1);assert.equal((await b.state()).rows[0].state,'saved');assert.equal(outputs.get('out.mp4').toString(),'test-video');
    await b.$('batch-change-task').onclick();assert.equal(outputs.get('out.mp4').toString(),'test-video');assert.equal(await b.state(),null);
  }finally{b.close();}
});

test('cancel stops at the current row, and a second tab cannot edit or start a running queue',async()=>{
  const env=environment();env.pending=true;const a=await browser(env);let b;
  try{
    await a.load('a.mp4,b.mp4,one.mp4\na.mp4,b.mp4,two.mp4');b=await browser(env);b.selectFiles();
    const running=a.$('batch-start').onclick();await until(()=>env.calls===1);
    await b.$('batch-start').onclick();assert.match(b.$('batch-status').textContent,/another tab/);assert.equal(env.calls,1);
    await b.$('batch-reset').onclick();assert.equal((await b.state()).rows.length,2);
    await b.$('batch-change-task').onclick();assert.equal((await b.state()).rows.length,2);assert.match(b.$('notifications').textContent,/another tab/);
    a.$('batch-cancel').onclick();await running;assert.equal((await a.state()).rows[0].state,'cancelled');assert.equal((await a.state()).rows[1].state,'pending');assert.equal(env.calls,1);
    env.pending=false;await b.$('batch-start').onclick();assert.equal(env.calls,2);assert.equal((await b.state()).rows[0].state,'cancelled');assert.equal((await b.state()).rows[1].state,'buffered');
  }finally{a.close();b?.close();}
});

test('ordinary generation errors skip rows but provider permission errors pause the batch',async()=>{
  const env=environment();env.failed='Cannot decode this clip';const b=await browser(env);
  try{
    await b.load('a.mp4,b.mp4,one.mp4\na.mp4,b.mp4,two.mp4');await b.$('batch-start').onclick();assert.equal(env.calls,2);assert.ok((await b.state()).rows.every(r=>r.state==='failed'));
    await b.$('batch-reset').onclick();env.failed='fal returned 403 Forbidden';await b.load('a.mp4,b.mp4,three.mp4\na.mp4,b.mp4,four.mp4');await b.$('batch-start').onclick();
    assert.equal(env.calls,3);assert.equal((await b.state()).rows[0].state,'failed');assert.equal((await b.state()).rows[1].state,'pending');assert.match(b.$('batch-status').textContent,/Provider access/);
  }finally{b.close();}
});

test('pause waits for the current output to be saved, then leaves the next row pending',async()=>{
  const env=environment();env.pending=true;const b=await browser(env);
  try{
    await b.load('a.mp4,b.mp4,one.mp4\na.mp4,b.mp4,two.mp4');const running=b.$('batch-start').onclick();await until(()=>env.calls===1);
    b.$('batch-pause').onclick();env.jobs.get('job-1').state='complete';await running;
    assert.equal(env.calls,1);assert.equal((await b.state()).rows[0].state,'buffered');assert.equal((await b.state()).rows[1].state,'pending');assert.equal(env.workspace,null);
  }finally{b.close();}
});

test('browser storage failure retains the completed server result and retries saving without re-generation',async()=>{
  const env=environment(),b=await browser(env),original=IDBObjectStore.prototype.put;let rejectBlob=true;
  try{
    await b.load('a.mp4,b.mp4,out.mp4');
    IDBObjectStore.prototype.put=function(value,...args){if(this.name==='outputs'&&rejectBlob){rejectBlob=false;throw new DOMException('Storage quota exceeded','QuotaExceededError');}return original.call(this,value,...args);};
    await b.$('batch-start').onclick();assert.equal(env.calls,1);assert.equal((await b.state()).rows[0].state,'saving');assert.ok(env.workspace);assert.match(b.$('batch-status').textContent,/checkpoint the output/);
    await b.$('batch-start').onclick();assert.equal(env.calls,1);assert.equal((await b.state()).rows[0].state,'buffered');assert.equal(env.workspace,null);
  }finally{IDBObjectStore.prototype.put=original;b.close();}
});

test('mixed CSV validates bad settings per row, blocks all uploads for missing keys and reports actual durations',async()=>{
  const env=environment(),b=await browser(env);env.keys={fal:false,kie:false};
  try{
    b.$('quality-mode').value='off';
    await b.load('OUTPUT,first_half,second_half,METHOD,DURATION,score\nfilm.mp4,a.mp4,b.mp4,FiLm,.33,10\nkling.mp4,a.mp4,b.mp4,kling-fal,3,20\nkie.mp4,a.mp4,b.mp4,kling-kie,3,30\nlocal.mp4,a.mp4,b.mp4,blend,.3,40\nbad.mp4,a.mp4,b.mp4,nope,.4,50\nlong.mp4,a.mp4,b.mp4,film,5,60\nfraction.mp4,a.mp4,b.mp4,seedance,4.5,70');
    b.$('mode-batch').onclick();await b.$('batch-validate').onclick();
    assert.match(b.$('batch-status').textContent,/4 ready, 3 invalid/);
    assert.match(b.$('batch-csv-warning').textContent,/Ignored CSV columns: score/);
    assert.equal(b.$('prompt-wrap').hidden,false);assert.match(b.$('method-label').textContent,/Default method/);
    assert.equal(b.$('batch-unit-cost').disabled,true);assert.match(b.$('batch-estimate').textContent,/1 × kling-fal, 3s/);
    b.$('prompt').value='Only the right hand moves one card.';
    await b.$('batch-start').onclick();
    assert.match(b.$('batch-status').textContent,/fal: film \(1 row\), kling-fal \(1 row\)/);assert.match(b.$('batch-status').textContent,/kie: kling-kie \(1 row\)/);
    assert.equal(env.uploads,0);assert.equal(env.calls,0);assert.equal((await b.state()).settings,undefined);
    env.keys.fal=true;await b.$('batch-start').onclick();assert.match(b.$('batch-status').textContent,/kie: kling-kie/);assert.equal(env.uploads,0);
    env.keys.kie=true;await b.$('batch-start').onclick();
    assert.deepEqual(env.submissions.map(s=>[s.method,s.duration]),[['film',.33],['kling-fal',3],['kling-kie',3],['blend',.3]]);
    assert.ok(env.submissions.every(s=>s.prompt==='Only the right hand moves one card.'));
    const q=await b.state();assert.equal(q.rows.filter(r=>r.state==='invalid').length,3);assert.equal(q.rows[0].resolvedSettings.duration,.33);
    b.$('batch-report').onclick();const report=await env.downloads.at(-1).text();
    assert.match(report,/"method","duration","setting_source","method_source","duration_source"/);
    const rows=report.split('\r\n').map(s=>s.split(',').map(x=>x.replace(/^"|"$/g,''))),header=rows[0];
    assert.equal(rows[1][header.indexOf('method')],'film');assert.equal(rows[1][header.indexOf('duration')],'0.33');assert.equal(rows[1][header.indexOf('setting_source')],'csv');
    assert.equal(Number(rows[1][header.indexOf('actual_bridge_seconds')]),8/24);assert.equal(rows[1][header.indexOf('bridge_frames')],'8');
    b.$('mode-single').onclick();assert.equal(b.$('prompt-wrap').hidden,true);assert.equal(b.$('method-label').textContent,'Interpolation method');
  }finally{b.close();}
});

test('mixed queue freezes row overrides and shared settings across pause, refresh and changed panel defaults',async()=>{
  const env=environment();env.pending=true;let b=await browser(env);
  try{
    b.$('method').value='blend';b.$('method').dispatchEvent(new b.w.Event('change'));b.$('duration').value='.7';b.$('fps').value='24';b.$('prompt').value='Frozen prompt';b.$('mute').checked=true;
    await b.load('first_half,second_half,output,method,duration\na.mp4,b.mp4,one.mp4,,\na.mp4,b.mp4,two.mp4,film,.33\na.mp4,b.mp4,three.mp4,kling-fal,');
    const running=b.$('batch-start').onclick();await until(()=>env.calls===1);b.$('batch-pause').onclick();env.jobs.get('job-1').state='complete';await running;
    let q=await b.state();assert.deepEqual(q.rows.map(r=>[r.resolvedSettings.method,r.resolvedSettings.duration,r.resolvedSettings.settingSource]),[['blend',.7,'panel'],['film',.33,'csv'],['kling-fal',3,'method default']]);
    b.close();env.pending=false;b=await browser(env);b.selectFiles();
    b.$('method').value='seedance';b.$('method').dispatchEvent(new b.w.Event('change'));b.$('duration').value=8;b.$('fps').value='30';b.$('prompt').value='Changed';b.$('mute').checked=false;
    await b.$('batch-validate').onclick();await b.$('batch-start').onclick();
    assert.deepEqual(env.submissions.map(s=>[s.method,s.duration,s.fps,s.prompt,s.mute]),[['blend',.7,'24','Frozen prompt',true],['film',.33,'24','Frozen prompt',true],['kling-fal',3,'24','Frozen prompt',true]]);
    q=await b.state();assert.ok(q.rows.every(r=>r.state==='buffered'));assert.equal(env.calls,3);
  }finally{b.close();}
});

test('legacy checkpoints without per-row settings resume using their original panel settings',async()=>{
  const env=environment();env.pending=true;let b=await browser(env);
  try{
    b.$('method').value='rife';b.$('method').dispatchEvent(new b.w.Event('change'));b.$('duration').value='.6';
    await b.load('a.mp4,b.mp4,one.mp4\na.mp4,b.mp4,two.mp4');
    const running=b.$('batch-start').onclick();await until(()=>env.calls===1);b.$('batch-pause').onclick();env.jobs.get('job-1').state='complete';await running;b.close();
    await new Promise((resolve,reject)=>{const req=env.indexedDB.open('dealer-transition-batches',1);req.onsuccess=()=>{const db=req.result,tx=db.transaction(['meta','rows'],'readwrite'),rows=tx.objectStore('rows'),read=rows.getAll(),meta=tx.objectStore('meta'),get=meta.get('queue');read.onsuccess=()=>{for(const row of read.result){delete row.resolvedSettings;delete row.csvMethod;delete row.csvDuration;rows.put(row);}};get.onsuccess=()=>{const q=get.result;delete q.columns;delete q.warnings;meta.put(q,'queue');};tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};});
    env.pending=false;b=await browser(env);b.selectFiles();b.$('method').value='seedance';b.$('method').dispatchEvent(new b.w.Event('change'));
    await b.$('batch-start').onclick();
    assert.deepEqual(env.submissions.map(s=>[s.method,s.duration]),[['rife',.6],['rife',.6]]);
    assert.ok((await b.state()).rows.every(r=>r.resolvedSettings.method==='rife'&&r.resolvedSettings.duration===.6));
  }finally{b.close();}
});

test('human review: decide flagged clips in the grid and player, survive reload, then apply moves and redoes with another method',async()=>{
  const env=environment(),folder=memoryFolder();
  const flagged={decisionPolicy:DECISION_POLICY,verdict:'needs_review',summary:'Card edge flickers at the second join.',selectedAttempt:0,redoCount:0,pauseBatch:false,attempts:[{attempt:0,source:'generated',assessment:{verdict:'uncertain',confidence:.6,issues:[{category:'cards_objects',severity:'major',time:.9,evidence:'Card edge flickers.'}]}}]};
  const approved={...flagged,verdict:'pass',summary:'Clean.',attempts:[]};
  env.review=n=>n<=2?flagged:approved;
  let b=await browser(env,{folder:folder.root});
  try{
    b.$('batch-destination').value='folder';b.$('batch-destination').onchange();await b.$('batch-output-folder').onclick();
    await b.load('first_half,second_half,output,method,duration\na.mp4,b.mp4,one.mp4,film,0.33\na.mp4,b.mp4,two.mp4,film,0.67\na.mp4,b.mp4,three.mp4,film,0.33');
    await b.$('batch-start').onclick();
    assert.deepEqual([...folder.data.keys()].sort(),['approved/three.mp4','needs-review/one.mp4','needs-review/two.mp4'],b.$('batch-status').textContent);
    assert.equal(b.$('human-review').hidden,false);assert.match(b.$('hr-count').textContent,/2 clips flagged/);
    const cards=()=>[...b.$('hr-grid').querySelectorAll('.hr-card')];
    assert.deepEqual(cards().map(c=>c.querySelector('code').textContent),['one.mp4','two.mp4']);
    assert.match(cards()[0].querySelector('p').textContent,/Major · cards objects: Card edge flickers/);
    // the grid: Fine on one; the player: Redo on two (keyboard), which empties the to-decide view
    cards()[0].querySelector('[data-v=pass]').onclick();await until(async()=>(await b.state()).rows[0].humanDecision==='pass');
    assert.deepEqual(cards().map(c=>c.querySelector('code').textContent),['two.mp4']);
    cards()[0].querySelector('.hr-thumb').onclick();await until(()=>b.$('hr-name').textContent==='two.mp4');
    assert.match(b.$('hr-issues').textContent,/0.90s Major/);
    b.w.document.dispatchEvent(new b.w.KeyboardEvent('keydown',{key:'r'}));
    await until(async()=>(await b.state()).rows[1].humanDecision==='redo');
    assert.match(b.$('hr-tally').textContent,/0 to decide · 1 fine · 1 redo/);
    assert.equal(b.$('hr-apply').textContent,'Apply 2 decisions & start redos');
    assert.deepEqual([...folder.data.keys()].sort(),['approved/three.mp4','needs-review/one.mp4','needs-review/two.mp4'],'nothing moves before apply');
    // decisions are checkpointed: reload, reselect folders, apply
    b.close();b=await browser(env,{folder:folder.root});
    assert.match(b.$('hr-tally').textContent,/1 fine · 1 redo/);
    b.selectFiles();await b.$('batch-output-folder').onclick();
    await b.$('hr-apply').onclick();
    await until(async()=>(await b.state()).rows[1].state==='saved');
    assert.deepEqual([...folder.data.keys()].sort(),['approved/one.mp4','approved/three.mp4','approved/two.mp4','rejected/two.mp4']);
    assert.equal(env.calls,4);assert.equal(env.submissions.at(-1).method,'rife');assert.equal(env.submissions.at(-1).duration,0.67);
    const q=await b.state();
    assert.equal(q.rows[0].humanReview.verdict,'pass');assert.equal(q.rows[0].savedName,'approved/one.mp4');
    assert.equal(q.rows[1].humanRedos,1);assert.equal(q.rows[1].history.at(-1).human.rejected,'rejected/two.mp4');assert.equal(q.rows[1].resolvedSettings.method,'rife');
    assert.equal(b.$('human-review').hidden,false);assert.match(b.$('hr-tally').textContent,/1 already approved by you/);
    b.$('batch-report').onclick();const report=await env.downloads.at(-1).text();
    assert.match(report,/"human_review","human_redos"/);const lines=report.split('\r\n');assert.match(lines[1],/"approved\/one.mp4","needs_review".*,"pass",""$/);assert.match(lines[2],/"approved\/two.mp4","pass".*,"","1"$/);
  }finally{b.close();}
});
