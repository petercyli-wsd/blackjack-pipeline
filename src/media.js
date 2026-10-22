const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {createWriteStream}=require('node:fs');
const ffmpeg=process.env.FFMPEG_PATH||require('ffmpeg-static');
const ffprobe=process.env.FFPROBE_PATH||require('ffprobe-static').path;
const {validateOptions}=require('./models');
const {generate}=require('./providers');
function run(bin,args,signal) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted) return reject(new Error('Cancelled'));
    const p=spawn(bin,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='';
    p.stdout.on('data',d=>out+=d); p.stderr.on('data',d=>err=(err+d).slice(-8000));
    const abort=()=>p.kill(); signal?.addEventListener('abort',abort,{once:true});
    p.on('error',reject); p.on('close',code=>{signal?.removeEventListener('abort',abort); if(signal?.aborted) reject(new Error('Cancelled')); else if(code) reject(new Error(`Video processing failed: ${err.slice(-3000)}`)); else resolve(out);});
  });
}
const ff=(args,signal)=>run(ffmpeg,['-hide_banner','-loglevel','error','-y',...args],signal);
async function extractBoundary(input,output,last,signal) {
  // Seeking to duration - 1/fps can land just AFTER the final presentation
  // timestamp because MP4 duration is rounded. FFmpeg then succeeds with no PNG.
  // Count decoded frames and select by index instead of rounded timestamps.
  let index=0;
  if(last) {
    const data=JSON.parse(await run(ffprobe,['-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=nb_read_frames','-of','json',input],signal));
    const count=Number(data.streams?.[0]?.nb_read_frames);
    if(!Number.isSafeInteger(count)||count<1) throw new Error('Cannot extract boundary: no decodable video frames.');
    index=count-1;
  }
  await ff(['-i',input,'-map','0:v:0','-vf',`select=eq(n\\,${index})`,'-frames:v','1','-fps_mode','passthrough',output],signal);
  const png=await fs.readFile(output).catch(()=>null);
  if(!png||png.length<8||!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    throw new Error(`Could not extract the ${last?'outgoing':'incoming'} boundary image. No cloud job was submitted.`);
  }
}
async function probe(file,signal,untrusted=false) {
  // Uploaded videos must be self-contained media, not playlists that can open URLs or other files.
  const restrictions=untrusted?['-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm,avi,mpegts,mpeg,ogg,flv,asf']:[];
  const d=JSON.parse(await run(ffprobe,['-v','error',...restrictions,'-show_streams','-show_format','-of','json',file],signal));
  const v=d.streams.find(s=>s.codec_type==='video'); if(!v) throw new Error('This file has no video stream.');
  const duration=Number(v.duration||d.format.duration);
  if(!Number.isFinite(duration)||duration<=0) throw new Error('Cannot determine video duration');
  const [n,den]=v.avg_frame_rate.split('/').map(Number);
  const rotation=Number(v.tags?.rotate || v.side_data_list?.find(x=>x.rotation!==undefined)?.rotation || 0);
  const swap=Math.abs(rotation)%180===90;
  return {duration,width:swap?v.height:v.width,height:swap?v.width:v.height,fps:n/den||30,audio:d.streams.some(s=>s.codec_type==='audio')};
}
const encoding=['-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart'];
function scale(w,h,fps) {return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},settb=AVTB,format=yuv420p`;}
async function normalize(input,output,info,start,duration,w,h,fps,mute,signal) {
  const args=['-ss',String(start),'-i',input];
  if(!info.audio||mute) args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
  args.push('-t',String(duration),'-map','0:v:0','-map',!info.audio||mute?'1:a:0':'0:a:0','-vf',scale(w,h,fps),'-af','aresample=48000,apad','-ac','2',...encoding,output);
  await ff(args,signal);
}
async function localBridge(method,a,b,out,d,fps,dir,signal) {
  if(method==='blend') {
    await ff(['-loop','1','-framerate',String(fps),'-i',a,'-loop','1','-framerate',String(fps),'-i',b,'-filter_complex',`[0:v][1:v]blend=all_expr='A*(1-T/${d})+B*T/${d}',format=yuv420p[v]`,'-map','[v]','-t',String(d),'-an',...encoding.filter((_,i)=>i<8),out],signal);
  } else {
    // Four temporal anchors supply the context required by minterpolate.
    for(const [i,file] of [a,a,b,b,b].entries()) await fs.copyFile(file,path.join(dir,`anchor-${i}.png`));
    await ff(['-framerate',String(1/d),'-i',path.join(dir,'anchor-%d.png'),'-vf',`minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=none,trim=start=${d}:duration=${d},setpts=PTS-STARTPTS,format=yuv420p`,'-an','-c:v','libx264','-crf','18',out],signal);
  }
}
async function download(url,file,signal) {
  if(new URL(url).protocol!=='https:') throw new Error('Provider returned a non-HTTPS video URL');
  const combined=AbortSignal.any([signal,AbortSignal.timeout(300000)]);
  const r=await fetch(url,{signal:combined}); if(!r.ok||!r.body) throw new Error(`Video download failed (${r.status})`);
  await pipeline(Readable.fromWeb(r.body),createWriteStream(file),{signal:combined});
}
async function createComparison(a,b,dir,signal,log=()=>{}) {
  log('Creating no-bridge comparison: A directly followed by B…');
  const ai=await probe(a,signal);
  const noBridge=path.join(dir,'no-bridge.mp4'),noBridgePreview=path.join(dir,'no-bridge-preview.mp4');
  await ff(['-i',a,'-i',b,'-filter_complex','[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][au]','-map','[v]','-map','[au]',...encoding,noBridge],signal);
  const cutPreviewStart=Math.max(0,ai.duration-1.5);
  await ff(['-ss',String(cutPreviewStart),'-i',noBridge,'-t',String(ai.duration+1.5-cutPreviewStart),...encoding,noBridgePreview],signal);
  const info=await probe(noBridge,signal);
  return {noBridge,noBridgePreview,noBridgeDuration:info.duration};
}
async function processVideos(o,{dir,key,signal,log=()=>{},generator=generate}) {
  const m=validateOptions(o);
  const [aInfo,bInfo]=await Promise.all([probe(o.a,signal),probe(o.b,signal)]);
  if(o.aEnd>aInfo.duration+0.05||o.bStart>=bInfo.duration-1/o.fps) throw new Error('Cut points must lie inside the clips.');
  const aDuration=Math.round(Math.min(o.aEnd,aInfo.duration)*o.fps)/o.fps;
  const bDuration=Math.floor((bInfo.duration-o.bStart)*o.fps)/o.fps;
  if(aDuration<2/o.fps||bDuration<2/o.fps) throw new Error('Each selected clip must contain at least two frames.');
  if(m.id==='dissolve' && (o.duration>=aDuration||o.duration>=bDuration)) throw new Error('Dissolve duration must be shorter than both selected clips.');
  if(m.provider!=='local'&&!key) throw new Error(`Missing ${m.provider} API key`);
  await fs.mkdir(dir,{recursive:true});
  const w=Math.max(2,Math.round(Math.min(aInfo.width,1920)/2)*2),h=Math.max(2,Math.round(aInfo.height*w/aInfo.width/2)*2);
  const a=path.join(dir,'a.mp4'),b=path.join(dir,'b.mp4'),output=path.join(dir,'result.mp4');
  log('Normalizing clips and selected cut points…');
  await normalize(o.a,a,aInfo,0,aDuration,w,h,o.fps,o.mute,signal);
  await normalize(o.b,b,bInfo,o.bStart,bDuration,w,h,o.fps,o.mute,signal);
  const ai=await probe(a,signal),bi=await probe(b,signal);
  const frames=[path.join(dir,'start.png'),path.join(dir,'end.png')];
  await extractBoundary(a,frames[0],true,signal);
  await extractBoundary(b,frames[1],false,signal);
  const manifest={method:m.id,duration:o.duration,fps:o.fps,aEnd:o.aEnd,bStart:o.bStart,prompt:o.prompt,createdAt:new Date().toISOString()};
  const saveManifest=async job=>{Object.assign(manifest,{job}); await fs.writeFile(path.join(dir,'job.json'),JSON.stringify(manifest,null,2));};
  await saveManifest(null);
  let joinStart=ai.duration;
  if(m.id==='dissolve') {
    log('Crossfading moving clips and audio…'); joinStart=ai.duration-o.duration;
    await ff(['-i',a,'-i',b,'-filter_complex',`[0:v]settb=AVTB[v0];[1:v]settb=AVTB[v1];[v0][v1]xfade=transition=fade:duration=${o.duration}:offset=${joinStart}[v];[0:a][1:a]acrossfade=d=${o.duration}[au]`,'-map','[v]','-map','[au]',...encoding,output],signal);
  } else {
    const raw=path.join(dir,'bridge-raw.mp4'),bridge=path.join(dir,'bridge.mp4');
    if(m.provider==='local') { log('Interpolating boundary frames locally…'); await localBridge(m.id,...frames,raw,o.duration,o.fps,dir,signal); }
    else { const url=await generator(m,frames,o,key,signal,log,saveManifest); log('Downloading generated bridge…'); await download(url,raw,signal); }
    const info=await probe(raw,signal);
    // Keep both generated endpoints when reconciling provider FPS/duration.
    const speed=o.duration/Math.max(1/info.fps,info.duration-1/info.fps);
    await ff(['-i',raw,'-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-filter_complex',`[0:v]setpts=${speed}*(PTS-STARTPTS),${scale(w,h,o.fps)},tpad=stop_mode=clone:stop_duration=1[v]`,'-map','[v]','-map','1:a','-t',String(o.duration),...encoding,bridge],signal);
    log('Joining A → bridge → B (silent bridge, source audio retained)…');
    await ff(['-i',a,'-i',bridge,'-i',b,'-filter_complex',`[0:a]afade=t=out:st=${Math.max(0,ai.duration-0.08)}:d=0.08[a0];[2:a]afade=t=in:d=0.08[a2];[0:v][a0][1:v][1:a][2:v][a2]concat=n=3:v=1:a=1[v][au]`,'-map','[v]','-map','[au]',...encoding,output],signal);
  }
  log('Rendering a short preview around the join…');
  const preview=path.join(dir,'preview.mp4');
  const previewStart=Math.max(0,joinStart-1.5);
  await ff(['-ss',String(previewStart),'-i',output,'-t',String(joinStart+o.duration+1.5-previewStart),...encoding,preview],signal);
  const comparison=await createComparison(a,b,dir,signal,log);
  const resultInfo=await probe(output,signal);
  return {output,preview,...comparison,frames,joinStart,duration:resultInfo.duration,width:w,height:h};
}
module.exports={ff,probe,processVideos,localBridge,extractBoundary,createComparison};
