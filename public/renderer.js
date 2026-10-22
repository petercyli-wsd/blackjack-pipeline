const $=id=>document.getElementById(id);
let methods=[],clips={},result=null,busy=false;
let reviewMode='preview';
function showResult(){
  if(!result)return;
  const plain=$('comparison').value==='no-bridge';
  const full=reviewMode==='full';
  $('result').pause();
  $('result').src=plain?(full?result.noBridgeUrl:result.noBridgePreview):(full?result.url:result.preview);
  const label=plain?'No bridge · direct cut':'With transition';
  const duration=plain?result.noBridgeDuration:result.duration;
  $('result-info').textContent=`${label} · ${duration.toFixed(2)} seconds total · ${result.width} × ${result.height} · Showing ${full?'full video':'join preview'}. Switching versions restarts playback.`;
  $('export').textContent=plain?'Export no-bridge MP4':'Export transition MP4';
  $('preview').setAttribute('aria-pressed',String(!full));$('full').setAttribute('aria-pressed',String(full));
}
const status=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
const fail=e=>status(e.message.replace(/^Error invoking remote method '[^']+': Error: /,''),true);
function readiness() {$('generate').disabled=busy||!clips.a||!clips.b;}
function methodChange() {
  const m=methods.find(m=>m.id===$('method').value);if(!m)return;
  $('method-help').textContent=m.help;$('duration').min=m.min;$('duration').max=m.max;$('duration').step=m.provider==='local'||m.id==='film'?'0.1':'1';$('duration').value=m.defaultDuration;
  $('prompt-wrap').hidden=m.provider==='local'||m.id==='film';
  $('timing').textContent=m.id==='dissolve'?'A and B overlap by the transition duration.':'Inserts the full bridge between the selected boundaries. Duration is added to the timeline; cloud videos are not compressed into a subsecond join.';
}
function keyStatus(k){
  const label=p=>k[p]?(k.saved?.[p]?'saved':'ready for session'):'not set';
  $('key-status').textContent=` · fal ${label('fal')} / KIE ${label('kie')}`;

  if(k.warning)status(k.warning,true);
}
for(const slot of ['a','b']) {
  $(`pick-${slot}`).onclick=async()=>{$(`pick-${slot}`).disabled=true;try{const c=await window.studio.pick();if(!c)return;clips[slot]=c;$(`video-${slot}`).src=c.url;$(`meta-${slot}`).textContent=`${c.name} · ${c.width} × ${c.height} · ${c.duration.toFixed(2)} s · ${c.fps.toFixed(2)} fps${c.audio?'':' · no audio'}`;const cut=$(slot==='a'?'a-end':'b-start');cut.disabled=false;cut.max=c.duration;cut.value=slot==='a'?c.duration:0;$(`use-${slot}`).disabled=false;readiness();}catch(e){fail(e);}finally{$(`pick-${slot}`).disabled=busy;}};
  $(`use-${slot}`).onclick=()=>{$(slot==='a'?'a-end':'b-start').value=$(`video-${slot}`).currentTime.toFixed(3);};
}
$('method').onchange=methodChange;
async function applyKeys(){
  const remember=false;
  keyStatus(await window.studio.setKeys({fal:$('fal-key').value,kie:$('kie-key').value,remember}));
  $('fal-key').value='';$('kie-key').value='';return remember;
}
$('save-keys').onclick=async()=>{try{const saved=await applyKeys();status(saved?'API keys saved on this device. They will load automatically next time.':'Keys are ready for this session. Use Clear keys or End my session to clear them.');}catch(e){fail(e);}};
$('forget-keys').onclick=async()=>{try{keyStatus(await window.studio.forgetKeys());$('fal-key').value='';$('kie-key').value='';status('Session keys cleared.');}catch(e){fail(e);}};
function setBusy(value) {busy=value;document.querySelectorAll('.settings input,.settings select,.settings textarea,.settings button,.sources button,.sources input,.credentials input,.credentials button').forEach(e=>e.disabled=value);$('latest-result').disabled=value;$('cancel').disabled=false;$('cancel').hidden=!value;readiness();}
function receiveResult(r){
  result=r;reviewMode='preview';$('comparison').value='transition';$('empty').hidden=true;$('anchors').hidden=false;$('anchor-a').src=r.frames[0];$('anchor-b').src=r.frames[1];
  for(const id of ['preview','full','export','reveal','comparison'])$(id).disabled=false;
  showResult();$('result-status').textContent='READY TO REVIEW';
}
$('latest-result').onclick=async()=>{
  setBusy(true);status('Opening latest completed result and preparing comparison…');
  try{receiveResult(await window.studio.latestResult());status('Previous result loaded. No new AI generation was requested.');}catch(e){fail(e);}finally{setBusy(false);}
};
$('generate').onclick=async()=>{
  if(!clips.a||!clips.b)return;
  setBusy(true);$('log').textContent='';status('Starting…');$('result-status').textContent='PROCESSING';
  try {
    await applyKeys();
    const r=await window.studio.process({a:clips.a.id,b:clips.b.id,method:$('method').value,duration:Number($('duration').value),aEnd:Number($('a-end').value),bStart:Number($('b-start').value),fps:Number($('fps').value),prompt:$('prompt').value,mute:$('mute').checked});
    receiveResult(r);
    $('result-status').textContent='READY TO REVIEW';status('Complete. Review both joins before exporting.');
  }catch(e){fail(e);$('result-status').textContent=result?'PREVIOUS RESULT':'JOB STOPPED';}
  finally{setBusy(false);}
};
$('cancel').onclick=()=>{window.studio.cancel().catch(fail);$('cancel').disabled=true;status('Cancelling local work… Cloud charges may still apply.');};
$('comparison').onchange=showResult;
$('preview').onclick=()=>{reviewMode='preview';showResult();};$('full').onclick=()=>{reviewMode='full';showResult();};
$('export').onclick=async()=>{try{const p=await window.studio.export(result.id,$('comparison').value);if(p)status(`Download started in ${p}`);}catch(e){fail(e);}};
$('reveal').onclick=()=>window.studio.reveal(result.id);
window.studio.onProgress(message=>{status(message);const log=$('log');log.textContent+=`${new Date().toLocaleTimeString()}  ${message}\n`;log.scrollTop=log.scrollHeight;});
window.studio.init().then(data=>{if(data.activeJob){status('Your previous render is still running. Use Resume render to reconnect.');const resume=document.createElement('button');resume.textContent='Resume render';resume.onclick=async()=>{resume.disabled=true;setBusy(true);try{receiveResult(await window.studio.resume(data.activeJob));status('Result restored.');}catch(e){fail(e);}finally{setBusy(false);resume.remove();}};$('latest-result').after(resume);}methods=data.methods;for(const m of methods){const op=document.createElement('option');op.value=m.id;op.textContent=m.name;$('method').append(op);}$('prompt').value=data.prompt;keyStatus(data.keys);methodChange();}).catch(fail);
