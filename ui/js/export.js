// PDF export window: settings panel + live, paginated preview (Paged.js) + native print to PDF.
//
// Pipeline
//   1. build_export (Rust) renders every markdown file (in parallel) → bundle
//   2. prepareDocs: unique ids, links between files → in-document anchors
//   3. plugins (mermaid, math…) run once on an off-screen copy of every document
//   4. paginate: cover + ToC + documents → Paged.js pages, off-screen; then swapped into view
//      (settings changes only redo this step; ToC depth changes are debounced)
//   5. export: save dialog → print_to_pdf (Rust) prints this webview (the @media print rules in
//      export.css leave exactly the pages) and adds bookmarks + title metadata with lopdf.

import * as api from './api.js';
import { prepareDocs, tocEntries, tocHtml, coverHtml, pageCss, pageSizeMm, pagePx, escapeHtml, dirname } from './export-build.js';
import { loadPaged, paginate, Cancelled, makeLocator, fillTocNumbers, outlineItems } from './export-paginate.js';

const invoke = window.__TAURI__.core.invoke;
const $ = (id) => document.getElementById(id);

const PATH = api.params.get('path') || '';
const MODE = api.params.get('mode') === 'folder' ? 'folder' : 'file';
const PLATFORM = /Mac/i.test(navigator.platform) ? 'macos' : /Win/i.test(navigator.platform) ? 'windows' : 'linux';
const STORE_KEY = 'mdr.export.settings';

const DEFAULTS = {
  cover: MODE === 'folder',
  toc: MODE === 'folder',
  tocFolders: true,
  tocDepth: MODE === 'folder' ? 2 : 3,
  pageSize: 'A4', // always A4 portrait by default (Letter/A5/Legal are options)
  orientation: 'portrait',
  margins: 'normal',
  fontSize: '10.5',
  newPage: true,
  header: true,
  pageNumbers: true,
};

// Settings that are layout/appearance preferences are remembered; per-document ones are not.
const REMEMBERED = ['tocFolders', 'pageSize', 'orientation', 'margins', 'fontSize', 'newPage', 'header', 'pageNumbers'];

const state = {
  bundle: null,
  sections: null,      // prepared <section> templates (plugins already applied)
  styles: null,        // {url: cssText}[] for Paged.js (static part)
  settings: { ...DEFAULTS, title: '' },
  current: null,       // {pagesArea, previewer, total, outline, sizeMm, title} of the visible preview
  job: null,           // in-flight pagination {cancel, dispose}
  seq: 0,
  zoom: 'fit',         // 'fit' or a number
  exporting: false,
  lastExport: null,
};

// ---------------------------------------------------------------------------------------------
// Settings

function loadRemembered() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    for (const k of REMEMBERED) if (k in saved) state.settings[k] = saved[k];
    const perMode = saved[MODE] || {};
    for (const k of ['cover', 'toc', 'tocDepth']) if (k in perMode) state.settings[k] = perMode[k];
  } catch {}
}

function saveRemembered() {
  try {
    const out = {};
    for (const k of REMEMBERED) out[k] = state.settings[k];
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    out.file = saved.file || {};
    out.folder = saved.folder || {};
    out[MODE] = { cover: state.settings.cover, toc: state.settings.toc, tocDepth: state.settings.tocDepth };
    localStorage.setItem(STORE_KEY, JSON.stringify(out));
  } catch {}
}

const form = $('ex-form');

function writeForm() {
  const s = state.settings;
  $('opt-title').value = s.title;
  $('opt-cover').checked = s.cover;
  $('opt-toc').checked = s.toc;
  $('opt-toc-folders').checked = s.tocFolders;
  $('opt-toc-depth').value = String(s.tocDepth);
  $('opt-page-size').value = s.pageSize;
  $('opt-margins').value = s.margins;
  $('opt-font-size').value = String(s.fontSize);
  for (const r of form.querySelectorAll('input[name="orientation"]')) r.checked = r.value === s.orientation;
  $('opt-new-page').checked = s.newPage;
  $('opt-header').checked = s.header;
  $('opt-page-numbers').checked = s.pageNumbers;
  syncTocControls();
}

function readForm() {
  const s = state.settings;
  s.title = $('opt-title').value;
  s.cover = $('opt-cover').checked;
  s.toc = $('opt-toc').checked;
  s.tocFolders = $('opt-toc-folders').checked;
  s.tocDepth = Number($('opt-toc-depth').value);
  s.pageSize = $('opt-page-size').value;
  s.margins = $('opt-margins').value;
  s.fontSize = $('opt-font-size').value;
  s.orientation = form.querySelector('input[name="orientation"]:checked')?.value || 'portrait';
  s.newPage = $('opt-new-page').checked;
  s.header = $('opt-header').checked;
  s.pageNumbers = $('opt-page-numbers').checked;
}

function depthLabel(d) {
  const folders = MODE === 'folder' && state.settings.tocFolders;
  const parts = [];
  if (folders) parts.push('Folders');
  if (MODE === 'folder') parts.push('Files');
  if (d >= 1) parts.push(d === 1 ? 'H1' : `H1–H${d}`);
  return parts.join(' + ') || 'H1';
}

function syncTocControls() {
  const s = state.settings;
  const range = $('opt-toc-depth');
  range.min = MODE === 'folder' ? '0' : '1';
  $('toc-depth-value').textContent = depthLabel(s.tocDepth);
  $('toc-options').classList.toggle('is-disabled', !s.toc);
  const ticks = [];
  for (let i = Number(range.min); i <= 6; i++) ticks.push(`<span>${i === 0 ? 'Files' : 'H' + i}</span>`);
  $('toc-ticks').innerHTML = ticks.join('');
}

// Which settings require what: everything re-paginates, but text inputs are debounced longer.
let debounceTimer = 0;
function scheduleRender(delay = 250) {
  clearTimeout(debounceTimer);
  markStale(true);
  debounceTimer = setTimeout(() => render(), delay);
}

form.addEventListener('submit', (e) => e.preventDefault());
form.addEventListener('input', (e) => {
  readForm();
  syncTocControls();
  saveRemembered();
  clearDone();
  if (!state.sections) return;
  scheduleRender(e.target.id === 'opt-title' ? 450 : 250);
});
form.addEventListener('change', () => {
  // (checkbox/select/radio already handled by 'input'; this catches WebKit's select quirks)
  const before = JSON.stringify(state.settings);
  readForm();
  if (JSON.stringify(state.settings) !== before && state.sections) {
    syncTocControls();
    saveRemembered();
    scheduleRender(150);
  }
});

// ---------------------------------------------------------------------------------------------
// Status UI

function setStatus(text, kind = '') {
  const el = $('ex-status');
  el.textContent = text || '';
  el.classList.toggle('is-error', kind === 'error');
}

function setBusy(text) {
  $('ex-busy').hidden = !text;
  if (text) $('ex-busy-text').textContent = text;
}

function markStale(stale) {
  $('ex-sizer').classList.toggle('is-stale', stale && !!state.current);
  if (stale && state.current) setBusy('Updating preview…');
}

function showEmpty(text, isError = false) {
  const e = $('ex-empty');
  e.hidden = !text;
  e.classList.toggle('is-error', isError);
  $('ex-empty-text').textContent = text || '';
}

function updateExportButton() {
  $('btn-export').disabled = !state.current || state.exporting || !!state.job;
}

function clearDone() {
  $('ex-done').hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Loading

async function loadCss(href) {
  const url = new URL(href, location.href).href;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.statusText);
    return { [url]: await res.text() };
  } catch (e) {
    console.warn('[export] could not load', href, e);
    return { [url]: '' };
  }
}

async function loadPluginHost() {
  try {
    const mod = await import('./plugins.js');
    await mod.loadPlugins?.();
    return mod;
  } catch (e) {
    console.warn('[export] plugin host unavailable:', e);
    return null;
  }
}

async function init() {
  document.body.classList.toggle('is-folder', MODE === 'folder');
  if (PLATFORM === 'windows') $('btn-reveal').textContent = 'Show in Explorer';
  else if (PLATFORM === 'linux') $('btn-reveal').textContent = 'Show in Folder';
  loadRemembered();
  const name = PATH.split(/[\\/]/).filter(Boolean).pop() || PATH;
  $('ex-source').textContent = name;
  $('ex-source').title = PATH;
  writeForm();
  // Show the window after the first paint of the chrome.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    api.currentWindow().show().then(() => api.currentWindow().setFocus()).catch(() => {});
  }));
  api.currentWindow().setTitle(`Export “${name}” to PDF`).catch(() => {});

  if (!PATH) {
    showEmpty('Nothing to export: no file or folder was given.', true);
    return;
  }

  // Heavy things load in parallel with the Rust rendering.
  const pagedP = loadPaged().catch((e) => e);
  const pluginsP = loadPluginHost();
  const stylesP = Promise.all(['css/markdown.css', 'css/syntax.css', 'css/export-page.css'].map(loadCss));

  let unlisten = null;
  try {
    unlisten = await api.listen('export-progress', ({ done, total }) => {
      if (total > 1) {
        const t = `Rendering ${done}/${total}…`;
        showEmpty(t);
        setStatus(t);
      }
    });
  } catch {}

  let bundle;
  try {
    showEmpty(MODE === 'folder' ? 'Reading folder…' : 'Reading file…');
    bundle = await invoke('build_export', { path: PATH, mode: MODE });
  } catch (e) {
    showEmpty(String(e), true);
    setStatus('Could not read ' + name, 'error');
    return;
  } finally {
    unlisten?.();
  }
  state.bundle = bundle;
  if (!state.settings.title) {
    state.settings.title = bundle.title;
    $('opt-title').value = bundle.title;
  }
  const n = bundle.docs.length;
  $('ex-source').textContent = MODE === 'folder' ? `${name} — ${n} ${n === 1 ? 'file' : 'files'}` : name;

  const sections = prepareDocs(bundle);

  // Plugins (diagrams, math…) render once, off-screen but attached to the document.
  const plugins = await pluginsP;
  if (plugins?.runPlugins) {
    const stage = $('ex-stage');
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i];
      stage.append(sec);
      if (sections.length > 3) {
        const t = `Rendering diagrams & math ${i + 1}/${sections.length}…`;
        setStatus(t);
        showEmpty(t);
      }
      try {
        await plugins.runPlugins(sec, { mode: 'export', theme: 'light', docPath: bundle.docs[i].path });
      } catch (e) {
        console.error('[export] plugins failed for', bundle.docs[i].path, e);
      }
      sec.remove();
    }
  }
  state.sections = sections;

  const paged = await pagedP;
  if (paged instanceof Error) {
    showEmpty(paged.message, true);
    setStatus(paged.message, 'error');
    return;
  }
  state.styles = await stylesP;
  render();
}

// ---------------------------------------------------------------------------------------------
// Pagination

/** Cover + ToC ("front matter") HTML for the current settings. */
function frontHtml() {
  const { bundle, settings: s } = state;
  const title = docTitle();
  let head = '';
  if (s.cover) {
    const n = bundle.docs.length;
    const sub = bundle.mode === 'folder' ? `${n} ${n === 1 ? 'document' : 'documents'}` : '';
    const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    head += coverHtml(title, sub, date);
  }
  const entries = s.toc ? tocEntries(bundle, { folders: s.tocFolders, headingDepth: s.tocDepth }) : [];
  if (s.toc && entries.length) head += tocHtml(entries);
  return head;
}

const docTitle = () => state.settings.title.trim() || state.bundle.title;

function buildContent(withDocs = true) {
  const frag = document.createDocumentFragment();
  const wrap = document.createElement('div');
  wrap.innerHTML = frontHtml();
  frag.append(...wrap.childNodes);
  if (withDocs) for (const sec of state.sections) frag.append(sec.cloneNode(true));
  return frag;
}

// Settings that only change the cover / ToC. The documents' own pagination doesn't depend on
// them (the ToC always ends with a page break), so those changes re-paginate just the front
// matter and splice it into the existing preview — fast even for very large folders.
const FRONT_KEYS = ['cover', 'toc', 'tocFolders', 'tocDepth'];
const layoutKey = () =>
  JSON.stringify(Object.entries(state.settings).filter(([k]) => !FRONT_KEYS.includes(k)));

function outlineFor(loc) {
  const entries = tocEntries(state.bundle, { folders: true, headingDepth: Math.max(state.settings.tocDepth, 3) });
  return outlineItems(entries, loc);
}

/** Number of pages before the first document. */
function frontCount(pagesArea, loc) {
  const first = pagesArea.querySelector('.ex-doc');
  const l = first ? loc.locateEl(first) : null;
  return l ? l.page - 1 : 0;
}

async function render() {
  clearTimeout(debounceTimer);
  debounceTimer = 0;
  if (!state.sections || !state.styles) return;
  const seq = ++state.seq;
  if (state.job) state.job.cancel();

  const s = state.settings;
  const key = layoutKey();
  const frontOnly = !!state.current && state.current.key === key;
  const title = docTitle();
  const css = pageCss(s, title, state.bundle.mode === 'file');
  const stylesheets = [...state.styles, { [location.href]: css }];
  const host = $('ex-host');
  const sizeMm = pageSizeMm(s);
  // Pages are laid out at their real size off-screen; give the host that width.
  host.style.width = pagePx(s)[0] + 'px';

  let result = null;
  const content = buildContent(!frontOnly);
  if (!frontOnly) {
    if (!state.current) showEmpty('Paginating…');
    setBusy('Paginating…');
    setStatus('Paginating…');
  }
  if (content.childNodes.length) {
    const job = paginate({
      content,
      stylesheets,
      host,
      onPage: (n) => {
        if (seq !== state.seq || state.job !== job || frontOnly) return;
        const t = `Paginating… ${n} ${n === 1 ? 'page' : 'pages'}`;
        setBusy(t);
        setStatus(t);
        if (!state.current) showEmpty(t);
      },
    });
    state.job = job;
    updateExportButton();
    try {
      result = await job.promise;
    } catch (e) {
      if (state.job === job) state.job = null;
      updateExportButton();
      if (e instanceof Cancelled) return;
      console.error('[export] pagination failed', e);
      setBusy('');
      markStale(false);
      setStatus('Could not lay out the document: ' + (e?.message || e), 'error');
      if (!state.current) showEmpty('Could not lay out the document: ' + (e?.message || e), true);
      return;
    }
    if (seq !== state.seq) {
      job.dispose();
      return;
    }
    state.job = null;
  }

  const scroll = $('ex-scroll');
  const ratio = scroll.scrollHeight > scroll.clientHeight ? scroll.scrollTop / (scroll.scrollHeight - scroll.clientHeight) : 0;
  if (frontOnly) {
    // Splice the new cover/ToC pages in front of the (unchanged) document pages.
    const cur = state.current;
    const oldLoc = makeLocator(cur.pagesArea);
    const oldFront = frontCount(cur.pagesArea, oldLoc);
    const newPages = result ? [...result.pagesArea.querySelectorAll(':scope > .pagedjs_page')] : [];
    const shift = newPages.length - oldFront;
    for (const span of result ? result.pagesArea.querySelectorAll('.ex-toc-pg[data-target]') : []) {
      const l = oldLoc.locate(span.dataset.target);
      span.textContent = l ? String(l.page + shift) : '';
    }
    const firstDocPage = oldLoc.pages[oldFront] || null;
    for (const p of oldLoc.pages.slice(0, oldFront)) p.remove();
    for (const p of newPages) cur.pagesArea.insertBefore(p, firstDocPage);
    if (result) result.previewer.polisher.destroy(); // same rules as the current preview's
    result?.pagesArea.remove();
    const loc = makeLocator(cur.pagesArea);
    loc.pages.forEach((p, i) => {
      p.dataset.pageNumber = String(i + 1);
      p.id = 'page-' + (i + 1);
      p.classList.toggle('pagedjs_first_page', i === 0);
    });
    cur.pagesArea.style.setProperty('--pagedjs-page-count', String(loc.pages.length));
    cur.total = loc.pages.length;
    cur.outline = outlineFor(loc);
  } else {
    // Measure while still at 100% scale, then swap into view.
    const { pagesArea, previewer, total } = result;
    const loc = makeLocator(pagesArea);
    fillTocNumbers(pagesArea, loc);
    // Link annotations: WKWebView keeps links (internal and external) when printing (Chromium /
    // WebView2 does too), so none are added in post-processing (print_to_pdf `links` unused).
    const old = state.current;
    if (old) {
      old.pagesArea.remove();
      try { old.previewer.polisher.destroy(); } catch {}
    }
    $('ex-holder').replaceChildren(pagesArea);
    state.current = { pagesArea, previewer, total: loc.pages.length || total, outline: outlineFor(loc), sizeMm, title, key };
  }
  showEmpty('');
  setBusy('');
  markStale(false);
  applyZoom();
  scroll.scrollTop = ratio * (scroll.scrollHeight - scroll.clientHeight);

  const pages = state.current.total;
  const [w, h] = sizeMm;
  $('ex-count').textContent = `${pages} ${pages === 1 ? 'page' : 'pages'} · ${s.pageSize}${s.orientation === 'landscape' ? ' landscape' : ''}`;
  setStatus(state.exporting ? 'Writing PDF…' : `${pages} ${pages === 1 ? 'page' : 'pages'}, ${Math.round(w)} × ${Math.round(h)} mm`);
  updateExportButton();
}

// ---------------------------------------------------------------------------------------------
// Zoom

function pageWidth() {
  const page = state.current?.pagesArea.querySelector('.pagedjs_page');
  return page ? page.offsetWidth : 794;
}

function fitScale() {
  if (!state.current) return 1;
  const avail = $('ex-scroll').clientWidth - 48;
  return Math.max(0.2, Math.min(1.25, avail / pageWidth()));
}

function applyZoom() {
  const cur = state.current;
  if (!cur) return;
  const scale = state.zoom === 'fit' ? fitScale() : state.zoom;
  const holder = $('ex-holder');
  const sizer = $('ex-sizer');
  const w = pageWidth();
  holder.style.width = w + 'px';
  const h = cur.pagesArea.offsetHeight;
  holder.style.transform = `scale(${scale})`;
  sizer.style.width = Math.ceil(w * scale) + 'px';
  sizer.style.height = Math.ceil(h * scale) + 'px';
  $('zoom-fit').textContent = Math.round(scale * 100) + '%';
  $('zoom-fit').title = state.zoom === 'fit' ? 'Fit to width' : 'Fit to width (click)';
}

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];
function zoomBy(dir) {
  const cur = state.zoom === 'fit' ? fitScale() : state.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > cur + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.001);
  if (next) {
    state.zoom = next;
    applyZoom();
  }
}

$('zoom-in').addEventListener('click', () => zoomBy(1));
$('zoom-out').addEventListener('click', () => zoomBy(-1));
$('zoom-fit').addEventListener('click', () => {
  state.zoom = 'fit';
  applyZoom();
});
let resizeRaf = 0;
window.addEventListener('resize', () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => state.zoom === 'fit' && applyZoom());
});

// Links inside the preview: in-document anchors scroll the preview, others do nothing here.
$('ex-holder').addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (href.startsWith('#') && state.current) {
    const el = state.current.pagesArea.querySelector('#' + CSS.escape(href.slice(1)));
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
});

// ---------------------------------------------------------------------------------------------
// Export

function safeFileName(s) {
  const clean = String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return (clean || 'Export').slice(0, 120);
}

function joinPath(dir, name) {
  if (!dir) return name;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

async function doExport() {
  if (!state.current || state.exporting) return;
  if (state.job || debounceTimer) {
    // A settings change is pending: finish that layout first.
    await render();
    if (!state.current || state.job) return;
  }
  const cur = state.current;
  const bundle = state.bundle;
  const baseDir = MODE === 'folder' ? dirname(bundle.rootPath) : bundle.rootPath;
  let out;
  state.exporting = true; // also guards against a second dialog (menu + key shortcut)
  updateExportButton();
  try {
    out = await api.dialog.save({
      title: 'Export PDF',
      defaultPath: joinPath(baseDir, safeFileName(cur.title) + '.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
  } catch (e) {
    setStatus('Could not open the save dialog: ' + e, 'error');
    out = null;
  }
  if (!out) {
    state.exporting = false;
    updateExportButton();
    return; // cancelled
  }
  if (typeof out === 'object' && out.path) out = out.path;
  if (!/\.pdf$/i.test(out)) out += '.pdf';

  state.exporting = true;
  updateExportButton();
  clearDone();
  setStatus('Writing PDF…');
  setBusy('Writing PDF…');
  document.body.classList.add('is-exporting');
  const [w, h] = cur.sizeMm;
  try {
    const res = await invoke('print_to_pdf', {
      outPath: out,
      pageWidthMm: w,
      pageHeightMm: h,
      title: cur.title,
      outline: cur.outline,
    });
    state.lastExport = res.path || out;
    const name = state.lastExport.split(/[\\/]/).pop();
    $('ex-done-text').innerHTML = `<strong>Saved</strong> ${escapeHtml(name)} · ${res.pages} ${res.pages === 1 ? 'page' : 'pages'}`;
    $('ex-done').hidden = false;
    if (res.pages && res.pages !== cur.total) console.warn(`[export] preview had ${cur.total} pages, PDF has ${res.pages}`);
    setStatus(res.warning ? 'Saved without bookmarks: ' + res.warning : '', res.warning ? 'error' : '');
  } catch (e) {
    setStatus('Export failed: ' + e, 'error');
  } finally {
    state.exporting = false;
    document.body.classList.remove('is-exporting');
    setBusy('');
    updateExportButton();
  }
}

$('btn-export').addEventListener('click', doExport);
$('btn-close').addEventListener('click', () => api.currentWindow().close());
$('btn-open').addEventListener('click', () => state.lastExport && api.opener.openPath(state.lastExport).catch((e) => setStatus(String(e), 'error')));
$('btn-reveal').addEventListener('click', () => state.lastExport && api.opener.revealItemInDir(state.lastExport).catch((e) => setStatus(String(e), 'error')));

document.addEventListener('keydown', (e) => {
  const mod = PLATFORM === 'macos' ? e.metaKey : e.ctrlKey;
  if (mod && (e.key === 'Enter' || e.key.toLowerCase() === 'e' || e.key.toLowerCase() === 's')) {
    e.preventDefault();
    doExport();
  } else if (mod && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    zoomBy(1);
  } else if (mod && e.key === '-') {
    e.preventDefault();
    zoomBy(-1);
  } else if (mod && e.key === '0') {
    e.preventDefault();
    state.zoom = 'fit';
    applyZoom();
  } else if (mod && e.key.toLowerCase() === 'w') {
    e.preventDefault();
    api.currentWindow().close();
  } else if (e.key === 'Escape' && !state.exporting && !/^(INPUT|SELECT)$/.test(document.activeElement?.tagName || '')) {
    api.currentWindow().close();
  }
});

// macOS menu commands arrive as events (the menu accelerators don't reach keydown).
api.listen('menu', (id) => {
  if (id === 'export-pdf' || id === 'export-folder-pdf') doExport();
  else if (id === 'zoom-in') zoomBy(1);
  else if (id === 'zoom-out') zoomBy(-1);
  else if (id === 'zoom-reset') { state.zoom = 'fit'; applyZoom(); }
  else if (id === 'reload') location.reload();
}).catch(() => {});

init().catch((e) => {
  console.error(e);
  showEmpty(String(e?.message || e), true);
  api.currentWindow().show().catch(() => {});
});
