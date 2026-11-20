import * as THREE from 'three';

const WIDTH = 512;
const HEIGHT = 240;
const FRAME_MS = 1000 / 30;
const TURN = 0x1000;
const ROLL_STEP = 20;
const meshUrl = new URL('./menu-vortex.bin', import.meta.url);

// The title overlay (rotation writes at 800B3ADC and 800B4950) uses model 0131, part 6,
// with a 659-unit yaw and a roll of 20 units per menu frame. These are its
// 4.12 sine and cosine, as stored in the game's rotation table.
const YAW_SIN = 3471;
const YAW_COS = 2175;
const signedScreen = (value: number) => Math.max(-1024, Math.min(1023, value));

interface Triangle {
  a: number;
  b: number;
  c: number;
  flags: number;
  order: number;
  depth: number;
}

class MenuVortex {
  private readonly geometry = new THREE.BufferGeometry();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly material = new THREE.RawShaderMaterial({
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `
      precision highp float;
      attribute vec2 position;
      attribute vec3 rgb;
      varying vec3 gouraud;
      void main() {
        vec2 pixel = position + 0.5;
        gl_Position = vec4(pixel.x / 256.0 - 1.0, 1.0 - pixel.y / 120.0, 0.0, 1.0);
        gouraud = rgb;
      }`,
    fragmentShader: `
      precision highp float;
      varying vec3 gouraud;
      void main() {
        // The NTSC display blanks the top eight rows of the 240-line raster.
        if (gl_FragCoord.y >= 232.0) discard;
        // Untextured GP0(30h), with dithering off. The reference capture
        // expands the RGB555 framebuffer through the core's RGB565 output.
        vec3 rgb5 = floor((gouraud + 0.0001) / 8.0);
        gl_FragColor = vec4(rgb5 / vec3(31.0, 31.5, 31.0), 1.0);
      }`,
  });
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world: Int16Array;
  private readonly screen: THREE.BufferAttribute;
  private readonly z: Uint16Array;
  private readonly triangles: Triangle[] = [];
  private readonly visible: Triangle[] = [];
  private readonly indices: THREE.BufferAttribute;

  constructor(data: ArrayBuffer) {
    // Packed from tools/t29.py's parse_model(0131). Part 6 is 875 opaque,
    // untextured triangles. Vertices share entries only when XYZ and RGB agree.
    // LE u16 vertex/triangle counts, then i16 xyz + u8 rgb + pad per vertex,
    // followed by u16 abc in GPU strip order + third-vertex flags per triangle.
    const view = new DataView(data);
    const vertexCount = view.getUint16(0, true);
    const triangleCount = view.getUint16(2, true);
    this.world = new Int16Array(vertexCount * 3);
    const rgb = new Uint8Array(vertexCount * 3);
    this.screen = new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.z = new Uint16Array(vertexCount);
    let offset = 4;
    for (let vertex = 0; vertex < vertexCount; vertex++, offset += 10) {
      for (let axis = 0; axis < 3; axis++) {
        this.world[vertex * 3 + axis] = view.getInt16(offset + axis * 2, true);
        rgb[vertex * 3 + axis] = view.getUint8(offset + 6 + axis);
      }
    }
    for (let order = 0; order < triangleCount; order++, offset += 8) {
      this.triangles.push({
        a: view.getUint16(offset, true), b: view.getUint16(offset + 2, true), c: view.getUint16(offset + 4, true),
        flags: view.getUint16(offset + 6, true), order, depth: 0,
      });
    }
    this.indices = new THREE.BufferAttribute(new Uint16Array(triangleCount * 3), 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.screen);
    this.geometry.setAttribute('rgb', new THREE.BufferAttribute(rgb, 3));
    this.geometry.setIndex(this.indices);
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    const canvas = document.createElement('canvas');
    canvas.className = 'vortex3d';
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: false, antialias: false, depth: false, powerPreference: 'low-power' });
    this.renderer.sortObjects = false;
    // Keep the native framebuffer and scale the finished pixels with the menu shell.
    this.renderer.setSize(WIDTH, HEIGHT, false);
    this.renderer.setClearColor(0);
  }

  get canvas() { return this.renderer.domElement; }

  draw(roll: number) {
    const angle = roll * 2 * Math.PI / TURN;
    const sin = Math.round(TURN * Math.sin(angle));
    const cos = Math.round(TURN * Math.cos(angle));
    // Rotate Y * Z in disc space (Y down, Z away from camera). The object
    // scales X/Z by 2.5. The viewport scales X/Y by 0xCCC/4096 and 0.5.
    const xFromX = ((cos * YAW_COS >> 12) * 5 >> 1) * 0xccc >> 12;
    const xFromY = ((-sin * YAW_COS >> 12) * 5 >> 1) * 0xccc >> 12;
    const xFromZ = (YAW_SIN * 5 >> 1) * 0xccc >> 12;
    const yFromX = sin >> 1;
    const yFromY = cos >> 1;
    const zFromX = (-cos * YAW_SIN >> 12) * 5 >> 1;
    const zFromY = (sin * YAW_SIN >> 12) * 5 >> 1;
    const zFromZ = YAW_COS * 5 >> 1;
    const screen = this.screen.array;
    for (let i = 0; i < this.z.length; i++) {
      const x = this.world[i * 3];
      const y = this.world[i * 3 + 1];
      const z = this.world[i * 3 + 2];
      const cx = (xFromX * x + xFromY * y + xFromZ * z) >> 12;
      const cy = (yFromX * x + yFromY * y) >> 12;
      const cz = Math.max(0, ((zFromX * x + zFromY * y + zFromZ * z) >> 12) + 0x400 + 0x4c8);
      this.z[i] = cz;
      // GTE RTPS with H=400. Its divider saturates close to the eye, so
      // the camera projects even the vertices at the minimum depth. The
      // object shifts the logical projection center 100 units left of 320.
      const scale = Math.min(0x1ffff, Math.round(400 * 0x10000 / cz));
      screen[i * 2] = signedScreen(176 + Math.floor(scale * cx / 0x10000));
      screen[i * 2 + 1] = signedScreen(120 + Math.floor(scale * cy / 0x10000));
    }

    const visible = this.visible;
    visible.length = 0;
    for (const triangle of this.triangles) {
      const { a, b, c, flags } = triangle;
      const depth = (((this.z[a] + this.z[b] + this.z[c]) * 0x155 >> 12) - 128) >> 1;
      if (depth < 0 || depth >= 2047) continue;
      const ax = screen[a * 2], ay = screen[a * 2 + 1];
      const bx = screen[b * 2], by = screen[b * 2 + 1];
      const cx = screen[c * 2], cy = screen[c * 2 + 1];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!(flags & 2) && (area > 0) === Boolean(flags & 1)) continue;
      if (Math.max(ax, bx, cx) - Math.min(ax, bx, cx) >= 1024 ||
          Math.max(ay, by, cy) - Math.min(ay, by, cy) >= 512) continue;
      triangle.depth = depth;
      visible.push(triangle);
    }
    // The PS1 draws depth buckets back to front, inserting new triangles at
    // the head of each bucket. Keeping that order preserves overlapping faces.
    visible.sort((a, b) => b.depth - a.depth || b.order - a.order);
    const indices = this.indices.array;
    let count = 0;
    for (const { a, b, c } of visible) {
      indices[count++] = a;
      indices[count++] = b;
      indices[count++] = c;
    }
    this.indices.needsUpdate = true;
    this.screen.needsUpdate = true;
    this.geometry.setDrawRange(0, count);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.canvas.remove();
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

/** The disc menu backdrop, shared by the title, lobby and results shell. */
export class VortexBackdrop {
  private readonly motion = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly load = new AbortController();
  private surface: MenuVortex | null = null;
  private raf = 0;
  private last = 0;
  private roll = 1400; // Starting pose from the main-menu reference capture.
  private on = false;

  constructor(private readonly host: HTMLElement) {
    document.addEventListener('visibilitychange', this.sync);
    this.motion.addEventListener('change', this.sync);
    window.addEventListener('pagehide', this.pageHide);
    void this.init();
  }

  private async init() {
    try {
      const response = await fetch(meshUrl, { signal: this.load.signal });
      if (!response.ok) return;
      const data = await response.arrayBuffer();
      if (this.load.signal.aborted) return;
      this.surface = new MenuVortex(data);
      this.sync();
    } catch { /* Leave the CSS backdrop visible if the mesh or WebGL is unavailable. */ }
  }

  set active(value: boolean) {
    if (this.on === value) return;
    this.on = value;
    this.sync();
  }

  private sync = () => {
    this.stop();
    if (!this.on || document.hidden || !this.surface) return;
    this.surface.draw(this.roll);
    if (!this.surface.canvas.parentNode) this.host.appendChild(this.surface.canvas);
    if (this.motion.matches) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  };

  private loop = (now: number) => {
    const frames = Math.floor((now - this.last) / FRAME_MS);
    if (frames > 0) {
      this.last += frames * FRAME_MS;
      this.roll = (this.roll + frames * ROLL_STEP) & (TURN - 1);
      this.surface?.draw(this.roll);
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private pageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) this.dispose();
  };

  dispose() {
    this.stop();
    this.load.abort();
    document.removeEventListener('visibilitychange', this.sync);
    this.motion.removeEventListener('change', this.sync);
    window.removeEventListener('pagehide', this.pageHide);
    this.surface?.dispose();
    this.surface = null;
  }
}
