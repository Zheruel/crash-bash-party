// Full-screen 2D confetti overlay.
interface P { x: number; y: number; vx: number; vy: number; r: number; vr: number; w: number; h: number; c: string; life: number; g: number }
const COLORS = ['#ff8a00', '#ffd21f', '#ff4f4f', '#4fd1ff', '#7be04a', '#c070ff', '#ffffff'];

export class Confetti {
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private ps: P[] = [];
  private running = false;
  private rainUntil = 0;

  constructor(cv: HTMLCanvasElement) {
    this.cv = cv;
    this.g = cv.getContext('2d')!;
    addEventListener('resize', () => this.resize());
    this.resize();
  }
  private resize() {
    const d = Math.min(devicePixelRatio, 2);
    this.cv.width = innerWidth * d;
    this.cv.height = innerHeight * d;
  }
  burst(x: number, y: number, n = 80, power = 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = (3 + Math.random() * 9) * power;
      this.ps.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 6 * power, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, w: 6 + Math.random() * 6, h: 4 + Math.random() * 5, c: COLORS[(Math.random() * COLORS.length) | 0], life: 1.6 + Math.random() * 1.2, g: 0.28 });
    }
    this.kick();
  }
  rain(seconds: number) {
    this.rainUntil = performance.now() + seconds * 1000;
    this.kick();
  }
  clear() { this.ps = []; this.rainUntil = 0; }
  private kick() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      if (t < this.rainUntil) {
        for (let i = 0; i < 3; i++) this.ps.push({ x: Math.random() * innerWidth, y: -10, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, w: 6 + Math.random() * 6, h: 4 + Math.random() * 5, c: COLORS[(Math.random() * COLORS.length) | 0], life: 4, g: 0.05 });
      }
      const d = Math.min(devicePixelRatio, 2);
      const g = this.g;
      g.clearRect(0, 0, this.cv.width, this.cv.height);
      for (const p of this.ps) {
        p.life -= dt;
        p.vy += p.g * dt * 60;
        p.vx *= 0.99;
        p.x += p.vx * dt * 60;
        p.y += p.vy * dt * 60;
        p.r += p.vr * dt * 60;
        g.save();
        g.translate(p.x * d, p.y * d);
        g.rotate(p.r);
        g.scale(1, Math.cos(p.r * 2.3));
        g.globalAlpha = Math.min(1, p.life);
        g.fillStyle = p.c;
        g.fillRect((-p.w / 2) * d, (-p.h / 2) * d, p.w * d, p.h * d);
        g.restore();
      }
      this.ps = this.ps.filter((p) => p.life > 0 && p.y < innerHeight + 40);
      if (this.ps.length || t < this.rainUntil) requestAnimationFrame(loop);
      else { this.running = false; g.clearRect(0, 0, this.cv.width, this.cv.height); }
    };
    requestAnimationFrame(loop);
  }
}
