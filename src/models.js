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
const DEFAULT_PROMPT = [
  'One continuous photorealistic shot from a fixed camera, matching the supplied first and last frames. Preserve the same dealer, face, clothing, table layout, lighting and background.',
  'Move hands and forearms directly along the shortest natural path to the ending pose, then rest. No detours, extra tasks, dealing, collecting, shuffling or gestures. Do not reach for, touch or move either card holder, discard tray or shoe unless the endpoint explicitly requires contact. Never invent a card transfer to fill time.',
  'Treat every card and chip as the same persistent physical object throughout. Cards resting on the table stay fixed unless their movement is required by the ending frame.',
  "Preserve each card's size, thickness, rectangular shape, back design and visible rank/suit. Do not flip cards unless the ending frame requires it; required flips use continuous physical rotation.",
  "A moved card follows one continuous physical path under the hand's control, with consistent grip, contact, perspective and shadow. When fingers cover a card, it remains behind them and reappears intact as the hand moves away.",
  'Cards never vanish, fade, duplicate, merge or teleport. Maintain coherent fingers, wrists, grips and contact. Preserve body proportions and silhouette, sleeve shape, clothing seams and hair volume; natural cloth/hair motion only, no melting or morphing.',
  'Match the final card positions and hand pose exactly without a last-frame snap. If an object is only visible at one boundary, account for it through continuous physically plausible movement or occlusion; never make it appear or disappear by fading.'
].join(' ');

function getMethod(id) { const m = METHODS.find(m=>m.id===id); if(!m) throw new Error('Unknown interpolation method'); return m; }
const {parse:frameRate}=require('../public/frame-rate');
function validateOptions(o) {
  const m=getMethod(o.method);
  for(const k of ['duration','aEnd','bStart']) if(!Number.isFinite(o[k])) throw new Error(`Invalid ${k}`);
  if(o.duration<m.min || o.duration>m.max || (m.provider!=='local' && m.kind!=='interpolation' && !Number.isInteger(o.duration))) throw new Error(`Duration must be ${m.min}–${m.max} seconds${m.kind!=='interpolation' && m.provider!=='local'?' (whole seconds)':''}`);
  frameRate(o.fps,true);
  if(o.aEnd<=0 || o.bStart<0) throw new Error('Invalid cut points');
  if(typeof o.prompt!=='string' || o.prompt.length>2000) throw new Error('Prompt must be at most 2000 characters');
  return m;
}
function falInput(m, a, b, o) {
  // fal's FILM/RIFE video container FPS is integer-only. The local assembly
  // converts it to the exact requested output rate; frame count uses that rate.
  if(m.kind==='interpolation') return {start_image_url:a,end_image_url:b,output_type:'video',num_frames:Math.max(1,Math.round(o.duration*frameRate(o.fps).value)-2),include_start:true,include_end:true,fps:Math.round(frameRate(o.fps).value)};
  if(m.id==='seedance') return {image_url:a,end_image_url:b,prompt:o.prompt,duration:String(o.duration),resolution:'720p',aspect_ratio:'auto',generate_audio:false,codec:'H264'};
  return {start_image_url:a,end_image_url:b,prompt:o.prompt,duration:String(o.duration),generate_audio:false};
}
module.exports={METHODS,DEFAULT_PROMPT,getMethod,validateOptions,falInput,frameRate};
