// MD Reader — reader window.
// Startup path: resolve the target, render the document, paint, show the window. Everything
// else (plugins, watchers, drag & drop, find, quick open) is set up after the window is visible.
import * as api from './api.js';
import { renderInto, installDocHandlers, renderError } from './doc.js';
import { createTree } from './sidebar.js';
import { createOutline } from './outline.js';
import {
  $, h, icon, store, session, toast, debounce, isMac, isWindows,
  basename, dirname, joinPath, normPath, isInside, relativePath, isMarkdownPath,
} from './util.js';

const body = document.body;
const rootEl = document.documentElement;
const contentEl = $('#content');
const docEl = $('#doc');
const mainEl = $('#main');

const state = {
  mode: 'welcome',   // 'welcome' | 'file' | 'folder'
  root: null,        // folder path (folder mode)
  path: null,        // current document path
  doc: null,         // last render_file result
  shown: false,
  history: [],       // [{path, hash, scroll}]
  hIndex: -1,
  watching: null,
  version: '',
};
let tree = null;
let find = null;
let navToken = 0;
let pendingScroll = null; // {top} or {hash}: re-applied after plugins changed the layout

const outline = createOutline($('#outline-list'), contentEl, { onNavigate: (id) => openDoc(state.path, { hash: id }) });
installDocHandlers(docEl);

// =================================================================== startup
// (started at the bottom of this module, once every binding is initialized)

async function init() {
  const target = api.params.get('path');
  await startWith(target);
  await showWindow();
  afterShow();
}

async function startWith(target) {
  if (!target) {
    setMode('welcome');
    const { renderWelcome } = await import('./welcome.js');
    renderWelcome(welcomeEl(), { openFile: () => openDialog(false), openFolder: () => openDialog(true), open: openTarget }, state.version);
    setTitle('MD Reader');
    return;
  }
  const info = await api.pathInfo(target).catch(() => null);
  if (!info || !info.exists) {
    setMode('file');
    setTitle(basename(target));
    state.path = target;
    updateCrumbs();
    showError({
      title: 'File not found',
      detail: 'It may have been moved, renamed or deleted.',
      path: target,
      action: { label: 'Open File…', run: () => openDialog(false) },
    });
    return;
  }
  // Not on the critical path: the recent list is only needed by the welcome screen.
  import('./welcome.js').then((m) => m.addRecent(target, info.isDir ? 'folder' : 'file'));
  if (info.isDir) await openFolder(target);
  else {
    setMode('file');
    await openDoc(target);
  }
}

let welcome = null;
function welcomeEl() {
  if (!welcome) { welcome = h('div', { id: 'welcome' }); contentEl.append(welcome); }
  return welcome;
}

function setMode(mode) {
  state.mode = mode;
  body.classList.remove('mode-welcome', 'mode-file', 'mode-folder');
  body.classList.add('mode-' + mode);
  docEl.hidden = mode === 'welcome';
  if (mode !== 'welcome' && welcome) { welcome.remove(); welcome = null; }
  if (mode === 'welcome') body.classList.remove('has-outline');
  layoutPanels();
}

function showWindow() {
  return new Promise((resolve) => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      state.shown = true;
      const w = api.currentWindow();
      w.show().then(() => w.setFocus()).catch(() => {});
      window.__mdrShownAt = performance.now();
      console.debug(`[mdr] window shown ${window.__mdrShownAt.toFixed(1)}ms after navigation start`);
      resolve();
    };
    // After the first paint. Hidden windows may not tick rAF, so a timer backs it up.
    void document.body.offsetHeight; // style + layout are done now
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 16);
  });
}

function afterShow() {
  api.appInfo().then((i) => { state.version = i.version; }).catch(() => {});
  api.listen('menu', (id) => run(id));
  api.listen('fs-changed', onFsChanged);
  setupDragDrop();
  setupSplitter();
  setupLinkStatus();
  new ResizeObserver(layoutPanels).observe(mainEl);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
  window.addEventListener('storage', (e) => {
    if (e.key === 'mdr.theme') applyTheme();
    else if (e.key === 'mdr.zoom') applyZoom(store.get('mdr.zoom', 1), false);
  });
  window.addEventListener('mdr:plugins-changed', () => rerender());
  syncNativeTheme();
  watchCurrent();
  runPlugins();
}

// =================================================================== documents

async function openFolder(root) {
  setMode('folder');
  state.root = root;
  if (!tree) tree = createTree($('#tree'), $('#filter'), { rootPath: root, onOpen: (p, o) => { closePeeks(); openDoc(p, o); } });
  const last = store.get('mdr.last:' + root, null);
  const [node, lastDoc] = await Promise.all([
    api.scanFolder(root),
    last && isInside(last, root) ? api.renderFile(last).catch(() => null) : null,
  ]);
  tree.setData(node);
  updateCrumbs();
  if (lastDoc && tree.hasFile(last)) {
    display(lastDoc, {});
    pushHistory({ path: lastDoc.path, hash: null });
    return;
  }
  const first = tree.firstFile();
  if (first) return openDoc(first);
  setTitle(basename(root));
  state.path = null;
  state.doc = null;
  outline.set([], docEl);
  body.classList.remove('has-outline');
  showError({ title: 'No markdown files', detail: 'This folder does not contain any markdown files yet. New files appear here automatically.', path: root });
}

/**
 * Open a document in this window.
 * opts: {hash, push=true, scrollTop, newWindow, smooth}
 */
async function openDoc(path, opts = {}) {
  const { hash = null, push = true, newWindow = false } = opts;
  if (newWindow) return api.openWindow(path);
  saveScroll();
  const same = state.doc && normPath(path) === normPath(state.path);
  if (same) {
    if (push) pushHistory({ path, hash });
    if (hash) scrollToId(hash, opts.smooth !== false);
    else if (opts.scrollTop != null) contentEl.scrollTop = opts.scrollTop;
    else if (push) contentEl.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const token = ++navToken;
  let doc;
  try {
    doc = await api.renderFile(path);
  } catch (e) {
    if (token !== navToken) return;
    const exists = (await api.pathInfo(path).catch(() => null))?.exists;
    state.doc = null;
    state.path = path;
    if (push) pushHistory({ path, hash });
    tree?.setActive(tree.hasFile(path) ? path : null);
    outline.set([], docEl);
    body.classList.remove('has-outline');
    setTitle(basename(path));
    updateCrumbs();
    showError(exists === false
      ? { title: 'File not found', detail: 'It may have been moved, renamed or deleted.', path }
      : { title: 'Could not open this file', detail: String(e?.message || e), path });
    watchCurrent();
    return;
  }
  if (token !== navToken) return;
  display(doc, { hash, scrollTop: opts.scrollTop });
  if (push) pushHistory({ path: doc.path, hash });
  if (state.shown) { watchCurrent(); runPlugins(); }
}

/** Insert a rendered doc and update everything that depends on it. */
function display(doc, { hash = null, scrollTop = null, keepScroll = false } = {}) {
  const prevPath = state.path;
  state.doc = doc;
  state.path = doc.path;
  const top = keepScroll ? contentEl.scrollTop : null;
  renderInto(docEl, doc);
  outline.set(doc.headings, docEl);
  body.classList.toggle('has-outline', doc.headings.length > 1);
  layoutPanels();
  setTitle(doc.title || basename(doc.path));
  if (state.mode === 'folder') {
    const inside = tree.hasFile(doc.path);
    tree.setActive(inside ? doc.path : null, { reveal: normPath(prevPath || '') !== normPath(doc.path) });
    if (inside) store.set('mdr.last:' + state.root, doc.path);
  } else if (state.mode === 'file') {
    history.replaceState(null, '', 'index.html?path=' + encodeURIComponent(doc.path));
  }
  updateCrumbs();
  // Scroll position
  if (keepScroll) { contentEl.scrollTop = top; pendingScroll = { top }; }
  else if (hash) { scrollToId(hash, false); pendingScroll = { hash }; }
  else {
    const t = scrollTop ?? session.get('mdr.scroll:' + doc.path, 0);
    contentEl.scrollTop = t;
    pendingScroll = t ? { top: t } : null;
  }
  outline.refresh();
  find?.refresh();
  if (!keepScroll && document.activeElement !== $('#filter') && !document.activeElement?.closest?.('#tree, .findbar')) {
    contentEl.focus({ preventScroll: true });
  }
}

/** Re-render the current document (file changed on disk, reload, theme change). */
async function reloadCurrent({ live = false } = {}) {
  if (!state.path) return;
  const path = state.path;
  let doc;
  for (let attempt = 0; ; attempt++) {
    try { doc = await api.renderFile(path); break; } catch (e) {
      // Editors often save by delete + rename; give the new file a moment to appear.
      if (live && attempt < 2) { await new Promise((r) => setTimeout(r, 250)); continue; }
      if (normPath(state.path) !== normPath(path)) return;
      const exists = (await api.pathInfo(path).catch(() => null))?.exists;
      state.doc = null;
      showError(exists === false
        ? { title: 'This file no longer exists', detail: 'It was moved, renamed or deleted.', path }
        : { title: 'Could not open this file', detail: String(e?.message || e), path });
      outline.set([], docEl);
      body.classList.remove('has-outline');
      return;
    }
  }
  if (normPath(state.path) !== normPath(path)) return;
  display(doc, { keepScroll: true });
  runPlugins();
}

/** Re-insert the cached HTML (e.g. after a theme change so plugins render in the new theme). */
function rerender() {
  if (!state.doc) return;
  display(state.doc, { keepScroll: true });
  runPlugins();
}

function showError(err) {
  docEl.hidden = false;
  renderError(docEl, err);
  contentEl.scrollTop = 0;
}

function scrollToId(id, smooth) {
  let raw = id;
  try { raw = decodeURIComponent(id); } catch {}
  const el = document.getElementById(raw) || document.getElementById(id) || docEl.querySelector(`[name="${CSS.escape(raw)}"]`);
  if (!el || !docEl.contains(el)) { if (smooth) toast(`No heading “${raw}” in this document`); return; }
  el.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'instant' });
  if (el.matches('li, p')) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
}

// =================================================================== history

function pushHistory(entry) {
  state.history.splice(state.hIndex + 1);
  const cur = state.history[state.hIndex];
  if (cur && normPath(cur.path) === normPath(entry.path) && cur.hash === entry.hash) return updateNavButtons();
  state.history.push({ ...entry, scroll: null });
  if (state.history.length > 200) state.history.shift();
  state.hIndex = state.history.length - 1;
  updateNavButtons();
}

function saveScroll() {
  if (!state.path || !state.doc) return;
  const cur = state.history[state.hIndex];
  if (cur && normPath(cur.path) === normPath(state.path)) cur.scroll = contentEl.scrollTop;
  session.set('mdr.scroll:' + state.path, contentEl.scrollTop);
}

function go(delta) {
  const i = state.hIndex + delta;
  const e = state.history[i];
  if (!e) return;
  saveScroll();
  state.hIndex = i;
  updateNavButtons();
  openDoc(e.path, { push: false, hash: e.scroll == null ? e.hash : null, scrollTop: e.scroll ?? undefined, smooth: false });
}

function updateNavButtons() {
  $('#btn-back').disabled = state.hIndex <= 0;
  $('#btn-forward').disabled = state.hIndex >= state.history.length - 1;
}

contentEl.addEventListener('scroll', debounce(() => {
  if (state.path && state.doc) session.set('mdr.scroll:' + state.path, contentEl.scrollTop);
}, 250), { passive: true });
contentEl.addEventListener('wheel', () => { pendingScroll = null; }, { passive: true });
contentEl.addEventListener('keydown', () => { pendingScroll = null; });

// =================================================================== links

docEl.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented) return;
  e.preventDefault();
  handleLink(a.getAttribute('href'), { newWindow: e.metaKey || e.ctrlKey });
});
docEl.addEventListener('auxclick', (e) => {
  const a = e.target.closest('a[href]');
  if (!a || e.button !== 1) return;
  e.preventDefault();
  handleLink(a.getAttribute('href'), { newWindow: true });
});

async function handleLink(href, { newWindow = false } = {}) {
  href = href.trim();
  if (href.startsWith('#')) {
    if (href.length > 1) openDoc(state.path, { hash: href.slice(1) });
    return;
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  const winDrive = isWindows && /^[a-z]:[\\/]/i.test(href);
  if (scheme && !winDrive && scheme !== 'file' && scheme !== 'mdr') {
    if (['http', 'https', 'mailto', 'tel'].includes(scheme) || scheme === 'ftp') {
      api.opener.openUrl(href).catch((e) => toast(`Couldn't open link: ${e}`, 3000));
    } else toast(`Unsupported link: ${href}`, 2500);
    return;
  }
  // A local path (relative, absolute, file:// or mdr://).
  let raw = href;
  if (scheme === 'file') raw = href.replace(/^file:\/\/(localhost)?/i, '');
  else if (scheme === 'mdr') raw = '/' + href.replace(/^mdr:\/\/localhost\/?/i, '');
  const hashAt = raw.indexOf('#');
  const frag = hashAt >= 0 ? raw.slice(hashAt + 1) : null;
  let p = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  p = p.split('?')[0];
  try { p = decodeURIComponent(p); } catch {}
  if (isWindows && /^\/[a-z]:/i.test(p)) p = p.slice(1);
  if (!p) { if (frag) openDoc(state.path, { hash: frag }); return; }

  const base = state.doc?.dir || (state.path ? dirname(state.path) : state.root);
  const absolute = p.startsWith('/') || /^[a-z]:[\\/]/i.test(p);
  const candidates = [];
  if (absolute) {
    candidates.push(p);
    if (state.root && p.startsWith('/')) candidates.push(joinPath(state.root, p.slice(1))); // repo-root relative
  } else candidates.push(joinPath(base, p));
  let target = null, info = null;
  for (const c of candidates) {
    for (const alt of /\.[a-z0-9]{1,8}$/i.test(c) ? [c] : [c, c + '.md', c + '.markdown']) {
      const i = await api.pathInfo(alt).catch(() => null);
      if (i?.exists) { target = alt; info = i; break; }
    }
    if (target) break;
  }
  if (!target) { toast(`File not found: ${p}`, 2500); return; }

  if (info.isDir) {
    if (state.mode === 'folder' && isInside(target, state.root) && !newWindow) {
      const f = tree.firstFileIn(target);
      if (f) return openDoc(f);
    }
    return api.openWindow(target);
  }
  if (info.isMarkdown || isMarkdownPath(target)) {
    if (newWindow) return api.openWindow(target);
    return openDoc(target, { hash: frag });
  }
  // Only safe document/media types may be opened (capability scope); anything else is revealed.
  api.opener.openPath(target).catch(() => api.opener.revealItemInDir(target).catch((e) => toast(`Couldn't open file: ${e}`, 3000)));
}

function setupLinkStatus() {
  const status = $('#status');
  docEl.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    status.textContent = href.startsWith('#') ? href : decodeSafe(href);
    status.classList.add('show');
  });
  docEl.addEventListener('mouseout', (e) => {
    if (e.target.closest('a[href]') && !e.relatedTarget?.closest?.('a[href]')) status.classList.remove('show');
  });
}
const decodeSafe = (s) => { try { return decodeURI(s); } catch { return s; } };

// =================================================================== watching / live reload

function watchCurrent() {
  if (!state.shown) return;
  let target = null;
  if (state.mode === 'folder') target = !state.path || isInside(state.path, state.root) ? state.root : state.path;
  else if (state.mode === 'file') target = state.path;
  if (!target || target === state.watching) return;
  const wasOther = state.mode === 'folder' && state.watching && state.watching !== state.root && target === state.root;
  state.watching = target;
  api.watchPath(target).catch((e) => console.warn('watch failed', e));
  if (wasOther) rescan(); // changes may have been missed while watching another file
}

const pendingFs = new Set();
const flushFs = debounce(async () => {
  const paths = [...pendingFs];
  pendingFs.clear();
  const cur = state.path ? normPath(state.path) : null;
  const docChanged = paths.some((p) => normPath(p) === cur) ||
    // images of the current document
    (state.doc && paths.some((p) => /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i.test(p) && isInside(p, state.doc.dir)));
  if (state.mode === 'folder' && tree && state.watching === state.root) {
    let changed = false;
    for (const p of paths) {
      if (isMarkdownPath(p)) {
        if (!tree.hasFile(p)) { if ((await api.pathInfo(p).catch(() => null))?.exists) { changed = true; break; } }
        else if (normPath(p) !== cur && !(await api.pathInfo(p).catch(() => null))?.exists) { changed = true; break; }
      } else if (tree.hasDir(p) || !/\.[^\\/]+$/.test(basename(p))) { changed = true; break; }
    }
    if (changed) await rescan();
  }
  if (docChanged) reloadCurrent({ live: true });
  else if (!state.doc && state.mode === 'folder' && !state.path && tree?.firstFile()) openDoc(tree.firstFile());
}, 150);

function onFsChanged(paths) {
  for (const p of paths || []) pendingFs.add(p);
  flushFs();
}

async function rescan() {
  if (state.mode !== 'folder') return;
  try {
    const node = await api.scanFolder(state.root);
    tree.setData(node);
    tree.setActive(state.path && tree.hasFile(state.path) ? state.path : null, { reveal: false });
  } catch (e) { console.warn('rescan failed', e); }
}

// =================================================================== plugins

let pluginHost = null;
function plugins() {
  return (pluginHost ??= import('./plugins.js')
    .then((m) => { m.loadPlugins?.(); return m; })
    .catch((e) => { console.info('[mdr] plugin host unavailable:', e?.message || e); return null; }));
}

async function runPlugins() {
  if (!state.shown || !state.doc) return;
  const m = await plugins();
  if (!m?.runPlugins || !state.doc) return;
  const docAtStart = state.doc;
  try {
    await m.runPlugins(docEl, { mode: 'reader', theme: rootEl.dataset.theme, docPath: state.path });
  } catch (e) { console.error('[mdr] plugins failed', e); }
  if (state.doc !== docAtStart) return;
  // Plugins (diagrams, math) change heights: restore the intended position if the user didn't scroll.
  const ps = pendingScroll;
  pendingScroll = null;
  if (ps?.hash) scrollToId(ps.hash, false);
  else if (ps?.top != null) contentEl.scrollTop = ps.top;
  outline.refresh();
  find?.refresh();
}

async function showPlugins() {
  try {
    const m = await import('./plugin-manager.js');
    await m.showPluginManager();
  } catch (e) {
    console.warn(e);
    toast('Plugins are not available');
  }
}

// =================================================================== theme & zoom

const THEMES = ['system', 'light', 'dark'];
const themePref = () => { try { const v = localStorage.getItem('mdr.theme'); return THEMES.includes(v) ? v : 'system'; } catch { return 'system'; } };

function setThemePref(pref, announce = false) {
  try { localStorage.setItem('mdr.theme', pref); } catch {}
  applyTheme();
  if (announce) {
    const eff = rootEl.dataset.theme;
    toast(pref === 'system' ? `Theme: System (${eff === 'dark' ? 'Dark' : 'Light'})` : `Theme: ${pref === 'dark' ? 'Dark' : 'Light'}`);
  }
}

function applyTheme() {
  const pref = themePref();
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const theme = dark ? 'dark' : 'light';
  const changed = rootEl.dataset.theme !== theme;
  rootEl.dataset.theme = theme;
  updateThemeButton();
  syncNativeTheme();
  // Plugins are idempotent and re-render only what depends on the theme (e.g. diagrams).
  if (changed && state.shown && state.doc) { pendingScroll = { top: contentEl.scrollTop }; runPlugins(); }
}

function syncNativeTheme() {
  const pref = themePref();
  try { api.currentWindow().setTheme(pref === 'system' ? null : pref).catch(() => {}); } catch {}
}

function updateThemeButton() {
  const pref = themePref();
  const b = $('#btn-theme');
  b.innerHTML = icon(pref === 'system' ? 'system' : pref === 'dark' ? 'moon' : 'sun');
  const label = `Theme: ${pref[0].toUpperCase() + pref.slice(1)}`;
  b.title = label;
  b.setAttribute('aria-label', label);
}

function themeItems() {
  const pref = themePref();
  return [
    { label: 'System', checked: pref === 'system', run: () => setThemePref('system') },
    { label: 'Light', checked: pref === 'light', run: () => setThemePref('light') },
    { label: 'Dark', checked: pref === 'dark', run: () => setThemePref('dark') },
  ];
}

const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
let zoom = 1;
function applyZoom(z, persist = true) {
  z = Math.min(3, Math.max(0.5, Number(z) || 1));
  const changed = z !== zoom;
  zoom = z;
  if (persist) store.set('mdr.zoom', z);
  if (changed || z !== 1) api.currentWebview().setZoom(z).catch(() => {});
}
function stepZoom(dir) {
  const i = ZOOMS.findIndex((x) => x >= zoom - 0.001);
  const next = dir > 0 ? ZOOMS.find((x) => x > zoom + 0.001) ?? 3 : [...ZOOMS].reverse().find((x) => x < zoom - 0.001) ?? 0.5;
  applyZoom(dir === 0 ? 1 : next);
  toast(`Zoom ${Math.round(zoom * 100)}%`, 900);
  void i;
}

// =================================================================== panels & layout

function applyPanels() {
  body.classList.toggle('sidebar-on', store.get('mdr.sidebar', true));
  body.classList.toggle('outline-on', store.get('mdr.outline', true));
  const w = store.get('mdr.sidebarWidth', 260);
  body.style.setProperty('--sidebar-w', w + 'px');
  updatePanelButtons();
}

function layoutPanels() {
  const w = mainEl.clientWidth || window.innerWidth;
  const sidebarNarrow = w < 640;
  const sw = state.mode === 'folder' && body.classList.contains('sidebar-on') && !sidebarNarrow ? parseInt(body.style.getPropertyValue('--sidebar-w')) || 260 : 0;
  body.classList.toggle('narrow-sidebar', sidebarNarrow);
  body.classList.toggle('narrow-outline', w - sw - 232 < 620);
  if (!sidebarNarrow) body.classList.remove('sidebar-peek');
  if (!body.classList.contains('narrow-outline')) body.classList.remove('outline-peek');
  updatePanelButtons();
}

function updatePanelButtons() {
  const sb = body.classList.contains('narrow-sidebar') ? body.classList.contains('sidebar-peek') : body.classList.contains('sidebar-on');
  const ol = body.classList.contains('narrow-outline') ? body.classList.contains('outline-peek') : body.classList.contains('outline-on');
  $('#btn-sidebar').setAttribute('aria-pressed', String(sb));
  $('#btn-outline').setAttribute('aria-pressed', String(ol));
}

function toggleSidebar() {
  if (state.mode !== 'folder') return;
  if (body.classList.contains('narrow-sidebar')) body.classList.toggle('sidebar-peek');
  else store.set('mdr.sidebar', body.classList.toggle('sidebar-on'));
  layoutPanels();
}
function toggleOutline() {
  if (!body.classList.contains('has-outline')) { toast('This document has no outline', 1200); return; }
  if (body.classList.contains('narrow-outline')) body.classList.toggle('outline-peek');
  else store.set('mdr.outline', body.classList.toggle('outline-on'));
  layoutPanels();
}
function closePeeks() { body.classList.remove('sidebar-peek', 'outline-peek'); updatePanelButtons(); }
contentEl.addEventListener('mousedown', closePeeks);

function setupSplitter() {
  const sp = $('#splitter'), sb = $('#sidebar');
  sp.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('dragging');
    body.classList.add('resizing');
    const left = sb.getBoundingClientRect().left;
    const move = (ev) => {
      const w = Math.round(Math.min(Math.max(160, ev.clientX - left), Math.min(560, window.innerWidth * 0.6)));
      body.style.setProperty('--sidebar-w', w + 'px');
    };
    const up = () => {
      sp.removeEventListener('pointermove', move);
      sp.classList.remove('dragging');
      body.classList.remove('resizing');
      store.set('mdr.sidebarWidth', parseInt(body.style.getPropertyValue('--sidebar-w')) || 260);
      layoutPanels();
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up, { once: true });
    sp.addEventListener('pointercancel', up, { once: true });
  });
  sp.addEventListener('dblclick', () => { body.style.setProperty('--sidebar-w', '260px'); store.set('mdr.sidebarWidth', 260); layoutPanels(); });
}

// =================================================================== toolbar, title, crumbs

function setupToolbar() {
  const icons = { 'btn-sidebar': 'sidebar', 'btn-back': 'back', 'btn-forward': 'forward', 'btn-find': 'search', 'btn-outline': 'outline', 'btn-export': 'export', 'btn-plugins': 'plugins', 'btn-more': 'more' };
  for (const [id, name] of Object.entries(icons)) $('#' + id).innerHTML = icon(name);
  const k = (mac, win) => (isMac ? mac : win);
  const tips = {
    'btn-sidebar': `Toggle sidebar (${k('⌘\\', 'Ctrl+\\')})`, 'btn-back': `Back (${k('⌘[', 'Alt+←')})`, 'btn-forward': `Forward (${k('⌘]', 'Alt+→')})`,
    'btn-find': `Find (${k('⌘F', 'Ctrl+F')})`, 'btn-outline': `Toggle outline (${k('⇧⌘\\', 'Ctrl+Shift+\\')})`, 'btn-export': 'Export to PDF',
    'btn-plugins': `Plugins (${k('⌘,', 'Ctrl+,')})`,
  };
  for (const [id, t] of Object.entries(tips)) $('#' + id).title = t;
  updateThemeButton();
  $('#toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cmd]');
    if (b && !b.disabled) run(b.dataset.cmd, b);
  });
}

function setTitle(t) {
  document.title = t;
  api.currentWindow().setTitle(t).catch(() => {});
}

function updateCrumbs() {
  const el = $('#crumbs');
  el.innerHTML = '';
  if (state.mode === 'welcome') return;
  const parts = [];
  if (state.mode === 'folder') {
    parts.push(basename(state.root));
    if (state.path) {
      if (isInside(state.path, state.root)) parts.push(...relativePath(state.path, state.root).split(/[\\/]/));
      else parts.push(basename(state.path));
    }
  } else if (state.path) parts.push(basename(state.path));
  parts.forEach((p, i) => {
    if (i) el.append(h('span', { class: 'sep', 'aria-hidden': 'true', text: '›' }));
    el.append(h('span', { class: i === parts.length - 1 ? 'cur' : '', text: p, title: i === parts.length - 1 ? state.path || state.root : null }));
  });
}

// =================================================================== commands

function exportItems() {
  return [
    { label: 'Export this document…', kbd: isMac ? '⌘E' : 'Ctrl+E', disabled: !state.doc, run: () => run('export-pdf') },
    ...(state.mode === 'folder' ? [{ label: 'Export entire folder…', kbd: isMac ? '⇧⌘E' : 'Ctrl+Shift+E', run: () => run('export-folder-pdf') }] : []),
  ];
}

function moreItems() {
  const k = (mac, win) => (isMac ? mac : win);
  const inDoc = state.mode !== 'welcome';
  return [
    { label: 'Open File…', kbd: k('⌘O', 'Ctrl+O'), run: () => run('open-file') },
    { label: 'Open Folder…', kbd: k('⇧⌘O', 'Ctrl+Shift+O'), run: () => run('open-folder') },
    { label: 'New Window', kbd: k('⌘N', 'Ctrl+N'), run: () => run('new-window') },
    ...(state.mode === 'folder' ? [{ label: 'Go to File…', kbd: k('⌘P', 'Ctrl+P'), run: () => run('quick-open') }] : []),
    '-',
    ...exportItems(),
    { label: isMac ? 'Show in Finder' : 'Show in Explorer', disabled: !inDoc || !(state.path || state.root), run: () => run('reveal') },
    { label: 'Reload', kbd: k('⌘R', 'Ctrl+R'), disabled: !inDoc, run: () => run('reload') },
    '-',
    { note: 'Appearance' },
    ...themeItems(),
    '-',
    { label: 'Zoom In', kbd: k('⌘+', 'Ctrl++'), run: () => run('zoom-in') },
    { label: 'Zoom Out', kbd: k('⌘−', 'Ctrl+−'), run: () => run('zoom-out') },
    { label: 'Actual Size', kbd: k('⌘0', 'Ctrl+0'), run: () => run('zoom-reset') },
    '-',
    { label: 'Plugins…', kbd: k('⌘,', 'Ctrl+,'), run: () => run('manage-plugins') },
    { label: 'About MD Reader', run: about },
  ];
}

async function about() {
  if (!state.version) state.version = (await api.appInfo().catch(() => ({}))).version || '';
  api.dialog.message(`MD Reader ${state.version}\nA fast, native markdown reader.`, { title: 'About MD Reader', kind: 'info' }).catch(() => toast(`MD Reader ${state.version}`));
}

async function withMenu(fn) { const m = await import('./menu.js'); fn(m.showMenu); }

async function run(cmd, btn) {
  switch (cmd) {
    case 'open-file': return openDialog(false);
    case 'open-folder': return openDialog(true);
    case 'new-window': return api.openWindow();
    case 'quick-open': return quickOpen();
    case 'export-pdf': if (state.path && state.doc) api.openExport(state.path, 'file').catch((e) => toast(String(e), 3000)); return;
    case 'export-folder-pdf':
      if (state.mode === 'folder') api.openExport(state.root, 'folder').catch((e) => toast(String(e), 3000));
      else if (state.path) api.openExport(state.path, 'file').catch((e) => toast(String(e), 3000));
      return;
    case 'export-menu': return withMenu((show) => show(btn || $('#btn-export'), exportItems()));
    case 'theme-menu': return withMenu((show) => show(btn || $('#btn-theme'), [{ note: 'Appearance' }, ...themeItems(), '-', { label: 'Cycle theme', kbd: isMac ? '⇧⌘D' : 'Ctrl+Shift+D', run: () => run('toggle-theme') }]));
    case 'more-menu': return withMenu((show) => show(btn || $('#btn-more'), moreItems()));
    case 'reveal': { const p = state.path || state.root; if (p) api.opener.revealItemInDir(p).catch((e) => toast(String(e), 3000)); return; }
    case 'find': return (await getFind()).open();
    case 'find-next': return (await getFind()).step(1);
    case 'find-prev': return (await getFind()).step(-1);
    case 'toggle-sidebar': return toggleSidebar();
    case 'toggle-outline': return toggleOutline();
    case 'zoom-in': return stepZoom(1);
    case 'zoom-out': return stepZoom(-1);
    case 'zoom-reset': return stepZoom(0);
    case 'toggle-theme': return setThemePref(THEMES[(THEMES.indexOf(themePref()) + 1) % 3], true);
    case 'reload':
      if (state.mode === 'folder') await rescan();
      if (state.path) await reloadCurrent();
      return;
    case 'manage-plugins': return showPlugins();
    case 'back': return go(-1);
    case 'forward': return go(1);
    case 'close': return api.currentWindow().close();
  }
}

async function getFind() {
  if (!find) {
    const { createFind } = await import('./find.js');
    find = createFind(contentEl.parentElement, docEl, contentEl);
  }
  return find;
}

async function quickOpen() {
  if (state.mode !== 'folder' || !tree) return;
  const { showQuickOpen } = await import('./quickopen.js');
  showQuickOpen(tree.files(), { current: state.path, onOpen: (p, o) => openDoc(p, o) });
}

async function openDialog(directory) {
  const opts = directory
    ? { directory: true, multiple: false, title: 'Open Folder' }
    : { multiple: false, title: 'Open Markdown File', filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn', 'mdwn', 'mdx'] }] };
  let p;
  try { p = await api.dialog.open(opts); } catch (e) { toast(String(e), 3000); return; }
  if (Array.isArray(p)) p = p[0];
  if (p) openTarget(p);
}

/** Open a path chosen by the user: in this window when it shows the welcome screen, else a new window. */
function openTarget(p) {
  if (state.mode === 'welcome') {
    history.replaceState(null, '', 'index.html?path=' + encodeURIComponent(p));
    startWith(p).then(() => { watchCurrent(); runPlugins(); });
  } else api.openWindow(p);
}

// =================================================================== keyboard

document.addEventListener('keydown', (e) => {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  let cmd = null;
  if (mod && !e.altKey) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const c = e.code;
    const s = e.shiftKey;
    if (k === 'o') cmd = s ? 'open-folder' : 'open-file';
    else if (k === 'p' && !s) cmd = 'quick-open';
    else if (k === 'e') cmd = s ? 'export-folder-pdf' : 'export-pdf';
    else if (k === 'f' && !s) cmd = 'find';
    else if (k === 'g') cmd = s ? 'find-prev' : 'find-next';
    else if (c === 'Backslash' || k === '\\' || k === '|') cmd = s ? 'toggle-outline' : 'toggle-sidebar';
    else if (c === 'Equal' || k === '=' || k === '+') cmd = 'zoom-in';
    else if (c === 'Minus' || k === '-' || k === '_') cmd = 'zoom-out';
    else if ((c === 'Digit0' || k === '0') && !s) cmd = 'zoom-reset';
    else if (k === 'd' && s) cmd = 'toggle-theme';
    else if (k === 'r' && !s) cmd = 'reload';
    else if (k === 'w' && !s) cmd = 'close';
    else if (c === 'BracketLeft' || k === '[') cmd = 'back';
    else if (c === 'BracketRight' || k === ']') cmd = 'forward';
    else if (k === ',') cmd = 'manage-plugins';
    else if (k === 'n' && !s && !isMac) cmd = 'new-window'; // macOS: handled by the native menu
  } else if (e.altKey && !e.metaKey && !e.ctrlKey && !isMac && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    cmd = e.key === 'ArrowLeft' ? 'back' : 'forward';
  } else if (e.key === 'F3' && !e.metaKey && !e.ctrlKey) {
    cmd = e.shiftKey ? 'find-prev' : 'find-next';
  } else if (e.key === 'Escape') {
    if (find?.isOpen) { find.close(); e.preventDefault(); return; }
    if (body.classList.contains('sidebar-peek') || body.classList.contains('outline-peek')) { closePeeks(); e.preventDefault(); return; }
  }
  if (!cmd) return;
  e.preventDefault();
  e.stopPropagation();
  if (state.mode === 'welcome' && !['open-file', 'open-folder', 'new-window', 'zoom-in', 'zoom-out', 'zoom-reset', 'toggle-theme', 'close', 'manage-plugins'].includes(cmd)) return;
  run(cmd);
}, true);

// Mouse back/forward buttons.
window.addEventListener('mouseup', (e) => {
  if (e.button === 3) { e.preventDefault(); run('back'); }
  else if (e.button === 4) { e.preventDefault(); run('forward'); }
});

// =================================================================== drag & drop

function setupDragDrop() {
  let wv;
  try { wv = api.currentWebview(); } catch { return; }
  wv.onDragDropEvent(async (ev) => {
    const t = ev.payload.type;
    if (t === 'enter' || t === 'over') body.classList.add('drop-target');
    else if (t === 'leave') body.classList.remove('drop-target');
    else if (t === 'drop') {
      body.classList.remove('drop-target');
      const paths = ev.payload.paths || [];
      const infos = await Promise.all(paths.map((p) => api.pathInfo(p).catch(() => null)));
      const ok = paths.filter((p, i) => infos[i]?.exists && (infos[i].isDir || infos[i].isMarkdown));
      if (!ok.length) { toast('Drop a markdown file or a folder', 2000); return; }
      let rest = ok;
      if (state.mode === 'welcome') { openTarget(ok[0]); rest = ok.slice(1); }
      for (const p of rest) api.openWindow(p);
    }
  }).catch(() => {});
}

// =================================================================== go
setupToolbar();
applyPanels();
applyZoom(store.get('mdr.zoom', 1), false);
init().catch((e) => {
  console.error(e);
  showError({ title: 'Something went wrong', detail: String(e?.message || e) });
  showWindow();
});
