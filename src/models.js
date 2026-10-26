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
  'One continuous fixed-camera shot matching both reference frames. This is a minimal pose transition, not a performance or a new casino action. Preserve the dealer, table, background, exposure, white balance and shadows.',
  'Only move what must change to reach the ending pose. Hands and forearms take short, direct, physically plausible paths. Begin gently near the start and progress at an even natural pace across the interval, easing into the end. No long frozen hold followed by a rush, overshoot, detour or last-frame snap. Similar poses need only a tiny adjustment, never filler actions.',
  'No invented dealing, mimed dealing, shuffling, collecting, presenting, wide arm spreads or sweeps into the player area. Do not approach or touch the shoe, holders or tray unless required by the endpoints. An empty hand stays empty unless a visible, endpoint-required pickup occurs.',
  'Every card and chip persists as the same physical object. Stationary cards stay fixed. Preserve count, size, thickness, rectangular shape, back design and visible rank/suit. No appearance from nowhere, disappearance, duplication, merging, fading or teleporting. A required move or flip follows a continuous hand-controlled path with stable grip, contact, shadow and occlusion; covered cards reappear intact.',
  'Keep fingers, wrists, arms and body coherent in EVERY consecutive frame: no position jumps, stretched limbs or intersections. Keep head and torso quiet unless endpoints require a change. No head toss, hair flick, new fringe, hair passing through itself, face melting or identity changes.',
  'Preserve hair silhouette, sleeve contours, seams and sweater knit texture throughout, especially at both joins. Only small physically necessary cloth/hair motion; no texture redraw, smoothing, flicker or lighting pulse. Match the reference poses and visible object layout at both boundaries.'
].join(' ');
const KLING_NEGATIVE_PROMPT='invented dealing, mimed dealing, cards appearing from nowhere, vanishing cards, extra gestures, wide arm spread, unnecessary table sweep, limb teleportation, one-frame position pop, head toss, hair flick, new fringe, hair self-intersection, face morphing, changing sweater texture, exposure flicker, frozen hold then rushed movement';

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
  return {start_image_url:a,end_image_url:b,prompt:o.prompt,negative_prompt:KLING_NEGATIVE_PROMPT,duration:String(o.duration),generate_audio:false};
}
module.exports={METHODS,DEFAULT_PROMPT,getMethod,validateOptions,falInput,frameRate};
