/* Browser-owned sequential queue. No credentials or source videos are checkpointed. */
(()=>{
  const $=id=>document.getElementById(id),api=window.studio.batchAPI,ui=window.studioUI;
  const pauseStates=['uploading','submitting','running','saving'];
  const retryStates=['failed','cancelled','uncertain'];
  const terminal=['saved','buffered','failed','cancelled','invalid','skipped','uncertain'];
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let queue=null,files=new Map(),foldedFiles=new Map(),destination=null,running=false,stopAfter=false,cancelled=false,uploadController=null,page=0,downloaded=false;
  let buffered=[],db,available=false,editing=false;
  const message=(text,error=false)=>{$('batch-status').textContent=text;$('batch-status').classList.toggle('error',error);};
  const ids=['batch-csv','batch-folder','batch-input-root','batch-output-root','batch-destination','batch-output-folder','batch-validate','batch-start','batch-reset','batch-retry','batch-skip','batch-download','batch-ack','batch-unit-cost','batch-cost-unit','mode-single','mode-batch'];
  function lock(value){running=value;ui.lock(value);for(const id of ids)$(id).disabled=value;$('batch-pause').disabled=!value;$('batch-cancel').disabled=!value;render();}
  const storage=new Promise((resolve,reject)=>{
    const request=indexedDB.open('dealer-transition-batches',1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('meta');request.result.createObjectStore('rows',{keyPath:'id'});request.result.createObjectStore('outputs',{keyPath:'id'});};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  function read(store,key){return new Promise((resolve,reject)=>{const request=db.transaction(store).objectStore(store).get(key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  function all(store){return new Promise((resolve,reject)=>{const request=db.transaction(store).objectStore(store).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  const allOutputs=()=>all('outputs');
  async function readQueue(){const metadata=await read('meta','queue');return metadata?{...metadata,rows:(await all('rows')).sort((a,b)=>a.number-b.number)}:null;}
  function checkpoint({row,rows=[],allRows=false,add,remove=[],clear=false}={}){
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(['meta','rows','outputs'],'readwrite');
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Browser checkpoint could not be saved.'));
      try{
        if(queue){const {rows,...metadata}=queue;tx.objectStore('meta').put(metadata,'queue');}else tx.objectStore('meta').delete('queue');
        if(clear)tx.objectStore('rows').clear();
        for(const item of allRows?queue.rows:row?[row]:rows)tx.objectStore('rows').put(item);
        if(clear)tx.objectStore('outputs').clear();for(const id of remove)tx.objectStore('outputs').delete(id);if(add)tx.objectStore('outputs').put(add);
      }catch(e){tx.abort();reject(e);}
    });
  }
  function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),300000);}
  function report(){return BatchFormat.csv([
    ['first_half','second_half','output','row','status','error','method','bridge_seconds','fps','elapsed_seconds','provider','provider_request_id','zip_part','previous_attempts'],
    ...(queue?.rows||[]).map(r=>[r.first,r.second,r.output,r.number,r.state,r.error,queue.settings?.method,queue.settings?.duration,queue.settings?.fps,r.elapsed?.toFixed(1),r.providerJob?.provider,r.providerJob?.requestId,r.part,r.history?JSON.stringify(r.history):''].map(value=>typeof value==='string'&&/^[=+@\-\t\r]/.test(value)?"'"+value:value))
  ]);}
  function mode(batch){if(running)return;document.body.classList.toggle('batch-mode',batch);$('batch-panel').hidden=!batch;$('mode-batch').setAttribute('aria-pressed',String(batch));$('mode-single').setAttribute('aria-pressed',String(!batch));}
  $('mode-single').onclick=()=>mode(false);$('mode-batch').onclick=()=>mode(true);
  function render(){
    $('batch-csv').hidden=!!queue;
    $('batch-csv-info').textContent=queue?`Loaded: ${queue.csvName||'CSV from saved checkpoint'} (${queue.rows.length} ${queue.rows.length===1?'row':'rows'}). To replace it, use Clear batch checkpoint below.`:'';
    for(const id of ids)$(id).disabled=running||editing||(!available&&!id.startsWith('mode-'));
    $('batch-download').disabled=running||editing||!buffered.length;$('batch-ack').disabled=running||editing||!buffered.length||!downloaded;
    $('batch-start').disabled=running||editing||!available||!queue;$('batch-output-folder').disabled=running||editing||$('batch-destination').value!=='folder'||!window.showDirectoryPicker;
    for(const id of ['batch-input-root','batch-output-root'])$(id).disabled=running||editing||!!queue?.settings;
    if(!queue)return;
    const counts={};for(const r of queue.rows)counts[r.state]=(counts[r.state]||0)+1;
    const complete=(counts.saved||0)+(counts.buffered||0),pending=(counts.pending||0)+queue.rows.filter(r=>pauseStates.includes(r.state)).length;
    const times=queue.rows.filter(r=>['saved','buffered'].includes(r.state)&&r.elapsed).slice(-10).map(r=>r.elapsed),average=times.reduce((a,b)=>a+b,0)/(times.length||1);
    const method=queue.settings?.method||$('method').value,local=['blend','flow','dissolve'].includes(method),raw=$('batch-unit-cost').value,cost=Number(raw);
    const estimate=local?'0 provider credits':raw!==''&&Number.isFinite(cost)&&cost>=0?`${(cost*pending).toFixed(2)} ${$('batch-cost-unit').value} estimated remaining (${cost}/row)`:'Provider cost unknown: enter a per-row pilot estimate above.';
    const eta=times.length?`${Math.ceil(average*pending/60)} min remaining, based on last ${times.length} saved rows`:'Time estimate appears after the first saved row.';
    $('batch-metrics').textContent=`${complete} / ${queue.rows.length} outputs saved or buffered · ${counts.pending||0} pending · ${(counts.invalid||0)+(counts.failed||0)+(counts.cancelled||0)+(counts.skipped||0)} skipped/failed · ${counts.uncertain||0} need review\n${eta}\n${estimate}\n${buffered.length} files / ${(buffered.reduce((sum,x)=>sum+x.blob.size,0)/1048576).toFixed(1)} MB buffered for ZIP part ${queue.part}${queue.settings?` · Locked method: ${method}`:''}`;
    $('batch-progress').max=queue.rows.length;$('batch-progress').value=queue.rows.filter(r=>terminal.includes(r.state)).length;
    page=Math.max(0,Math.min(page,Math.ceil(queue.rows.length/50)-1));const start=page*50;
    $('batch-rows').replaceChildren();
    for(const row of queue.rows.slice(start,start+50)){
      const tr=document.createElement('tr');for(const text of [row.number,row.name||row.output,`${row.state}${row.error?' — '+row.error:''}${row.providerJob?.requestId?' · Request '+row.providerJob.requestId:''}`]){const td=document.createElement('td');td.textContent=text;tr.append(td);}$('batch-rows').append(tr);
    }
    $('batch-page').textContent=`${start+1}–${Math.min(start+50,queue.rows.length)} of ${queue.rows.length}`;
    $('batch-prev').disabled=page===0;$('batch-next').disabled=start+50>=queue.rows.length;
  }
  $('batch-prev').onclick=()=>{page--;render();};$('batch-next').onclick=()=>{page++;render();};
  function findFile(name){return files.get(name)||(/^[a-z]:|^\\\\/i.test($('batch-input-root').value)?foldedFiles.get(name.toLowerCase()):null);}
  function match(){
    if(!queue)throw new Error('Upload a CSV first.');
    const prepared=BatchFormat.prepare(queue.rows.map(r=>r.fields),$('batch-input-root').value,$('batch-output-root').value);
    for(let i=0;i<queue.rows.length;i++){
      const row=queue.rows[i];if(!['pending','invalid'].includes(row.state))continue;
      Object.assign(row,prepared[i]);
      if(row.state==='invalid')continue;
      for(const [slot,key] of [['a','signatureA'],['b','signatureB']]){
        const file=findFile(row[slot]);
        if(!file){row.state='invalid';row.error=`Missing or ambiguous source: ${row[slot]}`;break;}
        if(file.size>512*1048576){row.state='invalid';row.error=`Source exceeds 512 MB: ${row[slot]}`;break;}
        const signature=`${file.size}:${file.lastModified}`;
        if(row[key]&&row[key]!==signature){row.state='invalid';row.error=`Source changed since validation: ${row[slot]}. Restore the original or start a new CSV.`;break;}
        row[key]=signature;
      }
    }
    queue.inputRoot=$('batch-input-root').value;queue.outputRoot=$('batch-output-root').value;render();
  }
  $('batch-folder').onchange=()=>{
    files=new Map();foldedFiles=new Map();
    for(const file of $('batch-folder').files){const relative=file.webkitRelativePath.split('/').slice(1).join('/');files.set(relative,file);const key=relative.toLowerCase();foldedFiles.set(key,foldedFiles.has(key)?null:file);}
    $('batch-source-info').textContent=`${files.size} files available locally from ${$('batch-folder').files[0]?.webkitRelativePath.split('/')[0]||'selected folder'}. Only the current row's two videos upload.`;
  };
  $('batch-csv').onchange=async()=>{
    const previousQueue=queue;
    try{
      if(queue)throw new Error('Clear the existing batch checkpoint before importing a new CSV.');
      const file=$('batch-csv').files[0];if(!file)return;if(file.size>20*1048576)throw new Error('CSV limit: 20 MB.');
      const records=BatchFormat.parseCSV(await file.text());
      queue={id:crypto.randomUUID(),csvName:file.name,created:new Date().toISOString(),part:1,inputRoot:$('batch-input-root').value,outputRoot:$('batch-output-root').value,rows:BatchFormat.prepare(records,$('batch-input-root').value,$('batch-output-root').value).map((r,i)=>({...r,id:crypto.randomUUID(),fields:records[i]}))};
      if(files.size)match();await checkpoint({allRows:true});render();message('CSV loaded. Validate file matching, choose the method and destination, then start.');
    }catch(e){queue=previousQueue;message(e.message,true);}finally{$('batch-csv').value='';render();}
  };
  $('batch-validate').onclick=async()=>{try{match();await checkpoint({allRows:true});message('Validation complete. Invalid rows will be skipped; review their errors below.');}catch(e){message(e.message,true);}};
  $('batch-template').onclick=()=>download(new Blob(['first_half,second_half,output\r\n"table-01/first.mp4","table-01/second.mp4","table-01/combined.mp4"\r\n'],{type:'text/csv'}),'batch-example.csv');
  $('batch-destination').onchange=()=>{render();$('batch-destination-info').textContent=$('batch-destination').value==='folder'?(destination?`Output folder: ${destination.name}`:'Choose a dedicated empty output folder.'):'ZIPs keep relative output folders and filenames.';};
  $('batch-output-folder').onclick=async()=>{try{destination=await window.showDirectoryPicker({mode:'readwrite',id:'studio-batch-output'});$('batch-destination-info').textContent=`Output folder: ${destination.name}`;}catch(e){if(e.name!=='AbortError')message(e.message,true);}};
  for(const id of ['batch-unit-cost','batch-cost-unit'])$(id).oninput=()=>{render();};
  $('method').addEventListener('change',render);
  function checkCancelled(){if(cancelled)throw Object.assign(new Error('Cancelled by you. Submitted cloud work may still be billed.'),{cancelled:true});}
  async function release(row){await api('/api/batch/release','POST',{rowId:row.attempt});}
  async function cleanPrevious(){
    const current=await api('/api/batch');if(!current.rowId)return;
    const previous=queue.rows.find(r=>r.attempt===current.rowId);
    if(!previous)throw new Error('This session has a different batch workspace. Return to its original tab or end the server session after saving its results.');
    if(terminal.includes(previous.state)&&previous.state!=='uncertain')await release(previous);
  }
  async function poll(row,id){
    while(true){
      if(cancelled)await api('/api/batch/cancel','POST',{rowId:row.attempt});
      const job=await api(`/api/jobs/${id}`);
      if(job.providerJob&&!row.providerJob){row.providerJob=job.providerJob;await checkpoint({row});}
      message(`Row ${row.number}/${queue.rows.length}: ${job.messages.at(-1)||job.state}`);
      if(job.state!=='running')return job;
      await wait(1500);
    }
  }
  async function writeToFolder(row,response){
    if(!destination)throw new Error('Choose your output folder again to save this completed row.');
    let dir=destination;const segments=row.name.split('/'),name=segments.pop();
    for(const segment of segments)dir=await dir.getDirectoryHandle(segment,{create:true});
    try{await dir.getFileHandle(name);throw new Error(`Output already exists: ${row.name}. Move it aside before resuming. It will not be overwritten.`);}catch(e){if(e.name!=='NotFoundError')throw e;}
    const handle=await dir.getFileHandle(name,{create:true});
    try{const writable=await handle.createWritable();await response.body.pipeTo(writable);}catch(e){await dir.removeEntry(name).catch(()=>{});throw e;}
  }
  async function saveOutput(row){
    if($('batch-destination').value==='folder'){
      const response=await fetch(row.result.url);if(!response.ok)throw new Error('Completed result is no longer on the server. Check the provider request before retrying.');
      try{await writeToFolder(row,response);}finally{if(!response.body.locked)await response.body.cancel().catch(()=>{});}
      row.state='saved';row.error='';row.elapsed=(Date.now()-row.started)/1000;await checkpoint({row});
    }else{
      const head=await fetch(row.result.url,{method:'HEAD'});if(!head.ok)throw new Error('Completed result is no longer on the server.');
      const size=Number(head.headers.get('content-length'));
      if(size>512*1048576)throw new Error('This output exceeds the 512 MB ZIP-file limit. Choose folder mode in Chrome/Edge to stream it to disk.');
      if(buffered.length&&(buffered.length>=20||buffered.reduce((n,x)=>n+x.blob.size,0)+size>250*1048576))throw new Error('ZIP part is full. Download it, confirm ZIP saved, then resume this completed row.');
      const response=await fetch(row.result.url);if(!response.ok)throw new Error('Result download failed. Resume to retry saving without generating again.');
      const blob=await response.blob();if(blob.size!==size)throw new Error('Incomplete result download. Resume to download it again.');
      const item={id:row.id,name:row.name,blob};row.state='buffered';row.part=queue.part;row.error='';row.elapsed=(Date.now()-row.started)/1000;
      try{await checkpoint({row,add:item});}catch(e){row.state='saving';throw new Error(`Could not checkpoint the output (${e.message}). Free browser storage or choose folder mode, then resume.`);}
      buffered.push(item);downloaded=false;
    }
    await release(row);render();
  }
  async function processRow(row){
    if(row.state==='pending'){
      row.attempt=crypto.randomUUID();row.state='uploading';row.error='';row.started=Date.now();delete row.providerJob;delete row.result;delete row.jobId;await checkpoint({row});
    }
    let workspace=await api('/api/batch');
    if(!workspace.rowId){
      if(['submitting','running','saving'].includes(row.state)){
        row.state='uncertain';row.error='Server workspace lost. Check provider history and saved files before explicitly retrying or skipping.';await checkpoint({row});throw new Error(row.error);
      }
      await api('/api/batch/row','POST',{rowId:row.attempt});workspace={rowId:row.attempt,uploads:{}};
    }
    if(workspace.rowId!==row.attempt)throw new Error('A different row still owns the workspace. Resume it first.');
    if(row.state==='saving'){await saveOutput(row);return;}
    if(!workspace.jobId){
      for(const slot of ['a','b']){
        checkCancelled();if(workspace.uploads?.[slot])continue;
        const file=findFile(row[slot]);if(!file)throw Object.assign(new Error(`Reselect the source folder. Missing ${row[slot]}`),{pause:true});
        const signature=row[slot==='a'?'signatureA':'signatureB'];if(signature&&signature!==`${file.size}:${file.lastModified}`)throw Object.assign(new Error(`Source changed: ${row[slot]}`),{pause:true});
        message(`Row ${row.number}: uploading ${slot==='a'?'first':'second'} half (${(file.size/1048576).toFixed(1)} MB)...`);
        uploadController=new AbortController();await window.studio.batchUpload(file,row.attempt,slot,uploadController.signal);uploadController=null;
      }
      checkCancelled();row.state='submitting';await checkpoint({row});
      while(true){
        checkCancelled();
        try{const submitted=await api('/api/batch/process','POST',{...queue.settings,rowId:row.attempt});workspace.jobId=submitted.id;break;}
        catch(e){if(e.status!==429)throw e;message(`Row ${row.number}: waiting for the team's render slot...`);await wait(5000);}
      }
    }
    row.jobId=workspace.jobId;row.state='running';await checkpoint({row});render();
    const job=await poll(row,workspace.jobId);row.providerJob=job.providerJob||row.providerJob;
    if(job.state==='failed'){
      row.state=cancelled?'cancelled':'failed';row.error=job.error;await checkpoint({row});await release(row);
      if(!cancelled&&/\b(401|403|429|forbidden|unauthori[sz]ed|insufficient|credits|balance|quota|rate.?limit)\b/i.test(job.error||''))throw new Error(`Provider access/billing/rate limit needs attention: ${job.error}`);
      return;
    }
    row.state='saving';row.result=job.result;await checkpoint({row});await saveOutput(row);
  }
  async function run(){
    if(ui.isBusy())throw new Error('Wait for the current single-clip action to finish.');
    if(!queue)throw new Error('Upload a CSV first.');
    if($('batch-destination').value==='folder'&&!destination)throw new Error('Choose an output folder first.');
    if(!files.size&&queue.rows.some(r=>r.state==='pending'||r.state==='uploading'))throw new Error('Select your source folder first.');
    if(buffered.length>=20||buffered.reduce((n,x)=>n+x.blob.size,0)>=250*1048576)throw new Error('Download and confirm the current ZIP part before continuing.');
    stopAfter=false;cancelled=false;lock(true);
    try{
      await ui.applyKeys();
      if(!queue.settings){match();await checkpoint({allRows:true});}else ui.restoreSettings(queue.settings);
      const settings=queue.settings||ui.settings();
      window.StudioFrameRate.parse(settings.fps,true);
      const init=await window.studio.init(),method=init.methods.find(m=>m.id===settings.method);
      if(!method)throw new Error('The selected method is no longer available.');
      if(method.provider!=='local'&&!init.keys[method.provider])throw new Error(`Enter your ${method.provider} key above and resume.`);
      const d=settings.duration;if(!Number.isFinite(d)||d<method.min||d>method.max||(method.provider!=='local'&&method.kind!=='interpolation'&&!Number.isInteger(d)))throw new Error('Choose a transition duration within the selected method limits.');
      queue.settings=settings;
      queue.destination=$('batch-destination').value;queue.unitCost=$('batch-unit-cost').value;queue.costUnit=$('batch-cost-unit').value;await checkpoint();
      await cleanPrevious();
      if(queue.rows.some(r=>r.state==='uncertain'))throw new Error('Review interrupted rows, then explicitly retry or skip them before continuing.');
      while(!stopAfter){
        const row=queue.rows.find(r=>pauseStates.includes(r.state))||queue.rows.find(r=>r.state==='pending');if(!row)break;
        page=Math.floor((row.number-1)/50);render();
        try{await processRow(row);}catch(e){
          if(cancelled){
            await api('/api/batch/cancel','POST',{rowId:row.attempt}).catch(()=>{});
            // A lost submission response can still have created a billable job. Settle it before cleanup.
            const current=await api('/api/batch');
            if(current.jobId){const job=await poll(row,current.jobId);row.providerJob=job.providerJob||row.providerJob;}
            row.state='cancelled';row.error='Cancelled locally; submitted provider work may still incur charges.';await checkpoint({row});
            await release(row);stopAfter=true;
          }else if(e.status===400&&!['running','saving'].includes(row.state)&&!e.pause){
            row.state='failed';row.error=e.message;await checkpoint({row});await release(row);
          }else{row.error=e.message;await checkpoint({row});throw e;}
        }
        render();if(buffered.length>=20||buffered.reduce((n,x)=>n+x.blob.size,0)>=250*1048576){message('ZIP part ready. Download it and confirm ZIP saved before resuming.');return;}
      }
      message(stopAfter?'Batch paused. Saved outputs are retained; resume when ready.':`Batch finished. ${buffered.length?'Download and confirm the remaining ZIP part. ':''}Check the row report for skipped or failed items.`);
    }finally{uploadController=null;lock(false);}
  }
  $('batch-start').onclick=run;
  $('batch-pause').onclick=()=>{stopAfter=true;$('batch-pause').disabled=true;message('Will pause after saving the current row.');};
  $('batch-cancel').onclick=()=>{
    cancelled=true;stopAfter=true;uploadController?.abort();$('batch-cancel').disabled=true;
    const row=queue?.rows.find(r=>pauseStates.includes(r.state));if(row?.attempt)api('/api/batch/cancel','POST',{rowId:row.attempt}).catch(()=>{});
    message('Cancelling current work and pausing. Cloud charges may still apply.');
  };
  $('batch-download').onclick=async()=>{
    try{
      $('batch-download').disabled=true;message('Preparing ZIP part...');
      const blob=await BatchZip.create([...buffered.map(x=>({name:x.name,blob:x.blob})),{name:'batch-report.csv',blob:new Blob([report()],{type:'text/csv'})}]);
      download(blob,`transitions-${queue.id.slice(0,8)}-part-${queue.part}.zip`);downloaded=true;message('ZIP download started. Verify it finished and opens correctly, then click “ZIP saved: clear part”.');
    }catch(e){message(e.message,true);}finally{render();}
  };
  $('batch-ack').onclick=async()=>{
    if(!confirm('Have you saved and checked this ZIP? Its buffered videos will be removed from browser storage.'))return;
    try{const ids=buffered.map(x=>x.id),rows=queue.rows.filter(row=>ids.includes(row.id));for(const row of rows)row.state='saved';queue.part++;await checkpoint({rows,remove:ids});buffered=[];downloaded=false;render();message('ZIP part cleared. Resume to process remaining rows.');}catch(e){message(e.message,true);}
  };
  $('batch-report').onclick=()=>download(new Blob([report()],{type:'text/csv'}),'batch-report.csv');
  async function resolveRows(retry){
    if(!queue||running)return;
    if(!confirm(retry?'Retry failed, cancelled and uncertain rows? Check provider request IDs first: retries can incur another charge. Completed outputs are kept.':'Skip all uncertain/in-progress rows? Submitted cloud work may still be billed. Saved outputs are kept.'))return;
    try{
      const states=retry?retryStates:['uncertain',...pauseStates];
      const current=await api('/api/batch');
      if(current.rowId){const row=queue.rows.find(r=>r.attempt===current.rowId);if(row&&states.includes(row.state))await release(row);}
      for(const row of queue.rows)if(states.includes(row.state)){
        (row.history||=[]).push({state:row.state,error:row.error,providerJob:row.providerJob,jobId:row.jobId,at:new Date().toISOString()});
        row.state=retry?'pending':'skipped';row.error='';
      }
      await checkpoint({allRows:true});render();message(retry?'Selected rows reset to pending. Revalidate files and resume.':'Interrupted rows skipped. Resume the remaining queue.');
    }catch(e){message(e.message,true);}
  }
  $('batch-retry').onclick=()=>resolveRows(true);$('batch-skip').onclick=()=>resolveRows(false);
  $('batch-reset').onclick=async()=>{
    if(running||!confirm('Clear this browser’s batch checkpoint and any buffered ZIP files? Download results/report first. Files already saved to your computer are kept.'))return;
    try{
      const current=await api('/api/batch');if(current.rowId)await api('/api/batch/release','POST',{rowId:current.rowId});
      queue=null;await checkpoint({clear:true});buffered=[];downloaded=false;page=0;$('batch-rows').replaceChildren();$('batch-metrics').textContent='No CSV loaded.';$('batch-progress').value=0;$('batch-page').textContent='';render();message('Checkpoint cleared. Load another CSV.');
    }catch(e){message(e.message,true);}
  };
  // All persistent edits share one origin-wide lease. Refresh the checkpoint under
  // that lease so an idle second tab cannot resubmit rows completed in the first.
  function exclusive(handler){return async event=>{
    if(editing||running)return;editing=true;render();
    try{
      if(!navigator.locks)throw new Error('Batch processing needs a modern browser with Web Locks (HTTPS or localhost).');
      await navigator.locks.request('dealer-transition-batch',{ifAvailable:true},async lease=>{
        if(!lease)throw new Error('A batch action is running in another tab. Use that tab or pause it first.');
        const latest=await readQueue();
        if((latest?.id||null)!==(queue?.id||null))throw new Error('The batch changed in another tab. Reload this page to restore it.');
        queue=latest||null;buffered=await allOutputs();await handler(event);
      });
    }catch(e){message(`Paused: ${e.message}`,true);}finally{editing=false;render();}
  };}
  for(const id of ['batch-start','batch-validate','batch-download','batch-ack','batch-retry','batch-skip','batch-reset'])$(id).onclick=exclusive($(id).onclick);
  $('batch-csv').onchange=exclusive($('batch-csv').onchange);
  window.addEventListener('beforeunload',event=>{if(running){event.preventDefault();event.returnValue='';}});
  storage.then(async value=>{
    db=value;queue=await readQueue();buffered=await allOutputs();available=true;
    if(queue){
      $('batch-input-root').value=queue.inputRoot||'';$('batch-output-root').value=queue.outputRoot||'';$('batch-destination').value=queue.destination||'zip';$('batch-unit-cost').value=queue.unitCost||'';$('batch-cost-unit').value=queue.costUnit||'USD';
      mode(true);message('Batch checkpoint restored. Reselect folders and enter keys if needed, then resume. Existing ZIP buffers are available below.');
    }
    if(!window.showDirectoryPicker){$('batch-destination').querySelector('[value=folder]').disabled=true;$('batch-destination').value='zip';}
    render();
  }).catch(e=>{available=false;message(`Browser checkpoint storage unavailable: ${e.message}. Enable site storage to use batches.`,true);render();});
  render();
})();
