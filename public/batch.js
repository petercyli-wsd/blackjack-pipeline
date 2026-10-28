/* Browser-owned sequential queue. No credentials or source videos are checkpointed. */
(()=>{
  const $=id=>document.getElementById(id),api=window.studio.batchAPI,ui=window.studioUI;
  const pauseStates=['uploading','submitting','running','saving'];
  const retryStates=['failed','cancelled','uncertain'];
  const terminal=['saved','buffered','failed','cancelled','invalid','skipped','discarded','uncertain'];
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let queue=null,files=new Map(),foldedFiles=new Map(),destination=null,running=false,stopAfter=false,cancelled=false,uploadController=null,page=0,downloaded=false;
  let buffered=[],db,available=false,editing=false,existingFiles=new Map();
  const message=(text,error=false,notice)=>{$('batch-status').textContent=text;$('batch-status').classList.toggle('error',error);if(error||notice)window.StudioNotice.show({id:'batch',message:text,kind:error?'error':'warning',target:'batch-status'});else window.StudioNotice.dismiss('batch');};
  const ids=['batch-workflow','batch-existing-folder','batch-csv','batch-folder','batch-input-root','batch-output-root','batch-destination','batch-output-folder','batch-path-label','batch-validate','batch-start','batch-reset','batch-retry','batch-retry-reviews','batch-enable-redos','batch-repair-retries','batch-skip','batch-download','batch-ack','batch-discard','batch-unit-cost','batch-cost-unit','mode-single','mode-batch'];
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
        if(clear)tx.objectStore('outputs').clear();for(const id of remove)tx.objectStore('outputs').delete(id);for(const item of [].concat(add||[]))tx.objectStore('outputs').put(item);
      }catch(e){tx.abort();reject(e);}
    });
  }
  function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),300000);}
  const replacing=()=>$('batch-destination').value==='replace';
  function retryableReview(row){
    const review=row.result?.review,attempt=review?.attempts?.[0];
    // Only recheck untouched originals after an initial review error. A visual
    // verdict or any attempted repair needs separate inspection, not this retry.
    return queue?.workflow==='existing'&&queue.destination==='replace'&&row.state==='saved'&&
      !row.replacement&&!row.backupPath&&review?.verdict==='needs_review'&&review.pauseBatch===true&&
      review.selectedAttempt===0&&review.redoCount===0&&review.attempts?.length===1&&
      attempt.attempt===0&&attempt.source==='existing'&&attempt.assessment?.error===true;
  }
  function flaggedOriginal(row){
    const review=row.result?.review,attempt=review?.attempts?.[0];
    return row.state==='saved'&&!row.replacement&&!row.backupPath&&review?.verdict==='needs_review'&&
      review.selectedAttempt===0&&review.redoCount===0&&review.attempts?.length===1&&
      attempt.attempt===0&&attempt.source==='existing'&&!!attempt.assessment;
  }
  function canEnableRedos(){
    const review=queue?.settings?.review;
    return queue?.workflow==='existing'&&queue.destination==='replace'&&
      (review?.mode==='review'||review?.mode==='redo'&&review.maxRetries===0)&&
      queue.rows.some(row=>flaggedOriginal(row)||row.state==='pending');
  }
  function requeueReviewedRow(row){
    const next={...row,state:'pending',error:'',history:[...(row.history||[]),{state:row.state,error:row.error,providerJob:row.providerJob,providerJobs:row.providerJobs,jobId:row.jobId,review:row.result.review,fileAction:row.fileAction,at:new Date().toISOString()}]};
    for(const key of ['result','providerJob','providerJobs','jobId','savedName','fileAction','elapsed','started','attempt'])delete next[key];
    return next;
  }
  function reviewFailure(review){
    const last=review.attempts?.at(-1);
    return last?.generationError||(last?.assessment?.error&&last.assessment.summary)||review.summary||'Review service or redo failed.';
  }
  function reviewDescription(review){
    const assessment=review.attempts?.find(a=>a.attempt===(review.selectedAttempt??0))?.assessment;
    if(assessment?.error)return `Review error (not a visual verdict): ${review.summary}`;
    // New summaries explain the asymmetric policy. Older saved results retain
    // their original 85% gate; never reclassify a stored uncertain verdict.
    const legacy=!review.decisionPolicy;
    const low=legacy&&review.verdict!=='pass'&&Number.isFinite(assessment?.confidence)&&assessment.confidence<.85;
    const reason=low?`Confidence ${Math.floor(assessment.confidence*10000)/100}% is below the 85% threshold; manual review required.`:'';
    const summary=reason&&!review.summary?.startsWith(reason)?`${reason} ${review.summary}`:review.summary;
    return `${review.verdict==='pass'?'Approved':'Needs review'}${low?' (earlier 85% policy)':''}: ${summary}`;
  }
  const resolveRow=row=>BatchSettings.resolve(row,queue?.settings||ui.settings(),ui.methods());
  function previewSettings(row){try{return resolveRow(row);}catch{return null;}}
  function report(){return BatchFormat.csv([
    ['first_half','second_half','output','row','status','error','method','duration','setting_source','method_source','duration_source','bridge_seconds','actual_bridge_seconds','bridge_frames','fps','encoded_fps','elapsed_seconds','provider','provider_request_id','zip_part','previous_attempts','saved_path','quality_verdict','quality_summary','redo_count','quality_details','all_provider_requests','file_action','original_backup','human_review','human_redos'],
    ...(queue?.rows||[]).map(r=>{const s=previewSettings(r);return [r.first,r.second,r.output,r.number,r.state,r.error,s?.method||r.csvMethod,s?.duration??r.csvDuration,s?.settingSource,s?.methodSource,s?.durationSource,s?.duration,r.result?.bridgeDuration,r.result?.bridgeFrames,(queue.settings||ui.settings()).fps,r.result?.fpsRational,r.elapsed?.toFixed(1),r.providerJob?.provider,r.providerJob?.requestId,r.part,r.history?JSON.stringify(r.history):'',r.savedName,r.result?.review?.verdict,r.result?.review?.summary,r.result?.review?.redoCount,r.result?.review?JSON.stringify(r.result.review):'',r.providerJobs?JSON.stringify(r.providerJobs):'',r.fileAction,r.backupPath,r.humanReview?.verdict||r.humanDecision&&`${r.humanDecision} (not applied)`||'',r.humanRedos||''].map(value=>typeof value==='string'&&/^[=+@\-\t\r]/.test(value)?"'"+value:value);})
  ]);}
  function mode(batch){if(running)return;document.body.classList.toggle('batch-mode',batch);$('batch-panel').hidden=!batch;$('mode-batch').setAttribute('aria-pressed',String(batch));$('mode-single').setAttribute('aria-pressed',String(!batch));render();}
  $('mode-single').onclick=()=>mode(false);$('mode-batch').onclick=()=>mode(true);
  function renderDestination(){
    const folder=$('batch-destination').value!=='zip',name=destination?.name||queue?.destinationName;
    $('batch-path-label-wrap').hidden=!folder;
    $('batch-path-label').disabled=running||editing||!destination;
    $('batch-output-folder').textContent=replacing()?(destination?'Change original folder':name?'Reselect original folder':'Choose original output folder'):destination?'Change folder':name?'Reselect output folder':'Choose output folder';
    $('batch-destination-label').textContent=folder?(destination?'Selected output folder':name?'Reselect this folder to resume':'Output folder not selected'):'Download destination';
    $('batch-destination-info').textContent=folder?(name||'Choose a folder on your computer'):'ZIP parts';
    const label=$('batch-path-label').value.trim();
    if(replacing())$('batch-destination-label').textContent=destination?'Original folder: approved repairs replace these files':'Original folder required';
    $('batch-destination-detail').textContent=!folder?'ZIPs keep the CSV output folders and filenames.':destination?(label?`Path label (provided by you): ${label}`:'On your computer. The browser does not share the full path.')+(replacing()?' Originals backed up under _bridge-backups/.':queue?.settings?.review?.mode&&queue.settings.review.mode!=='off'?' Results go into approved/ or needs-review/.':''):name?'Browser access needs to be granted again after a refresh. Choose the intended output folder before resuming.':'Each completed video will be saved here automatically.';
  }
  function render(){
    window.BatchReview?.render();
    const isExisting=$('batch-workflow').value==='existing';
    $('batch-existing-wrap').hidden=!isExisting;
    $('batch-existing-picker').hidden=replacing();$('batch-existing-info').hidden=replacing();
    $('batch-replace-source').hidden=!replacing();$('batch-copy-help').hidden=replacing();$('batch-replace-help').hidden=!replacing();
    $('batch-destination').querySelector('[value=replace]').disabled=!isExisting||!window.showDirectoryPicker||!!(queue?.settings&&queue.destination!=='replace');
    $('batch-csv').hidden=!!queue;
    $('batch-csv-info').textContent=queue?`Loaded: ${queue.csvName||'CSV from saved checkpoint'} (${queue.rows.length} ${queue.rows.length===1?'row':'rows'}).`:'';
    $('batch-reset').hidden=!queue;
    for(const id of ids)$(id).disabled=running||editing||(!available&&!id.startsWith('mode-'));
    $('batch-download').disabled=running||editing||!buffered.length;$('batch-ack').disabled=running||editing||!buffered.length||!downloaded;
    $('batch-start').disabled=running||editing||!available||!queue;$('batch-output-folder').disabled=running||editing||$('batch-destination').value==='zip'||!window.showDirectoryPicker;
    for(const id of ['batch-input-root','batch-output-root'])$(id).disabled=running||editing||!!queue?.settings;
    $('batch-workflow').disabled=running||editing||!!queue?.settings;
    $('batch-destination').disabled=running||editing||!!(queue?.settings&&queue.destination==='replace');
    $('batch-task-lock').hidden=!queue?.settings;
    const unfinished=queue?.rows.filter(r=>!terminal.includes(r.state)).length||0;
    $('batch-task-lock-copy').textContent=queue?.settings?`${running?'Pause after the current row before changing tasks.':'This task and its settings belong to the current batch.'} To choose another task, discard this batch: ${queue.rows.length} CSV row${queue.rows.length===1?'':'s'} (${unfinished} unfinished) and ${buffered.length} buffered video${buffered.length===1?'':'s'}. Files already saved on your computer are kept. You will need to load a CSV again.`:'';
    $('batch-change-task').textContent=running?(stopAfter?'Pausing after this row...':'Pause to change task'):'Discard batch & change task';
    $('batch-change-task').disabled=running?stopAfter||cancelled:editing||!queue;
    $('batch-pause').hidden=!running;$('batch-cancel').hidden=!running;
    $('batch-zip-actions').hidden=!buffered.length;
    $('batch-discard').disabled=running||editing||!buffered.length;
    $('batch-output-folder').hidden=$('batch-destination').value==='zip';
    renderDestination();
    $('batch-retry').disabled=running||editing||!queue?.rows.some(r=>retryStates.includes(r.state));
    const failedReviews=queue?.rows.filter(retryableReview).length||0;
    $('batch-review-recovery').hidden=!failedReviews;
    $('batch-retry-reviews').disabled=running||editing||!failedReviews;
    $('batch-review-recovery-help').textContent=failedReviews?`${failedReviews} original video${failedReviews===1?' has':'s have'} not been reviewed because the review service failed. Fix the reported error, then choose Retry failed reviews and Start / resume batch. This keeps your CSV and completed reviews. Originals stay unchanged unless a later repair passes review.`:'';
    const enableRedos=canEnableRedos(),unsettled=queue?.rows.some(r=>[...pauseStates,'uncertain'].includes(r.state));
    $('batch-enable-repairs').hidden=!enableRedos;
    $('batch-enable-redos').disabled=running||editing||!enableRedos||unsettled;
    $('batch-enable-repairs-help').textContent=enableRedos?`${running?'Pause after this row first. ':unsettled?'Resolve interrupted work before switching. ':''}Enable automatic redos for this batch: recheck ${queue.rows.filter(flaggedOriginal).length} flagged original(s) and continue ${queue.rows.filter(r=>r.state==='pending').length} pending row(s). Approved rows stay completed. New reviews and any redos use credits; your CSV and prior reports are kept.`:'';
    $('batch-skip').disabled=running||editing||!queue?.rows.some(r=>['uncertain',...pauseStates].includes(r.state));
    for(const id of ['batch-report','batch-reset'])$(id).disabled=running||editing||!queue;
    const settings=queue?.settings||ui.settings(),methods=ui.methods();
    const groups=BatchSettings.groups(queue?.rows||[],settings,methods);
    ui.setBatchContext({active:document.body.classList.contains('batch-mode'),hasGenerative:groups.some(g=>{const m=methods.find(m=>m.id===g.method);return m.provider!=='local'&&m.kind!=='interpolation';})});
    $('batch-settings-summary').textContent=queue?`${queue.settings?'Frozen at first start':'Resolved settings (validate after changing defaults)'}: ${groups.slice(0,8).map(g=>`${g.rows} × ${g.method}, ${g.duration}s`).join('; ')||'No valid settings'}${groups.length>8?`; and ${groups.length-8} more groups (see row table/report)`:''}. Quality review: ${settings.review?.mode||'off'}${settings.review?.mode==='redo'?`, max ${settings.review.maxRetries} redos`:''}; appearance: ${settings.review?.appearance||'strict'}. FPS, movement instructions and mute are shared; movement instructions apply to generative rows.`:'';
    $('batch-csv-warning').textContent=(queue?.warnings||[]).join(' ');
    if(!queue){$('batch-estimate').textContent='Load a CSV to see estimated time and provider cost before starting.';$('batch-estimate-basis').textContent='';return;}
    const counts={};for(const r of queue.rows)counts[r.state]=(counts[r.state]||0)+1;
    const complete=(counts.saved||0)+(counts.buffered||0);
    const remainingRows=queue.rows.filter(r=>!['saved','buffered','skipped','discarded','invalid'].includes(r.state));
    const pendingGroups=BatchSettings.groups(remainingRows,settings,methods),remaining=pendingGroups.reduce((n,g)=>n+g.rows,0);
    const samples=queue.rows.filter(r=>['saved','buffered','discarded'].includes(r.state)).map(r=>({...previewSettings(r),elapsed:r.elapsed}));
    const mixed=groups.length>1;
    for(const id of ['batch-unit-cost','batch-cost-unit'])$(id).disabled=running||editing||mixed||!!(settings.review&&settings.review.mode!=='off');
    const estimate=window.BatchEstimates.aggregate(pendingGroups,{unitCost:mixed?'':$('batch-unit-cost').value,unit:$('batch-cost-unit').value,samples,review:settings.review,workflow:queue.workflow||$('batch-workflow').value});
    if(groups.length){
      const time=seconds=>seconds<3600?`${Math.ceil(seconds/60)} min`:`${(seconds/3600).toFixed(1)} hr`;
      const cost=value=>estimate.unit==='USD'?`$${value.toFixed(2)}`:`${value.toFixed(2)} ${estimate.unit}`;
      const description=groups.length===1?`${groups[0].method}, ${groups[0].duration}s bridge`:'Mixed methods / durations';
      $('batch-estimate').textContent=`${queue.settings?'Locked batch':'Selected'}: ${description}. For ${remaining} unfinished rows with valid settings:\nApproximately ${time(estimate.time[0])} to ${time(estimate.time[1])}; provider cost ${cost(estimate.cost[0])} to ${cost(estimate.cost[1])}.\n${estimate.parts.slice(0,8).map(p=>`${p.rows} × ${p.method}, ${p.duration}s: ${time(p.time[0])}–${time(p.time[1])}, ${cost(p.cost[0])}–${cost(p.cost[1])}`).join('\n')}${estimate.parts.length>8?`\nPlus ${estimate.parts.length-8} more groups, included in totals.`:''}\n${estimate.measured?'Time uses recent completions of the same method and duration where available.':'Speculative time range available before starting.'} Planning estimates, not a quote or spending cap; actual totals can fall outside these ranges.`;
      $('batch-estimate-basis').textContent=[...new Set(estimate.parts.map(p=>p.basis))].join(' ')+' '+(mixed?'A single per-row cost override is disabled for mixed settings; each group uses its own automatic range. ':'')+'Invalid/skipped rows and past charges are excluded. Failed rows assume one retry. Excludes retries beyond the selected limit, taxes and hosting charges. Time assumes continuous running; ZIP confirmations and sleep add delays.';
    }else{$('batch-estimate').textContent='Choose a valid method and duration to see estimates.';$('batch-estimate-basis').textContent='';}
    $('batch-metrics').textContent=`${complete} / ${queue.rows.length} outputs saved or buffered | ${counts.pending||0} pending | ${(counts.invalid||0)+(counts.failed||0)+(counts.cancelled||0)+(counts.skipped||0)} skipped/failed | ${counts.discarded||0} discarded | ${counts.uncertain||0} need review\n${buffered.length} files / ${(buffered.reduce((sum,x)=>sum+x.blob.size,0)/1048576).toFixed(1)} MB buffered for ZIP part ${queue.part}`;
    if(replacing())$('batch-metrics').textContent=`${complete} / ${queue.rows.length} outputs reviewed | ${counts.pending||0} pending | ${(counts.failed||0)+(counts.invalid||0)} failed/invalid | ${queue.rows.filter(r=>r.fileAction?.startsWith('replaced')).length} replaced | ${queue.rows.filter(r=>r.fileAction?.startsWith('original kept')).length} originals kept for manual review`;
    const reviewed=queue.rows.filter(r=>r.result?.review),reviewErrors=reviewed.filter(r=>r.result.review.attempts?.some(a=>a.assessment?.error||a.generationError));
    if(reviewed.length)$('batch-metrics').textContent+=`\nAI review: ${reviewed.filter(r=>r.result.review.verdict==='pass').length} approved | ${reviewed.filter(r=>r.result.review.verdict!=='pass'&&!reviewErrors.includes(r)).length} need human review | ${reviewErrors.length} review/redo errors | ${reviewed.reduce((n,r)=>n+r.result.review.redoCount,0)} redos`;
    $('batch-progress').max=queue.rows.length;$('batch-progress').value=queue.rows.filter(r=>terminal.includes(r.state)).length;
    page=Math.max(0,Math.min(page,Math.ceil(queue.rows.length/50)-1));const start=page*50;
    $('batch-rows').replaceChildren();
    for(const row of queue.rows.slice(start,start+50)){
      const s=previewSettings(row);
      const tr=document.createElement('tr');for(const text of [row.number,row.savedName||row.name||row.output,s?`${s.method} · ${s.duration}s (${s.settingSource})`:'Invalid settings',`${row.fileAction||row.state}${row.humanReview?' · Approved by you':row.humanRedos?` · Redo ${row.humanRedos} requested by you`:''}${row.result?.review?' · '+reviewDescription(row.result.review):''}${row.error?' — '+row.error:''}${row.providerJob?.requestId?' · Request '+row.providerJob.requestId:''}`]){const td=document.createElement('td');td.textContent=text;tr.append(td);}$('batch-rows').append(tr);
    }
    $('batch-page').textContent=`${start+1}–${Math.min(start+50,queue.rows.length)} of ${queue.rows.length}`;
    $('batch-prev').disabled=page===0;$('batch-next').disabled=start+50>=queue.rows.length;
  }
  $('batch-prev').onclick=()=>{page--;render();};$('batch-next').onclick=()=>{page++;render();};
  function findFile(name){return files.get(name)||(/^[a-z]:|^\\\\/i.test($('batch-input-root').value)?foldedFiles.get(name.toLowerCase()):null);}
  async function refreshExisting(){
    if(!replacing()||!destination||!queue)return;
    existingFiles=new Map();
    for(const row of queue.rows){
      if(!['pending','invalid','uploading'].includes(row.state))continue;
      try{
        const name=BatchFormat.outputPath(row.output,$('batch-output-root').value);
        if(name.split('/')[0].toLowerCase()==='_bridge-backups')continue;
        existingFiles.set(name,await (await BatchReplace.handle(destination,name)).getFile());
      }catch(e){if(!['NotFoundError','TypeMismatchError'].includes(e.name)&&!/Output/.test(e.message))throw e;}
    }
  }
  async function match(){
    if(!queue)throw new Error('Upload a CSV first.');
    await refreshExisting();
    const prepared=BatchFormat.prepare(queue.rows.map(r=>r.fields),$('batch-input-root').value,$('batch-output-root').value,queue.columns);
    for(let i=0;i<queue.rows.length;i++){
      const row=queue.rows[i];if(!['pending','invalid'].includes(row.state))continue;
      Object.assign(row,prepared[i]);
      if(row.state==='invalid')continue;
      try{resolveRow(row);}catch(e){row.state='invalid';row.error=e.message;continue;}
      for(const [slot,key] of [['a','signatureA'],['b','signatureB']]){
        const file=findFile(row[slot]);
        if(!file){row.state='invalid';row.error=`Missing or ambiguous source: ${row[slot]}`;break;}
        if(file.size>512*1048576){row.state='invalid';row.error=`Source exceeds 512 MB: ${row[slot]}`;break;}
        const signature=`${file.size}:${file.lastModified}`;
        if(row[key]&&row[key]!==signature){row.state='invalid';row.error=`Source changed since validation: ${row[slot]}. Restore the original or start a new CSV.`;break;}
        row[key]=signature;
      }
      if($('batch-workflow').value==='existing'){
        const file=existingFiles.get(row.name);
        if(!file){row.state='invalid';row.error=`Missing existing output: ${row.name}. Choose the folder matching the CSV output paths.`;}
        else if(file.size>512*1048576){row.state='invalid';row.error=`Existing output exceeds 512 MB: ${row.name}`;}
        else {const signature=`${file.size}:${file.lastModified}`;if(row.signatureCandidate&&row.signatureCandidate!==signature){row.state='invalid';row.error='Existing output changed since validation. Start a new CSV review.';}else row.signatureCandidate=signature;}
      }
    }
    queue.inputRoot=$('batch-input-root').value;queue.outputRoot=$('batch-output-root').value;render();
  }
  $('batch-folder').onchange=()=>{
    files=new Map();foldedFiles=new Map();
    for(const file of $('batch-folder').files){const relative=file.webkitRelativePath.split('/').slice(1).join('/');files.set(relative,file);const key=relative.toLowerCase();foldedFiles.set(key,foldedFiles.has(key)?null:file);}
    $('batch-source-info').textContent=`${files.size} files available locally from ${$('batch-folder').files[0]?.webkitRelativePath.split('/')[0]||'selected folder'}. Only files needed by the current row upload.`;
  };
  $('batch-existing-folder').onchange=()=>{existingFiles=new Map();for(const file of $('batch-existing-folder').files){const name=file.webkitRelativePath.split('/').slice(1).join('/');existingFiles.set(name,existingFiles.has(name)?null:file);}$('batch-existing-info').textContent=`${existingFiles.size} existing files selected. CSV output paths must match relative to this folder. Original files are kept; reviewed copies go to a new destination.`;};
  $('batch-workflow').onchange=()=>{if($('batch-workflow').value!=='existing'&&replacing())$('batch-destination').value='zip';if($('batch-workflow').value==='existing'&&$('quality-mode').value==='off')$('quality-mode').value='redo';render();};
  $('batch-csv').onchange=async()=>{
    const previousQueue=queue;
    try{
      if(queue)throw new Error('Use Clear CSV beside the loaded filename before importing a new CSV.');
      const file=$('batch-csv').files[0];if(!file)return;if(file.size>20*1048576)throw new Error('CSV limit: 20 MB.');
      const records=BatchFormat.parseCSV(await file.text());
      queue={id:crypto.randomUUID(),csvName:file.name,columns:records.columns,warnings:records.warnings,created:new Date().toISOString(),part:1,inputRoot:$('batch-input-root').value,outputRoot:$('batch-output-root').value,rows:BatchFormat.prepare(records,$('batch-input-root').value,$('batch-output-root').value).map((r,i)=>({...r,id:crypto.randomUUID(),fields:records[i]}))};
      if(files.size)await match();await checkpoint({allRows:true});render();message('CSV loaded. Validate file matching, choose the method and destination, then start.'+(queue.warnings?.length?' '+queue.warnings.join(' '):''),false,!!queue.warnings?.length);
    }catch(e){queue=previousQueue;message(e.message,true);}finally{$('batch-csv').value='';render();}
  };
  $('batch-validate').onclick=async()=>{try{await match();await checkpoint({allRows:true});const invalid=queue.rows.filter(r=>r.state==='invalid').length;message(`Validation complete: ${queue.rows.filter(r=>r.state==='pending').length} ready, ${invalid} invalid. Invalid rows will be skipped; review their errors below.`,false,invalid>0);}catch(e){message(e.message,true);}};
  $('batch-template').onclick=()=>download(new Blob(['first_half,second_half,output,method,duration\r\ntable-01/first.mp4,table-01/second.mp4,film.mp4,film,0.33\r\ntable-02/first.mp4,table-02/second.mp4,kling.mp4,kling-fal,3\r\ntable-03/first.mp4,table-03/second.mp4,panel.mp4,,\r\n'],{type:'text/csv'}),'batch-example.csv');
  $('batch-destination').onchange=()=>{existingFiles=new Map();$('batch-existing-folder').value='';$('batch-existing-info').textContent='Reselect your existing output folder when using copy mode.';render();};
  $('batch-path-label').oninput=renderDestination;
  $('batch-output-folder').onclick=async()=>{try{const picked=await window.showDirectoryPicker({mode:'readwrite',id:'studio-batch-output',...(destination?{startIn:destination}:{})});destination=picked;$('batch-path-label').value='';renderDestination();}catch(e){if(e.name!=='AbortError')message(e.message,true);}};
  for(const id of ['batch-unit-cost','batch-cost-unit'])$(id).oninput=()=>{render();};
  $('method').addEventListener('change',render);
  function restoreBatchSettings(){if(queue?.settings&&ui.methods().length)ui.restoreSettings(queue.settings);render();}
  window.addEventListener('studio:ready',restoreBatchSettings);
  for(const id of ['duration','fps'])$(id).addEventListener('input',render);
  for(const id of ['quality-mode','quality-retries','quality-appearance'])$(id).addEventListener('change',render);
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
      if(job.providerJobs&&job.providerJobs.length!==(row.providerJobs?.length||0)){row.providerJobs=job.providerJobs;await checkpoint({row});}
      if(job.providerJob&&!row.providerJob){row.providerJob=job.providerJob;await checkpoint({row});}
      message(`Row ${row.number}/${queue.rows.length}: ${job.messages.at(-1)||job.state}`);
      if(job.state!=='running')return job;
      await wait(1500);
    }
  }
  async function writeToFolder(row,response){
    if(!destination)throw new Error('Choose your output folder again to save this completed row.');
    let dir=destination;const segments=(row.savedName||row.name).split('/'),name=segments.pop();
    for(const segment of segments)dir=await dir.getDirectoryHandle(segment,{create:true});
    try{await dir.getFileHandle(name);throw new Error(`Output already exists: ${row.name}. Move it aside before resuming. It will not be overwritten.`);}catch(e){if(e.name!=='NotFoundError')throw e;}
    const handle=await dir.getFileHandle(name,{create:true});
    try{const writable=await handle.createWritable();await response.body.pipeTo(writable);}catch(e){await dir.removeEntry(name).catch(()=>{});throw e;}
  }
  async function saveOutput(row){
    if(replacing()){
      if(!destination)throw new Error('Reselect the original output folder before saving.');
      await BatchReplace.bind(destination,queue,()=>checkpoint());
      const review=row.result.review;
      if(!review)throw new Error('A review assessment is required for in-place repair.');
      if(review.verdict==='pass'&&Number.isInteger(review.selectedAttempt)&&review.selectedAttempt>0){
        row.backupPath=await BatchReplace.replace(destination,queue,row,{fetchResult:()=>fetch(row.result.url),save:()=>checkpoint({row}),check:checkCancelled});
        row.fileAction='replaced: approved repair';
      }else{
        await BatchReplace.capture(destination,row,()=>checkpoint({row}));
        row.fileAction=review.verdict==='pass'?'unchanged: passed review':'original kept: needs review';
      }
      row.savedName=row.name;row.state='saved';row.error='';row.elapsed=(Date.now()-row.started)/1000;
      try{await checkpoint({row});}catch(e){row.state='saving';throw e;}
      await release(row);render();
      if(review.pauseBatch)throw new Error(`Original kept. ${reviewFailure(review)} ${retryableReview(row)?'After fixing this error, choose Retry failed reviews, then Start / resume batch.':'Check the row report and provider requests before resuming.'}`);
      return;
    }
    row.savedName=row.result.review?`${row.result.review.verdict==='pass'?'approved':'needs-review'}/${row.name}`:row.name;
    if($('batch-destination').value==='folder'){
      const response=await fetch(row.result.url);if(!response.ok)throw new Error('Completed result is no longer on the server. Check the provider request before retrying.');
      try{await writeToFolder(row,response);}finally{if(!response.body.locked)await response.body.cancel().catch(()=>{});}
      row.state='saved';row.error='';row.elapsed=(Date.now()-row.started)/1000;await checkpoint({row});
    }else{
      const head=await fetch(row.result.url,{method:'HEAD'});if(!head.ok)throw new Error('Completed result is no longer on the server.');
      const size=Number(head.headers.get('content-length'));
      if(size>512*1048576)throw new Error('This output exceeds the 512 MB ZIP-file limit. Choose folder mode in Chrome/Edge to stream it to disk.');
      if(buffered.length&&(buffered.length>=20||buffered.reduce((n,x)=>n+x.blob.size,0)+size>250*1048576))throw new Error('ZIP part is full. Download it and confirm ZIP saved, or discard buffered outputs, then resume this completed row.');
      const response=await fetch(row.result.url);if(!response.ok)throw new Error('Result download failed. Resume to retry saving without generating again.');
      const blob=await response.blob();if(blob.size!==size)throw new Error('Incomplete result download. Resume to download it again.');
      const item={id:row.id,name:row.savedName,blob};row.state='buffered';row.part=queue.part;row.error='';row.elapsed=(Date.now()-row.started)/1000;
      try{await checkpoint({row,add:item});}catch(e){row.state='saving';throw new Error(`Could not checkpoint the output (${e.message}). Free browser storage or choose folder mode, then resume.`);}
      buffered.push(item);downloaded=false;
    }
    await release(row);render();
    if(row.result.review?.pauseBatch)throw new Error(`Result saved under needs-review. ${reviewFailure(row.result.review)} Check the row report and provider requests before resuming. No automatic resubmission was made.`);
  }
  async function processRow(row){
    if(row.state==='pending'){
      row.attempt=crypto.randomUUID();row.state='uploading';row.error='';row.started=Date.now();delete row.providerJob;delete row.providerJobs;delete row.result;delete row.savedName;delete row.jobId;delete row.replacement;delete row.backupPath;delete row.fileAction;await checkpoint({row});
    }
    if(replacing()&&row.state==='saving'){await saveOutput(row);return;}
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
      for(const slot of queue.workflow==='existing'?['a','b','candidate']:['a','b']){
        checkCancelled();if(workspace.uploads?.[slot])continue;
        let file=slot==='candidate'?existingFiles.get(row.name):findFile(row[slot]);if(!file)throw Object.assign(new Error(`Reselect the ${slot==='candidate'?'existing output':'source'} folder. Missing ${slot==='candidate'?row.name:row[slot]}`),{pause:true});
        const signature=row[slot==='candidate'?'signatureCandidate':slot==='a'?'signatureA':'signatureB'];if(signature&&signature!==`${file.size}:${file.lastModified}`)throw Object.assign(new Error(`File changed: ${slot==='candidate'?row.name:row[slot]}`),{pause:true});
        if(slot==='candidate'&&replacing())file=await BatchReplace.capture(destination,row,()=>checkpoint({row}));
        message(`Row ${row.number}: uploading ${slot==='candidate'?'existing output':slot==='a'?'first half':'second half'} (${(file.size/1048576).toFixed(1)} MB)...`);
        uploadController=new AbortController();await window.studio.batchUpload(file,row.attempt,slot,uploadController.signal);uploadController=null;
      }
      checkCancelled();row.state='submitting';await checkpoint({row});
      while(true){
        checkCancelled();
        try{const s=resolveRow(row);const submitted=await api('/api/batch/process','POST',{...queue.settings,method:s.method,duration:s.duration,rowId:row.attempt,workflow:queue.workflow||'generate'});workspace.jobId=submitted.id;break;}
        catch(e){if(e.status!==429)throw e;message(`Row ${row.number}: waiting for the team's render slot...`);await wait(5000);}
      }
    }
    row.jobId=workspace.jobId;row.state='running';await checkpoint({row});render();
    const job=await poll(row,workspace.jobId);row.providerJob=job.providerJob||row.providerJob;row.providerJobs=job.providerJobs||row.providerJobs;
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
    if($('batch-destination').value!=='zip'&&!destination)throw new Error('Choose an output folder first.');
    if(replacing()){
      if((queue.workflow||$('batch-workflow').value)!=='existing')throw new Error('Repair original folder requires the existing-output review task.');
      if(queue.settings&&queue.destination!=='replace')throw new Error('Start a new CSV review to enable in-place repairs.');
      if(queue.replacementBound)await BatchReplace.bind(destination,queue,()=>checkpoint());
      await refreshExisting();
    }
    if(!files.size&&queue.rows.some(r=>r.state==='pending'||r.state==='uploading'))throw new Error('Select your source folder first.');
    if(!replacing()&&(queue.workflow||$('batch-workflow').value)==='existing'&&!existingFiles.size&&queue.rows.some(r=>['pending','invalid','uploading'].includes(r.state)))throw new Error('Select the existing output folder first.');
    if(buffered.length>=20||buffered.reduce((n,x)=>n+x.blob.size,0)>=250*1048576)throw new Error('Save and confirm the current ZIP part, or choose Discard buffered outputs, before continuing.');
    stopAfter=false;cancelled=false;lock(true);
    try{
      await ui.applyKeys();
      if(!queue.settings){await match();await checkpoint({allRows:true});}else ui.restoreSettings(queue.settings);
      const settings=queue.settings||ui.settings();
      window.StudioFrameRate.parse(settings.fps,true);
      const init=await window.studio.init();
      const needed=queue.rows.filter(r=>['pending',...pauseStates].includes(r.state));
      // Resolve every runnable row before any upload or checkpoint freeze.
      for(const row of needed)BatchSettings.resolve(row,settings,init.methods);
      const workflow=queue.workflow||$('batch-workflow').value;
      if(workflow==='existing'&&(!settings.review||settings.review.mode==='off'))throw new Error('Enable AI review for an existing output folder.');
      if(settings.review?.mode!=='off'&&settings.review&&!init.keys.fal)throw new Error('Quality review needs your fal key. No videos were uploaded.');
      if(settings.review?.mode!=='off'&&settings.review&&needed.some(r=>resolveRow(r).method==='dissolve'))throw new Error('Quality review supports inserted bridges, not overlapping dissolves. Split dissolve rows into a separate CSV or disable review.');
      const missing=workflow==='existing'&&settings.review.mode==='review'?[]:BatchSettings.missingKeys(needed,settings,init.methods,init.keys);
      if(missing.length)throw new Error(`Missing provider keys — ${missing.join('; ')}. Enter these keys above, then resume. No videos were uploaded.`);
      if(replacing()&&!queue.replacementBound){
        if(!confirm(`Review ${needed.length} outputs in "${destination.name}"? Only approved repairs will replace the same filenames. Originals will be backed up in _bridge-backups/${queue.id}/originals/. Clear or uncertain outputs stay unchanged. Reviews and redos use provider credits. Keep this tab open, online and awake.`))return;
        await BatchReplace.bind(destination,queue,()=>checkpoint());
      }
      for(const row of queue.rows)if(!row.resolvedSettings){try{row.resolvedSettings=BatchSettings.resolve(row,settings,init.methods);}catch{/* Invalid rows remain skipped, with the original validation error. */}}
      queue.settings=settings;
      queue.workflow=workflow;
      queue.destination=$('batch-destination').value;queue.destinationName=destination?.name||queue.destinationName;queue.destinationPathLabel=$('batch-path-label').value.trim();queue.unitCost=$('batch-unit-cost').value;queue.costUnit=$('batch-cost-unit').value;await checkpoint({allRows:true});
      await cleanPrevious();
      if(queue.rows.some(r=>r.state==='uncertain'))throw new Error('Review interrupted rows, then explicitly retry or skip them before continuing.');
      while(!stopAfter){
        const row=queue.rows.find(r=>pauseStates.includes(r.state))||queue.rows.find(r=>r.state==='pending');if(!row)break;
        page=Math.floor((row.number-1)/50);render();
        try{await processRow(row);}catch(e){
          if(cancelled&&replacing()&&row.state==='saving'){
            row.error='Saving paused. Resume to finish saving this reviewed repair without regenerating.';await checkpoint({row});stopAfter=true;
          }else if(cancelled){
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
        render();if(buffered.length>=20||buffered.reduce((n,x)=>n+x.blob.size,0)>=250*1048576){message('ZIP part ready. Download it and confirm ZIP saved, or discard buffered outputs before resuming. Choose folder mode for continuous saving.',false,true);return;}
      }
      message(stopAfter?'Batch paused. Saved outputs are retained; resume when ready.':`Batch finished. ${buffered.length?'Download and confirm the remaining ZIP part. ':''}Check the row report for skipped or failed items.`,false,stopAfter||buffered.length>0||queue.rows.some(r=>['failed','invalid','uncertain'].includes(r.state)||r.result?.review?.verdict==='needs_review'));
    }finally{uploadController=null;lock(false);}
  }
  $('batch-start').onclick=run;
  $('batch-pause').onclick=()=>{stopAfter=true;$('batch-pause').disabled=true;render();message('Will pause after saving the current row.');};
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
  async function clearBuffered(state){
    const previous=queue;
    try{
      const ids=buffered.map(x=>x.id),rows=queue.rows.filter(r=>ids.includes(r.id)).map(r=>({...r,state,error:state==='discarded'?'Output deliberately discarded without downloading.':''}));
      const changed=new Map(rows.map(r=>[r.id,r]));queue={...queue,part:queue.part+1,rows:queue.rows.map(r=>changed.get(r.id)||r)};
      await checkpoint({rows,remove:ids});buffered=[];downloaded=false;
    }catch(e){queue=previous;throw e;}
  }
  $('batch-discard').onclick=async()=>{
    if(!buffered.length||!confirm(`Permanently discard these ${buffered.length} buffered videos without downloading? These rows will be marked discarded and will NOT run again automatically. Provider charges are not refunded. Pending rows are kept.`))return;
    try{await clearBuffered('discarded');message('Buffered outputs discarded. Pending rows are kept; resume when ready.');}catch(e){message(e.message,true);}finally{render();}
  };
  $('batch-ack').onclick=async()=>{
    if(!buffered.length||!downloaded||!confirm('Have you saved and checked this ZIP? Its buffered videos will be removed from browser storage.'))return;
    try{await clearBuffered('saved');message('ZIP part cleared. Resume to process remaining rows.');}catch(e){message(e.message,true);}finally{render();}
  };
  $('batch-report').onclick=()=>download(new Blob([report()],{type:'text/csv'}),'batch-report.csv');
  $('batch-retry-reviews').onclick=async()=>{
    const rows=queue?.rows.filter(retryableReview)||[];
    if(!rows.length||!confirm(`Queue ${rows.length} failed review${rows.length===1?'':'s'} again? Check the provider request IDs if billing is uncertain: another review can incur a charge. This keeps your CSV and completed reviews. On resume, only confirmed visual flaws can trigger a redo under your existing settings.`))return;
    const previous=queue;
    try{
      const current=await api('/api/batch');
      const completed=rows.find(row=>row.attempt===current.rowId);
      if(completed)await release(completed);
      const changed=new Map(rows.map(row=>[row.id,requeueReviewedRow(row)]));
      queue={...queue,rows:queue.rows.map(row=>changed.get(row.id)||row)};
      await checkpoint({rows:[...changed.values()]});
      message(`${rows.length} failed review${rows.length===1?'':'s'} queued again. Reselect folders if needed, then choose Start / resume batch. Completed reviews and original videos are kept.`);
    }catch(e){queue=previous;throw e;}
  };
  $('batch-enable-redos').onclick=async()=>{
    if(!canEnableRedos())return;
    if(queue.rows.some(r=>[...pauseStates,'uncertain'].includes(r.state)))throw new Error('Finish or resolve interrupted work before enabling redos.');
    const maxRetries=Number($('batch-repair-retries').value),rows=queue.rows.filter(flaggedOriginal);
    if(![1,2].includes(maxRetries))throw new Error('Choose 1 or 2 redos.');
    if(!confirm(`Enable up to ${maxRetries} extra generations per eligible row? Recheck ${rows.length} flagged originals and continue pending rows; approved rows stay completed. Reviews and redos use credits. Only confirmed major defects can trigger Kling/Seedance redos, and only approved repairs replace originals with backups. Your CSV, filenames and other settings are kept.`))return;
    const previous=queue;
    try{
      const current=await api('/api/batch');
      if(current.rowId){
        const completed=queue.rows.find(row=>row.attempt===current.rowId&&row.state==='saved');
        if(!completed)throw new Error('Another row still owns the server workspace. Finish or recover it before enabling redos.');
        await release(completed);
      }
      const changed=new Map(rows.map(row=>[row.id,requeueReviewedRow(row)]));
      queue={...queue,settings:{...queue.settings,review:{...queue.settings.review,mode:'redo',maxRetries}},rows:queue.rows.map(row=>changed.get(row.id)||row)};
      await checkpoint({rows:[...changed.values()]});
    }catch(e){queue=previous;throw e;}
    ui.restoreSettings(queue.settings);
    message(`Automatic redos enabled (up to ${maxRetries} per eligible row). ${rows.length} flagged originals queued for recheck; approved rows are kept. Reselect folders if needed, then Start / resume batch. No videos were regenerated yet.`);
  };
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
  async function clearBatch(changeTask=false){
    if(running||!queue||!confirm(`${changeTask?'Discard this batch to choose a different task?\n\n':''}Clear ${queue.csvName||'the loaded CSV'} and its ${queue.rows.length} batch rows? This permanently removes batch progress and ${buffered.length} buffered output videos without downloading. Save anything you want to keep first. Your original CSV, source videos and files already saved to your computer are kept.`))return;
    const previous=queue;
    try{
      const current=await api('/api/batch');if(current.rowId)await api('/api/batch/release','POST',{rowId:current.rowId});
      queue=null;await checkpoint({clear:true});buffered=[];downloaded=false;page=0;$('batch-csv').value='';$('batch-rows').replaceChildren();$('batch-metrics').textContent='No CSV loaded.';$('batch-progress').value=0;$('batch-page').textContent='';render();message(changeTask?'Batch discarded. Choose your new Batch task above, then load its CSV.':'CSV and batch checkpoint cleared. Choose another CSV to begin.');
      if(changeTask)setTimeout(()=>{$('batch-workflow').scrollIntoView?.({block:'center',behavior:'instant'});$('batch-workflow').focus();},0);
    }catch(e){queue=previous;render();message(e.message,true);}
  }
  $('batch-reset').onclick=()=>clearBatch();
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
  for(const id of ['batch-start','batch-validate','batch-download','batch-ack','batch-retry','batch-retry-reviews','batch-enable-redos','batch-skip','batch-reset','batch-discard'])$(id).onclick=exclusive($(id).onclick);
  const discardForTask=exclusive(()=>clearBatch(true));
  // For batch-review.js: human decisions on flagged outputs share this queue, its checkpoint and its lease.
  window.studioBatch={
    get queue(){return queue;},get buffered(){return buffered;},get destination(){return destination;},get running(){return running||editing;},
    hasSources:()=>files.size>0,resolve:resolveRow,checkpoint,render,message,exclusive,requeue:requeueReviewedRow,
    setBuffered(id,item){buffered=item?buffered.map(x=>x.id===id?item:x):buffered.filter(x=>x.id!==id);},
    // Apply runs under the lease; start once it is released.
    async startAfterLease(){while(editing)await wait(20);return $('batch-start').onclick();}
  };
  $('batch-change-task').onclick=()=>running?$('batch-pause').onclick():discardForTask();
  $('batch-csv').onchange=exclusive($('batch-csv').onchange);
  window.addEventListener('beforeunload',event=>{if(running){event.preventDefault();event.returnValue='';}});
  storage.then(async value=>{
    db=value;queue=await readQueue();buffered=await allOutputs();available=true;
    if(queue){
      $('batch-input-root').value=queue.inputRoot||'';$('batch-output-root').value=queue.outputRoot||'';$('batch-destination').value=queue.destination||'zip';$('batch-path-label').value=queue.destinationPathLabel||'';$('batch-unit-cost').value=queue.unitCost||'';$('batch-cost-unit').value=queue.costUnit||'USD';$('batch-workflow').value=queue.workflow||'generate';
      mode(true);message('Batch checkpoint restored. Reselect folders and enter keys if needed, then resume.'+(queue.settings?' To change tasks, use Discard batch & change task beside the locked selector.':''),false,true);
    }
    if(!window.showDirectoryPicker){$('batch-destination').querySelector('[value=folder]').disabled=true;if(queue?.destination!=='replace')$('batch-destination').value='zip';}
    restoreBatchSettings();
  }).catch(e=>{available=false;message(`Browser checkpoint storage unavailable: ${e.message}. Enable site storage to use batches.`,true);render();});
  render();
})();
