const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
(async()=>{
  const root=path.resolve(__dirname,'..');
  // Unique build folders prevent overwriting a running shareable copy.
  const out=path.join(root,'dist',`DealerTransitionWeb-${Date.now()}`);
  await fs.mkdir(path.join(out,'runtime'),{recursive:true});
  for(const name of ['public','src','node_modules'])await fs.cp(path.join(root,name),path.join(out,name),{recursive:true});
  for(const name of ['server.js','package.json','package-lock.json','README.md','DESKTOP-REFERENCE.md','Start Web App.vbs','Start Web App.cmd'])await fs.copyFile(path.join(root,name),path.join(out,name));
  await fs.copyFile(process.execPath,path.join(out,'runtime','node.exe'));
  // Include the runtime's license; dependencies retain their own license files.
  const license=path.join(path.dirname(process.execPath),'LICENSE');
  await fs.copyFile(license,path.join(out,'runtime','LICENSE')).catch(()=>{});
  const zip=`${out}.zip`;
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  execFileSync('powershell.exe',['-NoProfile','-Command',`Compress-Archive -LiteralPath ${quote(out)} -DestinationPath ${quote(zip)} -CompressionLevel Optimal`],{windowsHide:true,stdio:'inherit'});
  console.log(`SHARE THIS ZIP: ${zip}`);
  const source=path.join(root,'dist',`DealerTransitionWeb-source-${Date.now()}`);
  await fs.mkdir(source,{recursive:true});
  for(const name of ['public','src','scripts','test'])await fs.cp(path.join(root,name),path.join(source,name),{recursive:true});
  for(const name of ['server.js','package.json','package-lock.json','README.md','DESKTOP-REFERENCE.md','Dockerfile','render.yaml','.dockerignore','.gitignore','Start Web App.cmd','Start Web App.vbs'])await fs.copyFile(path.join(root,name),path.join(source,name));
  execFileSync('powershell.exe',['-NoProfile','-Command',`Compress-Archive -LiteralPath ${quote(source)} -DestinationPath ${quote(source+'.zip')} -CompressionLevel Optimal`],{windowsHide:true,stdio:'inherit'});
  console.log(`SOURCE ZIP (Linux/Windows): ${source}.zip`);
})().catch(e=>{console.error(e);process.exitCode=1;});
