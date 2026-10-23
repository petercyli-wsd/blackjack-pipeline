(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.BatchFormat=api;})(globalThis,()=>{
  function parseCSV(text){
    text=text.replace(/^\uFEFF/,'');
    const rows=[];let row=[],field='',quoted=false,closed=false;
    const endField=()=>{row.push(field.trim());field='';closed=false;};
    const endRow=()=>{endField();if(row.some(Boolean))rows.push(row);row=[];if(rows.length>10001)throw new Error('Maximum 10,000 data rows per CSV.');};
    for(let i=0;i<text.length;i++){
      const c=text[i];
      if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
      if(c===','){endField();continue;}
      if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;endRow();continue;}
      if(c==='"'&&!field.trim()&&!closed){field='';quoted=true;continue;}
      if(c==='"'||(closed&&!/\s/.test(c)))throw new Error('Malformed CSV quoting. Quote fields containing commas and double any embedded quotes.');
      if(!closed)field+=c;
    }
    if(quoted)throw new Error('Unclosed quoted field in CSV.');
    if(field||row.length||closed)endRow();
    if(rows[0]?.map(x=>x.toLowerCase()).join(',')==='first_half,second_half,output')rows.shift();
    if(!rows.length)throw new Error('CSV has no data rows.');
    if(rows.length>10000)throw new Error('Maximum 10,000 data rows per CSV.');
    return rows;
  }
  const slashes=p=>p.replace(/\\/g,'/');
  const absolute=p=>p.startsWith('/')||/^[a-z]:/i.test(p);
  function relativePath(value,base,label){
    let p=slashes(value.trim()),b=slashes(base.trim()).replace(/\/+$/,'');
    if(absolute(p)){
      if(!base.trim()||!absolute(slashes(base.trim())))throw new Error(`${label}: set its absolute root path above.`);
      const windows=/^[a-z]:/i.test(b)||b.startsWith('//');
      const prefix=b+'/',left=windows?p.toLowerCase():p,right=windows?prefix.toLowerCase():prefix;
      if(!left.startsWith(right))throw new Error(`${label}: path is outside the configured root.`);
      p=p.slice(prefix.length);
    }
    if(!p||p.split('/').some(x=>!x||x==='.'||x==='..')||/[\x00-\x1f]/.test(p))throw new Error(`${label}: empty, traversal or invalid path.`);
    return p;
  }
  function outputPath(value,base=''){
    const p=relativePath(value,base,'Output');
    if(!/\.mp4$/i.test(p))throw new Error('Output must end in .mp4.');
    if(p.length>1024||p.split('/').some(x=>/[<>:"|?*]/.test(x)||/[. ]$/.test(x)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(x)))throw new Error('Output contains a filename that is unsafe on Windows/macOS/Linux.');
    return p;
  }
  function prepare(records,inputRoot='',outputRoot=''){
    const used=new Set();
    return records.map((fields,index)=>{
      const row={number:index+1,first:fields[0]||'',second:fields[1]||'',output:fields[2]||'',state:'pending',error:''};
      try{
        if(fields.length!==3)throw new Error(`Expected 3 columns, found ${fields.length}.`);
        row.a=relativePath(row.first,inputRoot,'First half');row.b=relativePath(row.second,inputRoot,'Second half');row.name=outputPath(row.output,outputRoot);
        const key=row.name.toLowerCase();if(used.has(key))throw new Error('Duplicate output name (case-insensitive).');used.add(key);
      }catch(e){row.state='invalid';row.error=e.message;}
      return row;
    });
  }
  function csv(rows){return rows.map(row=>row.map(value=>'"'+String(value??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');}
  return {parseCSV,prepare,relativePath,outputPath,csv};
});
