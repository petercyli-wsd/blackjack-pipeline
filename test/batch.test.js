const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {setTimeout:delay}=require('node:timers/promises');
const {parseCSV,prepare}=require('../public/batch-format');
const {create}=require('../public/batch-zip');
const {createStudio}=require('../server');
const {ff,probe}=require('../src/media');

test('CSV accepts UTF-8 BOM, CRLF, quoted commas, doubled quotes and optional header',()=>{
  const records=parseCSV('\uFEFFfirst_half,second_half,output\r\n"table, one/a.mp4","b ""two"".mp4","results/é.mp4"\r\n\r\n');
  assert.deepEqual(records,[['table, one/a.mp4','b "two".mp4','results/é.mp4']]);
  assert.equal(parseCSV('a.mp4,b.mp4,c.mp4').length,1);
  assert.throws(()=>parseCSV('"unfinished,b,c'),/Unclosed/);
  assert.throws(()=>parseCSV('"x"oops,b,c'),/Malformed/);
  assert.throws(()=>parseCSV('a,b,c\n'.repeat(10001)),/10,000/);
  assert.equal(prepare(parseCSV('a,b,c.mp4\n'.repeat(10000))).length,10000);
});

test('CSV maps absolute Windows/POSIX paths and rejects traversal, collisions and unsafe outputs per row',()=>{
  const records=[['C:\\Videos\\sub\\a.mp4','c:/videos/b.mp4','D:\\Out\\sub\\joined.mp4'],['a.mp4','b.mp4','SUB/JOINED.mp4'],['a.mp4','b.mp4','../escape.mp4'],['C:/VideosOther/a.mp4','b.mp4','safe.mp4'],['a.mp4','b.mp4','CON.mp4'],['a.mp4','b.mp4','wrong.mov'],['a.mp4','b.mp4','other.mp4','extra']];
  const rows=prepare(records,'C:\\Videos','D:\\Out');assert.equal(rows[0].state,'pending');assert.equal(rows[0].a,'sub/a.mp4');assert.equal(rows[0].name,'sub/joined.mp4');
  assert.deepEqual(rows.slice(1).map(r=>r.state),Array(6).fill('invalid'));assert.match(rows[1].error,/Duplicate/);
  assert.equal(prepare([['/home/me/a.mp4','/home/me/b.mp4','/tmp/out/result.mp4']],'/home/me','/tmp/out')[0].name,'result.mp4');
  assert.equal(prepare([['/home/Me/a.mp4','b.mp4','out.mp4']],'/home/me')[0].state,'invalid');
  assert.equal(prepare([['a.mp4','b.mp4','C:/unapproved/result.mp4']])[0].state,'invalid');
});

test('ZIP keeps UTF-8 relative names, file bytes, and valid standard CRC32 records',async()=>{
  const zip=Buffer.from(await (await create([{name:'folder/é.mp4',blob:new Blob(['123456789'])},{name:'report.csv',blob:new Blob(['first,second\r\n'])}])).arrayBuffer());
  assert.equal(zip.readUInt32LE(0),0x04034b50);assert.equal(zip.readUInt16LE(6),0x800);
  assert.equal(zip.readUInt32LE(14),0xcbf43926); // Published CRC32 check vector, not our implementation.
  assert.equal(zip.readUInt32LE(18),9);const length=zip.readUInt16LE(26);
  assert.equal(zip.subarray(30,30+length).toString(),'folder/é.mp4');assert.equal(zip.subarray(30+length,39+length).toString(),'123456789');
  assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);assert.equal(zip.readUInt16LE(zip.length-12),2);
  const directory=zip.readUInt32LE(zip.length-6);assert.equal(zip.readUInt32LE(directory),0x02014b50);
});

async function client(app){
  const session=await fetch(app.localURL+'/api/session'),{token}=await session.json();
  const headers={Cookie:session.headers.get('set-cookie').split(';')[0],'X-Studio-Token':token};
  const request=(route,method='GET',body)=>fetch(app.localURL+route,{method,headers:{...headers,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const api=async(...args)=>{const response=await request(...args),data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
  const upload=async(rowId,slot,file)=>{const response=await fetch(app.localURL+`/api/batch/upload?rowId=${rowId}&slot=${slot}`,{method:'POST',headers,body:await fs.readFile(file)});assert.ok(response.ok);return response.json();};
  const wait=async id=>{for(let i=0;i<500;i++){const job=await api(`/api/jobs/${id}`);if(job.state!=='running')return job;await delay(30);}throw new Error('Timed out');};
  return {request,api,upload,wait,headers};
}

test('batch workspace reuses bounded storage across >5 rows, isolates users, and deduplicates submissions',{timeout:60000},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-batch-')),input=path.join(root,'input.mp4');
  await ff(['-f','lavfi','-i','color=c=red:size=160x90:rate=25:duration=0.5','-c:v','libx264','-pix_fmt','yuv420p',input]);
  let calls=0,complete;const seen=[];
  const app=await createStudio({dataDir:root,renderVideo:async(o,{dir,key,signal,onProviderJob,outputOnly})=>{
    calls++;seen.push({key,outputOnly,aEnd:o.aEnd,bStart:o.bStart});onProviderJob({provider:'fal',requestId:`request-${calls}`});
    await new Promise((resolve,reject)=>{complete=resolve;signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});
    if(calls===2)throw new Error('Mock provider failure');
    await fs.mkdir(dir,{recursive:true});const output=path.join(dir,'result.mp4');await fs.copyFile(input,output);
    return {output,frames:[],duration:1,width:160,height:90};
  }});
  try{
    const a=await client(app),b=await client(app);await a.api('/api/keys','POST',{fal:'test-person-a'});await b.api('/api/keys','POST',{fal:'test-person-b'});
    let oldURL;
    for(let n=0;n<7;n++){
      const rowId=`row-${n}`;await a.api('/api/batch/row','POST',{rowId});
      await a.upload(rowId,'a',input);await a.upload(rowId,'b',input);
      assert.equal((await a.api('/api/batch')).uploads.a.file,undefined);
      const options={rowId,method:'rife',duration:0.2,fps:30,prompt:'',mute:false};
      const job=await a.api('/api/batch/process','POST',options);
      assert.equal((await a.api('/api/batch/process','POST',options)).id,job.id);assert.equal(calls,n+1);
      assert.equal((await b.request(`/api/jobs/${job.id}`)).status,404);
      assert.equal((await a.request('/api/batch/release','POST',{rowId})).status,400);
      assert.equal((await a.request('/api/batch/row','POST',{rowId:'different'})).status,400);
      if(n===0){
        await b.api('/api/batch/row','POST',{rowId:'other'});await b.upload('other','a',input);await b.upload('other','b',input);
        assert.equal((await b.request('/api/batch/process','POST',{...options,rowId:'other'})).status,429);
        assert.equal((await b.request('/api/batch/cancel','POST',{rowId})).status,400);
        await b.api('/api/batch/release','POST',{rowId:'other'});
        await a.api('/api/batch/cancel','POST',{rowId});
      }else complete();
      const finished=await a.wait(job.id);assert.equal(finished.state,n<2?'failed':'complete');assert.equal(finished.providerJob.requestId,`request-${n+1}`);
      if(n>=2){oldURL=finished.result.url;assert.equal((await a.request(oldURL)).status,200);assert.equal((await b.request(oldURL)).status,404);}
      await a.api('/api/batch/release','POST',{rowId});assert.deepEqual(await a.api('/api/batch'),{});
      assert.equal((await a.request(`/api/jobs/${job.id}`)).status,404);
      if(oldURL)assert.equal((await a.request(oldURL)).status,404);
      const instance=(await fs.readdir(path.join(root,'web-sessions')))[0];
      for(const dir of await fs.readdir(path.join(root,'web-sessions',instance)))assert.ok(!(await fs.readdir(path.join(root,'web-sessions',instance,dir))).includes('batch'));
    }
    assert.ok(seen.every(x=>x.key==='test-person-a'&&x.outputOnly&&x.aEnd>0&&x.bStart===0));
    await a.api('/api/batch/row','POST',{rowId:'missing-key'});await a.upload('missing-key','a',input);await a.upload('missing-key','b',input);await a.api('/api/keys','DELETE');
    assert.equal((await a.request('/api/batch/process','POST',{rowId:'missing-key',method:'film',duration:0.2,fps:30,prompt:''})).status,428);
    assert.equal(calls,7);
  }finally{await app.close();}
});

test('real batch blend downloads full A + bridge + B without comparison intermediates',{timeout:60000},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-batch-real-')),input=path.join(root,'input.mp4');
  await ff(['-f','lavfi','-i','testsrc2=size=160x90:rate=25:duration=1','-c:v','libx264','-pix_fmt','yuv420p',input]);
  const app=await createStudio({dataDir:root});
  try{
    const c=await client(app);await c.api('/api/batch/row','POST',{rowId:'actual'});await c.upload('actual','a',input);await c.upload('actual','b',input);
    const {id}=await c.api('/api/batch/process','POST',{rowId:'actual',method:'blend',duration:0.2,fps:30,prompt:'',mute:false});
    const job=await c.wait(id);assert.equal(job.state,'complete',job.error);assert.ok(Math.abs(job.result.duration-2.2)<0.08);
    assert.equal(job.result.preview,null);assert.equal(job.result.noBridgeUrl,null);
    const out=path.join(root,'download.mp4');await fs.writeFile(out,Buffer.from(await (await c.request(job.result.url)).arrayBuffer()));assert.ok((await probe(out)).duration>2);
    await c.api('/api/batch/release','POST',{rowId:'actual'});assert.equal((await c.request(job.result.url)).status,404);
  }finally{await app.close();}
});
