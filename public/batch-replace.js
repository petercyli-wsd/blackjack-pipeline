/* In-place repairs: stage, verify a backup, checkpoint intent, then commit.
   Never delete a target on failure. Only the original folder handle is used. */
((root,factory)=>{const api=factory();if(typeof module==='object')module.exports=api;else root.BatchReplace=api;})(globalThis,()=>{
  const BACKUPS='_bridge-backups';
  function parts(path){
    const p=String(path).split('/');
    if(p.some(s=>!s||s==='.'||s==='..'||/[\\\x00-\x1f<>:"|?*]/.test(s)))throw new Error('Unsafe replacement path.');
    return p;
  }
  async function handle(root,path,create=false){
    const p=parts(path),name=p.pop();let dir=root;
    for(const segment of p)dir=await dir.getDirectoryHandle(segment,{create});
    return dir.getFileHandle(name,{create});
  }
  async function optionalFile(root,path){try{return await (await handle(root,path)).getFile();}catch(e){if(e.name==='NotFoundError')return null;throw e;}}
  // Fixed-size chunk hashes keep memory bounded even for 512 MB inputs. This is
  // a versioned content fingerprint, not the standard SHA-256 of the whole file.
  async function fingerprint(file){
    const hashes=[];
    for(let at=0;at<file.size;at+=4*1048576)hashes.push(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.slice(at,at+4*1048576).arrayBuffer())));
    const joined=new Uint8Array(hashes.length*32);hashes.forEach((h,i)=>joined.set(h,i*32));
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',joined));
    return `chunks-v1:${file.size}:`+Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function write(fileHandle,stream,expectedSize,check=()=>{}){
    const writable=await fileHandle.createWritable({keepExistingData:false,mode:'exclusive'}),reader=stream.getReader();let size=0;
    try{
      while(true){check();const item=await reader.read();if(item.done)break;size+=item.value.byteLength;await writable.write(item.value);}
      if(expectedSize!==undefined&&size!==expectedSize)throw new Error('Incomplete repair download. Resume to retry saving without generating again.');
      check();await writable.close();
    }catch(e){await writable.abort().catch(()=>{});await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
  }
  function base(queue){return `${BACKUPS}/${queue.id}`;}
  async function bind(root,queue,save){
    if(!root)throw new Error('Reselect the original output folder to review and replace its files.');
    const path=`${base(queue)}/batch.json`,marker=await optionalFile(root,path);
    if(marker){
      let data;try{data=JSON.parse(await marker.text());}catch{throw new Error('The repair folder marker is damaged. Restore it before resuming.');}
      if(data.batch!==queue.id)throw new Error('This is not the original repair folder.');
    }else{
      if(queue.replacementBound)throw new Error('Wrong folder: reselect the original output folder containing this batch\'s _bridge-backups folder.');
      const blob=new Blob([JSON.stringify({version:1,batch:queue.id,csv:queue.csvName})]);
      await write(await handle(root,path,true),blob.stream(),blob.size);
    }
    if(!queue.replacementBound){queue.replacementBound=true;await save();}
  }
  async function capture(root,row,save){
    if(parts(row.name)[0].toLowerCase()===BACKUPS)throw new Error('CSV outputs cannot be inside the reserved _bridge-backups folder.');
    const file=await (await handle(root,row.name)).getFile(),digest=await fingerprint(file);
    if(!row.originalDigest&&row.signatureCandidate&&row.signatureCandidate!==`${file.size}:${file.lastModified}`)throw new Error(`Original output changed since validation: ${row.name}. Revalidate before starting a new review.`);
    if(row.originalDigest&&row.originalDigest!==digest)throw new Error(`Original output changed: ${row.name}. Restore it or start a new review.`);
    row.originalDigest=digest;await save();return file;
  }
  async function replace(root,queue,row,{fetchResult,save,check=()=>{}}){
    const review=row.result?.review;
    if(review?.verdict!=='pass'||!Number.isInteger(review.selectedAttempt)||review.selectedAttempt<1)throw new Error('Only a reviewed, approved repair may replace an original.');
    if(!row.originalDigest)throw new Error('Original fingerprint is missing. No replacement was made.');
    const target=await handle(root,row.name),prefix=base(queue);
    const stagePath=`${prefix}/repairs/${row.id}.mp4`,backupPath=`${prefix}/originals/${row.name}`;
    const current=await target.getFile(),currentDigest=await fingerprint(current);
    if(row.replacement?.digest===currentDigest){
      const backup=await optionalFile(root,backupPath);
      if(!backup||await fingerprint(backup)!==row.originalDigest)throw new Error('Replacement is present but its original backup needs attention. No further write was made.');
      return backupPath; // Browser closed after commit but before the saved checkpoint.
    }
    if(currentDigest!==row.originalDigest)throw new Error(`Original output changed: ${row.name}. No file was overwritten.`);
    let staged=await optionalFile(root,stagePath);
    if(row.replacement){
      if(!staged||await fingerprint(staged)!==row.replacement.digest)throw new Error('Staged repair changed or is missing. Restore it from the repair folder before resuming.');
    }else{
      const response=await fetchResult();
      if(!response.ok||!response.body)throw new Error('Completed repair is no longer available. The original is unchanged; check provider history before retrying.');
      const length=response.headers.get('content-length'),size=Number(length);
      if(length===null||!Number.isSafeInteger(size)||size<=0){await response.body.cancel();throw new Error('Repair size is unavailable. Original kept; resume when the server is available.');}
      await write(await handle(root,stagePath,true),response.body,size,check);
      staged=await (await handle(root,stagePath)).getFile();
      row.replacement={digest:await fingerprint(staged),stagePath,backupPath};
      await save(); // Durable intent precedes any change to the original.
    }
    check();
    let backup=await optionalFile(root,backupPath);
    if(!backup){await write(await handle(root,backupPath,true),current.stream(),current.size,check);backup=await (await handle(root,backupPath)).getFile();}
    // A partial backup is never silently trusted or overwritten.
    if(await fingerprint(backup)!==row.originalDigest)throw new Error('Original backup verification failed. Original kept; restore or move the incomplete backup aside before resuming.');
    if(await fingerprint(await target.getFile())!==row.originalDigest)throw new Error('Original changed while preparing its repair. No replacement was made.');
    await write(target,staged.stream(),staged.size,check);
    if(await fingerprint(await target.getFile())!==row.replacement.digest)throw new Error('Could not verify the replacement. Original backup is preserved; inspect it before resuming.');
    return backupPath;
  }
  return {handle,fingerprint,bind,capture,replace};
});
