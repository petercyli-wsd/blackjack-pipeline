const $=id=>document.getElementById(id);
let methods=[],clips={},result=null,busy=false,importing=false,keyReady={fal:false,kie:false};
let reviewMode='preview',defaultPrompt='';
const selectedMethod=()=>methods.find(m=>m.id===$('method').value);
const hasPendingKeys=()=>!!($('fal-key').value.trim()||$('kie-key').value.trim());
const status=(text,error=false)=>{$('status').textContent=text;$('status').classList.toggle('error',error);};
const fail=e=>status(e.message.replace(/^Error invoking remote method '[^']+': Error: /,''),true);
function renderFailure(e){
  fail(e);$('result-status').textContent=e.canResume?'CONNECTION INTERRUPTED':result?'PREVIOUS RESULT':'JOB STOPPED';
  if(e.canResume)offerReconnect(e.jobId,e.requestId);
  else $('reconnect-render')?.remove();
}
function offerReconnect(id,requestId){
  $('reconnect-render')?.remove();
  const button=document.createElement('button');button.id='reconnect-render';button.textContent='Reconnect to render';
  button.onclick=async()=>{
    button.disabled=true;setBusy(true);status('Reconnecting to the existing render. No new generation request...');
    try{receiveResult(await window.studio.reconnect(id,requestId));status('Existing result restored. No new generation requested.');button.remove();}
    catch(e){renderFailure(e);if(!e.canResume)button.remove();}finally{button.disabled=false;setBusy(false);}
  };
  $('history-actions').append(button);
}
function readiness(){
  try{window.StudioFrameRate.parse($('fps').value,true);$('fps').setCustomValidity('');}catch(e){$('fps').setCustomValidity(e.message);}
  const m=selectedMethod(),locked=busy||importing;
  const hasKey=m&&(m.provider==='local'||keyReady[m.provider]||$(`${m.provider}-key`).value.trim());
  $('generate').disabled=!!locked||!clips.a||!clips.b||!hasKey||!$('fps').validity.valid;
  $('save-keys').disabled=!!locked||!hasPendingKeys();
  $('forget-keys').disabled=!!locked||(!keyReady.fal&&!keyReady.kie&&!hasPendingKeys());
  $('clear-results').disabled=!!locked;
  for(const slot of ['a','b']){
    $(`pick-${slot}`).disabled=!!locked;
    $(slot==='a'?'a-end':'b-start').disabled=!!locked||!clips[slot];
    $(`use-${slot}`).disabled=!!locked||!clips[slot];
  }
  $('generate-hint').textContent=busy?'Processing. You can cancel below.':importing?'Uploading your clip...':!m?'Loading methods...':!clips.a||!clips.b?'Choose both clips to continue.':!hasKey?`Add your ${m.provider==='fal'?'fal':'KIE'} key in Provider credentials above.`:!$('fps').validity.valid?$('fps').validationMessage:'Ready. Your output includes clip A, the transition and clip B.';
  if(m){
    $('provider-note').textContent=m.provider==='local'?'Runs on this server. No provider credits.':`${m.provider==='fal'?'fal':'KIE'} ${keyReady[m.provider]?'key ready':hasKey?'key entered':'key needed'} - uses your provider credits`;
    $('provider-note').classList.toggle('needs-key',!hasKey);
  }
}
function methodChange(){
  const m=selectedMethod();if(!m)return;
  const frames=m.kind==='interpolation';
  $('method-help').textContent=m.help;
  $('duration').min=m.min;$('duration').max=m.max;$('duration').step=m.provider==='local'||frames?'0.1':'1';$('duration').value=m.defaultDuration;
  $('prompt-wrap').hidden=m.provider==='local'||frames;
  $('timing').textContent=m.id==='dissolve'?'Overlaps A and B by this duration, shortening the full video.':`Inserts a ${frames?'frame-interpolated':'generated'} bridge between A and B. Its duration is added to the full video.`;
  readiness();
}
function keyStatus(k){
  keyReady={fal:!!k.fal,kie:!!k.kie};
  $('key-status').textContent=`fal: ${k.fal?'ready for this session':'not set'}  |  KIE: ${k.kie?'ready for this session':'not set'}`;
  if(k.warning)status(k.warning,true);readiness();
}
for(const provider of ['fal','kie']){
  $(`${provider}-key`).addEventListener('input',readiness);
  $(`${provider}-key`).addEventListener('keydown',e=>{if(e.key==='Enter'&&!$('save-keys').disabled){e.preventDefault();$('save-keys').click();}});
}
async function applyKeys(){
  const keys=await window.studio.setKeys({fal:$('fal-key').value,kie:$('kie-key').value});
  $('fal-key').value='';$('kie-key').value='';keyStatus(keys);
}
$('save-keys').onclick=async()=>{
  $('save-keys').disabled=true;
  try{await applyKeys();$('key-feedback').textContent='Keys applied to your session.';}catch(e){$('key-feedback').textContent=e.message;fail(e);}finally{readiness();}
};
$('forget-keys').onclick=async()=>{
  $('forget-keys').disabled=true;
  try{const keys=await window.studio.forgetKeys();$('fal-key').value='';$('kie-key').value='';keyStatus(keys);$('key-feedback').textContent='Session keys cleared.';}catch(e){$('key-feedback').textContent=e.message;fail(e);}finally{readiness();}
};
for(const slot of ['a','b']){
  $(`pick-${slot}`).onclick=async()=>{
    if(busy||importing)return;importing=true;readiness();
    try{
      const c=await window.studio.pick();if(!c)return;clips[slot]=c;
      $(`video-${slot}`).src=c.url;
      $(`meta-${slot}`).textContent=`${c.name} | ${c.width} x ${c.height} | ${c.duration.toFixed(2)} s | ${c.fps.toFixed(6)} fps${c.fpsRational?` (${c.fpsRational})`:''}${c.audio?'':' | no audio'}`;
      const cut=$(slot==='a'?'a-end':'b-start');cut.max=c.duration;cut.value=slot==='a'?c.duration:0;
      status(clips.a&&clips.b?'Both clips ready. Choose a method and create your transition.':`Clip ${slot.toUpperCase()} ready. Choose the other clip to continue.`);
    }catch(e){fail(e);}finally{importing=false;readiness();}
  };
  $(`use-${slot}`).onclick=()=>{$(slot==='a'?'a-end':'b-start').value=$(`video-${slot}`).currentTime.toFixed(3);};
}
function setBusy(value){
  busy=value;
  document.querySelectorAll('.settings input,.settings select,.settings textarea,.settings button,.credentials input').forEach(e=>e.disabled=value);
  $('latest-result').disabled=value;$('cancel').disabled=false;$('cancel').hidden=!value;
  if($('reconnect-render'))$('reconnect-render').disabled=value;
  $('generate').textContent=value?'Creating transition...':'Create transition';readiness();
}
function showResult(){
  if(!result)return;
  const plain=$('comparison').value==='no-bridge',full=reviewMode==='full';
  $('result').pause();$('result').src=plain?(full?result.noBridgeUrl:result.noBridgePreview):(full?result.url:result.preview);
  const label=plain?'No bridge - direct cut':'With transition',duration=plain?result.noBridgeDuration:result.duration;
  $('result-info').textContent=`${label} | ${duration.toFixed(2)} seconds total | ${result.width} x ${result.height}${Number.isFinite(result.fps)?` | ${result.fps.toFixed(6)} fps (${result.fpsRational})`:''} | ${full?'Full video':'Join preview'}. Switching versions restarts playback.`;
  $('export').textContent=plain?'Export direct cut':'Export transition';
  $('preview').setAttribute('aria-pressed',String(!full));$('full').setAttribute('aria-pressed',String(full));
}
function receiveResult(r){
  $('reconnect-render')?.remove();
  result=r;reviewMode='preview';$('comparison').value='transition';$('empty').hidden=true;$('result').hidden=false;$('anchors').hidden=false;$('anchor-a').src=r.frames[0];$('anchor-b').src=r.frames[1];
  for(const id of ['preview','full','export','reveal','comparison'])$(id).disabled=false;
  showResult();$('result-status').textContent='READY TO REVIEW';
}
$('method').onchange=methodChange;
$('fps').addEventListener('input',readiness);
$('restore-prompt').onclick=()=>{$('prompt').value=defaultPrompt;};
$('clear-results').onclick=async()=>{
  if(busy||importing||!confirm('Permanently discard all single-pair renders in this session without downloading? Source uploads, API keys and batch progress are kept.'))return;
  setBusy(true);
  try{
    await window.studio.clearResults();result=null;reviewMode='preview';
    $('result').pause();$('result').removeAttribute('src');$('result').load();$('result').hidden=true;
    $('empty').hidden=false;$('anchors').hidden=true;
    for(const id of ['anchor-a','anchor-b'])$(id).removeAttribute('src');
    for(const id of ['preview','full','export','reveal','comparison'])$(id).disabled=true;
    $('result-info').textContent='';$('log').textContent='';$('reconnect-render')?.remove();
    $('result-status').textContent='RESULTS CLEARED';status('Old renders cleared. Choose a method and create another transition. Your source uploads and keys are kept.');
  }catch(e){fail(e);}finally{setBusy(false);}
};
$('latest-result').onclick=async()=>{
  setBusy(true);status('Opening your latest result and preparing its comparison...');
  try{receiveResult(await window.studio.latestResult());status('Previous result loaded. No new AI generation was requested.');}catch(e){renderFailure(e);}finally{setBusy(false);}
};
$('generate').onclick=async()=>{
  if(!clips.a||!clips.b||busy||importing)return;
  if(!$('fps').reportValidity())return;
  setBusy(true);$('log').textContent='';status('Starting...');$('result-status').textContent='PROCESSING';
  try{
    await applyKeys();
    const r=await window.studio.process({a:clips.a.id,b:clips.b.id,method:$('method').value,duration:Number($('duration').value),aEnd:Number($('a-end').value),bStart:Number($('b-start').value),fps:$('fps').value.trim(),prompt:$('prompt').value,mute:$('mute').checked});
    receiveResult(r);status('Complete. Review both joins before exporting.');
  }catch(e){renderFailure(e);}finally{setBusy(false);}
};
$('cancel').onclick=()=>{window.studio.cancel().catch(fail);$('cancel').disabled=true;status('Cancelling server processing... Cloud charges may still apply.');};
$('comparison').onchange=showResult;
$('preview').onclick=()=>{reviewMode='preview';showResult();};$('full').onclick=()=>{reviewMode='full';showResult();};
$('export').onclick=async()=>{try{const destination=await window.studio.export(result.id,$('comparison').value);if(destination)status(`Download started in ${destination}`);}catch(e){fail(e);}};
$('reveal').onclick=()=>window.studio.reveal(result.id);
window.studio.onProgress(message=>{status(message);const log=$('log');log.textContent+=`${new Date().toLocaleTimeString()}  ${message}\n`;log.scrollTop=log.scrollHeight;});
window.studio.init().then(data=>{
  methods=data.methods;
  for(const [label,filter] of [
    ['Frame interpolation',m=>m.kind==='interpolation'],
    ['Generative bridges',m=>m.provider!=='local'&&m.kind!=='interpolation'],
    ['No provider credits',m=>m.provider==='local']
  ]){
    const group=document.createElement('optgroup');group.label=label;
    for(const m of methods.filter(filter)){const option=document.createElement('option');option.value=m.id;option.textContent=m.name;group.append(option);}
    $('method').append(group);
  }
  defaultPrompt=data.prompt;$('prompt').value=defaultPrompt;keyStatus(data.keys);methodChange();
  window.dispatchEvent(new Event('studio:ready'));
  if(data.activeJob&&!data.activeBatch){
    status('Your previous render is still running. Use Reconnect to render.');offerReconnect(data.activeJob);
  }
}).catch(fail);
readiness();
window.studioUI={
  isBusy:()=>busy||importing,lock:setBusy,applyKeys,
  settings:()=>({method:$('method').value,duration:Number($('duration').value),fps:$('fps').value.trim(),prompt:$('prompt').value,mute:$('mute').checked}),
  restoreSettings:o=>{$('method').value=o.method;methodChange();for(const id of ['duration','fps','prompt'])$(id).value=o[id];$('mute').checked=o.mute;readiness();}
};
