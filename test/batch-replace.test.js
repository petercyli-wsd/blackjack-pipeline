const {test}=require('node:test');
const assert=require('node:assert/strict');
const {memoryFolder}=require('./helpers/memory-folder');
const repair=require('../public/batch-replace');
const setup=async()=>{
  const folder=memoryFolder({'sub/one.mp4':'original-video'}),queue={id:'batch-id',csvName:'pairs.csv'},row={id:'row-id',name:'sub/one.mp4',result:{review:{verdict:'pass',selectedAttempt:1}}};
  const save=async()=>{},fetchResult=async()=>new Response('repaired-video',{headers:{'content-length':'14'}});
  await repair.bind(folder.root,queue,save);await repair.capture(folder.root,row,save);
  return {folder,queue,row,save,fetchResult};
};
test('only approved repairs replace exact relative filenames after verifying an original backup',async()=>{
  const {folder,queue,row,save,fetchResult}=await setup();
  for(const review of [{verdict:'needs_review',selectedAttempt:0},{verdict:'pass',selectedAttempt:0},{verdict:'pass',selectedAttempt:undefined}]){
    await assert.rejects(repair.replace(folder.root,queue,{...row,result:{review}},{save,fetchResult}),/Only a reviewed/);
    assert.equal(await folder.text(row.name),'original-video');
  }
  const backup=await repair.replace(folder.root,queue,row,{save,fetchResult});
  assert.equal(await folder.text(row.name),'repaired-video');assert.equal(await folder.text(backup),'original-video');
  assert.equal(backup,'_bridge-backups/batch-id/originals/sub/one.mp4');assert.ok(folder.writes.indexOf(backup)<folder.writes.indexOf(row.name));
  assert.ok(![...folder.data.keys()].some(p=>p.startsWith('approved/')));
});
test('changed originals, wrong resume folders, incomplete downloads and failed backups do not overwrite originals',async()=>{
  for(const scenario of ['changed','download','backup','checkpoint','target']){
    const {folder,queue,row,fetchResult}=await setup();let save=async()=>{},fetch=fetchResult;
    if(scenario==='changed')folder.put(row.name,'user-new-version');
    if(scenario==='download')fetch=async()=>new Response('short',{headers:{'content-length':'14'}});
    if(scenario==='backup')folder.options.failWrite=path=>path.includes('/originals/');
    if(scenario==='target')folder.options.failClose=path=>path===row.name;
    if(scenario==='checkpoint')save=async()=>{throw new Error('Storage full');};
    await assert.rejects(repair.replace(folder.root,queue,row,{save,fetchResult:fetch}));
    assert.equal(await folder.text(row.name),scenario==='changed'?'user-new-version':'original-video',scenario);
  }
  const {queue,save}=await setup();await assert.rejects(repair.bind(memoryFolder().root,queue,save),/Wrong folder/);
});
test('staged repairs resume after a lost server; committed repairs resume without writing twice',async()=>{
  const {folder,queue,row,save,fetchResult}=await setup();let durable;
  folder.options.failWrite=path=>path===row.name;
  await assert.rejects(repair.replace(folder.root,queue,row,{save:async()=>{durable=structuredClone(row);},fetchResult}),/Disk write/);
  assert.equal(await folder.text(row.name),'original-video');assert.ok(durable.replacement.digest);
  folder.options.failWrite=null;
  const resumed=structuredClone(durable),noServer=async()=>{throw new Error('Server lost');};
  const backup=await repair.replace(folder.root,queue,resumed,{save,fetchResult:noServer});
  assert.equal(await folder.text(backup),'original-video');assert.equal(await folder.text(row.name),'repaired-video');
  const written=folder.writes.length;
  await repair.replace(folder.root,queue,durable,{save,fetchResult:noServer});assert.equal(folder.writes.length,written);
});
test('tampered stages/backups and cancellation leave the original intact',async()=>{
  for(const scenario of ['stage','backup','cancel']){
    const {folder,queue,row,save,fetchResult}=await setup();
    folder.options.failWrite=path=>path===row.name;
    await assert.rejects(repair.replace(folder.root,queue,row,{save,fetchResult}));folder.options.failWrite=null;
    if(scenario==='stage')folder.put(row.replacement.stagePath,'bad');
    if(scenario==='backup')folder.put(row.replacement.backupPath,'bad');
    const check=()=>{if(scenario==='cancel')throw new Error('Cancelled');};
    await assert.rejects(repair.replace(folder.root,queue,row,{save,fetchResult,check}));
    assert.equal(await folder.text(row.name),'original-video');
  }
});
test('replacement file access rejects traversal and reserved backup inputs',async()=>{
  const {folder,row,save}=await setup();
  for(const path of ['../secret.mp4','sub/../secret.mp4','/root.mp4','sub\\file.mp4'])await assert.rejects(repair.handle(folder.root,path),/Unsafe/);
  await assert.rejects(repair.capture(folder.root,{...row,name:'_bridge-backups/foo.mp4'},save),/reserved/);
});
