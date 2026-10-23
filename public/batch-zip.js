// Store-only ZIP: MP4 is already compressed. Read CRCs in 1 MB chunks, not one huge array.
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.BatchZip=api;})(globalThis,()=>{
  const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  async function crc(blob){let n=0xffffffff;for(let i=0;i<blob.size;i+=1048576)for(const b of new Uint8Array(await blob.slice(i,i+1048576).arrayBuffer()))n=table[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
  async function create(entries){
    const parts=[],central=[];let offset=0,total=0;
    if(entries.length>10000)throw new Error('Too many ZIP entries.');
    for(const {name,blob} of entries){
      const bytes=new TextEncoder().encode(name),sum=await crc(blob);
      if(blob.size+offset+bytes.length+30>0xffffffff)throw new Error('ZIP part exceeds 4 GB. Use an output folder instead.');
      const h=new Uint8Array(30+bytes.length),v=new DataView(h.buffer);
      v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint16(12,33,true);
      v.setUint32(14,sum,true);v.setUint32(18,blob.size,true);v.setUint32(22,blob.size,true);v.setUint16(26,bytes.length,true);h.set(bytes,30);
      parts.push(h,blob);
      const c=new Uint8Array(46+bytes.length),d=new DataView(c.buffer);
      d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(8,0x800,true);d.setUint16(14,33,true);
      d.setUint32(16,sum,true);d.setUint32(20,blob.size,true);d.setUint32(24,blob.size,true);d.setUint16(28,bytes.length,true);d.setUint32(42,offset,true);c.set(bytes,46);
      central.push(c);total+=c.length;offset+=h.length+blob.size;
    }
    const end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,total,true);v.setUint32(16,offset,true);
    return new Blob([...parts,...central,end],{type:'application/zip'});
  }
  return {create};
});
