const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
(async()=>{
  const root=path.resolve(__dirname,'..'),out=path.join(root,'dist',`DealerTransitionTeam-source-${Date.now()}`);
  await fs.mkdir(out,{recursive:true});
  for(const name of ['public','src','scripts','test'])await fs.cp(path.join(root,name),path.join(out,name),{recursive:true});
  for(const name of ['server.js','package.json','package-lock.json','README.md','DESKTOP-REFERENCE.md','.gitignore','.dockerignore','Dockerfile','render.yaml','Start Web App.cmd','Start Web App.vbs'])await fs.copyFile(path.join(root,name),path.join(out,name));
  if(process.platform==='win32'){
    const quote=s=>"'"+s.replaceAll("'","''")+"'";
    // Explicit forward-slash entry names also extract correctly on Unix.
    const command=`$ErrorActionPreference='Stop'
      Add-Type -AssemblyName System.IO.Compression
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $sourceRoot=${quote(out)}
      $sourceParent=Split-Path -Parent $sourceRoot
      $archive=[System.IO.Compression.ZipFile]::Open(${quote(out+'.zip')},[System.IO.Compression.ZipArchiveMode]::Create)
      try { Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force | ForEach-Object {
        $entry=$_.FullName.Substring($sourceParent.Length+1).Replace('\\','/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$_.FullName,$entry,[System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
      }} finally { $archive.Dispose() }`;
    execFileSync('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,stdio:'inherit'});
  }else execFileSync('zip',['-qr',out+'.zip',path.basename(out)],{cwd:path.dirname(out),stdio:'inherit'});
  console.log(`TEAM DEPLOYMENT SOURCE: ${out}.zip`);
})().catch(e=>{console.error(e);process.exitCode=1;});
