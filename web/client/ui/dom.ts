import { CHARACTERS } from '../../shared/look';
import { propIcon } from '../shell/avatar';
import { hudFace } from './ps1hud';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const ord = (n: number) => ['1st', '2nd', '3rd', '4th'][n] ?? `${n + 1}th`;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function div(cls: string, html = '', parent?: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  parent?.appendChild(d);
  return d;
}

/** Restart a CSS animation class on an element. */
export function pop(el: HTMLElement, cls = 'pop') {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Silver cup (the round trophy of the real game's score screens). */
const CUP = '<svg class="ico cup" viewBox="0 0 32 32" aria-hidden="true"><path d="M9.5 6H4.5c0 5 2 8.200 6 9.200M22.500 6h5c0 5-2 8.200-6 9.200" fill="none" stroke="#15102c" stroke-width="4.200" stroke-linecap="round"/><path d="M9.5 6H4.5c0 5 2 8.200 6 9.200M22.500 6h5c0 5-2 8.200-6 9.200" fill="none" stroke="#b9b3e8" stroke-width="2" stroke-linecap="round"/><path d="M8.500 3h15v8c0 5.500-3.200 8.800-7.500 8.800S8.500 16.500 8.500 11z" fill="#d4d0f4" stroke="#15102c" stroke-width="1.800" stroke-linejoin="round"/><path d="M11 5h3v6c0 3 .8 5 2 6.200C12.500 16.500 11 14 11 11z" fill="#fff"/><path d="M14 19.500h4v4.500h-4z" fill="#9a93d4" stroke="#15102c" stroke-width="1.600"/><rect x="9" y="24" width="14" height="5" rx="1" fill="#b3addf" stroke="#15102c" stroke-width="1.800"/></svg>';

/** Wumpa / crystal / Aku Aku icons rendered from the real models; trophy cup is a flat vector. */
export function icon(name: 'wumpa' | 'crystal' | 'cup' | 'aku'): string {
  if (name === 'cup') return CUP;
  const u = propIcon(name === 'aku' ? 'akuAku' : name);
  return u ? `<img class="ico img" src="${u}" alt="">` : `<i class="ico ico-${name}"></i>`;
}

/** Background colours of the character-select squares (same order as the roster). */
const FACE_BG = ['#f5a30f', '#f06cae', '#1fa85c', '#2f6be0', '#86c53a', '#d634b6', '#8a40d4', '#18bfc6'];

/** Character face icon in a coloured square (bare = no square, like the in-game HUD). */
export function face(char: number, bare = false, cls = ''): string {
  const i = ((char % CHARACTERS.length) + CHARACTERS.length) % CHARACTERS.length;
  const c = CHARACTERS[i];
  const url = hudFace(i);
  const inner = url ? `<img src="${url}" alt="${esc(c.name)}" draggable="false">` : `<b>${esc(c.name[0])}</b>`;
  return `<span class="face ${bare ? 'bare' : ''} ${cls}" style="--bg:${FACE_BG[i] ?? '#667'}">${inner}</span>`;
}
