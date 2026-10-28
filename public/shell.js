/* App shell: the Pipelines / Transition Studio tabs, deep links (#pipelines/<pipeline>/<run>, #studio) and the keys chip. */
(()=>{
  const $=id=>document.getElementById(id),tabs=['pipelines','studio'];
  let current=null,keysSeen=false;
  const store={get:k=>{try{return localStorage.getItem(k);}catch{return null;}},set:(k,v)=>{try{localStorage.setItem(k,v);}catch{}}};
  function show(name,{focus=false,hash=true}={}){
    if(!tabs.includes(name))name='pipelines';
    current=name;document.body.dataset.tab=name;
    for(const t of tabs){const on=t===name,button=$(`tab-btn-${t}`);$(`tab-${t}`).hidden=!on;button.setAttribute('aria-selected',String(on));button.tabIndex=on?0:-1;}
    store.set('bp-tab',name);
    if(hash){const next=name==='studio'?'#studio':location.hash.startsWith('#pipelines')?location.hash:'#pipelines';if(location.hash!==next)history.replaceState(null,'',next);}
    if(focus)$(`tab-btn-${name}`).focus();
    window.dispatchEvent(new CustomEvent('shell:tab',{detail:name}));
  }
  for(const t of tabs){
    $(`tab-btn-${t}`).addEventListener('click',()=>show(t));
    $(`tab-btn-${t}`).addEventListener('keydown',e=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();
      const i=tabs.indexOf(t),next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length;show(tabs[next],{focus:true});
    });
  }
  const linked=location.hash.startsWith('#studio')?'studio':location.hash.startsWith('#pipelines')?'pipelines':null;
  show(linked||store.get('bp-tab')||'pipelines',{hash:!linked});
  window.addEventListener('hashchange',()=>{const t=location.hash.startsWith('#studio')?'studio':location.hash.startsWith('#pipelines')?'pipelines':null;if(t&&t!==current)show(t,{hash:false});});
  // The keys panel opens by itself only when nothing is set yet; otherwise the chip opens it.
  const names={fal:'fal',kie:'KIE',runninghub:'RunningHub'};
  // Scripts load one by one, so the first key status may have been announced before this ran.
  function keys(k){
    const ready=Object.keys(names).filter(p=>k[p]),chip=$('keys-chip');
    chip.textContent=ready.length?`Keys: ${ready.map(p=>names[p]).join(' · ')}`:'Add your keys';
    chip.classList.toggle('missing',!ready.length);chip.title=ready.length?'Provider keys in use. Click to change.':'No provider keys yet. Click to add.';
    const panel=$('credentials');
    if(!keysSeen){keysSeen=true;panel.open=!ready.length;}
    else if(ready.length&&panel.dataset.saving==='1'){panel.open=false;}
    panel.dataset.saving='';
  }
  window.addEventListener('studio:keys',e=>keys(e.detail||{}));
  if(window.studioKeys)keys(window.studioKeys);
  $('save-keys').addEventListener('click',()=>{$('credentials').dataset.saving='1';},{capture:true});
  $('keys-chip').addEventListener('click',()=>{const panel=$('credentials');panel.open=true;panel.scrollIntoView({block:'start',behavior:'smooth'});setTimeout(()=>$('fal-key').focus({preventScroll:true}),300);});
  window.Shell={show,current:()=>current,store,
    setPipelines(enabled){
      $('runninghub-wrap').hidden=!enabled;document.body.classList.toggle('no-pipelines',!enabled);
      if(!enabled&&!location.hash.startsWith('#pipelines')&&current==='pipelines'&&!store.get('bp-tab-chosen'))show('studio');
    }};
  $('tab-btn-pipelines').addEventListener('click',()=>store.set('bp-tab-chosen','1'));
})();
