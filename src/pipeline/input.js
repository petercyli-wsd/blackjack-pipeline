const fs=require('node:fs/promises');
const {run,ffmpeg,ffprobe}=require('../media');
const {parse:frameRate}=require('../../public/frame-rate');
const {bytes}=require('./util');

// Checks a take against the definition before any CPU time or money is spent on it.
// Errors block the run; warnings are shown but don't. Each says what to do about it.
const FORMATS='mov,matroska,webm,avi,mpegts,mpeg,ogg,flv,asf';
const clock=s=>`${Math.floor(s/60)}:${String(Math.round(s%60)).padStart(2,'0')}`;
function rate(text){const [n,d]=String(text||'').split('/').map(Number);return n>0&&d>0?n/d:null;}
async function inspect(file,spec={},{signal,name}={}){
  const errors=[],warnings=[],error=(message,fix)=>errors.push({message,fix}),warn=(message,fix)=>warnings.push({message,fix});
  const stat=await fs.stat(file);
  const info={name:name||null,size:stat.size,sizeText:bytes(stat.size)};
  if(!stat.size){error('The file is empty.','Choose the exported take again; the upload or export may have been interrupted.');return {ok:false,errors,warnings,info};}
  if(spec.maxBytes&&stat.size>spec.maxBytes)error(`The file is ${bytes(stat.size)}; the limit is ${bytes(spec.maxBytes)}.`,'Export the take with a higher compression (H.264, CRF 17-20 is plenty).');
  let data;
  try{data=JSON.parse(await run(ffprobe,['-v','error','-protocol_whitelist','file,pipe','-format_whitelist',FORMATS,'-show_streams','-show_format','-of','json',file],signal));}
  catch(e){if(signal?.aborted)throw e;error('This isn\'t a video file that can be read.','Export the take as an MP4 (H.264) or MOV and choose that file.');return {ok:false,errors,warnings,info};}
  const v=(data.streams||[]).find(s=>s.codec_type==='video'&&s.disposition?.attached_pic!==1);
  if(!v){error('The file has no video stream.','Choose the video export of the take, not an audio or image file.');return {ok:false,errors,warnings,info};}
  const rotation=Number(v.tags?.rotate||v.side_data_list?.find(x=>x.rotation!==undefined)?.rotation||0);
  const duration=Number(v.duration||data.format?.duration),fps=rate(v.avg_frame_rate)||rate(v.r_frame_rate);
  Object.assign(info,{width:v.width,height:v.height,codec:v.codec_name,duration,fps,fpsRational:v.avg_frame_rate,frames:Number(v.nb_frames)||null,rotation,
    summary:[`${v.width}×${v.height}`,fps?`${fps.toFixed(3)} fps`:null,Number.isFinite(duration)?clock(duration):null,v.codec_name?.toUpperCase(),bytes(stat.size)].filter(Boolean).join(' · ')});
  if(rotation%360)error(`The video is tagged to rotate by ${rotation}°.`,'Export it upright without rotation metadata. The pipeline measures the table in exact pixels.');
  if(spec.width&&(v.width!==spec.width||v.height!==spec.height))error(`The take is ${v.width}×${v.height}, but this pipeline needs exactly ${spec.width}×${spec.height}.`,`The table, seats and cards are located by fixed pixel positions from the locked-off camera. Export the original take at ${spec.width}×${spec.height}, with no crop, scale or reframing.`);
  if(spec.fps&&fps){
    const want=frameRate(spec.fps).value,off=Math.abs(fps-want)/want;
    if(off>.005)error(`The take runs at ${fps.toFixed(3)} fps, but this pipeline needs ${want.toFixed(3)} fps (${spec.fps}).`,'Export at the camera\'s original rate. A different rate would change the timing of every clip and loop.');
    else if(off>.0002)warn(`The take runs at ${fps.toFixed(3)} fps rather than exactly ${want.toFixed(3)} fps.`,'It will be treated as the expected rate; timing may drift very slightly.');
  }else if(spec.fps)error('The video\'s frame rate can\'t be read.','Re-export the take as a constant-frame-rate MP4.');
  const nominal=rate(v.r_frame_rate);
  if(fps&&nominal&&Math.abs(nominal-fps)/fps>.005)warn('The video looks like it has a variable frame rate.','Re-exporting at a constant frame rate gives the most reliable cuts.');
  if(!Number.isFinite(duration)||duration<=0)error('The video\'s length can\'t be read.','Re-export the take; the file may be incomplete.');
  else{
    if(spec.minSeconds&&duration<spec.minSeconds)error(`The take is only ${clock(duration)} long; a full take is at least ${clock(spec.minSeconds)}.`,'Choose the whole take, not a clip from it.');
    if(spec.maxSeconds&&duration>spec.maxSeconds)error(`The take is ${clock(duration)} long; the limit is ${clock(spec.maxSeconds)}.`,'Trim it to the dealing sequence before uploading.');
    if(info.frames&&fps&&Math.abs(info.frames-duration*fps)>fps*2)warn('The frame count in the file header doesn\'t match its length.','If the run fails while reading the take, re-export it.');
  }
  // Decode both ends: a truncated or damaged file usually fails right there.
  if(Number.isFinite(duration)&&duration>0&&!errors.length){
    for(const [label,start] of [['start',0],['end',Math.max(0,duration-1.5)]]){
      try{await run(ffmpeg,['-v','error','-xerror','-protocol_whitelist','file,pipe','-ss',String(start),'-i',file,'-t','1','-map','0:v:0','-f','null','-'],signal);}
      catch(e){if(signal?.aborted)throw e;error(`The video can't be decoded near its ${label}.`,'The file is damaged or incomplete. Export the take again and choose the new file.');break;}
    }
  }
  return {ok:!errors.length,errors,warnings,info};
}
module.exports={inspect};
