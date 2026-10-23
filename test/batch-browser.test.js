// DOM + IndexedDB integration tests. No real browser, keys, or provider charges.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const {IDBFactory,IDBObjectStore}=require('fake-indexeddb');
const {METHODS,DEFAULT_PROMPT}=require('../src/models');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const publicDir=path.join(__dirname,'../public');
async function until(check){for(let i=0;i<300;i++){if(await check())return;await delay(10);}throw new Error('Condition timed out');}
function environment(){
  const env={indexedDB:new IDBFactory(),workspace:null,jobs:new Map(),calls:0,lostResponse:false,pending:false,downloads:[],locked:false};
  env.fetch=async(url,options={})=>{
    const route=new URL(url,'http://studio.test'),method=options.method||'GET',value=typeof options.body==='string'?JSON.parse(options.body):{};
    const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
    if(route.pathname==='/api/session')return json({token:'session-token'});
    if(route.pathname==='/api/init')return json({methods:METHODS,prompt:DEFAULT_PROMPT,keys:{fal:true,kie:true},maxUploadBytes:512*1048576,hosted:true});
    if(route.pathname==='/api/keys')return json({fal:true,kie:true});
    if(route.pathname==='/api/batch')return json(env.workspace||{});
    if(route.pathname==='/api/batch/row'){env.workspace={rowId:value.rowId,uploads:{},jobId:null};return json({rowId:value.rowId});}
    if(route.pathname==='/api/batch/upload'){env.workspace.uploads[route.searchParams.get('slot')]={duration:1};return json({duration:1});}
    if(route.pathname==='/api/batch/process'){
      if(env.workspace.jobId)return json({id:env.workspace.jobId},202);
      env.calls++;const id=`job-${env.calls}`;env.workspace.jobId=id;
      env.jobs.set(id,{id,state:env.failed?'failed':env.pending?'running':'complete',error:env.failed,messages:['Working'],providerJob:{provider:'fal',requestId:`provider-${env.calls}`},result:{url:'/media/'+id}});
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
  w.navigator.locks={request:async(name,options,fn)=>{if(env.locked)return fn(null);env.locked=true;try{return await fn({name});}finally{env.locked=false;}}};
  w.URL.createObjectURL=blob=>{env.downloads.push(blob);return 'blob:test';};w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=()=>{};
  if(folder)w.showDirectoryPicker=async()=>folder;
  // Avoid 1.5-second polling waits; preserve asynchronous ordering.
  const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timeout(fn,ms===1500||ms===5000?1:ms,...args);
  for(const name of ['browser.js','frame-rate.js','renderer.js','batch-format.js','batch-zip.js','batch.js'])w.eval(fs.readFileSync(path.join(publicDir,name),'utf8'));
  await until(()=>$('method').options.length===METHODS.length&&!$('batch-csv').disabled).catch(e=>{throw new Error(`${e.message}: ${$('batch-status').textContent}; ${$('status').textContent}; methods=${$('method').options.length}`);});
  const selectFiles=()=>{
    Object.defineProperty($('batch-folder'),'files',{configurable:true,value:['a.mp4','b.mp4'].map(name=>({name,size:10,lastModified:1,webkitRelativePath:'videos/'+name}))});$('batch-folder').onchange();
  };
  const load=async csv=>{selectFiles();Object.defineProperty($('batch-csv'),'files',{configurable:true,value:[{size:csv.length,text:async()=>csv}]});await $('batch-csv').onchange();};
  const state=async()=>new Promise((resolve,reject)=>{const request=env.indexedDB.open('dealer-transition-batches',1);request.onsuccess=()=>{const db=request.result,tx=db.transaction(['meta','rows']),r=tx.objectStore('meta').get('queue'),rows=tx.objectStore('rows').getAll();tx.oncomplete=()=>{db.close();resolve(r.result?{...r.result,rows:rows.result.sort((a,b)=>a.number-b.number)}:null);};tx.onerror=()=>reject(tx.error);};});
  return {w,$,load,selectFiles,state,close:()=>w.close()};
}

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
  const b=await browser(env,{folder});
  try{
    await b.load('a.mp4,b.mp4,out.mp4');b.$('batch-destination').value='folder';b.$('batch-destination').onchange();await b.$('batch-output-folder').onclick();
    await b.$('batch-start').onclick();assert.equal(env.calls,1);assert.equal((await b.state()).rows[0].state,'saving');assert.equal(outputs.get('out.mp4').toString(),'existing');
    outputs.delete('out.mp4');await b.$('batch-start').onclick();assert.equal(env.calls,1);assert.equal((await b.state()).rows[0].state,'saved');assert.equal(outputs.get('out.mp4').toString(),'test-video');
  }finally{b.close();}
});

test('cancel stops at the current row, and a second tab cannot edit or start a running queue',async()=>{
  const env=environment();env.pending=true;const a=await browser(env);let b;
  try{
    await a.load('a.mp4,b.mp4,one.mp4\na.mp4,b.mp4,two.mp4');b=await browser(env);b.selectFiles();
    const running=a.$('batch-start').onclick();await until(()=>env.calls===1);
    await b.$('batch-start').onclick();assert.match(b.$('batch-status').textContent,/another tab/);assert.equal(env.calls,1);
    await b.$('batch-reset').onclick();assert.equal((await b.state()).rows.length,2);
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
