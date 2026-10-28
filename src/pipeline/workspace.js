const fs=require('node:fs/promises');
const path=require('node:path');
const {StageError,runProcess}=require('./command');
const {atomicWrite,readJSON,exists,remove,hashFiles,freeBytes,npmCommand,pythonIn,bytes,withLock,retry}=require('./util');
const definitions=require('./definitions');

// Each run works in its own copy of the game repo, so the game's own relative paths
// (game_assets/, bridges/, pipeline/work/) resolve inside the run and never touch your repo.
const norm=p=>p.replace(/\\/g,'/');
const excluded=(file,patterns)=>patterns.some(p=>{const x=norm(p).replace(/\/+$/,'');return file===x||file.startsWith(x+'/');});
// A host without your git sign-in (e.g. Render) can read a private game repo with GITHUB_TOKEN.
// It goes through git's environment config, so it never appears in a command line or log.
function gitEnv(){
  const env={...process.env,GIT_TERMINAL_PROMPT:'0'},token=process.env.GITHUB_TOKEN;
  if(token)Object.assign(env,{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0:`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`});
  return env;
}
async function git(args,cwd,signal){
  let out='';const r=await runProcess({argv:['git',...args],cwd,signal,env:gitEnv(),onLine:l=>{out+=l+'\n';}}).catch(e=>{
    if(e.code==='ENOENT')throw new StageError('git isn\'t installed or isn\'t on PATH.',{fix:'Install Git (https://git-scm.com), restart the pipeline server, then resume.'});throw e;});
  if(r.aborted)throw Object.assign(new Error('Stopped'),{aborted:true});
  if(r.code!==0)throw new StageError(`git ${args[0]} failed.`,{fix:'Check the game repo path or that you are signed in to GitHub, then resume.',detail:r.tail.stderr.filter(Boolean).at(-1)||''});
  return out;
}
async function walk(root,dir='',out=[]){
  for(const e of await fs.readdir(path.join(root,dir),{withFileTypes:true})){
    const rel=dir?`${dir}/${e.name}`:e.name;
    if(e.isDirectory()){if(!['.git','node_modules','.venv','__pycache__'].includes(e.name))await walk(root,rel,out);}
    else if(e.isFile())out.push(rel);
  }
  return out;
}
function sourcePath(def,options,appRoot){return path.resolve(appRoot,options.localPath||def.game.localPath||'');}
// Copies the game's code (tracked and untracked-but-not-ignored files, as `git status` sees them)
// minus the output folders. Re-running it syncs: changed files are copied, deleted ones removed,
// and outputs are left alone.
async function snapshot(ctx){
  const {run,def,ws,signal,log}=ctx;let src=sourcePath(def,run.options,ctx.appRoot),info={source:run.options.source||'local'};
  let checkout=null;
  if(info.source==='git'){
    if(!def.game.repo)throw new StageError('This pipeline has no GitHub repo configured.',{fix:'Use the local folder source instead.'});
    const mirror=path.join(ctx.root,'repos',`${def.game.name||def.id}.git`),ref=run.options.ref||def.game.ref||'main';
    await withLock(mirror,async()=>{
      if(!await exists(mirror)){log(`Cloning ${def.game.repo}…`);await fs.mkdir(path.dirname(mirror),{recursive:true});await git(['clone','--mirror','--quiet',def.game.repo,mirror],ctx.root,signal);}
      else{log(`Fetching ${def.game.repo}…`);await git(['remote','update','--prune'],mirror,signal);}
    });
    const commit=(await git(['rev-parse','--verify','--quiet',`${ref}^{commit}`],mirror,signal).catch(()=>{throw new StageError(`Branch, tag or commit "${ref}" wasn't found in ${def.game.repo}.`,{fix:'Check the name in the run options and push it if it only exists locally.'});})).trim();
    checkout=`${ws}.checkout`;await remove(ctx.runDir,checkout);
    await git(['clone','--quiet','--no-checkout','--shared',mirror,checkout],ctx.runDir,signal);
    await git(['sparse-checkout','set','--no-cone','/*',...(def.game.exclude||[]).map(x=>`!/${norm(x).replace(/\/+$/,'')}/`)],checkout,signal);
    await git(['checkout','--quiet','--detach',commit],checkout,signal);
    Object.assign(info,{repo:def.game.repo,ref,commit:commit.slice(0,10),dirty:0});src=checkout;
  }else{
    const stat=await fs.stat(src).catch(()=>null);
    if(!stat?.isDirectory())throw new StageError(`The game folder wasn't found: ${src}`,{fix:'Set the game folder in this run\'s options (or switch to the GitHub source), then redo Set up.'});
    info.path=src;
  }
  let files;
  if(await exists(path.join(src,'.git'))){
    files=(await git(['ls-files','-z','--cached','--others','--exclude-standard'],src,signal)).split('\0').map(s=>s.trim()).filter(Boolean);
    if(info.source!=='git'){
      info.commit=(await git(['rev-parse','--short=10','HEAD'],src,signal).catch(()=>'')).trim()||null;
      info.dirty=(await git(['status','--porcelain'],src,signal).catch(()=>'')).split('\n').filter(Boolean).length;
    }
  }else files=await walk(src);
  files=[...new Set(files.map(norm))].filter(f=>!excluded(f,def.game.exclude||[]));
  const previous=await readJSON(path.join(ws,'.snapshot.json'),{files:{}}),now={};let changed=0,total=0;
  for(const file of files){
    signal.throwIfAborted();
    const from=path.join(src,file),stat=await fs.stat(from).catch(()=>null);
    if(!stat?.isFile())continue; // listed by git but deleted in the working tree
    total+=stat.size;if(total>2*1024**3)throw new StageError('The game code is over 2 GB without its output folders.',{fix:'Large files in the game repo are copied into every run. Add their folders to game.exclude in the pipeline definition.'});
    now[file]={size:stat.size,mtime:Math.round(stat.mtimeMs)};
    const before=previous.files[file];if(before&&before.size===stat.size&&before.mtime===now[file].mtime&&await exists(path.join(ws,file)))continue;
    await fs.mkdir(path.dirname(path.join(ws,file)),{recursive:true});await retry(()=>fs.copyFile(from,path.join(ws,file)));changed++;
  }
  let deleted=0;
  for(const file of Object.keys(previous.files))if(!now[file]){await remove(ws,path.join(ws,file));deleted++;}
  if(checkout)await remove(ctx.runDir,checkout);
  Object.assign(info,{files:Object.keys(now).length,size:total,updatedAt:new Date().toISOString(),changed,deleted});
  await atomicWrite(path.join(ws,'.snapshot.json'),JSON.stringify({...info,files:now}));
  log(`Game code: ${info.files} files (${bytes(total)}) from ${info.source==='git'?`${info.repo} @ ${info.ref} (${info.commit})`:src}${info.dirty?`, including ${info.dirty} uncommitted change${info.dirty===1?'':'s'}`:''}. ${changed} copied, ${deleted} removed.`);
  return info;
}
// The game repo may ship its own contract; it replaces the stages so the game owns its method.
async function contract(ctx,baseDef){
  const file=baseDef.game?.contractFile&&path.join(ctx.ws,baseDef.game.contractFile);
  if(!file||!await exists(file))return {def:baseDef,source:'built-in'};
  let data;try{data=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){throw new StageError(`The game's ${baseDef.game.contractFile} isn't valid JSON.`,{fix:'Fix the file in the game repo, then use Update game code.',detail:e.message});}
  try{const def=definitions.merge(baseDef,data);ctx.log(`Using the game's own pipeline contract (${baseDef.game.contractFile}).`);return {def,source:'game'};}
  catch(e){throw new StageError(`The game's ${baseDef.game.contractFile} doesn't describe a valid pipeline.`,{fix:'Fix it in the game repo, then use Update game code.',detail:e.message});}
}
function declaredExtras(pyproject){
  const section=/^\[project\.optional-dependencies\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(pyproject)?.[1]||'';
  return [...section.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map(m=>m[1]);
}
async function tool(argv,label,fix,ctx,options){
  const r=await runProcess({argv,signal:ctx.signal,onLine:l=>ctx.log(l),...options}).catch(e=>{if(e.code==='ENOENT')throw new StageError(`${label} isn't installed or isn't on PATH.`,{fix});throw e;});
  if(r.aborted)throw Object.assign(new Error('Stopped'),{aborted:true});
  return r;
}
// Windows caps paths at 260 characters unless long paths are switched on. Python then silently
// fails to import files deep inside its own packages (SAM 2's Hydra config dies with
// "assert spec is not None"). PyTorch and Hydra reach ~120 characters below the environment.
const DEEPEST_IN_ENV=125;
let longPaths=null;
async function longPathsEnabled(){
  if(process.platform!=='win32')return true;
  if(longPaths!==null)return longPaths;
  let out='';
  await runProcess({argv:['reg','query','HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem','/v','LongPathsEnabled'],onLine:l=>{out+=l;}}).catch(()=>{});
  return longPaths=/LongPathsEnabled\s+REG_DWORD\s+0x1\b/.test(out);
}
async function checkPathLength(env){
  if(env.length+DEEPEST_IN_ENV<=259||await longPathsEnabled())return;
  throw new StageError('This app\'s data folder is too deep for Windows\' 260-character path limit.',{
    fix:`The Python tools would need paths of about ${env.length+DEEPEST_IN_ENV} characters, and long paths are turned off on this PC. Either turn them on once (in an admin PowerShell: New-ItemProperty -Path HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force, then restart), or start the app with DATA_DIR set to a short folder such as C:\\bp-data. Then redo Set up.`,
    detail:env});
}
async function ensurePython(ctx,{quiet=false}={}){
  const spec=ctx.def.toolchains?.python;if(!spec)return null;
  const dir=path.join(ctx.ws,spec.dir||'.'),lockFiles=(spec.lock||['pyproject.toml','uv.lock']).map(f=>path.join(dir,f));
  const pyproject=await fs.readFile(path.join(dir,'pyproject.toml'),'utf8').catch(()=>null);
  if(pyproject===null)throw new StageError(`The game code has no ${norm(path.join(spec.dir||'.','pyproject.toml'))}.`,{fix:'Check the game folder, or the toolchains section of the pipeline definition.'});
  const declared=declaredExtras(pyproject),extras=(spec.extras||[]).filter(e=>declared.includes(e)),skipped=(spec.extras||[]).filter(e=>!declared.includes(e));
  const env=path.join(ctx.root,'toolchains',`py-${await hashFiles(lockFiles,JSON.stringify(extras))}`);
  await checkPathLength(env);
  if(await exists(path.join(env,'.ready'))&&await exists(pythonIn(env)))return {env,python:pythonIn(env),cached:true};
  return withLock(env,async()=>{
    if(await exists(path.join(env,'.ready')))return {env,python:pythonIn(env),cached:true};
    if(!quiet)ctx.log(`Installing Python tools${extras.length?` with ${extras.join(', ')}`:''} (first run only; can take several minutes)…${skipped.length?` The game doesn't declare: ${skipped.join(', ')}.`:''}`);
    const frozen=await exists(path.join(dir,'uv.lock'));
    const r=await tool(['uv','sync',...(frozen?['--frozen']:[]),...extras.flatMap(e=>['--extra',e])],'uv','Install uv (https://docs.astral.sh/uv/getting-started/installation/), restart the pipeline server, then resume.',ctx,{cwd:dir,env:{...process.env,UV_PROJECT_ENVIRONMENT:env,VIRTUAL_ENV:'',UV_NO_PROGRESS:'1'}});
    if(r.code!==0)throw new StageError('Installing the Python tools failed.',{fix:'Check your internet connection and the log, then resume.',detail:r.tail.stderr.filter(Boolean).at(-1)||''});
    await fs.writeFile(path.join(env,'.ready'),new Date().toISOString());
    return {env,python:pythonIn(env),cached:false};
  });
}
async function ensureNode(ctx,{quiet=false}={}){
  const spec=ctx.def.toolchains?.node;if(!spec)return null;
  const dir=path.join(ctx.ws,spec.dir||'.'),locks=(spec.lock||['package.json','package-lock.json']);
  if(!await exists(path.join(dir,'package.json')))throw new StageError(`The game code has no ${norm(path.join(spec.dir||'.','package.json'))}.`,{fix:'Check the game folder, or the toolchains section of the pipeline definition.'});
  const env=path.join(ctx.root,'toolchains',`node-${await hashFiles(locks.map(f=>path.join(dir,f)))}`);
  const npm=await npmCommand().resolve();
  if(!npm)throw new StageError('npm wasn\'t found next to this Node.js install.',{fix:'Reinstall Node.js with npm, then resume.'});
  await withLock(env,async()=>{
    if(await exists(path.join(env,'.ready')))return;
    if(!quiet)ctx.log('Installing the game\'s Node packages (first run only)…');
    await fs.mkdir(env,{recursive:true});
    for(const f of locks)if(await exists(path.join(dir,f)))await fs.copyFile(path.join(dir,f),path.join(env,f));
    const lock=await exists(path.join(env,'package-lock.json'));
    const r=await tool([...npm,lock?'ci':'install','--include=dev','--no-audit','--no-fund'],'npm','Reinstall Node.js with npm, then resume.',ctx,{cwd:env,env:{...process.env,npm_config_update_notifier:'false'}});
    if(r.code!==0)throw new StageError('Installing the game\'s Node packages failed.',{fix:'Check your internet connection and the log, then resume.',detail:r.tail.stderr.filter(Boolean).at(-1)||''});
    await fs.writeFile(path.join(env,'.ready'),new Date().toISOString());
  });
  // node_modules is shared by every run with the same lockfile, linked (a junction on Windows) into the workspace.
  const link=path.join(dir,'node_modules');
  const current=await fs.readlink(link).catch(()=>null);
  if(current&&path.resolve(dir,current)===path.join(env,'node_modules'))return {env,npm};
  await unlinkModules(link);
  await fs.symlink(path.join(env,'node_modules'),link,process.platform==='win32'?'junction':'dir');
  return {env,npm};
}
// Never recurse into a linked node_modules: that would empty the shared toolchain.
async function unlinkModules(link){
  const stat=await fs.lstat(link).catch(()=>null);if(!stat)return;
  if(stat.isSymbolicLink())await fs.unlink(link).catch(()=>fs.rmdir(link));
  else await fs.rm(link,{recursive:true,force:true});
}
// Files the game needs that no stage makes (studio sets, textures, model weights) come from your
// game folder. They're refreshed whenever they changed there, so Update game code picks them up.
async function carry(ctx){
  const src=sourcePath(ctx.def,ctx.run.options,ctx.appRoot);let copied=0;
  const same=async(a,b)=>{const [x,y]=await Promise.all([fs.stat(a).catch(()=>null),fs.stat(b).catch(()=>null)]);return x&&y&&x.isFile()&&x.size===y.size&&Math.round(y.mtimeMs)>=Math.round(x.mtimeMs);};
  for(const item of ctx.def.game.carry||[]){
    const from=path.join(src,item.path),to=path.join(ctx.ws,item.path),stat=await fs.stat(from).catch(()=>null);
    if(!stat||(stat.isFile()&&await same(from,to)))continue;
    await fs.mkdir(path.dirname(to),{recursive:true});
    await fs.cp(from,to,{recursive:true,force:true,preserveTimestamps:true,errorOnExist:false});copied++;
    ctx.log(`Copied ${item.path} from the game folder.${item.why?` ${item.why}`:''}`);
  }
  return copied;
}
// The game's own pipeline reads the take through OpenCV; check it can before cutting starts.
async function opencvCheck(ctx,python){
  const script='import cv2,sys,json\nc=cv2.VideoCapture(sys.argv[1]);o=c.isOpened();n=int(c.get(7)) if o else 0\nf=bool(c.read()[0]) if o else False\nl=False\nif o and n>12:\n c.set(1,n-12);l=bool(c.read()[0])\nprint(json.dumps(dict(opened=o,frames=n,width=int(c.get(3)),height=int(c.get(4)),first=f,last=l)))';
  let out='';const r=await runProcess({argv:[python,'-c',script,ctx.input],signal:ctx.signal,onLine:(l,s)=>{if(s==='stdout')out+=l;}});
  if(r.aborted)throw Object.assign(new Error('Stopped'),{aborted:true});
  let data;try{data=JSON.parse(out);}catch{throw new StageError('Couldn\'t check the take with OpenCV.',{fix:'Redo Set up to reinstall the Python tools.',detail:r.tail.stderr.filter(Boolean).at(-1)||''});}
  const spec=ctx.def.input||{};
  if(!data.opened||!data.first)throw new StageError('OpenCV, which the pipeline uses to read every frame, can\'t open this take.',{fix:'Re-export the take as an H.264 MP4 and start a new run with it.'});
  if(spec.width&&(data.width!==spec.width||data.height!==spec.height))throw new StageError(`OpenCV reads the take as ${data.width}×${data.height}, not ${spec.width}×${spec.height}.`,{fix:'Re-export the take at its original size as an H.264 MP4.'});
  if(data.frames>12&&!data.last)throw new StageError('OpenCV can\'t read the last frames of the take.',{fix:'The file is probably truncated. Re-export it and start a new run.'});
  ctx.log(`OpenCV reads the take: ${data.frames} frames at ${data.width}×${data.height}.`);
}
async function prepare(ctx,baseDef){
  const need=ctx.def.minFreeBytes||3*1024**3;
  ctx.step('space','running');
  const free=await freeBytes(ctx.runDir);
  if(free!==null&&free<need)throw new StageError(`Only ${bytes(free)} of disk space is free; a run needs about ${bytes(need)}.`,{fix:'Free up space (delete old runs here, or other files), then resume.'});
  ctx.step('space','done',free===null?'':`${bytes(free)} free`);
  ctx.step('source','running');
  await fs.mkdir(ctx.ws,{recursive:true});
  ctx.run.game=await snapshot(ctx);
  const {def,source}=await contract(ctx,baseDef);ctx.setDefinition(def,source);
  ctx.step('source','done',ctx.run.game.commit?`${ctx.run.game.commit}${ctx.run.game.dirty?` + ${ctx.run.game.dirty} uncommitted`:''}`:'');
  let python=null;
  if(ctx.def.toolchains?.python){ctx.step('python','running');const t=await ensurePython(ctx);python=t.python;ctx.step('python','done',t.cached?'reused':'installed');}
  if(ctx.def.toolchains?.node){ctx.step('node','running');const t=await ensureNode(ctx);ctx.step('node','done',t?'linked':'');}
  ctx.step('carry','running');const n=await carry(ctx);ctx.step('carry','done',n?`${n} reused`:'nothing to reuse');
  if(ctx.def.input?.opencvCheck&&python){ctx.step('input','running');await opencvCheck(ctx,python);ctx.step('input','done');}
}
module.exports={prepare,snapshot,contract,carry,ensurePython,ensureNode,unlinkModules,declaredExtras,sourcePath,checkPathLength,longPathsEnabled};
