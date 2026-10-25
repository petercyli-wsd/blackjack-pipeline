(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.BatchSettings=api;})(globalThis,()=>{
  function resolve(row,panel,methods){
    const frozen=row.resolvedSettings;
    const csvMethod=String(row.csvMethod??'').trim().toLowerCase(),csvDuration=String(row.csvDuration??'').trim();
    const methodId=frozen?.method||csvMethod||panel.method;
    const method=methods.find(m=>m.id===methodId);
    if(!method)throw new Error(`Unknown method: ${methodId||'(blank)'}.`);
    const methodSource=frozen?.methodSource||(csvMethod?'csv':'panel');
    const durationSource=frozen?.durationSource||(csvDuration?'csv':methodId===panel.method?'panel':'method default');
    if(!frozen&&csvDuration&&!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(csvDuration))throw new Error(`Invalid duration: ${csvDuration}. Use a finite number of seconds.`);
    const duration=frozen?frozen.duration:csvDuration?Number(csvDuration):methodId===panel.method?panel.duration:method.defaultDuration;
    if(!Number.isFinite(duration)||duration<method.min||duration>method.max)throw new Error(`${methodId}: duration must be ${method.min}–${method.max} seconds; received ${duration}.`);
    if(method.provider!=='local'&&method.kind!=='interpolation'&&!Number.isInteger(duration))throw new Error(`${methodId}: duration must be a whole number of seconds; received ${duration}.`);
    return {method:methodId,duration,provider:method.provider,methodSource,durationSource,settingSource:durationSource==='method default'?'method default':methodSource==='csv'||durationSource==='csv'?'csv':'panel'};
  }
  function groups(rows,panel,methods){
    const grouped=new Map();
    for(const row of rows){
      let settings;try{settings=resolve(row,panel,methods);}catch{continue;}
      const key=`${settings.method}:${settings.duration}`;
      if(!grouped.has(key))grouped.set(key,{...settings,rows:0});
      grouped.get(key).rows++;
    }
    return [...grouped.values()];
  }
  function missingKeys(rows,panel,methods,keys){
    const missing=new Map();
    for(const {method,provider,rows:count} of groups(rows,panel,methods)){
      if(provider==='local'||keys[provider])continue;
      if(!missing.has(provider))missing.set(provider,new Map());
      const counts=missing.get(provider);counts.set(method,(counts.get(method)||0)+count);
    }
    return [...missing].map(([provider,counts])=>`${provider}: ${[...counts].map(([method,count])=>`${method} (${count} ${count===1?'row':'rows'})`).join(', ')}`);
  }
  return {resolve,groups,missingKeys};
});
