const fs=require('node:fs');
const path=require('node:path');

// A definition is the whole contract between this app and a game repo: where the game code
// lives, what a valid take looks like, and each stage's command, outputs and checks. The game
// repo can ship its own copy (game.contractFile) to take over the stages as its method changes.
const KINDS=['command','transitions'];
const id=/^[a-z0-9][a-z0-9-]{0,39}$/;
function fail(def,detail){throw new Error(`Pipeline definition ${def?.id||'(unnamed)'}: ${detail}`);}
function regex(def,where,value){try{new RegExp(value);}catch(e){fail(def,`${where} is not a valid pattern (${e.message})`);}}
function strings(def,where,value){if(value!==undefined&&(!Array.isArray(value)||value.some(v=>typeof v!=='string'||!v)))fail(def,`${where} must be a list of paths`);}
function validateStages(def,stages){
  if(!Array.isArray(stages)||!stages.length)fail(def,'needs at least one stage');
  const seen=new Set();
  for(const s of stages){
    if(!s||!id.test(s.id||''))fail(def,`stage id "${s?.id}" must be lowercase letters, digits and dashes`);
    if(s.id==='prepare')fail(def,'"prepare" is reserved for the built-in Set up stage');
    if(seen.has(s.id))fail(def,`duplicate stage id ${s.id}`);seen.add(s.id);
    if(!KINDS.includes(s.kind))fail(def,`stage ${s.id} has unknown kind ${s.kind}`);
    if(typeof s.title!=='string'||!s.title)fail(def,`stage ${s.id} needs a title`);
    strings(def,`stage ${s.id} outputs`,s.outputs);
    if(def.enabled&&s.kind==='command'&&(!Array.isArray(s.run)||!s.run.length||s.run.some(a=>typeof a!=='string')))fail(def,`stage ${s.id} needs a run command`);
    if(def.enabled&&s.kind==='transitions'&&(typeof s.csv!=='string'||typeof s.sourceRoot!=='string'))fail(def,`stage ${s.id} needs csv and sourceRoot`);
    const steps=new Set();
    for(const step of s.steps||[]){
      if(!id.test(step.id||'')||steps.has(step.id))fail(def,`stage ${s.id} has an invalid or duplicate step "${step.id}"`);
      steps.add(step.id);strings(def,`step ${s.id}/${step.id} outputs`,step.outputs);
    }
    for(const [k,v] of Object.entries(s.markers||{}))regex(def,`stage ${s.id} marker ${k}`,v);
    for(const h of s.errorHints||[])regex(def,`stage ${s.id} error hint`,h.match);
    for(const k of ['failed','flagged','summary'])if(s.ingest?.[k])regex(def,`stage ${s.id} ingest ${k}`,s.ingest[k]);
    for(const v of s.verify||[])if(!v.exists&&!v.json)fail(def,`stage ${s.id} has a verify rule without exists/json`);
  }
}
function validate(def){
  if(!def||def.version!==1)fail(def,'version must be 1');
  if(!id.test(def.id||''))fail(def,'id must be lowercase letters, digits and dashes');
  if(typeof def.name!=='string'||!def.name)fail(def,'needs a name');
  if(typeof def.enabled!=='boolean')fail(def,'enabled must be true or false');
  if(def.enabled){
    if(!def.game?.localPath&&!def.game?.repo)fail(def,'game needs a localPath or a repo');
    const i=def.input||{};
    if(!Number.isInteger(i.width)||!Number.isInteger(i.height)||typeof i.fps!=='string')fail(def,'input needs width, height and fps');
  }
  strings(def,'game.exclude',def.game?.exclude);
  validateStages(def,def.stages);
  return def;
}
function load(dir){
  const defs=new Map();
  for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort()){
    const def=validate(JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')));
    if(defs.has(def.id))fail(def,`id ${def.id} is used twice`);
    defs.set(def.id,def);
  }
  return defs;
}
// The game's own contract replaces the stages (and toolchains) it declares. Paths and input
// rules stay with this app's copy, so a contract can't widen what a run may read or delete.
function merge(def,contract){
  if(!contract||typeof contract!=='object')throw new Error('The game contract must be a JSON object.');
  const merged={...def,stages:contract.stages??def.stages,toolchains:contract.toolchains??def.toolchains};
  validate(merged);
  return merged;
}
function publicView(def){
  return {id:def.id,name:def.name,tagline:def.tagline||'',enabled:def.enabled,disabledReason:def.disabledReason||null,
    game:{name:def.game?.name,localPath:def.game?.localPath||null,repo:def.game?.repo||null,ref:def.game?.ref||null},
    input:def.input||{},
    stages:def.stages.map(s=>({id:s.id,title:s.title,kind:s.kind,summary:s.summary||'',optional:!!s.optional,default:s.default!==false,keys:s.keys||[],
      steps:(s.steps||[]).map(({id,title,detail})=>({id,title,detail:detail||''}))}))};
}
module.exports={load,validate,merge,publicView};
