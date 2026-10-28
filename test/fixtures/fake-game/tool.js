// Stands in for a game repo's pipeline in tests: bj3-style [run ]/[done]/[skip] markers,
// skip-if-output-exists caching, partial writes, and failures/pauses steered by files in
// FAKE_CONTROL (fail-<step>, slow-<step> released by release-<step>).
const fs=require('node:fs');
const path=require('node:path');
const control=process.env.FAKE_CONTROL||'.';
const flag=name=>fs.existsSync(path.join(control,name));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const [cmd,...args]=process.argv.slice(2);
(async()=>{
  if(cmd==='clips'){
    fs.mkdirSync('work',{recursive:true});
    for(const step of ['a','b','c']){
      const out=path.join('work',`${step}.txt`);
      if(fs.existsSync(out)){console.log(`[skip] ${step} (${out} exists)`);continue;}
      console.log(`[run ] ${step}`);
      fs.writeFileSync(out,'partial');
      if(flag(`slow-${step}`))while(!flag(`release-${step}`))await sleep(25);
      if(flag(`fail-${step}`)){console.error('Traceback (most recent call last):');console.error(`RuntimeError: BOOM at ${step}`);process.exit(1);}
      fs.writeFileSync(out,`done ${step} from ${path.basename(args[0]||'')}`);
      console.log(`[done] ${step} in 0s`);
    }
    fs.mkdirSync('work/stubs/exit',{recursive:true});fs.mkdirSync('work/stubs/entry',{recursive:true});
    const rows=Number(fs.existsSync(path.join(control,'rows'))?fs.readFileSync(path.join(control,'rows'),'utf8'):3),method=fs.existsSync(path.join(control,'method'))?fs.readFileSync(path.join(control,'method'),'utf8').trim():'blend';
    const lines=['first_half,second_half,output,method,duration'];
    for(let i=0;i<rows;i++){fs.copyFileSync(args[0],`work/stubs/exit/e${i}.mp4`);fs.copyFileSync(args[0],`work/stubs/entry/n${i}.mp4`);lines.push(`exit/e${i}.mp4,entry/n${i}.mp4,${i===1&&flag('bad-row')?'bad':'row'}${i}.mp4,${method},${((method==='film'?0.33:0.3)+(flag('distinct')?i/10:0)+(flag(`shift-${i}`)?0.05:0)).toFixed(2)}`);}
    fs.writeFileSync('work/plan.csv',lines.join('\n'));
  }else if(cmd==='ingest'){
    fs.mkdirSync('work/ingested',{recursive:true});let n=0;
    for(const f of fs.readdirSync(args[0]).filter(f=>f.endsWith('.mp4'))){
      if(f.startsWith('bad')){console.log(`  ! ${f}: stubs not found (exit 99.0, entry 99.0)`);continue;}
      fs.copyFileSync(path.join(args[0],f),path.join('work/ingested',f));n++;
    }
    console.log(`SUMMARY: ${n} generated`);
  }else if(cmd==='verdict'){
    fs.mkdirSync('work',{recursive:true});fs.writeFileSync('work/verdicts.json',JSON.stringify({[args[0]]:{verdict:args[1],note:args[2]}}));
  }else if(cmd==='build'){
    if(flag('fail-build')){console.error('src/table.ts(3,1): error TS2304: Cannot find name x.');process.exit(2);}
    fs.mkdirSync('out/clips',{recursive:true});fs.writeFileSync('out/index.html','<!doctype html><title>game</title>');fs.writeFileSync('out/clips/a.txt','clip');
  }else if(cmd==='reset'){fs.writeFileSync('work/reset.txt','yes');}
})();
