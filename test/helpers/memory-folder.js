// File System Access double: writes commit only on close, abort keeps old bytes.
const missing=()=>Object.assign(new Error('File not found'),{name:'NotFoundError'});
function memoryFolder(initial={}){
  const data=new Map(),directories=new Set(['']),writes=[],options={};let version=0;
  const put=(path,bytes)=>{const segments=path.split('/');for(let i=1;i<segments.length;i++)directories.add(segments.slice(0,i).join('/'));data.set(path,{blob:new Blob([bytes]),modified:++version});};
  Object.entries(initial).forEach(([path,bytes])=>put(path,bytes));
  function directory(prefix=''){
    const full=name=>prefix?prefix+'/'+name:name;
    return {name:prefix.split('/').at(-1)||'originals',
      async removeEntry(name){const path=full(name);if(!data.delete(path))throw missing();},
      async getDirectoryHandle(name,{create=false}={}){const path=full(name);if(!directories.has(path)){if(!create)throw missing();directories.add(path);}return directory(path);},
      async getFileHandle(name,{create=false}={}){
        const path=full(name);if(!data.has(path)){if(!create)throw missing();put(path,'');}
        return {
          async getFile(){const value=data.get(path);if(!value)throw missing();return new File([value.blob],name,{lastModified:value.modified});},
          async createWritable(){
            // A real WritableStream (folder saves pipe into it) that also takes write(chunk) calls.
            const chunks=[];
            const stream=new WritableStream({
              write(chunk){if(options.failWrite?.(path))throw new Error('Disk write failed');chunks.push(chunk);},
              async close(){if(options.beforeClose)await options.beforeClose(path);if(options.failClose?.(path))throw new Error('Disk commit failed');put(path,new Blob(chunks));writes.push(path);}
            });
            stream.write=async chunk=>{const writer=stream.getWriter();try{await writer.write(chunk);}finally{writer.releaseLock();}};
            return stream;
          }
        };
      }
    };
  }
  return {root:directory(),data,writes,options,put,text:async path=>data.get(path)?.blob.text()};
}
module.exports={memoryFolder};
