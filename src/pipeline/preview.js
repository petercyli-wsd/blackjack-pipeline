const http=require('node:http');
const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const path=require('node:path');
const {pipeline}=require('node:stream/promises');
const {inside}=require('./util');

// A built game expects to be served from "/" (it fetches /manifest.json, /clips/…), so each
// preview gets its own localhost port instead of a path under this app.
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8',
  '.md':'text/markdown; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.mp4':'video/mp4','.webm':'video/webm',
  '.woff2':'font/woff2','.woff':'font/woff','.wasm':'application/wasm','.txt':'text/plain; charset=utf-8'};
async function serve(root,req,res){
  let rel;try{rel=decodeURIComponent(new URL(req.url,'http://preview').pathname);}catch{res.writeHead(400).end();return;}
  let file=path.join(root,rel);
  if(!inside(root,file)&&path.resolve(file)!==path.resolve(root)){res.writeHead(404).end();return;}
  let stat=await fs.stat(file).catch(()=>null);
  if(stat?.isDirectory()){file=path.join(file,'index.html');stat=await fs.stat(file).catch(()=>null);}
  if(!stat&&!path.extname(rel)){file=path.join(root,'index.html');stat=await fs.stat(file).catch(()=>null);}
  if(!stat){res.writeHead(404,{'Content-Type':'text/plain'}).end('Not found');return;}
  await send(req,res,file,stat);
}
async function send(req,res,file,stat,extra={}){
  stat||=await fs.stat(file);
  const headers={'Content-Type':TYPES[path.extname(file).toLowerCase()]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-cache',...extra};
  let start=0,end=stat.size-1,code=200;
  const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range||'');
  if(range&&(range[1]||range[2])){
    if(!range[1])start=Math.max(0,stat.size-Number(range[2]));else{start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));}
    if(start>end||start>=stat.size){res.writeHead(416,{'Content-Range':`bytes */${stat.size}`}).end();return;}
    code=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length']=end-start+1;res.writeHead(code,headers);
  if(req.method==='HEAD'){res.end();return;}
  await pipeline(createReadStream(file,{start,end}),res).catch(()=>{});
}
function previews({idleMs=45*60*1000}={}){
  const open=new Map();
  function close(id){const p=open.get(id);if(!p)return;open.delete(id);clearTimeout(p.timer);p.server.closeAllConnections?.();p.server.close();}
  async function start(id,root){
    const existing=open.get(id);
    if(existing&&existing.root===root){existing.touch();return existing.url;}
    close(id);
    const p={root};p.touch=()=>{clearTimeout(p.timer);p.timer=setTimeout(()=>close(id),idleMs);p.timer.unref?.();};
    p.server=http.createServer((req,res)=>{p.touch();serve(root,req,res).catch(()=>{if(!res.headersSent)res.writeHead(500).end();else res.destroy();});});
    await new Promise((resolve,reject)=>{p.server.once('error',reject);p.server.listen(0,'127.0.0.1',resolve);});
    p.url=`http://127.0.0.1:${p.server.address().port}/`;p.touch();open.set(id,p);return p.url;
  }
  return {start,close,closeAll:()=>{for(const id of [...open.keys()])close(id);},url:id=>open.get(id)?.url||null};
}
module.exports={previews,serve,send,TYPES};
