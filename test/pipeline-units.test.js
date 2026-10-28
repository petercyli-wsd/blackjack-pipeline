// Units behind the pipeline engine: definitions, the process watchdog, ZIP downloads and path safety.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {PassThrough}=require('node:stream');
const {setTimeout:delay}=require('node:timers/promises');
const definitions=require('../src/pipeline/definitions');
const zip=require('../src/pipeline/zip');
const util=require('../src/pipeline/util');
const {describe,expandArgs,runProcess}=require('../src/pipeline/command');
const {declaredExtras}=require('../src/pipeline/workspace');

test('built-in definitions load: 3-seat is enabled, 7-seat is disabled with a reason',()=>{
  const defs=definitions.load(path.join(__dirname,'..','pipelines'));
  assert.equal(defs.get('3-seat').enabled,true);assert.equal(defs.get('7-seat').enabled,false);assert.match(defs.get('7-seat').disabledReason,/Not produced yet/);
  const view=definitions.publicView(defs.get('3-seat'));
  assert.deepEqual(view.stages.map(s=>s.id),['clips','scene','mattes','transitions','game']);
  assert.equal(view.stages.find(s=>s.id==='mattes').default,false);assert.deepEqual(view.stages.find(s=>s.id==='mattes').keys,['runninghub']);
});

test('invalid definitions and game contracts are rejected with a reason; a contract can replace stages only',()=>{
  const base={version:1,id:'x',name:'X',enabled:true,game:{localPath:'.'},input:{width:2,height:2,fps:'24'},stages:[{id:'a',title:'A',kind:'command',run:['x']}]};
  assert.throws(()=>definitions.validate({...base,stages:[{id:'prepare',title:'P',kind:'command',run:['x']}]}),/reserved/);
  assert.throws(()=>definitions.validate({...base,stages:[{id:'a',title:'A',kind:'nope'}]}),/unknown kind/);
  assert.throws(()=>definitions.validate({...base,stages:[{id:'a',title:'A',kind:'command',run:['x'],markers:{start:'('}}]}),/not a valid pattern/);
  assert.throws(()=>definitions.validate({...base,stages:[{id:'a',title:'A',kind:'command',run:['x']},{id:'a',title:'B',kind:'command',run:['y']}]}),/duplicate/);
  assert.throws(()=>definitions.validate({...base,game:{}}),/localPath or a repo/);
  const merged=definitions.merge(base,{stages:[{id:'cut',title:'Cut',kind:'command',run:['new']}],game:{localPath:'C:/evil'}});
  assert.equal(merged.stages[0].id,'cut');assert.equal(merged.game.localPath,'.');
  assert.throws(()=>definitions.merge(base,{stages:[]}),/at least one stage/);
});

test('outputs can only be deleted inside the run, with simple wildcards',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wipe-'));
  await fs.mkdir(path.join(root,'b'),{recursive:true});for(const f of ['a.csv','b.csv','keep.json'])await fs.writeFile(path.join(root,'b',f),'x');
  await util.wipe(root,['b/*.csv']);assert.deepEqual(await fs.readdir(path.join(root,'b')),['keep.json']);
  for(const bad of ['../outside','/etc','C:/Windows','a/../../x'])await assert.rejects(()=>util.wipe(root,[bad]),/Invalid output path/);
  await assert.rejects(()=>util.remove(root,root),/outside/);
});

test('failure descriptions use the definition\'s hints and the tool\'s last error line',()=>{
  const result={code:1,timedOut:false,tail:{stdout:['[run ] edl'],stderr:['Traceback (most recent call last):','  File "edl.py", line 64','ValueError: no quiet after 4410']}};
  const e=describe(result,{title:'Clips',hints:[{match:'no quiet (?:after|before) (\\d+)',message:'Still moment missing near frame $1.',fix:'Check the take.'}]});
  assert.equal(e.message,'Still moment missing near frame 4410.');assert.equal(e.fix,'Check the take.');assert.equal(e.detail,'ValueError: no quiet after 4410');
  const plain=describe(result,{title:'Clips'});assert.match(plain.message,/exit code 1/);
  assert.throws(()=>expandArgs(['{missing}'],{}),/isn't available/);assert.throws(()=>expandArgs(['{key:fal}'],{}),/only be passed through env/);
  assert.deepEqual(expandArgs(['{npm}','run','build'],{npm:['node','npm-cli.js']}),['node','npm-cli.js','run','build']);
  assert.deepEqual(declaredExtras('[project]\nname="x"\n[project.optional-dependencies]\nsam = ["torch"]\ndev=["x"]\n[tool.uv]\npackage=false\n'),['sam','dev']);
  assert.deepEqual(declaredExtras('[project]\nname="x"\n'),[]);
});

test('a missing tool is reported as not installed rather than as a crash',async()=>{
  await assert.rejects(()=>runProcess({argv:['definitely-not-a-real-tool-xyz','--version']}),e=>e.code==='ENOENT');
  const ok=await runProcess({argv:[process.execPath,'-e','console.log("hi");console.error("warn");process.exit(3)']});
  assert.equal(ok.code,3);assert.deepEqual(ok.tail.stdout,['hi']);assert.deepEqual(ok.tail.stderr,['warn']);
});

test('stage processes die with a crashed server instead of running on as orphans',{timeout:30000},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'orphan-')),pidFile=path.join(root,'pid');
  const sleeper=`require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const server=spawn(process.execPath,['-e',`require(${JSON.stringify(path.join(__dirname,'..','src','pipeline','command.js'))}).runProcess({argv:[process.execPath,'-e',${JSON.stringify(sleeper)}]});setInterval(()=>{},1000)`],{stdio:'ignore'});
  let pid;for(let i=0;i<200&&!pid;i++){pid=Number(await fs.readFile(pidFile,'utf8').catch(()=>0));await delay(50);}
  assert.ok(pid,'the stage process started');
  const alive=p=>{try{process.kill(p,0);return true;}catch{return false;}};
  assert.equal(alive(pid),true);
  server.kill('SIGKILL'); // no clean shutdown: the watchdog must notice on its own
  let gone=false;for(let i=0;i<120&&!gone;i++){gone=!alive(pid);await delay(100);}
  assert.equal(gone,true,'the orphaned stage process was killed');
});

test('ZIP downloads are valid store-only archives with correct CRCs',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'zip-'));
  await fs.mkdir(path.join(root,'clips','sub'),{recursive:true});
  const files={'index.html':'<!doctype html>','clips/a.mp4':Buffer.alloc(300000,7),'clips/sub/ü.json':'{"x":1}'};
  for(const [n,v] of Object.entries(files))await fs.writeFile(path.join(root,n),v);
  const plan=await zip.plan(root,'game/');const out=new PassThrough(),chunks=[];out.on('data',c=>chunks.push(c));
  await zip.write(out,root,plan);out.end();const buf=Buffer.concat(chunks);
  assert.equal(buf.length,plan.size,'Content-Length matches the bytes sent');
  const end=buf.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06])),count=buf.readUInt16LE(end+10);let at=buf.readUInt32LE(end+16);
  assert.equal(count,3);
  const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  const crc=b=>{let n=0xffffffff;for(const x of b)n=table[(n^x)&255]^(n>>>8);return (n^0xffffffff)>>>0;};
  const seen={};
  for(let i=0;i<count;i++){
    assert.equal(buf.readUInt32LE(at),0x02014b50);
    const sum=buf.readUInt32LE(at+16),size=buf.readUInt32LE(at+20),nameLen=buf.readUInt16LE(at+28),offset=buf.readUInt32LE(at+42),name=buf.toString('utf8',at+46,at+46+nameLen);
    const local=offset,localName=buf.readUInt16LE(local+26),data=buf.subarray(local+30+localName,local+30+localName+size);
    assert.equal(crc(data),sum,`${name} CRC`);seen[name]=data;at+=46+nameLen;
  }
  assert.deepEqual(Object.keys(seen).sort(),['game/clips/a.mp4','game/clips/sub/ü.json','game/index.html']);
  assert.equal(seen['game/clips/a.mp4'].length,300000);
});

test('a data folder too deep for Windows paths is refused before installing anything',async()=>{
  const {checkPathLength,longPathsEnabled}=require('../src/pipeline/workspace');
  await checkPathLength(path.win32.join('C:/','short','toolchains','py-123456789abc'));
  if(process.platform!=='win32'||await longPathsEnabled())return; // the limit only exists on Windows with long paths off
  await assert.rejects(()=>checkPathLength(path.win32.join('C:/',...Array(30).fill('deep'),'py-123456789abc')),e=>/260-character/.test(e.message)&&/DATA_DIR/.test(e.fix)&&/LongPathsEnabled/.test(e.fix));
});
