const METHODS = [
  {id:'film',kind:'interpolation', name:'FILM · fal · short motion gaps', provider:'fal', endpoint:'fal-ai/film', min:0.1, max:2, defaultDuration:0.4, help:'True neural frame interpolation. Start here for similar poses and a short gap (0.2–0.6 s). Large occlusions can warp hands.'},
  {id:'rife',kind:'interpolation', name:'RIFE \u00b7 fal \u00b7 short motion gaps', provider:'fal', endpoint:'fal-ai/rife', min:0.1, max:2, defaultDuration:0.4, help:'Neural frame interpolation between the two boundary images. Compare with FILM for small pose changes; inspect fingers and objects at both joins. Uses your fal credits.'},
  {id:'kling-fal', name:'Kling 3.0 Pro · fal · generative bridge', provider:'fal', endpoint:'fal-ai/kling-video/v3/pro/image-to-video', min:3, max:15, defaultDuration:3, help:'Generates motion between two poses. Minimum 3 seconds; inspect hands, face, cards and both joins.'},
  {id:'kling-kie', name:'Kling 3.0 Pro · kie.ai · generative bridge', provider:'kie', min:3, max:15, defaultDuration:3, help:'Same model family through your KIE account. Uploads two boundary images; minimum 3 seconds.'},
  {id:'seedance', name:'Seedance 2.5 · fal · generative bridge', provider:'fal', endpoint:'bytedance/seedance-2.5/image-to-video', min:4, max:30, defaultDuration:4, help:'Alternative first/last-frame model for comparison. Native duration is at least 4 seconds; output requested at 720p.'},
  {id:'flow', name:'Motion-compensated interpolation · local', provider:'local', min:0.1, max:2, defaultDuration:0.4, help:'FFmpeg block motion estimation, with no API cost. Useful for small displacement; can tear around fingers and occlusions.'},
  {id:'blend', name:'Linear frame blend · local', provider:'local', min:0.1, max:3, defaultDuration:0.3, help:'Pixel crossfade between the two boundary frames. Predictable baseline; moving features appear doubled.'},
  {id:'dissolve', name:'Overlapping clip dissolve · local', provider:'local', min:0.1, max:3, defaultDuration:0.3, help:'Crossfades moving footage and audio. Overlaps the end of A and start of B, shortening the combined duration.'}
];
const DEFAULT_PROMPT = 'Locked-off camera. The same casino dealer makes one small, natural, continuous movement from the starting pose to the ending pose. Preserve identity, face, clothing, table, lighting and background. Keep the exact cards, chips, markings and objects consistent. Natural hands and fingers. No cuts, camera movement, added objects or extra actions.';
function getMethod(id) { const m = METHODS.find(m=>m.id===id); if(!m) throw new Error('Unknown interpolation method'); return m; }
function validateOptions(o) {
  const m=getMethod(o.method);
  for(const k of ['duration','aEnd','bStart','fps']) if(!Number.isFinite(o[k])) throw new Error(`Invalid ${k}`);
  if(o.duration<m.min || o.duration>m.max || (m.provider!=='local' && m.kind!=='interpolation' && !Number.isInteger(o.duration))) throw new Error(`Duration must be ${m.min}–${m.max} seconds${m.kind!=='interpolation' && m.provider!=='local'?' (whole seconds)':''}`);
  if(![24,25,30,60].includes(o.fps)) throw new Error('Unsupported frame rate');
  if(o.aEnd<=0 || o.bStart<0) throw new Error('Invalid cut points');
  if(typeof o.prompt!=='string' || o.prompt.length>2000) throw new Error('Prompt must be at most 2000 characters');
  return m;
}
function falInput(m, a, b, o) {
  if(m.kind==='interpolation') return {start_image_url:a,end_image_url:b,output_type:'video',num_frames:Math.max(1,Math.round(o.duration*o.fps)-2),include_start:true,include_end:true,fps:o.fps};
  if(m.id==='seedance') return {image_url:a,end_image_url:b,prompt:o.prompt,duration:String(o.duration),resolution:'720p',aspect_ratio:'auto',generate_audio:false,codec:'H264'};
  return {start_image_url:a,end_image_url:b,prompt:o.prompt,duration:String(o.duration),generate_audio:false};
}
module.exports={METHODS,DEFAULT_PROMPT,getMethod,validateOptions,falInput};
