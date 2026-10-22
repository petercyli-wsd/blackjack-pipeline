const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {setTimeout:delay}=require('node:timers/promises');
const {createStudio}=require('../server');
const {ff}=require('../src/media');
// Raw HTTP preserves the reverse proxy Host header; Node fetch replaces it.
function fetch(url,options={}){return new Promise((resolve,reject)=>{
  const req=http.request(url,options,res=>{const parts=[];res.on('data',x=>parts.push(x));res.on('end',()=>resolve(new Response(Buffer.concat(parts),{status:res.statusCode,headers:res.headers})));});
  req.on('error',reject);req.end(options.body);
});}
async function client(app,extra={}){
  const session=await fetch(app.localURL+'/api/session',{headers:extra});assert.equal(session.status,200);
  const {token}=await session.json(),cookie=session.headers.get('set-cookie');
  const headers={...extra,Cookie:cookie.split(';')[0],'X-Studio-Token':token};
  const request=(route,method='GET',value)=>fetch(app.localURL+route,{method,headers:{...headers,...(value?{'Content-Type':'application/json'}:{})},body:value?JSON.stringify(value):undefined});
  const api=async(...args)=>{const r=await request(...args),data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;};
  return {headers,cookie,request,api};
}
test('hosted gate, per-user keys/media/jobs, key selection, cancellation and cleanup',{timeout:60000},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-isolation-'));
  const input=path.join(root,'input.mp4');await ff(['-f','lavfi','-i','testsrc2=size=160x90:rate=25:duration=1','-c:v','libx264','-pix_fmt','yuv420p',input]);
  const calls=[],pending=[];
  const app=await createStudio({dataDir:root,hosted:true,publicOrigin:'https://studio.example',teamPassword:'test-team-password-123456',maxConcurrentJobs:2,
    renderVideo:async(o,{dir,key,signal,log})=>{
      calls.push(key);log('Testing '+key);
      await new Promise((resolve,reject)=>{pending.push(resolve);signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});
      await fs.mkdir(dir,{recursive:true});const output=path.join(dir,'result.mp4');await fs.copyFile(input,output);
      return {output,preview:output,noBridge:output,noBridgePreview:output,frames:[output,output],duration:1,noBridgeDuration:1,width:160,height:90};
    }});
  const extra={Host:'studio.example',Authorization:'Basic '+Buffer.from('team:test-team-password-123456').toString('base64')};
  try{
    assert.equal((await fetch(app.localURL+'/health')).status,200);
    assert.equal((await fetch(app.localURL+'/',{headers:{Host:'studio.example'}})).status,401);
    assert.equal((await fetch(app.localURL+'/',{headers:{...extra,'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate'}})).status,200);
    const a=await client(app,extra),b=await client(app,extra);assert.notEqual(a.cookie,b.cookie);
    assert.match(a.cookie,/HttpOnly/);assert.match(a.cookie,/Secure/);assert.match(a.cookie,/SameSite=Strict/);
    assert.equal((await a.request('/api/shutdown','POST')).status,404);
    await a.api('/api/keys','POST',{fal:'person-a-key'});await b.api('/api/keys','POST',{kie:'person-b-key'});
    assert.deepEqual((await a.api('/api/init')).keys,{fal:true,kie:false});assert.deepEqual((await b.api('/api/init')).keys,{fal:false,kie:true});
    const upload=async c=>{const r=await fetch(app.localURL+'/api/upload?name=clip.mp4',{method:'POST',headers:c.headers,body:await fs.readFile(input)});assert.equal(r.status,200);return r.json();};
    const ua=await upload(a),ub=await upload(b);
    const playlist=await fetch(app.localURL+'/api/upload?name=playlist.m3u8',{method:'POST',headers:a.headers,body:'#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/blocked.ts\n#EXT-X-ENDLIST\n'});
    assert.equal(playlist.status,400,'Network playlists must not be accepted as uploaded videos');
    assert.equal((await b.request(ua.url)).status,404);
    assert.equal((await fetch(app.localURL+ua.url,{headers:extra})).status,404);
    const options={method:'kling-fal',duration:3,aEnd:1,bStart:0,fps:30,prompt:'test',mute:false};
    assert.equal((await b.request('/api/process','POST',{...options,a:ua.id,b:ua.id})).status,400);
    const ja=await a.api('/api/process','POST',{...options,a:ua.id,b:ua.id});
    const jb=await b.api('/api/process','POST',{...options,method:'kling-kie',a:ub.id,b:ub.id});
    assert.deepEqual(calls,['person-a-key','person-b-key']);
    assert.equal((await b.request('/api/jobs/'+ja.id)).status,404);
    const spoof=await fetch(app.localURL+'/api/init',{headers:{...b.headers,'X-Studio-Token':a.headers['X-Studio-Token']}});assert.equal(spoof.status,403);
    assert.ok(!JSON.stringify(await a.api('/api/jobs/'+ja.id)).includes('person-a-key'));
    await a.api('/api/keys','DELETE');assert.equal((await b.api('/api/init')).keys.kie,true);
    await b.api('/api/cancel','POST');await delay(20);
    assert.equal((await a.api('/api/jobs/'+ja.id)).state,'running');assert.equal((await b.api('/api/jobs/'+jb.id)).state,'failed');
    pending[0]();let complete;
    for(let i=0;i<100;i++){complete=await a.api('/api/jobs/'+ja.id);if(complete.state==='complete')break;await delay(20);}
    assert.equal(complete.state,'complete');assert.equal((await b.request(complete.result.url)).status,404);
    assert.equal((await a.request(complete.result.url)).status,200);
    await a.api('/api/logout','POST');assert.equal((await a.request('/api/init')).status,403);
    assert.equal((await a.request(complete.result.url)).status,404);assert.equal((await b.api('/api/init')).keys.kie,true);
    const instance=(await fs.readdir(path.join(root,'web-sessions')))[0],dirs=await fs.readdir(path.join(root,'web-sessions',instance));
    assert.equal(dirs.length,1,'Only B files should remain after A logs out');
  }finally{await app.close();}
});
test('hosted mode fails closed without HTTPS origin and team password',async()=>{
  await assert.rejects(createStudio({hosted:true,publicOrigin:'http://example.com',teamPassword:'test-password-12345'}),/HTTPS/);
  await assert.rejects(createStudio({hosted:true,publicOrigin:'https://example.com',teamPassword:''}),/TEAM_PASSWORD/);
});
test('keys expire independently and idle sessions expire',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-expiry-'));
  const app=await createStudio({dataDir:root,keyTtlMs:40,sessionTtlMs:200});
  try{const a=await client(app);await a.api('/api/keys','POST',{fal:'temporary'});await delay(60);
    assert.equal((await a.api('/api/init')).keys.fal,false);await delay(240);await app.sweep();assert.equal((await a.request('/api/init')).status,403);
  }finally{await app.close();}
});
