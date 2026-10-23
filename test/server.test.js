const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {setTimeout:delay}=require('node:timers/promises');
const {createStudio}=require('../server');
const {ff}=require('../src/media');
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
