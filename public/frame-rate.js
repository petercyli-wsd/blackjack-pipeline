(function(root){
  'use strict';
  function parse(input,allowSource=false){
    const text=String(input).trim();
    if(allowSource&&text==='source')return {source:true};
    const error=()=>new Error('Use source to match clip A, or enter 1–60 fps as a fraction (24000/1001) or a decimal with up to 6 places.');
    let numerator,denominator;
    if(/^\d+\/\d+$/.test(text)) [numerator,denominator]=text.split('/').map(Number);
    else if(/^\d+(?:\.\d{1,6})?$/.test(text)){
      denominator=10**(text.split('.')[1]?.length||0);numerator=Math.round(Number(text)*denominator);
    }else throw error();
    if(!Number.isSafeInteger(numerator)||!Number.isSafeInteger(denominator)||denominator<=0||numerator/denominator<1||numerator/denominator>60)throw error();
    let a=numerator,b=denominator;while(b){const next=a%b;a=b;b=next;}numerator/=a;denominator/=a;
    if(numerator>2147483647||denominator>2147483647)throw error();
    return {numerator,denominator,rational:`${numerator}/${denominator}`,value:numerator/denominator};
  }
  const api={parse};if(typeof module==='object'&&module.exports)module.exports=api;else root.StudioFrameRate=api;
})(globalThis);
