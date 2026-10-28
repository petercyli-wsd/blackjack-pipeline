const {spawn}=require('node:child_process');
const path=require('node:path');
const {killTree,readJSON,exists}=require('./util');

class StageError extends Error{
  constructor(message,{fix='',detail='',kind='error',actions}={}){super(message);Object.assign(this,{fix,detail,kind,actions});}
}
const WATCHDOG=require('node:path').join(__dirname,'watchdog.js');
// Runs one process, line by line. Resolves with its exit code; rejects only when it can't start.
// Every process runs under the watchdog, so it can't outlive a crashed server.
function runProcess({argv,cwd,env,signal,onLine=()=>{},timeoutMs=0}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(Object.assign(new Error('Stopped'),{aborted:true}));
    let child,spawnError=null;
    try{child=spawn(process.execPath,[WATCHDOG,String(process.pid),...argv],{cwd,env,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});}catch(e){return reject(e);}
    const tail={stdout:[],stderr:[]},partial={stdout:'',stderr:''};
    const line=(stream,text)=>{
      const t=text.replace(/\r$/,'');
      if(stream==='stderr'&&t.startsWith('__SPAWN_ERROR__ ')){const [,code,...rest]=t.split(' ');spawnError=Object.assign(new Error(rest.join(' ')),{code});return;}
      tail[stream].push(t);if(tail[stream].length>120)tail[stream].shift();onLine(t,stream);
    };
    for(const stream of ['stdout','stderr'])child[stream].setEncoding('utf8').on('data',chunk=>{
      // tqdm-style progress rewrites one line with \r; keep only its latest state.
      const parts=(partial[stream]+chunk).split('\n');partial[stream]=parts.pop();
      for(const p of parts)line(stream,p.split('\r').filter(Boolean).at(-1)||'');
    });
    let timedOut=false;
    const stop=()=>killTree(child);signal?.addEventListener('abort',stop,{once:true});
    const timer=timeoutMs?setTimeout(()=>{timedOut=true;killTree(child);},timeoutMs):null;timer?.unref?.();
    child.on('error',e=>{signal?.removeEventListener('abort',stop);clearTimeout(timer);reject(e);});
    child.on('close',code=>{
      signal?.removeEventListener('abort',stop);clearTimeout(timer);
      for(const stream of ['stdout','stderr'])if(partial[stream])line(stream,partial[stream]);
      if(spawnError&&!signal?.aborted)return reject(spawnError);
      resolve({code,aborted:!!signal?.aborted,timedOut,tail});
    });
  });
}
// {npm} expands to two arguments (node + npm-cli.js); anything else is string substitution.
function expandArgs(argv,vars){
  const out=[];
  for(const arg of argv){
    if(arg==='{npm}'){if(!vars.npm)throw new StageError('npm wasn\'t found next to this Node.js install.',{fix:'Reinstall Node.js with npm, then resume.'});out.push(...vars.npm);continue;}
    out.push(arg.replace(/\{([a-z]+(?::[a-z]+)?)\}/gi,(whole,name)=>{
      if(name.startsWith('key:'))throw new StageError(`Keys can only be passed through env, not arguments (${whole}).`);
      if(vars[name]===undefined||vars[name]===null)throw new StageError(`The command uses ${whole}, which isn't available at this stage.`,{fix:'Check the pipeline definition.'});
      return String(vars[name]);
    }));
  }
  return out;
}
function expandEnv(env,vars,keys){
  const out={};
  for(const [k,v] of Object.entries(env||{}))out[k]=String(v).replace(/\{key:([a-z]+)\}/g,(_,p)=>keys.get(p)||'').replace(/\{([a-z]+)\}/g,(w,n)=>vars[n]??w);
  return out;
}
// The last thing a failing tool said, plus the first matching hint from the definition.
function describe(result,{title,hints=[]}){
  const lines=[...result.tail.stdout.slice(-40),...result.tail.stderr.slice(-80)].filter(l=>l.trim());
  const text=lines.join('\n'),err=result.tail.stderr.filter(l=>l.trim());
  const detail=[...err].reverse().find(l=>!/^\s|^Traceback|^During handling|^The above exception/.test(l))||err.at(-1)||lines.at(-1)||'';
  for(const h of hints){
    const m=new RegExp(h.match,'m').exec(text);
    if(m)return new StageError(h.message.replace(/\$(\d)/g,(_,i)=>m[i]??''),{fix:h.fix||'',detail});
  }
  if(result.timedOut)return new StageError(`${title} ran past its time limit and was stopped.`,{fix:'Check the log for where it stalled, then resume.',detail});
  return new StageError(`${title} stopped with an error (exit code ${result.code}).`,{fix:'The last lines of the log below show what went wrong. Fix the cause, then retry this stage.',detail});
}
async function verify(ws,rules=[]){
  for(const rule of rules){
    if(rule.exists&&!await exists(path.join(ws,rule.exists)))throw new StageError(rule.message||`Expected output is missing: ${rule.exists}`,{fix:rule.fix||'Check the log; the stage finished without writing it.'});
    if(rule.json){
      const data=await readJSON(path.join(ws,rule.json));
      if(!data)throw new StageError(rule.message?.replace('{missing}','(file unreadable)')||`Couldn't read ${rule.json}.`,{fix:rule.fix||''});
      const value=rule.field?data[rule.field]:data;
      const missing=(rule.requireKeys||[]).filter(k=>!value||!(k in value));
      if(missing.length)throw new StageError((rule.message||'Missing entries in {file}: {missing}.').replace('{file}',rule.json).replace('{missing}',missing.length>12?`${missing.slice(0,12).join(', ')} and ${missing.length-12} more`:missing.join(', ')),{fix:rule.fix||'',detail:`${missing.length} missing`});
    }
  }
}
module.exports={StageError,runProcess,expandArgs,expandEnv,describe,verify};
