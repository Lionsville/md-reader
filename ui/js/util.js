// Small shared helpers for the reader UI: icons, storage, paths, DOM.

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const isWindows = /Win/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl+';

// ------------------------------------------------------------------ icons (inline SVG, stroke style)
const P = {
  sidebar: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10"/>',
  back: '<path d="M10 3 5 8l5 5"/>',
  forward: '<path d="m6 3 5 5-5 5"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
  outline: '<path d="M2.5 4h11M5 8h8.5M7.5 12h6"/>',
  export: '<path d="M4.5 1.8h4.8l3.2 3.2v8.2a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z"/><path d="M9 1.8v3.5h3.5M8 7.5v4.5M6.2 10.3 8 12.1l1.8-1.8"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/>',
  moon: '<path d="M13.5 9.6A5.7 5.7 0 0 1 6.4 2.5a5.7 5.7 0 1 0 7.1 7.1Z"/>',
  system: '<circle cx="8" cy="8" r="5.8"/><path d="M8 2.2v11.6A5.8 5.8 0 0 0 8 2.2Z" fill="currentColor"/>',
  plugins: '<path d="M6.2 2.2h3.6v2.1a1.3 1.3 0 1 0 2.1 0V4h2v3.8h-1.7a1.3 1.3 0 1 0 0 2.4h1.7V14H10.1v-1.6a1.3 1.3 0 1 0-2.4 0V14H3.9V10.2h1.5a1.3 1.3 0 1 0 0-2.4H3.9V4h2.3Z"/>',
  more: '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>',
  chevron: '<path d="m6 4 4 4-4 4"/>',
  up: '<path d="m4 10 4-4 4 4"/>',
  down: '<path d="m4 6 4 4 4-4"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  file: '<path d="M4.5 1.8h4.8l3.2 3.2v8.2a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z"/><path d="M9 1.8v3.5h3.5"/>',
  doc: '<path d="M4.5 1.8h4.8l3.2 3.2v8.2a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z"/><path d="M9 1.8v3.5h3.5M5.8 8.5h4.4M5.8 11h3"/>',
  folder: '<path d="M1.8 4.3a1 1 0 0 1 1-1h3.3l1.5 1.6h5.6a1 1 0 0 1 1 1v6.8a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1Z"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.8a1.3 1.3 0 0 0-1.3-1.3H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3h1.7"/>',
  check: '<path d="M3.2 8.4 6.4 11.5 12.8 4.8"/>',
  warn: '<path d="M8 2.2 14.3 13H1.7Z"/><path d="M8 6.5v3M8 11.3v.1"/>',
  missing: '<path d="M4.5 1.8h4.8l3.2 3.2v8.2a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1Z"/><path d="M6.2 8.2l3.6 3.6M9.8 8.2l-3.6 3.6"/>',
};
export function icon(name, cls = 'i') {
  return `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${P[name] || ''}</svg>`;
}

// ------------------------------------------------------------------ storage (never throws)
export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};
export const session = {
  get(key, fallback = null) {
    try { const v = sessionStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

// ------------------------------------------------------------------ paths
export const SEP = isWindows ? '\\' : '/';
const MD_EXT = /\.(md|markdown|mdown|mkd|mkdn|mdwn|mdx|mdtxt|mdtext)$/i;
export const isMarkdownPath = (p) => MD_EXT.test(p);
export const basename = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
export const dirname = (p) => {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i <= 0 ? (i === 0 ? s[0] : s) : s.slice(0, i);
};
export const stripExt = (name) => name.replace(/\.[^.]+$/, '');
const isAbs = (p) => p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');

/** Resolve `rel` against directory `base` and normalize `.`/`..`. Keeps the platform separator of `base`. */
export function joinPath(base, rel) {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const full = isAbs(rel) ? rel : base.replace(/[\\/]+$/, '') + '/' + rel;
  const parts = full.split(/[\\/]+/);
  const out = [];
  for (const part of parts) {
    if (part === '.' || (part === '' && out.length)) continue;
    if (part === '..') { if (out.length > 1) out.pop(); continue; }
    out.push(part);
  }
  let s = out.join(sep);
  if (full.startsWith('/') && !s.startsWith('/')) s = '/' + s;
  return s || sep;
}
/** Normalize for comparisons (separators, case on Windows). */
export const normPath = (p) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindows ? s.toLowerCase() : s;
};
export const isInside = (child, parent) => {
  const c = normPath(child), p = normPath(parent);
  return c === p || c.startsWith(p + '/');
};
export const relativePath = (path, root) => {
  const p = path.replace(/\\/g, '/'), r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return normPath(p).startsWith(normPath(r) + '/') ? p.slice(r.length + 1) : p;
};

// ------------------------------------------------------------------ DOM
export const $ = (sel, root = document) => root.querySelector(sel);
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) if (c != null) el.append(c);
  return el;
}
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let toastTimer;
export function toast(msg, ms = 1600) {
  let el = document.querySelector('.toast');
  if (!el) { el = h('div', { class: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = msg;
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), ms);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
