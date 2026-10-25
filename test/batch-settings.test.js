const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseCSV,prepare}=require('../public/batch-format');
const {resolve,groups,missingKeys}=require('../public/batch-settings');
const {METHODS}=require('../src/models');
const panel={method:'film',duration:.4};
const settings=row=>resolve(row,panel,METHODS);

test('named CSV columns reorder, ignore case and extras, and preserve blank optional cells',()=>{
  const records=parseCSV('Duration,Output,SCORE,SECOND_HALF,METHOD,FIRST_HALF,notes\n0.33,out.mp4,98,b.mp4,FiLm,a.mp4,"note, one"\n,out2.mp4,99,b.mp4,,a.mp4,');
  assert.deepEqual(records.warnings,['Ignored CSV columns: score, notes.']);
  const rows=prepare(records);assert.ok(rows.every(r=>r.state==='pending'));
  assert.equal(rows[0].a,'a.mp4');assert.equal(rows[0].b,'b.mp4');assert.equal(rows[0].name,'out.mp4');
  assert.equal(settings(rows[0]).duration,.33);assert.equal(settings(rows[0]).method,'film');
  assert.equal(settings(rows[1]).duration,.4);assert.equal(settings(rows[1]).settingSource,'panel');
  const restored=JSON.parse(JSON.stringify({records,columns:records.columns}));
  assert.deepEqual(prepare(restored.records,'','',restored.columns),rows);
  assert.deepEqual(parseCSV('first_half,second_half,output,\na,b,c.mp4,').warnings,['Ignored CSV columns: (unnamed column 4).']);
});

test('extended CSV requires a complete, unambiguous header; legacy three-column inputs remain equivalent',()=>{
  for(const input of ['a,b,c.mp4,film,.33','a,b,c.mp4\na,b,d.mp4,film'])assert.throws(()=>parseCSV(input),/header is required/);
  assert.throws(()=>parseCSV('first_half,second_half,method,duration\na,b,film,.3'),/missing required column: output/);
  assert.throws(()=>parseCSV('first_half,second_half,output,METHOD,method\na,b,c,film,rife'),/Duplicate CSV header: method/);
  const legacy=prepare(parseCSV('a.mp4,b.mp4,out.mp4'));
  assert.deepEqual(prepare(parseCSV('FIRST_HALF,SECOND_HALF,OUTPUT\na.mp4,b.mp4,out.mp4')),legacy);
  assert.deepEqual(settings(legacy[0]),settings({}));
  assert.equal(prepare(parseCSV('first_half,second_half,output,method\na,b,c.mp4'))[0].state,'invalid');
});

test('row settings follow CSV, panel and method-default precedence without rounding',()=>{
  assert.deepEqual(settings({csvMethod:'RIFE',csvDuration:'0.33'}),{method:'rife',duration:.33,provider:'fal',methodSource:'csv',durationSource:'csv',settingSource:'csv'});
  assert.equal(settings({csvMethod:'film'}).duration,.4);
  assert.equal(settings({csvMethod:'film'}).durationSource,'panel');
  assert.equal(settings({csvMethod:'kling-fal'}).duration,3);
  assert.equal(settings({csvMethod:'kling-fal'}).settingSource,'method default');
  assert.equal(settings({csvDuration:'.67'}).duration,.67);
  assert.equal(settings({csvDuration:'.67'}).methodSource,'panel');
  for(const m of METHODS)assert.equal(resolve({csvMethod:m.id},{method:m.id,duration:m.defaultDuration},METHODS).duration,m.defaultDuration);
});

test('bad methods and durations fail per row; generative durations require whole seconds',()=>{
  assert.throws(()=>settings({csvMethod:'unknown'}),/Unknown method/);
  for(const value of ['NaN','Infinity','-1','1e0','0x1','hello','0','.099','2.001'])assert.throws(()=>settings({csvDuration:value}),/duration/);
  for(const method of METHODS){
    assert.throws(()=>settings({csvMethod:method.id,csvDuration:String(method.max+1)}),/duration must be/);
    if(method.provider!=='local'&&method.kind!=='interpolation')assert.throws(()=>settings({csvMethod:method.id,csvDuration:String(method.min+.5)}),/whole number/);
  }
});

test('missing provider keys aggregate methods and counts across durations; local rows need none',()=>{
  const rows=[{csvMethod:'film',csvDuration:'.33'},{csvMethod:'film',csvDuration:'.67'},{csvMethod:'rife'},{csvMethod:'kling-fal'},{csvMethod:'kling-kie'},{csvMethod:'seedance'},{csvMethod:'blend'}];
  assert.deepEqual(missingKeys(rows,panel,METHODS,{}),['fal: film (2 rows), rife (1 row), kling-fal (1 row), seedance (1 row)','kie: kling-kie (1 row)']);
  assert.deepEqual(missingKeys(rows,panel,METHODS,{fal:true}),['kie: kling-kie (1 row)']);
  assert.deepEqual(missingKeys(rows,panel,METHODS,{fal:true,kie:true}),[]);
  assert.equal(groups(rows,panel,METHODS).length,7);
});

test('checkpointed per-row settings survive serialization and changed defaults',()=>{
  for(const row of [{},{csvMethod:'kling-fal'},{csvMethod:'film',csvDuration:'.33'}]){
    const original=settings(row),saved=JSON.parse(JSON.stringify({...row,resolvedSettings:original}));
    assert.deepEqual(resolve(saved,{method:'seedance',duration:12},METHODS),original);
  }
});
