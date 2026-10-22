const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {ff,extractBoundary}=require('../src/media');
test('short 30fps clip selects the exact final frame despite rounded MP4 duration',async()=>{
  await fs.mkdir(path.resolve('output'),{recursive:true});
  const dir=await fs.mkdtemp(path.resolve('output/boundary-'));
  const clip=path.join(dir,'short.mp4');
  await ff(['-f','lavfi','-i','testsrc2=size=96x64:rate=30','-frames:v','14','-c:v','libx264',clip]);
  const actual=path.join(dir,'last.png'),expected=path.join(dir,'expected.png');
  await extractBoundary(clip,actual,true);
  await ff(['-i',clip,'-vf','select=eq(n\\,13)','-frames:v','1','-fps_mode','passthrough',expected]);
  assert.deepEqual(await fs.readFile(actual),await fs.readFile(expected));
  const first=path.join(dir,'first.png');await extractBoundary(clip,first,false);
  assert.notDeepEqual(await fs.readFile(actual),await fs.readFile(first));
});
