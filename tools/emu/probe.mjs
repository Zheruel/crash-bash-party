import {chromium} from 'playwright-core';
const b=await chromium.launch({executablePath:process.env.HOME+'/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell',args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required']});
const p=await b.newPage({viewport:{width:960,height:720}});
p.on('pageerror',e=>console.log('ERR',e.message));p.on('console',m=>console.log('C',m.text().slice(0,200)));
await p.goto('http://localhost:8080/');
for(let i=0;i<6;i++){await p.waitForTimeout(8000);await p.screenshot({path:`emu/probe${i}.png`});console.log('shot',i);}
await b.close();
