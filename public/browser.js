(()=>{
  let token,activeJob,progress=()=>{},hosted=false,maxUploadBytes=512*1024*1024;
  let sessionRequest;
  const results=new Map();
  async function api(route,method='GET',body){
    if(!token){
      if(location.protocol==='file:')throw new Error('Launch Start Web App.vbs (Windows bundle) or npm start. This HTML page needs its included local processing server.');
      sessionRequest ||= fetch('/api/session').then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.error||'Could not open session');return data.token;}).catch(e=>{sessionRequest=null;throw e;});token=await sessionRequest;
    }
    const response=await fetch(route,{method,headers:{'X-Studio-Token':token,...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error||`Request failed (${response.status})`),{status:response.status});return data;
  }
  function pick(){return new Promise((resolve,reject)=>{
    const input=document.createElement('input');input.type='file';input.accept='video/*,.mkv,.avi,.mov';
    input.addEventListener('cancel',()=>resolve(null),{once:true});
    input.onchange=async()=>{
      const file=input.files[0];if(!file)return resolve(null);
      if(file.size>maxUploadBytes)return reject(new Error(`Maximum video size is ${Math.round(maxUploadBytes/1024/1024)} MB.`));
      try{
        await api('/api/init');
        progress(`Importing ${file.name} to the processing server…`);
        const xhr=new XMLHttpRequest();xhr.open('POST',`/api/upload?name=${encodeURIComponent(file.name)}`);xhr.setRequestHeader('X-Studio-Token',token);
        xhr.upload.onprogress=e=>{if(e.lengthComputable)progress(`Importing ${file.name}: ${Math.round(100*e.loaded/e.total)}%`);};
        xhr.onerror=()=>reject(new Error('Import failed. Check that the server is still running.'));
        xhr.onload=()=>{try{const data=JSON.parse(xhr.responseText);if(xhr.status!==200)throw new Error(data.error);progress('Video imported.');resolve(data);}catch(e){reject(e);}};
        xhr.send(file);
      }catch(e){reject(e);}
    };input.click();
  });}
  async function run(route,body={}){
    const started=await api(route,'POST',body);return poll(started.id);
  }
  async function poll(id){
    activeJob=id;let seen=0;
    try{
      while(true){
        const job=await api(`/api/jobs/${id}`);
        for(const message of job.messages.slice(Math.max(0,seen-(job.offset||0))))progress(message);seen=(job.offset||0)+job.messages.length;
        if(job.state==='failed')throw new Error(job.error);
        if(job.state==='complete'){results.set(job.result.id,job.result);return job.result;}
        await new Promise(resolve=>setTimeout(resolve,700));
      }
    }catch(e){throw new Error(`${e.message}${e instanceof TypeError?' The server may have restarted. Submitted cloud work may still be running.':''}`);}
    finally{activeJob=null;}
  }
  function download(url){const a=document.createElement('a');a.href=`${url}?download=1`;a.download='';document.body.append(a);a.click();a.remove();}
  window.studio={
    batchAPI:api,
    batchUpload:async(file,rowId,slot,signal)=>{
      await api('/api/init');
      if(file.size>maxUploadBytes)throw Object.assign(new Error('Video exceeds the 512 MB input limit.'),{status:400});
      const response=await fetch(`/api/batch/upload?rowId=${encodeURIComponent(rowId)}&slot=${slot}&name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'X-Studio-Token':token},body:file,signal});
      const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error),{status:response.status});return data;
    },
    init:async()=>{const data=await api('/api/init');hosted=data.hosted;maxUploadBytes=data.maxUploadBytes;document.getElementById('app-mode').textContent=hosted?'TEAM WEB APP':'LOCAL WEB APP';document.getElementById('shutdown').hidden=hosted;return data;},pick,resume:poll,
    setKeys:value=>api('/api/keys','POST',value),forgetKeys:()=>api('/api/keys','DELETE'),
    process:options=>run('/api/process',options),latestResult:()=>run('/api/latest'),
    cancel:()=>api('/api/cancel','POST'),
    export:async(id,variant)=>{const r=results.get(id);if(!r)throw new Error('No rendered result');download(variant==='no-bridge'?r.noBridgeUrl:r.url);return 'your browser’s Downloads';},
    reveal:id=>{
      const r=results.get(id);if(!r)return;
      const modal=document.createElement('dialog'),heading=document.createElement('h2');heading.textContent='Download result files';modal.append(heading);
      for(const [label,url] of [['With transition',r.url],['No bridge — direct cut',r.noBridgeUrl],['Transition preview',r.preview],['No-bridge preview',r.noBridgePreview],['Outgoing boundary',r.frames[0]],['Incoming boundary',r.frames[1]]]){
        const a=document.createElement('a');a.textContent=label;a.href=`${url}?download=1`;a.download='';modal.append(a);
      }
      const close=document.createElement('button');close.textContent='Close';close.onclick=()=>modal.close();modal.append(close);modal.onclose=()=>modal.remove();document.body.append(modal);modal.showModal();
    },onProgress:fn=>progress=fn
  };
  document.getElementById('end-session').onclick=async()=>{
    if(!confirm('End your server session? Your keys and temporary server videos/results will be removed. Browser batch checkpoints and buffered ZIPs remain until Clear batch checkpoint. Download results first. Submitted cloud jobs may still be billed.'))return;
    try{await api('/api/logout','POST');location.reload();}catch(e){alert(e.message);}
  };
  document.getElementById('shutdown').onclick=async()=>{
    if(!confirm('Stop the local app? This clears session keys and cancels local processing. Cloud jobs may still be billed.'))return;
    try{await api('/api/shutdown','POST');document.body.replaceChildren();const message=document.createElement('p');message.textContent='Local app stopped. You can close this tab. Use Start Web App to reopen it.';document.body.append(message);}catch(e){alert(e.message);}
  };
})();
