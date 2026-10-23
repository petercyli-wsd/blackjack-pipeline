const http=require('node:http');
const fs=require('node:fs/promises');
const {createReadStream,createWriteStream}=require('node:fs');
const path=require('node:path');
const {randomUUID,randomBytes,timingSafeEqual}=require('node:crypto');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {spawn}=require('node:child_process');
const {METHODS,DEFAULT_PROMPT,validateOptions}=require('./src/models');
const {probe,processVideos,createComparison}=require('./src/media');
const secret=()=>randomBytes(32).toString('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function body(req){
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>32768)throw new Error('Request too large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString()||'{}');
}
async function sendFile(req,res,file,download=false){
  const stat=await fs.stat(file);
  const headers={'Content-Type':path.extname(file)==='.png'?'image/png':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'no-store'};
  if(download)headers['Content-Disposition']=`attachment; filename="${path.basename(file).replace(/[^a-zA-Z0-9._-]/g,'_')}"`;
  let start=0,end=stat.size-1,code=200;
  if(req.headers.range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}
    if(!match[1])start=Math.max(0,stat.size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
    if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}
    code=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length']=end-start+1;res.writeHead(code,headers);
  if(req.method==='HEAD'){res.end();return;}
  await pipeline(createReadStream(file,{start,end}),res).catch(()=>{});
}
async function createStudio({dataDir=process.env.DATA_DIR||path.join(__dirname,'data'),port=Number(process.env.PORT)||0,
  hosted=process.env.STUDIO_HOSTED==='true'||process.env.RENDER==='true',publicOrigin=process.env.PUBLIC_ORIGIN||process.env.RENDER_EXTERNAL_URL,
  teamPassword=process.env.TEAM_PASSWORD||'',sessionTtlMs=2*60*60*1000,keyTtlMs=8*60*60*1000,
  maxConcurrentJobs=Number(process.env.MAX_CONCURRENT_JOBS)||1,maxSessions=Number(process.env.MAX_SESSIONS)||10,
  maxUploadBytes=512*1024*1024,jobTimeoutMs=60*60*1000,renderVideo=processVideos}={}){
  if(hosted&&(!publicOrigin||new URL(publicOrigin).protocol!=='https:'))throw new Error('Hosted mode requires an HTTPS PUBLIC_ORIGIN (or RENDER_EXTERNAL_URL).');
  if(hosted&&teamPassword.length<16)throw new Error('Hosted mode requires TEAM_PASSWORD with at least 16 characters.');
  let origin=hosted?new URL(publicOrigin).origin:null,closing=false,runningJobs=0;
  const sessions=new Map(),namespace=path.resolve(dataDir,'web-sessions');
  await fs.mkdir(namespace,{recursive:true});
  const instance=await fs.mkdtemp(path.join(namespace,'instance-'));
  async function removeOwned(dir,parent){
    const resolved=path.resolve(dir),rel=path.relative(path.resolve(parent),resolved);
    if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||rel.includes(path.sep))throw new Error('Invalid cleanup directory');
    await fs.rm(resolved,{recursive:true,force:true});
  }
  // Only stale instance directories are removed. Running instances update their timestamp.
  for(const entry of await fs.readdir(namespace,{withFileTypes:true})){
    if(!entry.isDirectory()||!/^instance-[a-zA-Z0-9]+$/.test(entry.name))continue;
    const dir=path.join(namespace,entry.name),stat=await fs.stat(dir);
    if(Date.now()-stat.mtimeMs>24*60*60*1000)await removeOwned(dir,namespace);
  }
  function newSession(){
    if(sessions.size>=maxSessions)throw new Error('All team sessions are occupied. End an unused session or try later.');
    const s={id:secret(),token:secret(),keys:{fal:'',kie:''},keySetAt:0,lastSeen:Date.now(),uploads:new Map(),media:new Map(),jobs:new Map(),active:null,upload:null,uploadBytes:0,renderCount:0};
    s.dir=path.join(instance,s.id);sessions.set(s.id,s);return s;
  }
  async function endSession(s){
    if(s.ending)return s.ending;
    sessions.delete(s.id);s.keys={fal:'',kie:''};s.active?.controller.abort();s.upload?.controller.abort();
    s.ending=(async()=>{await Promise.allSettled([s.active?.promise,s.upload?.promise]);await removeOwned(s.dir,instance);})();return s.ending;
  }
  function credentials(s){if(Date.now()-s.keySetAt>keyTtlMs)s.keys={fal:'',kie:''};return {fal:!!s.keys.fal,kie:!!s.keys.kie};}
  function mediaURL(s,file){const id=randomUUID();s.media.set(id,file);return `/media/${id}`;}
  function register(s,r){return {id:randomUUID(),url:mediaURL(s,r.output),preview:r.preview?mediaURL(s,r.preview):null,noBridgeUrl:r.noBridge?mediaURL(s,r.noBridge):null,noBridgePreview:r.noBridgePreview?mediaURL(s,r.noBridgePreview):null,frames:r.frames.map(f=>mediaURL(s,f)),duration:r.duration,noBridgeDuration:r.noBridgeDuration,width:r.width,height:r.height};}
  function startJob(s,work,requestId){
    if(requestId!==undefined&&(typeof requestId!=='string'||!/^[-a-zA-Z0-9]{1,80}$/.test(requestId)))throw new Error('Invalid render request reference.');
    if(s.active)throw new Error('Your session already has a running job. Wait or cancel it first.');
    if(runningJobs>=maxConcurrentJobs)throw Object.assign(new Error('The team server is rendering another job. Waiting for a slot.'),{status:429});
    const job={id:randomUUID(),requestId,state:'running',messages:[],offset:0,controller:new AbortController()};
    const secrets=Object.values(s.keys).filter(Boolean);
    const redact=value=>secrets.reduce((str,key)=>str.split(key).join('[redacted]'),String(value)).split(instance).join('[session files]');
    const log=msg=>{job.messages.push(redact(msg));if(job.messages.length>500){job.messages.shift();job.offset++;}};
    s.jobs.set(job.id,job);s.active=job;runningJobs++;
    const timer=setTimeout(()=>{job.timedOut=true;job.controller.abort();},jobTimeoutMs);timer.unref();
    job.promise=(async()=>{try{job.result=register(s,await work(job.controller.signal,log,value=>{job.providerJob=value;}));job.state='complete';}catch(e){
      job.error=job.controller.signal.aborted?`${job.timedOut?'Time limit reached':'Cancelled locally'}. Submitted cloud jobs may still complete and incur charges.`:redact(e.message);job.state='failed';
    }finally{clearTimeout(timer);s.active=null;runningJobs--;s.lastSeen=Date.now();}})();return {id:job.id};
  }
  async function releaseBatch(s,rowId){
    if(!s.batch)return;
    if(s.batch.rowId!==rowId)throw new Error('Another batch row owns this workspace.');
    if(s.active||s.upload)throw new Error('Wait for cancellation/upload/render to finish before releasing the row.');
    const dir=path.join(s.dir,'batch');await removeOwned(dir,s.dir);
    for(const [id,file] of s.media)if(file.startsWith(dir+path.sep))s.media.delete(id);
    if(s.batch.jobId)s.jobs.delete(s.batch.jobId);s.batch=null;
  }
  async function latest(s,signal,log){
    const root=path.join(s.dir,'renders'),entries=await fs.readdir(root,{withFileTypes:true}).catch(()=>[]);
    for(const entry of entries.filter(e=>e.isDirectory()).sort((a,b)=>b.name.localeCompare(a.name))){
      const dir=path.join(root,entry.name),output=path.join(dir,'result.mp4'),preview=path.join(dir,'preview.mp4'),frames=[path.join(dir,'start.png'),path.join(dir,'end.png')];
      if(!(await Promise.all([output,preview,...frames,path.join(dir,'a.mp4'),path.join(dir,'b.mp4')].map(f=>fs.stat(f).then(s=>s.size>0).catch(()=>false)))).every(Boolean))continue;
      const info=await probe(output,signal),comparison=await createComparison(path.join(dir,'a.mp4'),path.join(dir,'b.mp4'),dir,signal,log);
      return {output,preview,frames,...comparison,...info};
    }throw new Error('No completed result in your current session. Create a transition first.');
  }
  async function sweep(){
    await fs.utimes(instance,new Date(),new Date());
    for(const s of sessions.values()){credentials(s);if(!s.active&&!s.upload&&Date.now()-s.lastSeen>sessionTtlMs)await endSession(s);}
  }
  const cleanup=setInterval(()=>sweep().catch(()=>{}),60000);cleanup.unref();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(hosted)res.setHeader('Strict-Transport-Security','max-age=31536000');
    try{
      if(closing)return json(res,503,{error:'Server restarting. Try again shortly.'});
      if(req.url==='/health'&&req.method==='GET')return json(res,200,{ok:true});
      if(req.headers.host!==new URL(origin).host)return json(res,403,{error:'Unrecognized host'});
      if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'Cross-origin requests are not allowed'});
      if(req.headers['sec-fetch-site']==='cross-site'&&req.headers['sec-fetch-mode']!=='navigate')return json(res,403,{error:'Cross-site requests are not allowed'});
      if(hosted){const expected='Basic '+Buffer.from(`team:${teamPassword}`).toString('base64');if(!equal(req.headers.authorization,expected)){res.setHeader('WWW-Authenticate','Basic realm="Dealer Transition Team", charset="UTF-8"');return json(res,401,{error:'Use username team and your team access password.'});}}
      const url=new URL(req.url,origin),route=url.pathname;
      const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('studio_session='))?.slice(15);
      let s=sessions.get(cookie);
      if(s&&!s.active&&!s.upload&&Date.now()-s.lastSeen>sessionTtlMs){await endSession(s);s=null;}
      if(s){s.lastSeen=Date.now();credentials(s);}
      if(route==='/api/session'&&req.method==='GET'){
        if(!s)s=newSession();res.setHeader('Set-Cookie',`studio_session=${s.id}; HttpOnly; SameSite=Strict; Path=/${hosted?'; Secure':''}`);return json(res,200,{token:s.token});
      }
      if(route.startsWith('/api/')){
        if(!s||!equal(req.headers['x-studio-token'],s.token))return json(res,403,{error:'Session expired. Refresh this page and enter your keys again.'});
        if(route==='/api/init'&&req.method==='GET')return json(res,200,{methods:METHODS,prompt:DEFAULT_PROMPT,keys:credentials(s),hosted,maxUploadBytes,activeJob:s.active?.id||null,activeBatch:s.batch?.rowId||null});
        if(route.startsWith('/api/request-jobs/')&&req.method==='GET'){
          const requestId=route.slice('/api/request-jobs/'.length),job=[...s.jobs.values()].find(j=>j.requestId===requestId);
          if(!job)return json(res,404,{error:'That render request was not found in your server session. It may not have reached the server, or the server may have restarted. Check provider history before submitting again.'});
          return json(res,200,{id:job.id});
        }
        if(route==='/api/batch'&&req.method==='GET')return json(res,200,s.batch?{rowId:s.batch.rowId,jobId:s.batch.jobId,uploads:Object.fromEntries([...s.batch.uploads].map(([slot,{file,...info}])=>[slot,info]))}:{});
        if(route==='/api/batch/row'&&req.method==='POST'){
          const {rowId}=await body(req);if(typeof rowId!=='string'||!/^[-a-zA-Z0-9]{1,80}$/.test(rowId))throw new Error('Invalid batch row ID.');
          if(s.batch?.rowId===rowId)return json(res,200,{rowId,jobId:s.batch.jobId});
          if(s.batch||s.active||s.upload)throw new Error('Finish or release the current workspace before starting another batch row.');
          s.batch={rowId,jobId:null,uploads:new Map(),bytes:0};return json(res,200,{rowId});
        }
        if(route==='/api/batch/release'&&req.method==='POST'){const {rowId}=await body(req);await releaseBatch(s,rowId);return json(res,200,{});}
        if(route==='/api/keys'&&req.method==='POST'){
          const value=await body(req);for(const p of ['fal','kie'])if(typeof value[p]==='string'&&value[p].trim()){if(value[p].length>4096)throw new Error('API key is too long');s.keys[p]=value[p].trim();s.keySetAt=Date.now();}return json(res,200,credentials(s));
        }
        if(route==='/api/keys'&&req.method==='DELETE'){s.keys={fal:'',kie:''};return json(res,200,credentials(s));}
        if((route==='/api/upload'||route==='/api/batch/upload')&&req.method==='POST'){
          const batch=route==='/api/batch/upload'?s.batch:null,slot=url.searchParams.get('slot');
          if(route==='/api/batch/upload'&&(!batch||batch.rowId!==url.searchParams.get('rowId')||!['a','b'].includes(slot)))throw new Error('Invalid batch workspace or slot.');
          if(!batch&&s.batch)throw new Error('Finish or release the batch workspace first.');
          if(s.upload||s.active)throw new Error('Wait for your current upload or render to finish.');
          if(batch&&(batch.jobId||batch.uploads.has(slot)))throw new Error('This batch slot is already uploaded or submitted. Resume the existing row.');
          if(!batch&&s.uploads.size>=8)throw new Error('Session upload limit reached. Download your results and end this session to start fresh.');
          const id=randomUUID(),file=path.join(s.dir,batch?'batch':'uploads',`${id}.video`);let count=0;
          const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10*60*1000);timer.unref();
          const limiter=new Transform({transform(chunk,encoding,done){count+=chunk.length;done(count>maxUploadBytes||(batch?batch.bytes:s.uploadBytes)+count>2*maxUploadBytes?new Error(`Upload limit: ${Math.round(maxUploadBytes/1024/1024)} MB per video, twice that per workspace.`):null,chunk);}});
          const task={controller};s.upload=task;
          task.promise=(async()=>{
            await fs.mkdir(path.dirname(file),{recursive:true});await pipeline(req,limiter,createWriteStream(file),{signal:controller.signal});
            const info=await probe(file,controller.signal,true);if(info.duration>600||info.width>4096||info.height>4096)throw new Error('Maximum input: 10 minutes and 4096 pixels on either side.');
            const metadata={id,name:String(url.searchParams.get('name')||'Video').slice(0,200),url:mediaURL(s,file),...info};
            if(batch){batch.uploads.set(slot,{...metadata,file});batch.bytes+=count;}else{s.uploads.set(id,file);s.uploadBytes+=count;}
            return metadata;
          })();
          try{return json(res,200,await task.promise);}catch(e){await fs.rm(file,{force:true});throw e;}finally{clearTimeout(timer);s.upload=null;}
        }
        if(route==='/api/batch/process'&&req.method==='POST'){
          const o=await body(req),batch=s.batch;
          if(!batch||batch.rowId!==o.rowId)throw new Error('Batch workspace no longer exists. Review this row before retrying.');
          if(batch.jobId)return json(res,202,{id:batch.jobId}); // Idempotent within this session, including a lost POST response.
          if(s.upload)throw new Error('Wait for the upload to finish.');
          const a=batch.uploads.get('a'),b=batch.uploads.get('b');if(!a||!b)throw new Error('Upload both batch videos first.');
          const options={...o,a:a.file,b:b.file,aEnd:a.duration,bStart:0};
          const method=validateOptions(options),key=s.keys[method.provider];
          if(method.provider!=='local'&&!key)throw Object.assign(new Error(`Enter your own ${method.provider} key before resuming the batch.`),{status:428});
          const dir=path.join(s.dir,'batch','render');
          const started=startJob(s,(signal,log,onProviderJob)=>renderVideo(options,{dir,key,signal,log,onProviderJob,outputOnly:true}));
          batch.jobId=started.id;return json(res,202,started);
        }
        if(route==='/api/process'&&req.method==='POST'){
          if(s.batch)throw new Error('Finish or release the batch workspace first.');
          const o=await body(req),method=validateOptions(o);
          if(!s.uploads.has(o.a)||!s.uploads.has(o.b))throw new Error('Upload both videos in your own session first.');
          if(s.upload)throw new Error('Wait for your upload to finish.');
          if(s.renderCount>=5)throw new Error('Session render limit reached. Download your results and end this session to start fresh.');
          const key=s.keys[method.provider];if(method.provider!=='local'&&!key)throw new Error(`Enter your own ${method.provider} API key in Provider credentials first.`);
          const options={...o,a:s.uploads.get(o.a),b:s.uploads.get(o.b)},dir=path.join(s.dir,'renders',`${Date.now()}-${randomUUID().slice(0,8)}`);
          const started=startJob(s,(signal,log)=>renderVideo(options,{dir,key,signal,log}),o.requestId);s.renderCount++;return json(res,202,started);
        }
        if(route==='/api/latest'&&req.method==='POST'){if(s.batch)throw new Error('Finish or release the batch workspace first.');const o=await body(req);return json(res,202,startJob(s,(signal,log)=>latest(s,signal,log),o.requestId));}
        if(route==='/api/batch/cancel'&&req.method==='POST'){const {rowId}=await body(req);if(s.batch?.rowId!==rowId)throw new Error('Batch row changed.');if(s.batch.jobId)s.jobs.get(s.batch.jobId)?.controller.abort();s.upload?.controller.abort();return json(res,200,{});}
        if(route==='/api/cancel'&&req.method==='POST'){s.active?.controller.abort();return json(res,200,{});}
        if(route.startsWith('/api/jobs/')&&req.method==='GET'){
          const j=s.jobs.get(route.slice('/api/jobs/'.length));if(!j)return json(res,404,{error:'Job not found in your session'});return json(res,200,{id:j.id,state:j.state,messages:j.messages,offset:j.offset,result:j.result,error:j.error,providerJob:j.providerJob});
        }
        if(route==='/api/logout'&&req.method==='POST'){
          await endSession(s);res.setHeader('Set-Cookie',`studio_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/${hosted?'; Secure':''}`);return json(res,200,{});
        }
        if(route==='/api/shutdown'&&req.method==='POST'&&!hosted){json(res,200,{});setTimeout(()=>{close().then(()=>{if(require.main===module)process.exit(0);});},100);return;}
        return json(res,404,{error:'Not found'});
      }
      if(route.startsWith('/media/')&&['GET','HEAD'].includes(req.method)){
        const file=s?.media.get(route.slice('/media/'.length));if(!file)return json(res,404,{error:'Media not found in your session'});return await sendFile(req,res,file,url.searchParams.get('download')==='1');
      }
      const staticFiles={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/renderer.js':'renderer.js','/browser.js':'browser.js','/batch.js':'batch.js','/batch-format.js':'batch-format.js','/batch-zip.js':'batch-zip.js'};
      if(staticFiles[route]&&req.method==='GET'){
        const name=staticFiles[route],types={html:'text/html; charset=utf-8',css:'text/css; charset=utf-8',js:'text/javascript; charset=utf-8'};
        res.writeHead(200,{'Content-Type':types[name.split('.').at(-1)],'Cache-Control':'no-store'});res.end(await fs.readFile(path.join(__dirname,'public',name)));return;
      }json(res,404,{error:'Not found'});
    }catch(e){if(!res.headersSent&&!res.destroyed)json(res,e.status||400,{error:e.message});else res.destroy();}
  });
  server.requestTimeout=10*60*1000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,hosted?'0.0.0.0':'127.0.0.1',resolve);});
  const localURL=`http://127.0.0.1:${server.address().port}`;if(!origin)origin=localURL;
  let closePromise;
  function close(){return closePromise||=(async()=>{closing=true;clearInterval(cleanup);await Promise.allSettled([...sessions.values()].map(endSession));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await removeOwned(instance,namespace);})();}
  return {url:origin,localURL,hosted,close,server,sweep};
}
module.exports={createStudio};
if(require.main===module)createStudio().then(studio=>{
  console.log(`Dealer Transition Studio Web: ${studio.url}`);console.log('Each browser session uses its own keys and temporary files. Keys are never saved.');
  console.log(`Listening on ${studio.server.address().address}:${studio.server.address().port} (${studio.hosted?'hosted':'local'} mode)`);
  if(process.argv.includes('--open')&&!studio.hosted){
    if(process.platform==='win32')spawn('rundll32.exe',['url.dll,FileProtocolHandler',studio.url],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});
    else spawn(process.platform==='darwin'?'open':'xdg-open',[studio.url],{stdio:'ignore'}).on('error',()=>{});
  }
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>studio.close().then(()=>process.exit(0)));
}).catch(e=>{console.error(e.message);process.exitCode=1;});
