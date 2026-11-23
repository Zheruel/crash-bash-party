// Runtime T-pose sweep: plays solo all-bot rounds of every game stage with every character in headless Chromium
// and collects window.__tposes (dev-only detector in client/crash.ts ModelInstance).
//
//   cd web && node scripts/pose-sweep.mjs [--port 5480] [--out DIR] [--stages pushOff:polar,ringDing] [--conc 3] [--cap 45]
//
// Starts its own `vite` on --port (default 5480) unless --no-vite. playwright-core comes from tools/emu/node_modules
// (or set PLAYWRIGHT_CORE to a playwright-core dir: `npm i --prefix /some/dir playwright-core`; Chromium comes from ~/Library/Caches/ms-playwright). Exits non-zero if any record of kind "bind" is found.
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes('--' + n);
const port = Number(arg('port', 5480));
const out = path.resolve(arg('out', path.join(webDir, '../.pose-sweep')));
const conc = Number(arg('conc', 3));
const cap = Number(arg('cap', 0)); // 0 = FASTISH 5 s rounds (mostly draws); e.g. 45 lets bots reach a real winner
const ROUNDS = 3; // 3 rounds x 4 seats walk all 10 characters (0..9, then wrap)
const CHARS = '0,1,2,3,4,5,6,7,8,9';

const require = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_CORE ?? [path.resolve(webDir, '../tools/emu/node_modules/playwright-core'), 'playwright-core'].find((p) => { try { require.resolve(p); return true; } catch { return false; } });
if (!pwPath) throw new Error('playwright-core not found: npm i --prefix /tmp/pw playwright-core, then PLAYWRIGHT_CORE=/tmp/pw/node_modules/playwright-core');
const { chromium } = require(pwPath);

let stages = arg('stages')?.split(',');
if (!stages) {
  const list = execFileSync('npx', ['tsx', '-e', "import {GAMES} from './shared/registry'; console.log(GAMES.flatMap(g=>(g.variants??[]).length?g.variants.map(v=>g.id+':'+v.id):[g.id]).join(','))"], { cwd: webDir }).toString().trim();
  stages = list.split(',');
}
fs.mkdirSync(out, { recursive: true });

let vite = null;
if (!flag('no-vite')) {
  vite = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { cwd: webDir, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://localhost:${port}/`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
}
const browser = await chromium.launch({ args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const cleanup = async () => { await browser.close().catch(() => {}); vite?.kill(); };
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

/** --selftest: prove the detector fires. A catalog-less polarFoot-style ref (model with clips, no anims map) must record 'bind'. */
async function selftest() {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/?nopeer=1`);
  await page.waitForSelector('#create', { timeout: 60000 });
  const recs = await page.evaluate(async () => {
    const m = await import('/client/crash.ts');
    const ref = { model: 9008, scale: 1 };
    await m.ready([ref]);
    const inst = new m.ModelInstance(ref);
    inst.build();
    inst.play('idle');
    inst.update(0.03);
    return window.__tposes ?? [];
  });
  await page.close();
  return recs.some((r) => r.kind === 'bind' && r.model === 9008);
}
if (flag('selftest')) {
  const ok = await selftest();
  console.log(ok ? 'selftest ok: detector recorded the bind pose' : 'selftest FAILED: no bind record');
  await cleanup();
  process.exit(ok ? 0 : 1);
}

async function sweepStage(stage) {
  const dir = path.join(out, stage.replace(':', '_'));
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 640, height: 400 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(`http://localhost:${port}/?game=${stage}&fast=1&nopeer=1&allbots=1&chars=${CHARS}&rounds=${ROUNDS}${cap ? '&cap=' + cap : ''}`);
  await page.waitForSelector('#create', { timeout: 60000 });
  await page.click('#create');
  await page.waitForSelector('button[data-act=ready]', { timeout: 30000 });
  await page.click('button[data-act=ready]');
  const shots = [];
  const t0 = Date.now();
  const limit = ROUNDS * ((cap || 5) * 1000 + 30000) + 30000;
  let last = '', n = 0;
  while (Date.now() - t0 < limit) {
    const phase = await page.evaluate(() => window.__phase ?? '');
    last = phase || last;
    if (['intro', 'countdown', 'play', 'results'].includes(phase)) {
      const f = path.join(dir, `${String(n++).padStart(3, '0')}-${phase}.png`);
      await page.screenshot({ path: f }).catch(() => {});
      shots.push(f);
    }
    if (phase === 'final') break;
    await page.waitForTimeout(phase === 'play' ? 700 : 500);
  }
  const tposes = await page.evaluate(() => window.__tposes ?? []);
  // contact sheet: an HTML grid of the sampled frames rendered to one png
  const sheet = await ctx.newPage();
  const imgs = shots.map((f) => `<figure><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}" width="320"><figcaption>${path.basename(f)}</figcaption></figure>`).join('');
  await sheet.setViewportSize({ width: 1300, height: 800 });
  await sheet.setContent(`<body style="margin:0;background:#111;color:#ccc;font:10px sans-serif;display:flex;flex-wrap:wrap">${imgs}<style>figure{margin:2px}</style></body>`);
  await sheet.screenshot({ path: path.join(out, `sheet-${stage.replace(':', '_')}.png`), fullPage: true });
  await ctx.close();
  return { stage, tposes, errors, frames: shots.length, finished: last === 'final' };
}

const results = [];
const queue = [...stages];
await Promise.all(Array.from({ length: conc }, async () => {
  while (queue.length) {
    const s = queue.shift();
    try { const r = await sweepStage(s); results.push(r); console.log(`${s}: ${r.tposes.length} records, ${r.frames} frames${r.finished ? '' : ' (did not reach final)'}`); }
    catch (e) { results.push({ stage: s, tposes: [], errors: [String(e)], frames: 0, finished: false }); console.log(`${s}: ERROR ${String(e).slice(0, 160)}`); }
  }
}));
await cleanup();
fs.writeFileSync(path.join(out, 'tposes.json'), JSON.stringify(results, null, 1));
let bad = 0;
for (const r of results.sort((a, b) => a.stage.localeCompare(b.stage))) {
  for (const t of r.tposes) {
    if (t.kind === 'bind') bad++;
    console.log(`${t.kind.padEnd(9)} ${r.stage.padEnd(18)} model ${t.model} role=${t.role || '-'} word=${t.word == null ? '-' : '0x' + t.word.toString(16)} x${t.count}`);
  }
  for (const e of r.errors) console.log(`pageerror ${r.stage}: ${e}`);
}
console.log(`\nsheets + tposes.json in ${out}`);
process.exit(bad ? 1 : 0);
