const {test}=require('node:test');
const assert=require('node:assert/strict');
const {getMethod,validateOptions,falInput}=require('../src/models');
const base={method:'film',duration:0.4,aEnd:2,bStart:0,fps:30,prompt:'Smooth transition'};
test('duration and cut point validation rejects invalid and incompatible requests',()=>{
  for(const o of [{duration:NaN},{aEnd:0},{bStart:-1},{fps:29},{method:'missing'},{method:'kling-fal',duration:0.4},{method:'seedance',duration:3},{method:'kling-kie',duration:3.5}]) assert.throws(()=>validateOptions({...base,...o}));
  assert.equal(validateOptions(base).id,'film');
});
test('FILM requests intermediate frames with explicit endpoint inclusion',()=>{
  const input=falInput(getMethod('film'),'a','b',base);
  assert.equal(input.num_frames,10);assert.equal(input.include_start,true);assert.equal(input.include_end,true);assert.equal(input.output_type,'video');
});
test('RIFE accepts subsecond durations and requests a video containing both endpoints',()=>{
  const options={...base,method:'rife'};
  const method=validateOptions(options);
  assert.equal(method.endpoint,'fal-ai/rife');
  assert.deepEqual(falInput(method,'https://example.com/a.png','https://example.com/b.png',options),{
    start_image_url:'https://example.com/a.png',end_image_url:'https://example.com/b.png',
    output_type:'video',num_frames:10,include_start:true,include_end:true,fps:30
  });
  for(const duration of [0,2.1])assert.throws(()=>validateOptions({...options,duration}));
  assert.equal(falInput(method,'a','b',{...options,duration:2,fps:60}).num_frames,118);
});
test('generative adapters send both endpoints and model-specific fields',()=>{
  const kling=falInput(getMethod('kling-fal'),'a','b',{...base,duration:3});
  assert.equal(kling.start_image_url,'a');assert.equal(kling.end_image_url,'b');assert.equal(kling.duration,'3');assert.equal(kling.generate_audio,false);
  const seed=falInput(getMethod('seedance'),'a','b',{...base,duration:4});assert.equal(seed.image_url,'a');assert.equal(seed.end_image_url,'b');assert.equal(seed.aspect_ratio,'auto');
});
