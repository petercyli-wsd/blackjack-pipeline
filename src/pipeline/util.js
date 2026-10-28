const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');

// Windows briefly locks files that antivirus, indexers or a playing <video> have open.
const transient=e=>['EPERM','EBUSY','EACCES','ENOTEMPTY'].includes(e?.code);
async function retry(fn,tries=8){for(let i=0;;i++){try{return await fn();}catch(e){if(i>=tries||!transient(e))throw e;await delay(60*(i+1));}}}
async function atomicWrite(file,data){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp,data);
  try{await retry(()=>fs.rename(temp,file));}catch(e){await fs.rm(temp,{force:true});throw e;}
}
const readJSON=(file,fallback=null)=>fs.readFile(file,'utf8').then(JSON.parse).catch(()=>fallback);
const exists=file=>fs.access(file).then(()=>true,()=>false);
function inside(root,target){const rel=path.relative(path.resolve(root),path.resolve(target));return !!rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);}
// Every delete is confined to a root the caller owns; a malformed definition can never reach outside it.
async function remove(root,target){
  if(!inside(root,target))throw new Error(`Refusing to delete outside the run: ${target}`);
  await retry(()=>fs.rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:100}));
}
// Output patterns are workspace-relative paths; `*` is allowed in the last segment only.
async function expand(root,pattern){
  const clean=String(pattern).replace(/\\/g,'/');
  if(!clean||clean.startsWith('/')||/^[a-z]:/i.test(clean)||clean.split('/').some(p=>p==='..'||!p))throw new Error(`Invalid output path in definition: ${pattern}`);
  const full=path.join(root,clean);
  if(!path.basename(clean).includes('*'))return [full];
  const re=new RegExp('^'+path.basename(clean).split('*').map(s=>s.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$');
  const names=await fs.readdir(path.dirname(full)).catch(()=>[]);
  return names.filter(n=>re.test(n)).map(n=>path.join(path.dirname(full),n));
}
async function wipe(root,patterns){for(const p of patterns)for(const file of await expand(root,p))await remove(root,file);}
function shortId(){const d=new Date(),p=n=>String(n).padStart(2,'0');return `${String(d.getFullYear()).slice(2)}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${crypto.randomBytes(2).toString('hex')}`;}
async function hashFiles(files,extra=''){
  const h=crypto.createHash('sha256').update(extra);
  for(const f of files){h.update(path.basename(f));h.update(await fs.readFile(f).catch(()=>Buffer.from('missing')));}
  return h.digest('hex').slice(0,12);
}
async function dirSize(dir){
  let total=0;
  for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
    const p=path.join(dir,e.name);
    if(e.isDirectory())total+=await dirSize(p);else if(e.isFile())total+=(await fs.stat(p).catch(()=>({size:0}))).size;
  }
  return total;
}
async function freeBytes(dir){try{const s=await fs.statfs(dir);return s.bavail*s.bsize;}catch{return null;}}
// A child's own children (ffmpeg under Python, vite under npm) must die with it, or they keep writing files.
function killTree(child){
  if(!child||child.exitCode!==null||child.signalCode)return;
  if(process.platform==='win32')spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill());
  else{try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}}
}
// npm is a .cmd shim on Windows, which spawn() can't run without a shell; run its JS entry with this node instead.
function npmCommand(){
  const candidates=[process.env.npm_execpath,path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),path.join(path.dirname(process.execPath),'..','lib','node_modules','npm','bin','npm-cli.js')].filter(p=>p&&/npm-cli\.js$/.test(p));
  return {candidates,resolve:async()=>{for(const c of candidates)if(await exists(c))return [process.execPath,c];return process.platform==='win32'?null:['npm'];}};
}
const pythonIn=env=>process.platform==='win32'?path.join(env,'Scripts','python.exe'):path.join(env,'bin','python');
const bytes=n=>!Number.isFinite(n)?'?':n<1024**2?`${Math.round(n/1024)} KB`:n<1024**3?`${(n/1024**2).toFixed(n<10*1024**2?1:0)} MB`:`${(n/1024**3).toFixed(1)} GB`;
// One writer per key at a time (toolchain installs, run state), across concurrent runs.
const locks=new Map();
async function withLock(key,fn){
  const previous=locks.get(key)||Promise.resolve();let release;
  const gate=new Promise(r=>{release=r;}),chain=previous.then(()=>gate);locks.set(key,chain);
  await previous;try{return await fn();}finally{release();if(locks.get(key)===chain)locks.delete(key);}
}
module.exports={retry,atomicWrite,readJSON,exists,inside,remove,expand,wipe,shortId,hashFiles,dirSize,freeBytes,killTree,npmCommand,pythonIn,bytes,withLock};
