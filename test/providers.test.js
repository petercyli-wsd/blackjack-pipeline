const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generate,json,providerError}=require('../src/providers');
const {getMethod}=require('../src/models');
const path=require('node:path');
test('fal errors show the actual rejection reason and stage without exposing credentials',()=>{
  const error=providerError('fal boundary upload',{status:403,message:'Forbidden',body:{detail:'User is locked. Reason: Exhausted balance.'}});
  assert.match(error.message,/fal boundary upload \(HTTP 403\).*Exhausted balance/);
  const redacted=providerError('fal model submission',{body:{detail:'Rejected abcdefgh:secretvalue'}},'abcdefgh:secretvalue');
  assert.ok(!redacted.message.includes('secretvalue'));assert.ok(!redacted.message.includes('abcdefgh'));
});
test('KIE uploads two frames, submits correct endpoints and reads a completed job',async t=>{
  const calls=[];
  t.mock.method(global,'fetch',async(url,options)=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
    if(url.includes('file-base64'))return Response.json({code:200,data:{downloadUrl:`https://example.com/${calls.length}.png`}});
    if(url.endsWith('createTask'))return Response.json({code:200,data:{taskId:'job-123'}});
    return Response.json({code:200,data:{state:'success',resultJson:JSON.stringify({resultUrls:['https://example.com/result.mp4']})}});
  });
  let record;
  const url=await generate(getMethod('kling-kie'),[__filename,__filename],{prompt:'move',duration:3},'test-key',new AbortController().signal,()=>{},async x=>record=x);
  assert.equal(url,'https://example.com/result.mp4');assert.equal(record.requestId,'job-123');
  assert.deepEqual(calls[2].body.input.image_urls,['https://example.com/1.png','https://example.com/2.png']);
  assert.equal(calls[2].body.input.multi_shots,false);assert.equal(calls[2].body.model,'kling-3.0/video');
  assert.ok(!('aspect_ratio' in calls[2].body.input));
});
test('KIE detects API errors inside HTTP 200 responses',async t=>{
  t.mock.method(global,'fetch',async()=>Response.json({code:401,msg:'Invalid key'}));
  await assert.rejects(()=>json('https://example.com','test',null,new AbortController().signal),/401/);
});
test('cancelled generation does not upload or submit',async t=>{
  const mock=t.mock.method(global,'fetch',async()=>{throw new Error('Unexpected network');});
  const c=new AbortController();c.abort();
  await assert.rejects(()=>generate(getMethod('kling-kie'),[],{},'key',c.signal,()=>{},()=>{}));assert.equal(mock.mock.callCount(),0);
});
test('RIFE uploads only boundaries, uses the session key and retrieves the queued video',async()=>{
  const calls=[],records=[];
  const factory=options=>{
    assert.equal(options.credentials,'rife-session-key');
    return {storage:{upload:async blob=>{assert.equal(blob.type,'image/png');const url=`https://example.com/${calls.length}.png`;calls.push(['upload',url]);return url;}},queue:{
      submit:async(endpoint,payload)=>{calls.push(['submit',endpoint,payload]);return {request_id:'rife-job'};},
      status:async(endpoint,options)=>{assert.equal(endpoint,'fal-ai/rife');assert.equal(options.requestId,'rife-job');return {status:'COMPLETED'};},
      result:async()=>({data:{video:{url:'https://example.com/rife.mp4'}}})
    }};
  };
  const url=await generate(getMethod('rife'),[__filename,__filename],{duration:0.4,fps:30},'rife-session-key',new AbortController().signal,()=>{},async r=>records.push(r),{falClientFactory:factory});
  assert.equal(url,'https://example.com/rife.mp4');assert.equal(calls.length,3);
  assert.equal(calls[2][1],'fal-ai/rife');assert.equal(calls[2][2].input.num_frames,10);
  assert.equal(calls[2][2].input.output_type,'video');assert.equal(calls[2][2].input.include_end,true);
  assert.deepEqual(records,[{provider:'fal',endpoint:'fal-ai/rife',requestId:'rife-job'}]);
});
