const fs=require('node:fs/promises');
const {randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const {createFalClient}=require('@fal-ai/client');
const {falInput}=require('./models');
function providerError(stage,error,key='') {
  const detail=error.body?.detail;
  const validation=Array.isArray(detail)?detail.map(item=>`${Array.isArray(item.loc)?item.loc.join('.'):'input'}: ${item.msg||'invalid value'}`).join('; '):null;
  const message=typeof detail==='string'?detail:validation|| (typeof error.body?.message==='string'?error.body.message:error instanceof SyntaxError?'Provider returned an empty or invalid JSON response; its service may be temporarily unavailable.':error.message||'Provider request failed');
  let safe=message;
  if(key)for(const part of [key,...key.split(':')].filter(p=>p.length>=6))safe=safe.split(part).join('[redacted]');
  return new Error(`${stage}${error.status?` (HTTP ${error.status})`:''}: ${safe.slice(0,1200)}`);
}
async function falStep(stage,key,operation) {
  try{return await operation();}catch(error){throw providerError(stage,error,key);}
}
async function json(url,key,body,signal) {
  const r=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
  if(!r.ok) throw new Error(`Provider HTTP ${r.status}. Check credentials, credits and service availability.`);
  const data=await r.json();
  if(data.code!==undefined && Number(data.code)!==200) throw new Error(`Provider rejected request (${data.code}): ${data.msg||'Unknown error'}`);
  return data;
}
async function generate(m,frames,o,key,signal,log,record,{falClientFactory=createFalClient}={}) {
  signal.throwIfAborted();
  if(!key) throw new Error(`Enter your ${m.provider==='fal'?'fal':'KIE'} API key first.`);
  if(m.provider==='fal') {
    const fal=falClientFactory({credentials:key});
    log('Uploading boundary frames to fal…');
    const urls=[];
    for(const file of frames) { signal.throwIfAborted(); urls.push(await falStep('fal boundary upload',key,async()=>fal.storage.upload(new Blob([await fs.readFile(file)],{type:'image/png'})))); }
    signal.throwIfAborted();
    log('Submitting interpolation request to fal…');
    const {request_id}=await falStep('fal model submission',key,()=>fal.queue.submit(m.endpoint,{input:falInput(m,...urls,o)}));
    await record({provider:'fal',endpoint:m.endpoint,requestId:request_id});
    log(`Submitted fal job ${request_id}`);
    try {
      const deadline=Date.now()+45*60*1000;
      while(Date.now()<deadline) {
        signal.throwIfAborted();
        const state=await falStep('fal job status',key,()=>fal.queue.status(m.endpoint,{requestId:request_id,logs:false}));
        log(`fal: ${state.status}`);
        if(state.status==='COMPLETED') { const result=await falStep('fal result retrieval',key,()=>fal.queue.result(m.endpoint,{requestId:request_id})); if(!result.data.video?.url) throw new Error('Provider returned no video'); return result.data.video.url; }
        await delay(4000,undefined,{signal});
      }
      throw new Error(`Timed out. Job ${request_id} may still be running; check fal before retrying.`);
    } catch(e) {
      if(signal.aborted) { try { await fal.queue.cancel(m.endpoint,{requestId:request_id}); } catch {} }
      throw e;
    }
  }
  log('Uploading boundary frames to KIE…');
  const urls=[];
  for(const file of frames) {
    const data=await json('https://kieai.redpandaai.co/api/file-base64-upload',key,{base64Data:`data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`,uploadPath:'dealer-transitions',fileName:`${randomUUID()}.png`},signal);
    if(!data.data?.downloadUrl) throw new Error('KIE upload returned no URL');
    urls.push(data.data.downloadUrl);
  }
  const submitted=await json('https://api.kie.ai/api/v1/jobs/createTask',key,{model:'kling-3.0/video',input:{image_urls:urls,prompt:o.prompt,duration:String(o.duration),mode:'pro',sound:false,multi_shots:false}},signal);
  const id=submitted.data?.taskId;
  if(!id) throw new Error('KIE returned no task ID');
  await record({provider:'kie',requestId:id});
  log(`Submitted KIE job ${id}`);
  const deadline=Date.now()+45*60*1000;
  while(Date.now()<deadline) {
    const {data}=await json(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(id)}`,key,null,signal);
    log(`KIE: ${data.state}`);
    if(data.state==='fail') throw new Error(data.failMsg||'KIE generation failed');
    if(data.state==='success') { const result=JSON.parse(data.resultJson); if(!result.resultUrls?.[0]) throw new Error('KIE returned no video'); return result.resultUrls[0]; }
    await delay(5000,undefined,{signal});
  }
  throw new Error(`Timed out. KIE job ${id} may still be running; check your dashboard before retrying.`);
}
module.exports={generate,json,providerError};
