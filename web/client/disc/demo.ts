// Dev-only demo for the disc loader (open /client/disc/demo.html in `npm run dev:web`). Not part of the game build.
import * as THREE from 'three';
import { DiscError, loadDisc, type DiscAssets } from './index';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (s: string) => { $('status').textContent = s; };
let assets: DiscAssets | null = null;
const win = window as unknown as { __assets?: DiscAssets };

const renderer = new THREE.WebGLRenderer({ canvas: $('cv') as HTMLCanvasElement, antialias: true });
renderer.setSize(480, 360, false);
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(40, 480 / 360, 0.01, 100);
let mixer: THREE.AnimationMixer | null = null;
let current: THREE.Object3D | null = null;
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  mixer?.update(clock.getDelta());
  if (current) current.rotation.y += 0.01;
  renderer.render(scene, cam);
});

$('file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  $('err').textContent = '';
  $('tools').hidden = true;
  const t0 = performance.now();
  try {
    assets?.close();
    assets = await loadDisc(f, { onProgress: (m, d, t) => status(`${m} ${Math.round((100 * d) / t)}%`) });
    win.__assets = assets;
    status(`Disc ok (${assets.info.id}), ${assets.fileCount} files, cache ${assets.cached ? 'on' : 'off'}, opened in ${(performance.now() - t0).toFixed(0)} ms`);
    $('tools').hidden = false;
  } catch (err) {
    $('err').textContent = err instanceof DiscError ? `${err.message}` : `Unexpected error: ${(err as Error).message}`;
    status('');
  }
});

$('all').addEventListener('click', async () => {
  if (!assets) return;
  const st = await assets.decodeAll((d, t) => status(`decoding ${d}/${t}`));
  status(`decoded: ${JSON.stringify(st)}`);
});

$('show').addEventListener('click', async () => {
  if (!assets) return;
  const i = Number(($('model') as HTMLInputElement).value);
  try {
    const model = await assets.getModel(i);
    const tex = await assets.getTextures(i - 1).catch(() => undefined);
    if (current) scene.remove(current);
    current = model.instantiate({ textures: tex });
    scene.add(current);
    // frame the static pose (setFromObject would include every morph keyframe)
    const box = new THREE.Box3();
    for (const g of model.geometries) box.union(new THREE.Box3().setFromBufferAttribute(g.attributes.position as THREE.BufferAttribute));
    box.min.multiplyScalar(model.data.scale); box.max.multiplyScalar(model.data.scale);
    box.set(new THREE.Vector3(box.min.x, -box.max.y, -box.max.z), new THREE.Vector3(box.max.x, -box.min.y, -box.min.z));
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() || 1;
    current.position.sub(c);
    cam.position.set(0, 0, r * 1.2);
    cam.lookAt(0, 0, 0);
    mixer = model.clips.length ? new THREE.AnimationMixer(current) : null;
    if (mixer) mixer.clipAction(model.clips[0]).play();
    status(`model ${i}: ${model.data.parts.length} parts, ${model.clips.length} clips`);
  } catch (err) { $('err').textContent = (err as Error).message; }
});

$('play').addEventListener('click', async () => {
  if (!assets) return;
  const bank = await assets.getSoundBank(Number(($('bank') as HTMLInputElement).value));
  const ctx = new AudioContext();
  const buf = bank.audioBuffer(ctx, Number(($('smp') as HTMLInputElement).value));
  if (!buf) return;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  status(`playing sample: ${buf.duration.toFixed(2)} s`);
});
