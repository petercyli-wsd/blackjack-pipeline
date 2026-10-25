(function(root){
  // Budget assumptions, not measured benchmarks or live billing quotes.
  const profiles={
    film:{seconds:[30,120],cost:[0.005,0.05],basis:'FILM: speculative $0.005–$0.05 per row for a short HD bridge. This is a budget allowance, not a verified provider tariff; frame count and image size can change actual cost.'},
    rife:{seconds:[20,90],cost:[0.003,0.03],basis:'RIFE: speculative $0.003–$0.03 per row for a short HD bridge. This is a budget allowance, not a verified provider tariff; frame count and image size can change actual cost.'},
    'kling-fal':{seconds:[120,600],cost:[0.112,0.14],perSecond:true,basis:'Kling fal: $0.112–$0.14 per generated second, spanning fal’s published no-audio and pricing-table figures.'},
    'kling-kie':{seconds:[120,600],cost:[0.09,0.09],perSecond:true,basis:'Kling KIE Pro, audio off: published $0.09 per generated second (18 credits). Discounts/taxes excluded.'},
    seedance:{seconds:[120,900],cost:[0.34668,0.5778],perSecond:true,basis:'Seedance 720p: assumes 1280×720 at native 24 fps, $0.0214/1,000 tokens; about $0.46224/second with ±25% planning allowance for aspect ratio. Export FPS does not set provider billing FPS.'},
    flow:{seconds:[30,300],cost:[0,0],basis:'Local motion interpolation: no provider charge; server runtime varies strongly with resolution and clip length.'},
    blend:{seconds:[15,120],cost:[0,0],basis:'Local blend: no provider charge.'},
    dissolve:{seconds:[15,120],cost:[0,0],basis:'Local dissolve: no provider charge.'}
  };
  function estimate({method,duration,rows,unitCost='',unit='USD',samples=[]}){
    const p=profiles[method];if(!p||!Number.isFinite(duration)||duration<=0||!Number.isFinite(rows)||rows<0)return null;
    const completed=samples.filter(n=>Number.isFinite(n)&&n>0).slice(-10);
    const average=completed.reduce((a,b)=>a+b,0)/(completed.length||1);
    const seconds=completed.length?[average*.75,average*1.5]:p.seconds.map(n=>n*(p.perSecond?Math.max(1,duration/5):Math.max(1,duration/.4)));
    const local=['flow','blend','dissolve'].includes(method);
    const manual=!local&&String(unitCost).trim()!==''&&Number.isFinite(Number(unitCost))&&Number(unitCost)>=0;
    const cost=p.cost.map(n=>n*(p.perSecond?duration:1));
    const perRow=manual?[Number(unitCost),Number(unitCost)]:cost;
    return {time:seconds.map(n=>n*rows),cost:perRow.map(n=>n*rows),perRow,unit:manual?unit:'USD',measured:completed.length,basis:manual?'Your per-row cost override.':p.basis};
  }
  function aggregate(groups,{unitCost='',unit='USD',samples=[],review,workflow='generate'}={}){
    const mixed=groups.length>1;
    const reviewing=review&&review.mode!=='off';
    const bySettings=new Map();
    for(const sample of samples){const key=`${sample.method}:${sample.duration}`;if(!bySettings.has(key))bySettings.set(key,[]);bySettings.get(key).push(sample.elapsed);}
    const parts=groups.map(group=>{
      const p={...group,...estimate({...group,unitCost:mixed||reviewing?'':unitCost,unit,samples:reviewing?[]:bySettings.get(`${group.method}:${group.duration}`)||[]})};
      if(reviewing){
        const retries=review.mode==='redo'&&['kling-fal','kling-kie','seedance'].includes(group.method)?Math.min(2,Math.max(0,review.maxRetries||0)):0;
        const reviewCost=[.01*group.rows,.15*group.rows];
        const checks=retries?2:1;
        const initial=workflow==='existing'?0:1;
        p.cost=[initial*p.cost[0]+reviewCost[0],(initial+retries)*p.cost[1]+(1+retries)*checks*reviewCost[1]];
        p.time=[initial*p.time[0]+20*group.rows,(initial+retries)*p.time[1]+180*(1+retries)*checks*group.rows];
        p.unit='USD';p.basis+=` Quality review: speculative $0.01-$0.15 per vision-model check, charged by tokens, not a verified tariff. Automatic-redo failures require two independent checks. Upper range assumes all ${retries} permitted redos per row and both checks; lower assumes none. Review time is speculative 20-180s per check. Overrides are ignored when review is enabled to avoid mixing currencies.`;
      }
      return p;
    });
    return {parts,mixed,time:[0,1].map(i=>parts.reduce((n,p)=>n+p.time[i],0)),cost:[0,1].map(i=>parts.reduce((n,p)=>n+p.cost[i],0)),unit:mixed?'USD':parts[0]?.unit||'USD',measured:parts.some(p=>p.measured)};
  }
  const api={estimate,aggregate};if(typeof module==='object'&&module.exports)module.exports=api;else root.BatchEstimates=api;
})(globalThis);
