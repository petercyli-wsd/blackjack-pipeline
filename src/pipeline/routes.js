const fs=require('node:fs/promises');
const {createWriteStream}=require('node:fs');
const path=require('node:path');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const zip=require('./zip');
const {send}=require('./preview');
const util=require('./util');

// HTTP surface for pipelines. JSON routes sit behind the session token like the rest of /api;
// files and downloads are plain GETs (a <video> or <a download> can't send headers) and need
// only the session cookie.
const ID=/^[\w-]{6,40}$/;
const slug=s=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60)||'run';
function pipelineRoutes({engine,previews,hosted,json,body,keys,reason}){
  const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
  const reply=(res,status,value)=>{json(res,status,value);return true;};
  async function upload(req,res,id,url){
    const run=await engine.beginInput(id),name=String(url.searchParams.get('name')||'take.mp4').slice(0,200);
    const file=engine.inputPath(run,name),limit=run.def.input?.maxBytes||8*1024**3;
    try{
      const declared=Number(req.headers['content-length']);
      if(declared>limit)fail(413,`The file is ${util.bytes(declared)}; the limit is ${util.bytes(limit)}.`);
      const free=await util.freeBytes(engine.runsDir);
      if(free!==null&&declared&&declared+512*1024**2>free)fail(507,`Not enough disk space for this take (${util.bytes(free)} free).`);
      await fs.mkdir(path.dirname(file),{recursive:true});
      let count=0;
      const limiter=new Transform({transform(chunk,_,done){count+=chunk.length;done(count>limit?Object.assign(new Error(`The file is over the ${util.bytes(limit)} limit.`),{status:413}):null,chunk);}});
      await pipeline(req,limiter,createWriteStream(file));
      if(!count)fail(400,'The upload was empty.');
    }catch(e){
      await engine.failInput(run,file);
      if(e.code==='ERR_STREAM_PREMATURE_CLOSE'||e.code==='ECONNRESET')e.message='The upload was interrupted. Choose the file again.';
      if(e.code==='ENOSPC')Object.assign(e,{status:507,message:'The disk filled up during the upload. Free some space (old runs can be deleted here), then try again.'});
      throw e;
    }
    return reply(res,200,engine.view(await engine.acceptInput(run,file,name),{full:true}));
  }
  async function fromPath(req,res,id){
    if(hosted)fail(403,'Choosing a file by path only works when the app runs on your own computer.');
    const {path:p}=await body(req);
    if(typeof p!=='string'||!p.trim())fail(400,'Paste the full path to the take.');
    const source=path.resolve(p.trim().replace(/^"(.*)"$/,'$1'));
    const stat=await fs.stat(source).catch(()=>null);
    if(!stat)fail(400,`No file at ${source}.`);if(!stat.isFile())fail(400,'That path is a folder. Paste the path to the video file itself.');
    const run=await engine.beginInput(id),file=engine.inputPath(run,path.basename(source));
    try{await fs.mkdir(path.dirname(file),{recursive:true});await fs.copyFile(source,file);}
    catch(e){await engine.failInput(run,file);fail(400,`Couldn't copy the take: ${e.message}`);}
    return reply(res,200,engine.view(await engine.acceptInput(run,file,path.basename(source)),{full:true}));
  }
  async function api(req,res,route,url){
    if(route==='/api/pipeline'&&req.method==='GET')return reply(res,200,{enabled:!!engine,reason:engine?null:reason,hosted,previews:!!engine&&!hosted,library:!!engine,definitions:engine?engine.definitionList():[],keys:keys.status()});
    if(!engine)fail(404,reason||'Pipelines are turned off on this server.');
    if(route==='/api/pipeline/runs'){
      if(req.method==='GET')return reply(res,200,{runs:engine.list(url.searchParams.get('pipeline')||undefined)});
      if(req.method==='POST'){const b=await body(req);return reply(res,201,engine.view(await engine.create(String(b.pipeline||''),{name:b.name,options:b.options}),{full:true}));}
    }
    const m=/^\/api\/pipeline\/runs\/([^/]+)(?:\/([a-z-]+))?$/.exec(route);
    if(!m)return false;
    const [,id,action]=m;if(!ID.test(id))fail(404,'Run not found.');
    if(!action){
      if(req.method==='GET')return reply(res,200,await engine.detail(id));
      if(req.method==='PATCH'){const b=await body(req);await engine.update(id,b);return reply(res,200,await engine.detail(id));}
      if(req.method==='DELETE'){previews.close(id);await engine.remove(id);return reply(res,200,{deleted:true});}
    }
    if(action==='input'&&req.method==='POST')return upload(req,res,id,url);
    if(action==='input-path'&&req.method==='POST')return fromPath(req,res,id);
    if(action==='rows'&&req.method==='GET')return reply(res,200,await engine.rows(id,{filter:url.searchParams.get('filter')||'all',page:Number(url.searchParams.get('page'))||0}));
    if(action==='log'&&req.method==='GET')return reply(res,200,await engine.readLog(id,String(url.searchParams.get('stage')||''),url.searchParams.get('offset')));
    if(action==='gallery'&&req.method==='GET'){
      const run=engine.get(id),stage=run.stages.find(s=>s.id===url.searchParams.get('stage'));
      const files=stage?.gallery?(await util.expand(engine.ws(run),stage.gallery).catch(()=>[])).sort():[];
      return reply(res,200,{images:files.map(f=>({name:path.basename(f),url:`/pipeline-files/${id}/game/${path.relative(engine.ws(run),f).split(path.sep).map(encodeURIComponent).join('/')}`}))});
    }
    if(action==='preview'&&req.method==='POST'){
      if(hosted)fail(409,'Playing a build here needs the app on your own computer. Download the game instead.');
      const {dir}=engine.artifactDir(id,'site');return reply(res,200,{url:await previews.start(id,dir)});
    }
    if(req.method==='POST'){
      const b=await body(req);
      const actions={start:()=>engine.start(id),pause:()=>engine.pause(id,{now:!!b.now}),resume:()=>engine.resume(id),approve:()=>engine.approve(id,{skip:!!b.skip}),proceed:()=>engine.proceed(id),
        redo:()=>engine.redo(id,String(b.stage||''),b.step?String(b.step):undefined,{fresh:!!b.fresh}),'retry-rows':()=>engine.retryRows(id,b.which).then(r=>({count:r.count})),
        verdict:()=>engine.verdict(id,String(b.output||''),String(b.value||''),String(b.note||'')),'update-code':()=>engine.updateCode(id).then(r=>({message:r.message})),dismiss:()=>engine.dismiss(id)};
      if(actions[action]){const out=await actions[action]();return reply(res,200,{result:out?.count!==undefined||out?.graceful!==undefined||out?.message!==undefined?out:null,run:await engine.detail(id)});}
    }
    return false;
  }
  // Cookie-only GETs: run files (contact sheets, generated transitions) and ZIP downloads.
  async function files(req,res,route,url){
    if(!engine)return false;
    let m=/^\/pipeline-files\/([^/]+)\/(.+)$/.exec(route);
    if(m&&['GET','HEAD'].includes(req.method)){
      if(!ID.test(m[1]))fail(404,'Not found.');
      const file=engine.file(m[1],decodeURIComponent(m[2])),stat=await fs.stat(file).catch(()=>null);
      if(!stat?.isFile())fail(404,'That file isn\'t there (it may have been redone or deleted).');
      await send(req,res,file,stat,url.searchParams.get('download')==='1'?{'Content-Disposition':`attachment; filename="${path.basename(file).replace(/[^\w.@-]/g,'_')}"`}:{});
      return true;
    }
    m=/^\/pipeline-download\/([^/]+)\/([a-z]+)\.zip$/.exec(route);
    if(m&&req.method==='GET'){
      if(!ID.test(m[1]))fail(404,'Not found.');
      const {run,dir}=engine.artifactDir(m[1],m[2]),plan=await zip.plan(dir,`${slug(run.name)}-${m[2]}/`);
      res.writeHead(200,{'Content-Type':'application/zip','Content-Length':plan.size,'Cache-Control':'no-store','Content-Disposition':`attachment; filename="${slug(run.name)}-${m[2]==='site'?'game':m[2]}.zip"`});
      const controller=new AbortController();res.on('close',()=>{if(!res.writableFinished)controller.abort();});
      await zip.write(res,dir,plan,{signal:controller.signal}).then(()=>res.end(),()=>res.destroy());
      return true;
    }
    return false;
  }
  return {api,files};
}
module.exports={pipelineRoutes};
