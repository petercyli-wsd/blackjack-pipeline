const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {createStudio}=require('../server');
const {ff}=require('../src/media');

test('clear results frees the render limit, protects running jobs and preserves keys, inputs, batch and other users',{timeout:60000},async()=>{
  await fs.mkdir('output',{recursive:true});
  const root=await fs.mkdtemp(path.resolve('output/clear-test-')),input=path.join(root,'input.mp4');
  await ff(['-f','lavfi','-i','color=size=96x64:rate=24:duration=0.3','-c:v','libx264',input]);
  let calls=0,finish;
  const app=await createStudio({dataDir:path.join(root,'data'),renderVideo:async(o,{dir})=>{
    calls++;if(calls===6)await new Promise(resolve=>{finish=resolve;});
    await fs.mkdir(dir,{recursive:true});const output=path.join(dir,'result.mp4');await fs.copyFile(input,output);
    if(calls===3)throw new Error('Test failed render');
    return {output,frames:[],duration:.3,width:96,height:64};
  }});
  async function client(){
    const r=await fetch(app.url+'/api/session'),{token}=await r.json(),headers={Cookie:r.headers.get('set-cookie').split(';')[0],'X-Studio-Token':token};
    const request=(route,method='GET',data)=>fetch(app.url+route,{method,headers:{...headers,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    const api=async(...args)=>{const r=await request(...args),d=await r.json();assert.ok(r.ok,JSON.stringify(d));return d;};
    const uploaded=await fetch(app.url+'/api/upload?name=input.mp4',{method:'POST',headers,body:await fs.readFile(input)});assert.equal(uploaded.status,200);const item=await uploaded.json();
    const options={a:item.id,b:item.id,method:'kling-fal',duration:3,aEnd:.25,bStart:0,fps:24,prompt:'test',mute:true};
    await api('/api/keys','POST',{fal:'fake-session-key'});
    const wait=async id=>{for(let i=0;i<500;i++){const j=await api(`/api/jobs/${id}`);if(j.state!=='running')return j;await delay(10);}throw new Error('Timeout');};
    return {request,api,wait,options,item,headers};
  }
  try{
    const a=await client(),b=await client();
    const other=await b.wait((await b.api('/api/process','POST',b.options)).id);
    let first;
    for(let i=0;i<5;i++){
      const j=await a.api('/api/process','POST',{...a.options,requestId:`before-clear-${i}`});
      if(i===4){assert.equal((await a.request('/api/results','DELETE')).status,409);finish();}
      const done=await a.wait(j.id);if(i===0)first=done;
    }
    const limited=await a.request('/api/process','POST',a.options);assert.equal(limited.status,400);assert.match((await limited.json()).error,/Clear results/);
    await a.api('/api/batch/row','POST',{rowId:'preserved-batch'});
    for(const slot of ['a','b']){
      const uploaded=await fetch(app.url+`/api/batch/upload?rowId=preserved-batch&slot=${slot}`,{method:'POST',headers:a.headers,body:await fs.readFile(input)});assert.equal(uploaded.status,200);
    }
    const batchJob=await a.wait((await a.api('/api/batch/process','POST',{...a.options,rowId:'preserved-batch'})).id);
    assert.equal(batchJob.state,'complete',batchJob.error);
    assert.equal((await fetch(app.url+'/api/results',{method:'DELETE'})).status,403);
    await a.api('/api/results','DELETE');
    assert.equal((await a.request(first.result.url)).status,404);
    assert.equal((await a.request('/api/request-jobs/before-clear-0')).status,404);
    assert.equal((await a.request(a.item.url)).status,200);
    assert.equal((await a.api('/api/init')).keys.fal,true);
    assert.equal((await a.api('/api/batch')).rowId,'preserved-batch');
    assert.equal((await a.api(`/api/jobs/${batchJob.id}`)).state,'complete');
    assert.equal((await a.request(batchJob.result.url)).status,200);
    assert.equal((await b.request(other.result.url)).status,200);
    await a.api('/api/batch/release','POST',{rowId:'preserved-batch'});
    const next=await a.wait((await a.api('/api/process','POST',{...a.options,method:'seedance',duration:4})).id);
    assert.equal(next.state,'complete',next.error);
    await a.api('/api/results','DELETE');await a.api('/api/results','DELETE');
  }finally{finish?.();await app.close();}
});
test('web upload, job, comparison, downloads, restore, cancellation and credential isolation',{timeout:120000},async()=>{
  await fs.mkdir('output',{recursive:true});const root=await fs.mkdtemp(path.resolve('output/http-test-'));
  const clip=path.join(root,'input.mp4');
  await ff(['-f','lavfi','-i','testsrc2=size=160x90:rate=25:duration=1','-c:v','libx264','-pix_fmt','yuv420p',clip]);
  const app=await createStudio({dataDir:path.join(root,'data')});
  try{
    const session=await fetch(app.url+'/api/session');const {token}=await session.json();const Cookie=session.headers.get('set-cookie').split(';')[0];
    const headers={Cookie,'X-Studio-Token':token,'Content-Type':'application/json'};
    const api=async(route,method='GET',data)=>{const r=await fetch(app.url+route,{method,headers,body:data?JSON.stringify(data):undefined});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;};
    assert.equal((await fetch(app.url+'/api/init')).status,403);
    assert.equal((await fetch(app.url+'/api/init',{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
    const methods=(await api('/api/init')).methods;assert.equal(methods.length,8);assert.ok(methods.some(m=>m.id==='rife'&&m.provider==='fal'));
    const configured=await api('/api/keys','POST',{fal:'fake-key-do-not-save'});assert.equal(configured.fal,true);assert.ok(!JSON.stringify(configured).includes('fake-key'));
    await api('/api/keys','DELETE');assert.equal((await api('/api/init')).keys.fal,false);
    const upload=await fetch(app.url+'/api/upload?name=sample.mp4',{method:'POST',headers:{Cookie,'X-Studio-Token':token},body:await fs.readFile(clip)});assert.equal(upload.status,200);const item=await upload.json();
    const options={a:item.id,b:item.id,method:'blend',duration:0.2,aEnd:0.8,bStart:0.2,fps:30,prompt:'test',mute:false,requestId:'first-render-request'};
    async function wait(id){for(let i=0;i<300;i++){const job=await api(`/api/jobs/${id}`);if(job.state!=='running')return job;await delay(100);}throw new Error('Job timeout');}
    const submitted=await api('/api/process','POST',options);const job=await wait(submitted.id);assert.equal(job.state,'complete',job.error);
    assert.equal((await api('/api/request-jobs/first-render-request')).id,submitted.id);
    assert.equal((await fetch(app.url+'/api/request-jobs/first-render-request')).status,403);
    assert.ok(Math.abs(job.result.duration-1.8)<0.08);assert.ok(Math.abs(job.result.noBridgeDuration-1.6)<0.08);
    const partial=await fetch(app.url+job.result.url,{headers:{Cookie,Range:'bytes=0-31'}});assert.equal(partial.status,206);assert.equal((await partial.arrayBuffer()).byteLength,32);
    const download=await fetch(app.url+job.result.noBridgeUrl+'?download=1',{headers:{Cookie}});assert.match(download.headers.get('content-disposition'),/attachment/);await download.arrayBuffer();
    const invalid=await fetch(app.url+job.result.url,{headers:{Cookie,Range:'bytes=999999999-'}});assert.equal(invalid.status,416);
    const restored=await wait((await api('/api/latest','POST',{})).id);assert.equal(restored.state,'complete',restored.error);
    assert.equal(restored.result.noBridgeDuration,job.result.noBridgeDuration);
    const cancelled=await api('/api/process','POST',options);await api('/api/cancel','POST',{});assert.equal((await wait(cancelled.id)).state,'failed');
    assert.equal((await fs.readdir(path.join(root,'data'))).includes('credentials.enc'),false);
  }finally{await app.close();}
});
