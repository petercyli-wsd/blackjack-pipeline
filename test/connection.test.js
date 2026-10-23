const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {JSDOM}=require('jsdom');
const {providerError}=require('../src/providers');
function browser(fetch){
  const dom=new JSDOM(fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),{url:'http://studio.test',runScripts:'outside-only'});
  const w=dom.window;w.fetch=async(url,options)=>url==='/api/session'?Response.json({token:'test-token'}):fetch(url,options);
  const timeout=w.setTimeout.bind(w);w.setTimeout=(fn)=>timeout(fn,0);
  w.eval(fs.readFileSync(path.join(__dirname,'../public/browser.js'),'utf8'));return w;
}

test('RIFE progress recovers from empty and HTML gateway replies without resubmitting generation',async()=>{
  let submissions=0,polls=0;const logs=[];
  const w=browser(async(route,options)=>{
    if(route==='/api/process'){assert.equal(JSON.parse(options.body).method,'rife');submissions++;return Response.json({id:'job-rife'});}
    if(route==='/api/jobs/job-rife'){
      polls++;if(polls===1)return new Response('',{status:502});if(polls===2)return new Response('<html>gateway</html>',{status:503});
      return Response.json({state:'complete',messages:[],result:{id:'result-rife'}});
    }
    throw new Error('Unexpected '+route);
  });
  try{w.studio.onProgress(x=>logs.push(x));assert.equal((await w.studio.process({method:'rife'})).id,'result-rife');assert.equal(submissions,1);assert.equal(polls,3);assert.equal(logs.length,2);}finally{w.close();}
});

test('persistent empty progress gives a reconnectable error and reconnect uses the original job',async()=>{
  let working=false,submissions=0;const w=browser(async route=>{
    if(route==='/api/process'){submissions++;return Response.json({id:'existing-job'});}
    return working?Response.json({state:'complete',messages:[],result:{id:'saved'}}):new Response('',{status:200});
  });
  try{
    let failure;try{await w.studio.process({method:'rife'});}catch(e){failure=e;}
    assert.match(failure.message,/Checking render progress.*empty response.*HTTP 200/);assert.equal(failure.canResume,true);assert.equal(failure.jobId,'existing-job');
    working=true;assert.equal((await w.studio.reconnect(failure.jobId)).id,'saved');assert.equal(submissions,1);
  }finally{w.close();}
});

test('empty submission response is never retried and reconnect looks up its exact client request reference',async()=>{
  let reference,submissions=0;const w=browser(async(route,options)=>{
    if(route==='/api/process'){submissions++;reference=JSON.parse(options.body).requestId;return new Response('',{status:502});}
    if(route==='/api/request-jobs/'+reference)return Response.json({id:'correct-job'});
    if(route==='/api/jobs/correct-job')return Response.json({state:'complete',messages:[],result:{id:'correct-result'}});
    throw new Error('Must not look up an unrelated older result');
  });
  try{
    let failure;try{await w.studio.process({method:'rife'});}catch(e){failure=e;}
    assert.equal(failure.requestId,reference);assert.equal(failure.canResume,true);assert.equal(submissions,1);
    assert.equal((await w.studio.reconnect(undefined,failure.requestId)).id,'correct-result');assert.equal(submissions,1);
  }finally{w.close();}
});

test('real JSON permission failures remain distinct from connection errors and are not retried',async()=>{
  let calls=0;const w=browser(async()=>{calls++;return Response.json({error:'Session expired. Refresh and enter keys again.'},{status:403});});
  try{await assert.rejects(w.studio.batchAPI('/api/init'),e=>e.status===403&&!e.connection&&/Session expired/.test(e.message));assert.equal(calls,1);}finally{w.close();}
});

test('fal malformed response and validation errors identify the provider stage without input secrets',()=>{
  assert.match(providerError('fal result retrieval',new SyntaxError('Unexpected end of JSON input')).message,/fal result retrieval: Provider returned an empty or invalid JSON/);
  const error=providerError('fal model submission',{status:422,body:{detail:[{loc:['body','num_frames'],msg:'Must be positive',input:'do-not-print-this'}]}});
  assert.match(error.message,/HTTP 422.*body.num_frames: Must be positive/);assert.ok(!error.message.includes('do-not-print'));
});

test('a video child killed by the host is a failure, never a successful empty result',async()=>{
  const filename=path.join(__dirname,'../src/media.js'),actualRequire=createRequire(filename),module={exports:{}};
  const spawn=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();queueMicrotask(()=>child.emit('close',null,'SIGKILL'));return child;};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,process:{env:{}},require:name=>name==='node:child_process'?{spawn}:actualRequire(name),Buffer,AbortSignal});
  await assert.rejects(module.exports.ff(['-i','input.mp4','output.mp4']),/terminated by SIGKILL.*memory limit/);
});
