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

import { propIcon } from '../shell/avatar';

/** Wumpa / Crystal icon: rendered from the real model when the catalog has it, else a CSS stand-in. */
export function icon(name: 'wumpa' | 'crystal'): string {
  const u = propIcon(name);
  return u ? `<img class="ico img" src="${u}" alt="${name}">` : `<i class="ico ico-${name}"></i>`;
}
