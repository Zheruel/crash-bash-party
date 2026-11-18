// persistent emulator driver: http://127.0.0.1:9333/key?k=Enter&hold=100&n=1 | /shot?f=name | /eval?js=...
import {chromium} from 'playwright-core'; import http from 'node:http'; import fs from 'node:fs';
const OUT=process.env.EMU_OUT||'/private/tmp/claude-501/-Users-tinzeljar-Documents-crash-bash/0b16b027-8169-4540-9159-32d3215a93f5/scratchpad/emu/';
const b=await chromium.launch({executablePath:process.env.HOME+'/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell',args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required']});
const p=await b.newPage({viewport:{width:640,height:480}});
p.on('pageerror',e=>{});
await p.goto('http://localhost:8080/');
await p.mouse.click(320,240);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://x'); const q=u.searchParams;
    if(u.pathname==='/key'){ const keys=q.get('k').split(','); const hold=+(q.get('hold')||120), gap=+(q.get('gap')||250);
      for(let i=0;i<(+q.get('n')||1);i++) for(const k of keys){ await p.keyboard.down(k); await sleep(hold); await p.keyboard.up(k); await sleep(gap);} res.end('ok'); }
    else if(u.pathname==='/shot'){ const f=OUT+(q.get('f')||'s')+'.png'; await p.screenshot({path:f}); res.end(f); }
    else if(u.pathname==='/eval'){ const r=await p.evaluate(q.get('js')); res.end(JSON.stringify(r)); }
    else if(u.pathname==='/wait'){ await sleep(+q.get('ms')); res.end('ok'); }
    else res.end('?');
  }catch(e){res.statusCode=500;res.end(String(e));}
}).listen(Number(process.env.DRV_PORT||9333),'127.0.0.1',()=>console.log('drv up'));
