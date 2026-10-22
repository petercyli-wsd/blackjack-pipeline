const path=require('node:path');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
const {ff,probe,processVideos}=require('../src/media');
(async()=>{
  const root=path.resolve('output',`smoke-${Date.now()}`);await fs.mkdir(root,{recursive:true});
  const a=path.join(root,'a.mp4'),b=path.join(root,'b.mp4');
  await ff(['-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',a]);
  await ff(['-f','lavfi','-i','testsrc2=size=256x192:rate=24:duration=2','-vf','hflip','-c:v','libx264','-pix_fmt','yuv420p',b]);
  for(const method of ['blend','flow','dissolve']) {
    const o={a,b,method,duration:0.4,aEnd:1.6,bStart:0.2,fps:30,prompt:'test',mute:false};
    const r=await processVideos(o,{dir:path.join(root,method),signal:new AbortController().signal,log:console.log});
    const p=await probe(r.output);const expected=method==='dissolve'?3:3.8;
    assert.ok(Math.abs(p.duration-expected)<0.12,`${method}: ${p.duration}, expected ${expected}`);assert.equal(p.width,320);assert.equal(p.height,180);assert.ok(p.audio);assert.equal(p.fps,30);
    const baseline=await probe(r.noBridge),baselinePreview=await probe(r.noBridgePreview);
    assert.ok(Math.abs(baseline.duration-3.4)<1/30,`No-bridge must contain both selected clips without inserted or overlapping time: ${baseline.duration}`);
    assert.equal(baseline.width,320);assert.equal(baseline.height,180);assert.equal(baseline.fps,30);assert.ok(baseline.audio);
    assert.ok(Math.abs(baselinePreview.duration-3)<0.05,'No-bridge preview must surround the cut with 1.5 seconds on each side');
    assert.equal(r.noBridgeDuration,baseline.duration);
    assert.ok(Math.abs((p.duration-baseline.duration)-(method==='dissolve'?-0.4:0.4))<0.08);
    console.log(`PASS ${method}: ${p.duration}s, ${p.width}x${p.height}, ${p.fps}fps, audio`);
  }
  const c=new AbortController();c.abort();await assert.rejects(()=>probe(a,c.signal));
  console.log(`Smoke tests passed. Inspect outputs at ${root}`);
})().catch(e=>{console.error(e);process.exitCode=1;});
