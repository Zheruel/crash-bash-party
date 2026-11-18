import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET_BASE, ps1Material } from './crash';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/* Asset viewer: renders only data decoded from the user's own disc (/assets/models/*.gltf). */

// ---------- data ----------
interface Group { group: number; first_file: number; count: number; types?: Record<string, number> }
interface Level { level_id: number; name: string; family: string; files: { model_texture_groups?: number[] | null } }
interface Arenas { levels: Level[]; groups: Group[]; always_resident_groups?: Record<string, string> }

type Cat = 'char' | 'multi' | 'arena' | 'prop' | 'other';
const CAT_LABEL: Record<Cat, string> = { char: 'Characters', multi: 'Multi-part', arena: 'Arenas/sky', prop: 'Props', other: 'Other' };
const MULTI = new Set([85, 89, 103, 131, 458, 472, 474]);
function category(n: number): Cat {
  if (MULTI.has(n)) return 'multi';
  if (n >= 774 && n <= 990) return 'char'; // hint said odd, but the decoded t29 files here are the even numbers
  if ((n >= 1 && n <= 19) || (n >= 125 && n <= 129) || (n >= 377 && n <= 393) || (n >= 607 && n <= 713)) return 'arena';
  if (n >= 305 && n <= 773) return 'prop';
  return 'other';
}
const pad = (n: number) => String(n).padStart(4, '0');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('c');
const statusEl = $('status');
function setStatus(msg: string, err = false) { statusEl.textContent = msg; statusEl.classList.toggle('err', err); statusEl.style.display = msg ? '' : 'none'; }

let models: number[] = [];
let arenas: Arenas = { levels: [], groups: [] };
const empties = new Set<number>(); // discovered at load time

// ---------- three setup ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // PS1 values pass straight through
const scene = new THREE.Scene();
scene.background = new THREE.Color().setRGB(0.17, 0.18, 0.22, THREE.LinearSRGBColorSpace);
const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
const content = new THREE.Group();
scene.add(content);
let gridHelper: THREE.GridHelper | null = null;

const wobbleU = { value: 0 };
const resU = { value: new THREE.Vector2(320, 240) };

function makeMaterial(src: THREE.Material): THREE.MeshBasicMaterial {
  // Same PS1 colour pipeline as the game (crash.ts): raw texels/vertex colours, x2 modulation, ABR blend modes,
  // output-colour-space agnostic. Only the optional vertex wobble is added here.
  const m = ps1Material(src) as THREE.MeshBasicMaterial;
  const ps1Compile = m.onBeforeCompile;
  m.customProgramCacheKey = () => 'ps1-wobble';
  m.onBeforeCompile = (sh, r) => {
    ps1Compile.call(m, sh, r);
    sh.uniforms.uWobble = wobbleU;
    sh.uniforms.uRes = resU;
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'uniform float uWobble; uniform vec2 uRes; varying float vAffW;\nvoid main() {')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vAffW = gl_Position.w;
        #ifdef USE_MAP
        if (uWobble > 0.5) vMapUv *= gl_Position.w;
        #endif
        if (uWobble > 0.5) {
          vec2 ndc = gl_Position.xy / gl_Position.w;
          ndc = (floor((ndc * 0.5 + 0.5) * uRes) + 0.5) / uRes * 2.0 - 1.0;
          gl_Position.xy = ndc * gl_Position.w;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform float uWobble; varying float vAffW;\nvoid main() {')
      .replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment.replaceAll('vMapUv', '(uWobble > 0.5 ? vMapUv / vAffW : vMapUv)'));
  };
  return m;
}

// ---------- loading ----------
// The shipped glTFs lack min/max on morph-target POSITION accessors (fixed in tools/t29.py, needs a re-export);
// GLTFLoader warns once per accessor, which floods the console. Drop only that warning.
const origWarn = console.warn.bind(console);
console.warn = (...a: unknown[]) => { if (typeof a[0] === 'string' && a[0].includes('Missing min/max')) return; origWarn(...a); };

const gltfLoader = new GLTFLoader();

interface TexUse { index: number; tris: number; hasMap: boolean }
interface Info {
  n: number; tris: number; verts: number; parts: number; texUses: TexUse[]; globalTexTris: number; untexTris: number;
  clips: THREE.AnimationClip[]; size: THREE.Vector3; texDir: string; warnings: string[];
}
interface Loaded { n: number; root: THREE.Object3D; info: Info; mats: THREE.MeshBasicMaterial[]; }

function analyse(n: number, g: GLTF, mats: THREE.MeshBasicMaterial[], root: THREE.Object3D): Info {
  const j = g.parser.json as {
    meshes?: { extras?: { triangles?: number; vertices?: number }; primitives: { attributes: { POSITION: number }; material: number }[] }[];
    accessors: { count: number }[];
    materials?: { extras?: { textured: boolean; texture_index: number; texture_table: number }; pbrMetallicRoughness?: { baseColorTexture?: unknown } }[];
  };
  let tris = 0, verts = 0, globalTexTris = 0, untexTris = 0;
  const uses = new Map<number, TexUse>();
  for (const m of j.meshes ?? []) {
    tris += m.extras?.triangles ?? 0;
    verts += m.extras?.vertices ?? 0;
    for (const p of m.primitives) {
      const t = j.accessors[p.attributes.POSITION].count / 3;
      const mat = j.materials?.[p.material];
      const x = mat?.extras;
      const hasMap = !!mat?.pbrMetallicRoughness?.baseColorTexture;
      if (!x || !x.textured) untexTris += t;
      else if (!hasMap && x.texture_table === 1) globalTexTris += t; // bit-15 ids past the end of the paired t08
      else {
        const u = uses.get(x.texture_index) ?? { index: x.texture_index, tris: 0, hasMap };
        u.tris += t; uses.set(x.texture_index, u);
        if (!hasMap) globalTexTris += t; // texture file missing/out of range
      }
    }
  }
  const box = new THREE.Box3().setFromObject(root);
  const warnings: string[] = [];
  if (!tris) warnings.push('no geometry (empty stub)');
  const miss = [...uses.values()].filter((u) => !u.hasMap);
  if (miss.length) warnings.push(`texture index not in t08: ${miss.map((u) => u.index).join(', ')}`);
  void mats;
  return {
    n, tris, verts, parts: j.meshes?.length ?? 0, texUses: [...uses.values()].sort((a, b) => a.index - b.index),
    globalTexTris, untexTris, clips: g.animations, size: box.getSize(new THREE.Vector3()), texDir: pad(n - 1), warnings,
  };
}

async function loadModel(n: number): Promise<Loaded> {
  const g = await gltfLoader.loadAsync(`${ASSET_BASE}models/${pad(n)}.gltf`);
  const root = g.scene;
  const map = new Map<THREE.Material, THREE.MeshBasicMaterial>();
  const mats: THREE.MeshBasicMaterial[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.frustumCulled = false;
    const old = m.material as THREE.Material;
    let nm = map.get(old);
    if (!nm) { nm = makeMaterial(old); map.set(old, nm); mats.push(nm); old.dispose(); }
    m.material = nm;
  });
  const info = analyse(n, g, mats, root);
  if (!info.tris) empties.add(n);
  return { n, root, info, mats };
}

function disposeLoaded(l: Loaded) {
  l.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
  for (const m of l.mats) { m.map?.dispose(); m.dispose(); }
}

// ---------- state ----------
type Mode = 'single' | 'group' | 'sheet';
let mode: Mode = 'single';
let current: number | null = null;
let currentGroup = 5;
let shown: Loaded[] = [];
let mixers: THREE.AnimationMixer[] = [];
let actions: THREE.AnimationAction[] = [];
let playing = true;
let speed = 1;
let loadToken = 0;
const opts = { wobble: false, vcol: true, tex: true, wire: false, grid: true, spread: false };

function applyMatOpts() {
  for (const l of shown) for (const m of l.mats) {
    m.vertexColors = opts.vcol;
    m.map = opts.tex && m.userData.hadMap ? m.map ?? null : null;
    m.wireframe = opts.wire;
    m.needsUpdate = true;
  }
}

function clearShown() {
  for (const l of shown) { content.remove(l.root); disposeLoaded(l); }
  shown = []; mixers = []; actions = [];
}

function frame(obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) { camera.position.set(2, 1.5, 3); controls.target.set(0, 0, 0); controls.update(); return; }
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
  const dist = (r / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.05;
  camera.near = dist / 500; camera.far = dist * 50 + r * 4;
  camera.updateProjectionMatrix();
  const dir = new THREE.Vector3(0.7, 0.45, 1).normalize();
  camera.position.copy(c).addScaledVector(dir, dist);
  controls.target.copy(c);
  controls.minDistance = dist / 200; controls.maxDistance = dist * 20;
  controls.update();
  updateGrid(box);
}

function updateGrid(box: THREE.Box3) {
  if (gridHelper) { scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper = null; }
  const size = box.getSize(new THREE.Vector3());
  const s = Math.max(size.x, size.z, 1e-3) * 1.5;
  gridHelper = new THREE.GridHelper(s, 20, 0x555a68, 0x3a3e4a);
  gridHelper.position.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  gridHelper.visible = opts.grid;
  scene.add(gridHelper);
}

// ---------- animation ----------
const animEl = $('anim');
function setupAnimation(clipsOf: { l: Loaded }[]) {
  mixers = []; actions = [];
  const all = clipsOf.filter((c) => c.l.info.clips.length);
  if (!all.length) { animEl.hidden = true; return; }
  animEl.hidden = false;
  // Single model: picker over its clips; group: first clip of every model.
  if (mode === 'single') {
    const l = all[0].l;
    const mixer = new THREE.AnimationMixer(l.root);
    mixers.push(mixer);
    const acts = l.info.clips.map((c) => mixer.clipAction(c));
    animEl.innerHTML = '';
    const sel = document.createElement('select');
    sel.innerHTML = l.info.clips.map((c, i) => `<option value="${i}">${c.name} · ${(c.tracks[0]?.times.length ?? 0)} frames · ${c.duration.toFixed(2)}s</option>`).join('') +
      `<option value="all">all clips together (${acts.length})</option><option value="none">none (base pose)</option>`;
    const play = document.createElement('button');
    const spd = document.createElement('select');
    spd.innerHTML = [0.1, 0.25, 0.5, 1, 2, 4].map((s) => `<option value="${s}"${s === speed ? ' selected' : ''}>${s}x</option>`).join('');
    const scrub = document.createElement('input');
    scrub.type = 'range'; scrub.min = '0'; scrub.max = '1000'; scrub.value = '0'; scrub.style.width = '140px';
    animEl.append(sel, play, spd, scrub);
    const pick = () => {
      actions.forEach((a) => a.stop());
      actions = sel.value === 'all' ? acts : sel.value === 'none' ? [] : [acts[Number(sel.value)]];
      actions.forEach((a) => { a.reset().play(); });
      applyPlay();
    };
    const applyPlay = () => { play.textContent = playing ? 'Pause' : 'Play'; play.classList.toggle('on', playing); mixers.forEach((m) => (m.timeScale = playing ? speed : 0)); };
    play.onclick = () => { playing = !playing; applyPlay(); };
    spd.onchange = () => { speed = Number(spd.value); applyPlay(); };
    scrub.oninput = () => {
      playing = false; applyPlay();
      for (const a of actions) a.time = (Number(scrub.value) / 1000) * a.getClip().duration;
      mixers.forEach((m) => m.update(0));
    };
    sel.onchange = pick;
    animEl.dataset.pick = '1';
    (animEl as HTMLElement & { _pick?: () => void })._pick = applyPlay;
    pick();
  } else {
    animEl.innerHTML = '<span class="dim">first clip of each model</span>';
    const play = document.createElement('button');
    animEl.append(play);
    for (const { l } of all) {
      const mx = new THREE.AnimationMixer(l.root); mixers.push(mx);
      const a = mx.clipAction(l.info.clips[0]); a.play(); actions.push(a);
    }
    const applyPlay = () => { play.textContent = playing ? 'Pause' : 'Play'; play.classList.toggle('on', playing); mixers.forEach((m) => (m.timeScale = playing ? speed : 0)); };
    play.onclick = () => { playing = !playing; applyPlay(); };
    applyPlay();
  }
}
function togglePlay() {
  playing = !playing;
  mixers.forEach((m) => (m.timeScale = playing ? speed : 0));
  const b = animEl.querySelector('button'); if (b) { b.textContent = playing ? 'Pause' : 'Play'; b.classList.toggle('on', playing); }
}

// ---------- info panel ----------
const infoEl = $('info');
function groupOf(n: number): Group | undefined { return arenas.groups.find((g) => n >= g.first_file && n < g.first_file + g.count); }
function levelsOfGroup(g: number) {
  const exact: string[] = [], cand: string[] = [];
  for (const l of arenas.levels) {
    const gs = l.files.model_texture_groups;
    if (!gs || !gs.includes(g)) continue;
    (gs.length === 1 ? exact : cand).push(l.name);
  }
  return { exact, cand };
}
function groupModels(g: Group) { return models.filter((n) => n >= g.first_file && n < g.first_file + g.count); }
function levelHtml(g: Group | undefined): string {
  if (!g) return '<span class="dim">not in any file group</span>';
  const { exact, cand } = levelsOfGroup(g.group);
  const res = arenas.always_resident_groups?.[String(g.group)];
  const parts: string[] = [`<a href="#" data-grp="${g.group}">group ${g.group}</a> (files ${g.first_file}-${g.first_file + g.count - 1})`];
  if (res) parts.push(`<span class="dim">always resident: ${res}</span>`);
  if (exact.length) parts.push(`candidate for: <b>${exact.join(', ')}</b>`);
  if (cand.length) parts.push(`<span class="dim">in the unresolved range (${cand.length} levels): ${cand.join(', ')}</span>`);
  if (!res && !exact.length && !cand.length) parts.push('<span class="dim">no level lists this group</span>');
  return parts.join('<br>');
}

function renderInfoSingle(l: Loaded) {
  const i = l.info;
  const sz = (v: number) => (v * 1024).toFixed(0);
  const texs = i.texUses.map((u) => `<div class="tex" title="${u.tris} tris">${u.hasMap ? `<img src="${ASSET_BASE}textures/${i.texDir}/tex${String(u.index).padStart(3, '0')}.png">` : '<div style="height:40px;width:40px"></div>'}t${u.index}</div>`).join('');
  infoEl.innerHTML = `
    <h3>${pad(i.n)} <span class="dim">${CAT_LABEL[category(i.n)]}</span></h3>
    <dl>
      <dt>triangles</dt><dd>${i.tris.toLocaleString()}</dd>
      <dt>vertices</dt><dd>${i.verts.toLocaleString()}</dd>
      <dt>parts</dt><dd>${i.parts}</dd>
      <dt>size (raw)</dt><dd>${sz(i.size.x)} x ${sz(i.size.y)} x ${sz(i.size.z)}</dd>
      <dt>animations</dt><dd>${i.clips.length}</dd>
      <dt>untextured</dt><dd>${i.untexTris} tris</dd>
      <dt>global-table tex</dt><dd>${i.globalTexTris} tris${i.tris ? ` (${((100 * i.globalTexTris) / i.tris).toFixed(1)}%)` : ''} <span class="dim">drawn untextured</span></dd>
    </dl>
    ${i.warnings.map((w) => `<div class="warn">! ${w}</div>`).join('')}
    <h4>Textures (t08 ${i.texDir}) &middot; ${i.texUses.length}</h4>${texs || '<span class="dim">none</span>'}
    <h4>Levels</h4>${levelHtml(groupOf(i.n))}`;
}

function renderInfoGroup(g: Group, ls: Loaded[], hidden: Set<number>) {
  const { exact, cand } = levelsOfGroup(g.group);
  const tris = ls.reduce((s, l) => s + l.info.tris, 0);
  infoEl.innerHTML = `
    <h3>Group ${g.group}</h3>
    <dl><dt>files</dt><dd>${g.first_file}-${g.first_file + g.count - 1}</dd><dt>models</dt><dd>${ls.length}</dd><dt>triangles</dt><dd>${tris.toLocaleString()}</dd></dl>
    <h4>Levels</h4>${levelHtml(g)}
    ${exact.length + cand.length === 0 ? '' : ''}
    <h4>Models (click name to open)</h4>
    ${ls.map((l) => `<div class="gm"><input type="checkbox" data-vis="${l.n}" ${hidden.has(l.n) ? '' : 'checked'}><a href="#" data-open="${l.n}">${pad(l.n)}</a><span class="dim">${l.info.tris} tris${l.info.clips.length ? ' · anim' : ''}</span></div>`).join('')}`;
  infoEl.querySelectorAll<HTMLInputElement>('input[data-vis]').forEach((cb) => {
    cb.onchange = () => { const l = ls.find((x) => x.n === Number(cb.dataset.vis)); if (l) l.root.visible = cb.checked; };
  });
}
infoEl.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a') as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  if (a.dataset.open) selectModel(Number(a.dataset.open));
  if (a.dataset.grp) { currentGroup = Number(a.dataset.grp); setMode('group'); }
});

// ---------- modes ----------
async function showSingle(n: number) {
  const tok = ++loadToken;
  setStatus(`loading ${pad(n)}...`);
  try {
    const l = await loadModel(n);
    if (tok !== loadToken) { disposeLoaded(l); return; }
    clearShown(); shown = [l]; content.add(l.root);
    applyMatOpts();
    frame(l.root);
    setupAnimation([{ l }]);
    renderInfoSingle(l);
    setStatus(l.info.tris ? '' : `${pad(n)}: empty model (decoder produced no geometry)`);
    refreshListMarks();
  } catch (e) {
    if (tok !== loadToken) return;
    console.error(`load ${pad(n)} failed`, e);
    clearShown(); animEl.hidden = true;
    infoEl.innerHTML = `<h3>${pad(n)}</h3><div class="warn">load failed: ${String(e)}</div>`;
    setStatus(`failed to load ${pad(n)}`, true);
  }
}

async function showGroup(gnum: number) {
  const g = arenas.groups.find((x) => x.group === gnum);
  if (!g) return;
  const tok = ++loadToken;
  const files = groupModels(g);
  setStatus(`loading group ${gnum} (${files.length} models)...`);
  const results = await Promise.allSettled(files.map(loadModel));
  if (tok !== loadToken) { results.forEach((r) => r.status === 'fulfilled' && disposeLoaded(r.value)); return; }
  clearShown();
  const ls: Loaded[] = [];
  results.forEach((r, i) => { if (r.status === 'fulfilled') ls.push(r.value); else console.error(`load ${pad(files[i])} failed`, r.reason); });
  shown = ls;
  for (const l of ls) content.add(l.root);
  layoutGroup();
  applyMatOpts();
  frame(content);
  setupAnimation(ls.map((l) => ({ l })));
  renderInfoGroup(g, ls, new Set());
  setStatus(files.length ? '' : `group ${gnum} has no decoded models`);
}

function layoutGroup() {
  if (!opts.spread) { shown.forEach((l) => l.root.position.set(0, 0, 0)); return; }
  const sizes = shown.map((l) => Math.max(l.info.size.x, l.info.size.z, 0.2));
  const step = Math.max(...sizes) * 1.1;
  const cols = Math.ceil(Math.sqrt(shown.length));
  shown.forEach((l, i) => {
    const c = new THREE.Box3().setFromObject(l.root).getCenter(new THREE.Vector3());
    l.root.position.set((i % cols) * step - c.x, 0, Math.floor(i / cols) * step - c.z);
  });
}

// contact sheet
const sheetEl = $('sheet');
const thumbs = new Map<number, HTMLCanvasElement>();
let thumbRenderer: THREE.WebGLRenderer | null = null;
let sheetToken = 0;
const TH = 128;

async function renderThumb(n: number): Promise<HTMLCanvasElement> {
  const hit = thumbs.get(n); if (hit) return hit;
  const l = await loadModel(n);
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    thumbRenderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    thumbRenderer.setSize(TH, TH, false);
  }
  const sc = new THREE.Scene(); sc.background = new THREE.Color().setRGB(0.17, 0.18, 0.22, THREE.LinearSRGBColorSpace); sc.add(l.root);
  const cam = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  const box = new THREE.Box3().setFromObject(l.root);
  if (!box.isEmpty()) {
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
    const d = (r / Math.sin(THREE.MathUtils.degToRad(cam.fov) / 2)) * 1.05;
    cam.near = d / 500; cam.far = d * 50 + r * 4; cam.updateProjectionMatrix();
    cam.position.copy(c).addScaledVector(new THREE.Vector3(0.7, 0.45, 1).normalize(), d);
    cam.lookAt(c);
  }
  thumbRenderer.render(sc, cam);
  const out = document.createElement('canvas'); out.width = out.height = TH;
  out.getContext('2d')!.drawImage(thumbRenderer.domElement, 0, 0, TH, TH);
  disposeLoaded(l);
  thumbs.set(n, out);
  return out;
}

async function buildSheet() {
  const tok = ++sheetToken;
  const list = filtered();
  sheetEl.innerHTML = '';
  const cells = new Map<number, HTMLElement>();
  for (const n of list) {
    const cell = document.createElement('div'); cell.className = 'cell';
    cell.innerHTML = `<span>${pad(n)}</span>`;
    const c = thumbs.get(n);
    if (c) cell.prepend(cloneCanvas(c));
    cell.onclick = () => selectModel(n);
    sheetEl.append(cell); cells.set(n, cell);
  }
  let done = 0, i = 0;
  const todo = list.filter((n) => !thumbs.has(n));
  setStatus(`thumbnails: ${list.length - todo.length}/${list.length}`);
  const worker = async () => {
    while (tok === sheetToken && i < todo.length) {
      const n = todo[i++];
      try {
        const c = await renderThumb(n);
        const cell = cells.get(n); if (cell && tok === sheetToken) { cell.prepend(cloneCanvas(c)); if (empties.has(n)) cell.classList.add('empty'); }
      } catch (e) { console.error(`thumb ${pad(n)} failed`, e); cells.get(n)?.classList.add('empty'); }
      done++;
      if (tok === sheetToken) setStatus(`thumbnails: ${list.length - todo.length + done}/${list.length}`);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  if (tok === sheetToken) { setStatus(''); refreshListMarks(); }
}
function cloneCanvas(c: HTMLCanvasElement) {
  const o = document.createElement('canvas'); o.width = c.width; o.height = c.height;
  o.getContext('2d')!.drawImage(c, 0, 0); return o;
}

// ---------- sidebar ----------
const listEl = $('list');
const qEl = $<HTMLInputElement>('q');
const catsEl = $('cats');
let catFilter: Cat | 'all' = 'all';

function filtered(): number[] {
  const q = qEl.value.trim();
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(q);
  return models.filter((n) => {
    if (catFilter !== 'all' && category(n) !== catFilter) return false;
    if (!q) return true;
    if (range) return n >= Number(range[1]) && n <= Number(range[2]);
    return pad(n).includes(q.replace(/^0+(?=\d)/, '')) || String(n).startsWith(q);
  });
}
function renderList() {
  const l = filtered();
  listEl.innerHTML = l.map((n) => `<li data-n="${n}" class="${n === current ? 'sel' : ''}">${pad(n)}<small>${empties.has(n) ? 'empty' : CAT_LABEL[category(n)]}</small></li>`).join('');
  $('count').textContent = `${l.length} / ${models.length} models`;
  scrollToSel();
}
function refreshListMarks() {
  listEl.querySelectorAll<HTMLElement>('li').forEach((li) => {
    const n = Number(li.dataset.n);
    const s = li.querySelector('small'); if (s) s.textContent = empties.has(n) ? 'empty' : CAT_LABEL[category(n)];
  });
}
function scrollToSel() { listEl.querySelector('li.sel')?.scrollIntoView({ block: 'nearest' }); }
listEl.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest('li'); if (li) selectModel(Number(li.dataset.n));
});
qEl.addEventListener('input', () => { renderList(); if (mode === 'sheet') void buildSheet(); });
for (const c of ['all', ...Object.keys(CAT_LABEL)] as (Cat | 'all')[]) {
  const b = document.createElement('button');
  b.textContent = c === 'all' ? 'All' : CAT_LABEL[c]; b.dataset.cat = c;
  b.onclick = () => { catFilter = c; catsEl.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); renderList(); if (mode === 'sheet') void buildSheet(); };
  if (c === 'all') b.classList.add('on');
  catsEl.append(b);
}

function selectModel(n: number) {
  current = n;
  if (mode !== 'single') { mode = 'single'; syncMode(); }
  location.hash = pad(n);
  listEl.querySelectorAll('li.sel').forEach((x) => x.classList.remove('sel'));
  listEl.querySelector(`li[data-n="${n}"]`)?.classList.add('sel');
  scrollToSel();
  void showSingle(n);
}

function step(d: number) {
  if (mode === 'group') {
    const gs = arenas.groups.filter((g) => groupModels(g).length).map((g) => g.group);
    const i = gs.indexOf(currentGroup);
    currentGroup = gs[(i + d + gs.length) % gs.length];
    $<HTMLSelectElement>('grpsel').value = String(currentGroup);
    void showGroup(currentGroup);
    return;
  }
  const l = filtered(); if (!l.length) return;
  const i = current === null ? -1 : l.indexOf(current);
  selectModel(l[i < 0 ? (d > 0 ? 0 : l.length - 1) : Math.min(l.length - 1, Math.max(0, i + d))]);
}

// ---------- toolbar ----------
const modesEl = $('modes');
const MODES: [Mode, string][] = [['single', 'Model'], ['group', 'Arena group'], ['sheet', 'Contact sheet']];
for (const [m, label] of MODES) {
  const b = document.createElement('button'); b.textContent = label; b.dataset.mode = m;
  b.onclick = () => setMode(m);
  modesEl.append(b);
}
function syncMode() {
  modesEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('grpctl').hidden = mode !== 'group';
  sheetEl.hidden = mode !== 'sheet';
}
function setMode(m: Mode) {
  mode = m; syncMode(); sheetToken++;
  if (m === 'single') { if (current === null) current = filtered()[0] ?? models[0]; selectModel(current); }
  if (m === 'group') { location.hash = 'g' + currentGroup; $<HTMLSelectElement>('grpsel').value = String(currentGroup); void showGroup(currentGroup); }
  if (m === 'sheet') { location.hash = 'sheet'; loadToken++; animEl.hidden = true; infoEl.innerHTML = '<h3>Contact sheet</h3><div class="dim">Click a thumbnail to open it. Respects the category filter and search.</div>'; void buildSheet(); }
}

const bind = (id: string, key: keyof typeof opts, fn?: () => void) => {
  const el = $<HTMLInputElement>(id);
  el.checked = opts[key];
  el.onchange = () => { opts[key] = el.checked; fn?.(); };
};
bind('wobble', 'wobble', () => (wobbleU.value = opts.wobble ? 1 : 0));
bind('vcol', 'vcol', applyMatOpts);
bind('tex', 'tex', applyMatOpts);
bind('wire', 'wire', applyMatOpts);
bind('grid', 'grid', () => { if (gridHelper) gridHelper.visible = opts.grid; });
bind('spread', 'spread', () => { if (mode === 'group') { layoutGroup(); frame(content); } });
$<HTMLSelectElement>('grpsel').onchange = (e) => { currentGroup = Number((e.target as HTMLSelectElement).value); location.hash = 'g' + currentGroup; void showGroup(currentGroup); };

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'SELECT') return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    if (tag === 'INPUT' && (e.target as HTMLInputElement).type === 'text' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    if (mode === 'sheet') return;
    e.preventDefault(); step(e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1);
  } else if (e.key === ' ' && tag !== 'INPUT' && tag !== 'BUTTON') { e.preventDefault(); togglePlay(); }
});

// ---------- loop ----------
const clock = new THREE.Clock();
function resize() {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    resU.value.set(Math.round(w / 3), Math.round(h / 3)); // chunky snap grid
  }
}
function loop() {
  requestAnimationFrame(loop);
  if (mode === 'sheet') return;
  resize();
  const dt = clock.getDelta();
  for (const m of mixers) m.update(dt);
  controls.update();
  renderer.render(scene, camera);
}

// ---------- boot ----------
async function boot() {
  setStatus('loading index...');
  try {
    arenas = (await (await fetch(ASSET_BASE + 'arenas.json')).json()) as Arenas;
  } catch (e) { console.error('arenas.json failed', e); }
  // Model list: derived from the t29 file ranges in arenas.json groups is not enough (files are 4-digit and
  // sparse), so ask the dev server's directory-less assets endpoint via a probe list of candidates.
  models = await discoverModels();
  const grpSel = $<HTMLSelectElement>('grpsel');
  grpSel.innerHTML = arenas.groups
    .filter((g) => groupModels(g).length)
    .map((g) => {
      const { exact } = levelsOfGroup(g.group);
      return `<option value="${g.group}">G${g.group} · ${g.first_file}-${g.first_file + g.count - 1} · ${groupModels(g).length} models${exact.length ? ' · ' + exact.join('/') : ''}</option>`;
    }).join('');
  renderList();
  const h = location.hash.slice(1);
  if (h === 'sheet') setMode('sheet');
  else if (/^g\d+$/.test(h)) { currentGroup = Number(h.slice(1)); setMode('group'); }
  else if (/^\d+$/.test(h) && models.includes(Number(h))) { mode = 'single'; syncMode(); selectModel(Number(h)); }
  else { mode = 'single'; syncMode(); selectModel(models.find((n) => category(n) === 'char') ?? models[0]); }
  loop();
}

async function discoverModels(): Promise<number[]> {
  const idx = await fetch(ASSET_BASE + 'models/index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null) as number[] | null;
  if (idx) return idx;
  // No index file: probe every number 0..991 with HEAD (cheap on the local server).
  const probe = async (n: number) => ((await fetch(`${ASSET_BASE}models/${pad(n)}.gltf`, { method: 'HEAD' })).ok ? n : -1);
  const out: number[] = [];
  for (let s = 0; s < 992; s += 64) {
    const r = await Promise.all(Array.from({ length: Math.min(64, 992 - s) }, (_, k) => probe(s + k)));
    out.push(...r.filter((x) => x >= 0));
  }
  return out;
}

window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (/^\d+$/.test(h) && models.includes(Number(h)) && !(mode === 'single' && current === Number(h))) selectModel(Number(h));
  else if (/^g\d+$/.test(h) && !(mode === 'group' && currentGroup === Number(h.slice(1)))) { currentGroup = Number(h.slice(1)); setMode('group'); }
  else if (h === 'sheet' && mode !== 'sheet') setMode('sheet');
});
void boot();
