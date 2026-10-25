const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {promisify}=require('node:util');
const execFile=promisify(require('node:child_process').execFile);
const {frameRate,validateOptions,falInput,getMethod}=require('../src/models');
const {ff,probe,processVideos}=require('../src/media');
const base={method:'blend',duration:.3,aEnd:1,bStart:0,prompt:'',mute:true};
test('frame rates preserve exact decimals and fractions, with source matching and bounded validation',()=>{
  assert.equal(frameRate('23.976').rational,'2997/125');
  assert.equal(frameRate('48000/2002').rational,'24000/1001');
  assert.equal(frameRate('29.970001').rational,'29970001/1000000');
  for(const fps of ['source','24000/1001','23.976',29.97,60])validateOptions({...base,fps});
  for(const fps of [null,NaN,0,61,'1/0','23.9760001','24;echo','1e1',''])assert.throws(()=>validateOptions({...base,fps}));
  for(const method of ['film','rife']){
    const payload=falInput(getMethod(method),'a','b',{...base,fps:'24000/1001'});
    assert.equal(payload.fps,24);assert.equal(payload.num_frames,5);
  }
});
async function checkClock(file,rate){
  const {stdout}=await execFile(process.env.FFPROBE_PATH||require('ffprobe-static').path,['-v','error','-select_streams','v:0','-show_entries','stream=avg_frame_rate,time_base,nb_frames:frame=best_effort_timestamp','-of','json',file],{windowsHide:true});
  const d=JSON.parse(stdout),r=frameRate(rate);
  assert.equal(d.streams[0].avg_frame_rate,r.rational,file);
  assert.equal(d.streams[0].time_base,`1/${r.numerator}`);
  for(let i=1;i<d.frames.length;i++)assert.equal(d.frames[i].best_effort_timestamp-d.frames[i-1].best_effort_timestamp,r.denominator,`${file} frame ${i}`);
  return d.frames.length;
}
test('fractional exports preserve constant frame timestamps, source frame counts and integer-FPS provider frames',async t=>{
  await fs.mkdir(path.resolve('output'),{recursive:true});
  const dir=await fs.mkdtemp(path.resolve('output/fps-'));
  const a=path.join(dir,'source.mp4'),raw=path.join(dir,'provider.mp4');
  await ff(['-f','lavfi','-i','testsrc2=size=96x64:rate=24000/1001','-frames:v','24','-c:v','libx264',a]);
  await ff(['-f','lavfi','-i','testsrc2=size=96x64:rate=24','-frames:v','7','-c:v','libx264',raw]);
  const bytes=await fs.readFile(raw);
  t.mock.method(globalThis,'fetch',async()=>new Response(bytes));
  const input=await probe(a);
  for(const [fps,method] of [['source','rife'],['23.976','blend'],['30000/1001','dissolve'],['29.970001','flow']]){
    const target=fps==='source'?'24000/1001':fps,renderDir=path.join(dir,method);
    const result=await processVideos({...base,a,b:a,aEnd:input.duration,fps,method},{dir:renderDir,key:'mock-key',signal:new AbortController().signal,generator:async()=> 'https://test.invalid/bridge.mp4'});
    assert.equal(result.fpsRational,frameRate(target).rational);
    for(const file of [result.output,result.preview,result.noBridge,result.noBridgePreview])await checkClock(file,target);
    if(method==='rife'){
      assert.equal(await checkClock(path.join(renderDir,'a.mp4'),target),24);
      assert.equal(await checkClock(path.join(renderDir,'b.mp4'),target),24);
      assert.equal(await checkClock(path.join(renderDir,'bridge.mp4'),target),7);
      assert.equal(await checkClock(result.output,target),55);
      assert.equal(await checkClock(result.noBridge,target),48);
      const manifest=JSON.parse(await fs.readFile(path.join(renderDir,'job.json'),'utf8'));
      assert.equal(manifest.fpsRational,target);assert.equal(manifest.bridgeFrames,7);
      assert.equal(result.bridgeFrames,7);assert.equal(result.bridgeDuration,7/(24000/1001));
      assert.equal(manifest.duration,.3);assert.equal(manifest.actualBridgeDuration,result.bridgeDuration);
    }
  }
});
