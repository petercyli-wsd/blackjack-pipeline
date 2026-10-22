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
test('generative adapters send both endpoints and model-specific fields',()=>{
  const kling=falInput(getMethod('kling-fal'),'a','b',{...base,duration:3});
  assert.equal(kling.start_image_url,'a');assert.equal(kling.end_image_url,'b');assert.equal(kling.duration,'3');assert.equal(kling.generate_audio,false);
  const seed=falInput(getMethod('seedance'),'a','b',{...base,duration:4});assert.equal(seed.image_url,'a');assert.equal(seed.end_image_url,'b');assert.equal(seed.aspect_ratio,'auto');
});
