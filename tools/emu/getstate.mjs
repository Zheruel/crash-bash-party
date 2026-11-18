// node getstate.mjs out.bin  (asks drv to return base64 via chunks)
import fs from 'node:fs';
const [,,out]=process.argv;
const ev=async(js)=>JSON.parse(await (await fetch('http://127.0.0.1:'+(process.env.DRV_PORT||9333)+'/eval?js='+encodeURIComponent(js))).text());
const n=await ev('(window.ST=EJS_emulator.gameManager.getState()).length');
const bufs=[]; const CH=3*1024*1024;
for(let o=0;o<n;o+=CH){ const b64=await ev(`(()=>{const a=ST.subarray(${o},${Math.min(n,o+CH)});let s='';for(let i=0;i<a.length;i+=32768)s+=String.fromCharCode.apply(null,a.subarray(i,i+32768));return btoa(s)})()`); bufs.push(Buffer.from(b64,'base64')); }
fs.writeFileSync(out,Buffer.concat(bufs)); console.log(n);
