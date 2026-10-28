const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const path=require('node:path');

// Streams a folder as a store-only ZIP (videos are already compressed), computing each CRC as the
// bytes go out and writing it after the data (a data descriptor), so nothing is read twice.
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc(n,buf){for(let i=0;i<buf.length;i++)n=table[(n^buf[i])&255]^(n>>>8);return n;}
async function list(root,dir='',out=[]){
  for(const e of (await fs.readdir(path.join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const rel=dir?`${dir}/${e.name}`:e.name;
    if(e.isDirectory())await list(root,rel,out);else if(e.isFile())out.push(rel);
  }
  return out;
}
async function plan(root,prefix=''){
  const files=[];let total=0;
  for(const rel of await list(root)){const size=(await fs.stat(path.join(root,rel))).size;files.push({rel,size,name:prefix+rel});total+=size;}
  const overhead=files.reduce((n,f)=>n+30+16+46+2*Buffer.byteLength(f.name),22);
  if(total+overhead>0xffffffff||files.length>0xffff)throw Object.assign(new Error('This folder is too large for a single ZIP (over 4 GB). Copy it from the run folder instead.'),{status:413});
  return {files,size:total+overhead};
}
async function write(out,root,{files},{signal}={}){
  const central=[];let offset=0;
  const put=async buf=>{if(signal?.aborted)throw new Error('Download cancelled');offset+=buf.length;if(!out.write(buf))await new Promise((resolve,reject)=>{out.once('drain',resolve);out.once('close',()=>reject(new Error('Download cancelled')));});};
  for(const f of files){
    const name=Buffer.from(f.name),start=offset,h=Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(0x0808,6);h.writeUInt16LE(0,8);h.writeUInt16LE(33,12);h.writeUInt16LE(name.length,26);
    await put(h);await put(name);
    let sum=0xffffffff,size=0;
    for await(const chunk of createReadStream(path.join(root,f.rel),{highWaterMark:1<<20})){sum=crc(sum,chunk);size+=chunk.length;await put(chunk);}
    sum=(sum^0xffffffff)>>>0;
    const d=Buffer.alloc(16);d.writeUInt32LE(0x08074b50,0);d.writeUInt32LE(sum,4);d.writeUInt32LE(size,8);d.writeUInt32LE(size,12);await put(d);
    const c=Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x0808,8);c.writeUInt16LE(33,14);
    c.writeUInt32LE(sum,16);c.writeUInt32LE(size,20);c.writeUInt32LE(size,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(start,42);
    central.push(c,name);
  }
  const at=offset;for(const b of central)await put(b);
  const e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50,0);e.writeUInt16LE(files.length,8);e.writeUInt16LE(files.length,10);e.writeUInt32LE(offset-at,12);e.writeUInt32LE(at,16);
  await put(e);
}
module.exports={plan,write,list};
