/* Viewport notifications supplement the persistent, in-context status messages. */
(()=>{
  const region=document.getElementById('notifications'),items=new Map();
  function dismiss(id){items.get(id)?.element.remove();items.delete(id);}
  function reveal(id){
    const target=document.getElementById(id);if(!target)return;
    const tab=target.closest('[role=tabpanel]');if(tab){if(window.Shell)window.Shell.show(tab.id.replace(/^tab-/,''));else tab.hidden=false;}
    if(target.closest('#batch-panel'))document.getElementById('mode-batch').click();
    else if(target.closest('.review'))document.getElementById('mode-single').click();
    for(let parent=target.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
    target.scrollIntoView?.({block:'center',behavior:'instant'});
    if(!target.matches('button,input,select,textarea,a'))target.tabIndex=-1;
    target.focus({preventScroll:true});
  }
  function show({id='app',message,kind='warning',target}){
    if(!message)return;
    const previous=items.get(id);if(previous?.message===message&&previous.kind===kind)return;
    dismiss(id);
    // Bound the stack; progress polling never enters this notification channel.
    if(items.size>=3)dismiss(items.keys().next().value);
    const element=document.createElement('section');element.className=`toast toast-${kind==='error'?'error':kind==='success'?'success':'warning'}`;element.dataset.notice=id;
    const content=document.createElement('div');content.className='toast-content';content.setAttribute('role','alert');content.setAttribute('aria-atomic','true');
    const title=document.createElement('strong');title.textContent=kind==='error'?'Action needed':kind==='success'?'Done':'Please check';
    const body=document.createElement('p');body.textContent=message;content.append(title,body);
    const actions=document.createElement('div');actions.className='toast-actions';
    if(target){const details=document.createElement('button');details.textContent='View details';details.className='quiet';details.onclick=()=>{dismiss(id);reveal(target);};actions.append(details);}
    const close=document.createElement('button');close.textContent='Dismiss';close.className='quiet';close.setAttribute('aria-label','Dismiss notification');close.onclick=()=>dismiss(id);actions.append(close);
    element.append(content,actions);region.append(element);items.set(id,{element,message,kind});
  }
  window.StudioNotice={show,dismiss};
})();
