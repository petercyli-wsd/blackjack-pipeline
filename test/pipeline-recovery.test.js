// "Nothing is paid for twice": after a restart, a transition reconnects to its in-flight provider
// request, and a finished render or review is reused. Fake provider clients only; no charges.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {caching}=require('../src/pipeline/transitions');
const {resume}=require('../src/providers');
const {getMethod}=require('../src/models');

function fakeFal({statuses=['IN_PROGRESS','COMPLETED'],missing=false}={}){
  const calls={submit:0,status:0,result:0,upload:0};
  const client={storage:{upload:async()=>{calls.upload++;return 'https://fal.example/frame.png';}},
    queue:{submit:async()=>{calls.submit++;return {request_id:'new-request'};},
      status:async(_,{requestId})=>{calls.status++;if(missing)throw Object.assign(new Error('Not found'),{status:404});return {status:statuses[Math.min(calls.status-1,statuses.length-1)],requestId};},
      result:async(_,{requestId})=>{calls.result++;return {data:{video:{url:`https://fal.example/${requestId}.mp4`}}};},cancel:async()=>{}}};
  return {calls,factory:()=>client};
}
const ctx=(fal,renderVideo,reviewVideo=async()=>({verdict:'pass',confidence:.9,summary:'ok',issues:[]}))=>({hooks:{renderVideo,reviewVideo,falClientFactory:fal.factory}});

test('a restarted transition reconnects to its in-flight fal request instead of paying for a new one',{timeout:30000},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recover-'));
  // What processVideos had recorded before the server stopped: the submitted request, no result yet.
  await fs.writeFile(path.join(dir,'job.json'),JSON.stringify({job:{provider:'fal',endpoint:'fal-ai/film',requestId:'old-request'}}));
  const fal=fakeFal(),recorded=[];
  const render=async(o,c)=>{
    const url=await c.generator(getMethod('film'),['a.png','b.png'],o,'key',new AbortController().signal,()=>{},async j=>recorded.push(j));
    return {output:path.join(dir,'result.mp4'),url};
  };
  await fs.writeFile(path.join(dir,'result.mp4'),'video');
  const out=await caching(ctx(fal,render)).renderVideo({method:'film'},{dir,log:()=>{}});
  assert.equal(out.url,'https://fal.example/old-request.mp4');
  assert.equal(fal.calls.submit,0,'no new submission');assert.equal(fal.calls.upload,0,'no new upload');
  assert.deepEqual(recorded.map(j=>j.requestId),['old-request']);
  // The finished render is now cached: asking again doesn't touch the provider at all.
  const again=await caching(ctx(fal,async()=>{throw new Error('must not render again');})).renderVideo({method:'film'},{dir,log:()=>{}});
  assert.equal(again.url,out.url);assert.equal(fal.calls.status,2);
});

test('a request the provider no longer knows is submitted fresh; other provider errors are not',{timeout:30000},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recover-'));
  await fs.writeFile(path.join(dir,'job.json'),JSON.stringify({job:{provider:'fal',endpoint:'fal-ai/film',requestId:'expired'}}));
  const fal=fakeFal({missing:true}),logs=[];
  // Expired request: the generator falls back to a normal submission (which this fake answers).
  const render=async(o,c)=>({output:'x',url:await c.generator(getMethod('film'),[],o,'key',new AbortController().signal,m=>logs.push(m),async()=>{}).catch(e=>e.message)});
  await caching(ctx(fal,render)).renderVideo({method:'film',duration:.33,fps:24,prompt:''},{dir,log:()=>{}}).catch(()=>{});
  assert.ok(logs.some(m=>/no longer available; submitting a new request/.test(m)),logs.join('\n'));
  // A failed request is a real failure: reconnecting must surface it, not silently pay again.
  await assert.rejects(()=>resume(getMethod('film'),{provider:'fal',requestId:'r'},'key',new AbortController().signal,()=>{},{falClientFactory:()=>({queue:{status:async()=>{throw Object.assign(new Error('Unauthorized'),{status:401});}}})}),/401/);
});

test('a finished AI review is reused after a restart instead of being bought again',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recover-'));let reviews=0;
  const c=caching({hooks:{renderVideo:async()=>{},reviewVideo:async()=>{reviews++;return {verdict:'pass',confidence:.9,summary:'clean',issues:[]};}}});
  const first=await c.reviewVideo({},{},{dir});const second=await c.reviewVideo({},{},{dir});
  assert.equal(reviews,1);assert.deepEqual(second,first);
});
