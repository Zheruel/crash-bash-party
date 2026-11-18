// Real Crash Bash warp-room textures (assets/textures/0616): glowing floor buttons, stone, etc.
import { ASSET_BASE } from '../crash';

const WARP_TEX = 'textures/0616/';
const imgs = new Map<string, HTMLImageElement | null>();

function load(name: string): Promise<void> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => { imgs.set(name, im); resolve(); };
    im.onerror = () => { imgs.set(name, null); resolve(); };
    im.src = `${ASSET_BASE}${WARP_TEX}tex${name}.png`;
  });
}

/** tex029 stone tile, tex030..033 red/blue/green/yellow floor buttons, tex010 stone wall. */
export async function preloadBoardTextures() {
  await Promise.all(['029', '030', '031', '032', '033', '010', '041'].map(load));
}
export const warpTex = (name: string) => imgs.get(name) ?? null;
