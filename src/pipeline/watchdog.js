// node watchdog.js <server pid> <command> [args…]
// Runs a stage's command and kills its whole process tree if the server dies without stopping it
// (a crash, a killed terminal, a power cut). Otherwise the orphan would keep writing into the run
// while the restarted server runs the same step again. Output and exit code pass straight through.
const {spawn}=require('node:child_process');
const [parent,cmd,...args]=process.argv.slice(2);
let child;
function killTree(){
  if(!child||child.exitCode!==null)return;
  if(process.platform==='win32')spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  else{try{process.kill(-child.pid,'SIGKILL');}catch{try{child.kill('SIGKILL');}catch{}}}
}
try{child=spawn(cmd,args,{stdio:'inherit',windowsHide:true,detached:process.platform!=='win32'});}
catch(e){process.stderr.write(`__SPAWN_ERROR__ ${e.code||'ERROR'} ${e.message}\n`);process.exit(127);}
child.on('error',e=>{process.stderr.write(`__SPAWN_ERROR__ ${e.code||'ERROR'} ${e.message}\n`);process.exit(127);});
child.on('exit',(code,signal)=>{clearInterval(timer);process.exit(code??(signal?137:1));});
const timer=setInterval(()=>{try{process.kill(Number(parent),0);}catch(e){if(e.code==='ESRCH'){killTree();setTimeout(()=>process.exit(137),3000).unref();}}},1000);
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{killTree();setTimeout(()=>process.exit(137),3000).unref();});
