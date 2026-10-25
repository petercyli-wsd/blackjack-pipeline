const {test}=require('node:test');
const assert=require('node:assert/strict');
const {estimate,aggregate}=require('../public/batch-estimates');

test('mixed estimates sum distinct methods/durations, reject blanket overrides and use matching time samples',()=>{
  const groups=[{method:'film',duration:.33,rows:41},{method:'film',duration:.67,rows:123},{method:'kling-fal',duration:3,rows:4},{method:'blend',duration:.3,rows:2}];
  const result=aggregate(groups,{unitCost:999,unit:'credits',samples:[{method:'film',duration:.33,elapsed:10}]});
  assert.equal(result.unit,'USD');assert.equal(result.parts[0].measured,1);assert.equal(result.parts[1].measured,0);assert.equal(result.parts[2].measured,0);
  assert.deepEqual(result.parts[3].cost,[0,0]);assert.equal(result.parts[0].cost[0],.005*41);
  assert.equal(result.cost[0],result.parts.reduce((sum,p)=>sum+p.cost[0],0));
  assert.equal(result.time[0],result.parts.reduce((sum,p)=>sum+p.time[0],0));
  assert.deepEqual(aggregate([groups[0]],{unitCost:2,unit:'credits'}).cost,[82,82]);
  assert.deepEqual(aggregate([]).time,[0,0]);
});
test('preflight estimates cover every method, scale with rows/duration and accept manual costs',()=>{
  for(const method of ['film','rife','kling-fal','kling-kie','seedance','flow','blend','dissolve']){
    const e=estimate({method,duration:4,rows:871});assert.ok(e);assert.ok(e.time[0]>0);assert.ok(e.time[1]>=e.time[0]);assert.ok(e.cost[0]>=0);assert.equal(e.measured,0);
  }
  assert.equal(estimate({method:'kling-kie',duration:4,rows:100}).cost[0],36);
  assert.deepEqual(estimate({method:'seedance',duration:4,rows:100,unitCost:7,unit:'credits'}).cost,[700,700]);
  const local=estimate({method:'blend',duration:.3,rows:100,unitCost:7,unit:'credits'});
  assert.deepEqual(local.cost,[0,0]);assert.equal(local.unit,'USD');assert.match(local.basis,/Local blend/);
  assert.deepEqual(estimate({method:'film',duration:.3,rows:0}).cost,[0,0]);
  assert.equal(estimate({method:'seedance',duration:NaN,rows:1}),null);
  const measured=estimate({method:'film',duration:.3,rows:10,samples:[40,60]});assert.equal(measured.measured,2);assert.deepEqual(measured.time,[375,750]);
  assert.deepEqual(estimate({method:'kling-kie',duration:8,rows:100}).cost,[72,72]);
  assert.equal(estimate({method:'film',duration:.4,rows:1,unitCost:''}).perRow[0],.005);
  assert.deepEqual(estimate({method:'film',duration:.4,rows:1,unitCost:0}).perRow,[0,0]);
  assert.equal(estimate({method:'rife',duration:.4,rows:1,samples:[null,undefined,NaN,-1,0,...Array(12).fill(60)]}).measured,10);
});
