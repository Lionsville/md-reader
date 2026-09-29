// Plugin host: built-in + user plugins that post-process rendered markdown.
// See docs/PLUGINS.md for the plugin API.
//
// Performance model
// - Built-in plugins are described by a static manifest below. Their modules are only imported
//   when their selector (or match test) finds something in the document, and they in turn only
//   load their heavy library (mermaid, KaTeX…) at that point. A plain document costs a few
//   querySelector calls.
// - User plugins must be imported to learn their selector, so they load in the background:
//   runPlugins() starts the built-ins immediately and runs user plugins as soon as they arrive.

import * as api from './api.js';

const DISABLED_KEY = 'mdr.plugins.disabled';
const RUN_TIMEOUT_MS = 30000;
const APP_ROOT = new URL('../', import.meta.url);       // ui/
const BUILTIN_DIR = new URL('../plugins/', import.meta.url);

/** Built-in plugins. `match` is an optional extra (cheap) test, run only if `selector` matches. */
const BUILTINS = [
  {
    id: 'mermaid',
    name: 'Mermaid diagrams',
    description: 'Renders ```mermaid code blocks as diagrams: flowcharts, sequence, class, state, ER, Gantt, pie, mindmap, timeline and more.',
    selector: 'pre > code.language-mermaid, pre > code.language-mmd, div.mermaid-diagram[data-mdr-source]',
    file: 'mermaid.js',
  },
  {
    id: 'math',
    name: 'Math (KaTeX)',
    description: 'Typesets $inline$, $$display$$ and ```math blocks with KaTeX, including \\ce{} chemistry (mhchem).',
    selector: '[data-math-style]',
    file: 'math.js',
  },
  {
    id: 'callouts',
    name: 'Obsidian callouts',
    description: 'Turns > [!info], > [!todo], > [!bug] … blockquotes into styled callouts, with foldable variants ([!type]- / [!type]+).',
    selector: 'blockquote > p:first-child, .markdown-alert > .markdown-alert-title',
    match: (root) => {
      for (const p of root.querySelectorAll('blockquote > p:first-child')) {
        if (/^\s*\[![\w-]+\]/.test(p.firstChild?.textContent || '')) return true;
      }
      for (const t of root.querySelectorAll('.markdown-alert > .markdown-alert-title')) {
        if (/^\s*[-+](\s|$)/.test(t.textContent)) return true;
      }
      return false;
    },
    file: 'callouts.js',
  },
  {
    id: 'toc',
    name: 'Table of contents',
    description: 'Replaces a paragraph containing only [TOC], [[_TOC_]] or ${toc} with a linked table of contents.',
    selector: 'p',
    match: (root) => {
      for (const p of root.querySelectorAll('p')) {
        if (p.childNodes.length !== 1) continue; // a marker is a lone text node or wikilink
        const t = p.textContent;
        if (t.length < 12 && /^\s*(\[\[?_?toc_?\]\]?|_?toc_?|\$\{toc\})\s*$/i.test(t)) return true;
      }
      return false;
    },
    file: 'toc.js',
  },
  {
    id: 'diff',
    name: 'Diff highlighting',
    description: 'Colors whole lines of ```diff / ```patch blocks: additions, deletions, hunks and file headers.',
    selector: 'pre > code.language-diff, pre > code.language-patch',
    file: 'diff.js',
  },
];

// ---------------------------------------------------------------------------------------------
// State

/**
 * @typedef {{ id:string, name:string, description:string, version?:string, builtin:boolean,
 *   source:string, selector?:string, match?:Function, url:string, plugin:any, error?:string,
 *   loading?:Promise<any>|null }} Entry
 */
/** @type {Map<string, Entry>} */
const entries = new Map();
let disabled = readDisabled();
let userListPromise = null;   // resolves when the user plugin list is known (not necessarily imported)
let infoPromise = null;
let urlPrefix = null;
const running = new WeakMap(); // root -> Promise of the in-flight run (runs on one root are serialized)
const listeners = new Set();

for (const b of BUILTINS) {
  entries.set(b.id, {
    ...b,
    builtin: true,
    url: new URL(b.file, BUILTIN_DIR).href,
    source: 'plugins/' + b.file,
    plugin: null,
    loading: null,
  });
}

function readDisabled() {
  try {
    const v = JSON.parse(localStorage.getItem(DISABLED_KEY) || '[]');
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}

function writeDisabled() {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...disabled]));
  } catch {}
}

const isEnabled = (id) => !disabled.has(id);

function emitChange() {
  for (const cb of listeners) {
    try { cb(); } catch (e) { console.error(e); }
  }
  window.dispatchEvent(new CustomEvent('mdr:plugins-changed'));
}

// Another window toggled a plugin (localStorage is shared between windows).
window.addEventListener('storage', (e) => {
  if (e.key !== DISABLED_KEY) return;
  disabled = readDisabled();
  for (const entry of entries.values()) {
    if (!isEnabled(entry.id)) removeStyles(entry.id);
    else if (!entry.builtin && !entry.plugin) importEntry(entry);
  }
  emitChange();
});

// ---------------------------------------------------------------------------------------------
// Loading

function errorText(err) {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

function validate(mod, url) {
  const p = mod && mod.default;
  if (!p || typeof p !== 'object') throw new Error(`${url} has no default export (expected a plugin object)`);
  if (typeof p.render !== 'function') throw new Error(`${url}: the plugin has no render(root, ctx) function`);
  if (p.selector != null && typeof p.selector !== 'string') throw new Error(`${url}: selector must be a string`);
  if (p.selector) {
    try { document.createDocumentFragment().querySelector(p.selector); }
    catch { throw new Error(`${url}: invalid selector "${p.selector}"`); }
  }
  return p;
}

/** Imports an entry's module once (or again after a reload). Never rejects. */
function importEntry(entry, bust = false) {
  if (entry.plugin && !bust) return Promise.resolve(entry.plugin);
  if (entry.loading && !bust) return entry.loading;
  const url = bust ? entry.url + (entry.url.includes('?') ? '&' : '?') + 'v=' + Date.now() : entry.url;
  const p = import(url)
    .then((mod) => {
      const plugin = validate(mod, entry.builtin ? entry.source : entry.source.split(/[\\/]/).pop());
      entry.plugin = plugin;
      entry.error = undefined;
      if (!entry.builtin) {
        entry.name = String(plugin.name || entry.name);
        entry.description = String(plugin.description || '');
        entry.version = plugin.version ? String(plugin.version) : undefined;
        entry.selector = plugin.selector || undefined;
        entry.match = typeof plugin.match === 'function' ? plugin.match : undefined;
      }
      return plugin;
    })
    .catch((err) => {
      entry.plugin = null;
      entry.error = 'Failed to load: ' + errorText(err);
      console.error(`[plugins] ${entry.id}:`, err);
      return null;
    })
    .finally(() => {
      if (entry.loading === p) entry.loading = null;
    });
  entry.loading = p;
  return p;
}

function loadUserList(bust) {
  return api.pluginList()
    .catch((err) => {
      console.error('[plugins] plugin_list failed:', err);
      return [];
    })
    .then((files) => {
      const seen = new Set();
      for (const f of files || []) {
        const id = 'user:' + f.id;
        seen.add(id);
        let entry = entries.get(id);
        if (!entry || entry.url !== f.url) {
          entry = { id, name: f.id, description: '', builtin: false, source: f.file, url: f.url, plugin: null, loading: null };
          entries.set(id, entry);
        } else if (bust) {
          entry.plugin = null;
          entry.error = undefined;
          removeStyles(id); // re-injected (possibly changed) on the next run
        }
        if (isEnabled(id)) importEntry(entry, bust);
      }
      for (const [id, entry] of entries) {
        if (!entry.builtin && !seen.has(id)) {
          entries.delete(id);
          removeStyles(id);
        }
      }
    });
}

/**
 * Registers the built-ins and discovers user plugins (importing the enabled ones in the
 * background). Idempotent and cheap: it never loads a rendering library. The returned promise
 * resolves once the user plugin list is known; imports may still be in flight — runPlugins()
 * waits for those itself.
 */
export function loadPlugins() {
  if (!infoPromise) {
    infoPromise = api.appInfo().then(
      (info) => { urlPrefix = info.urlPrefix || ''; return info; },
      (err) => { console.error('[plugins] app_info failed:', err); urlPrefix = ''; return null; },
    );
  }
  if (!userListPromise) userListPromise = loadUserList(false);
  return userListPromise;
}

/** Resolves when the user plugin list is known and every enabled plugin finished importing. */
export async function pluginsReady() {
  await loadPlugins();
  await Promise.all([...entries.values()].map((e) => e.loading).filter(Boolean));
}

/** Re-scans the plugins folder and re-imports user plugins (cache-busted). */
export async function reloadPlugins() {
  userListPromise = loadUserList(true);
  await pluginsReady();
  emitChange();
}

// ---------------------------------------------------------------------------------------------
// Public listing / toggling

/** @returns {{id:string, name:string, description:string, version?:string, builtin:boolean, enabled:boolean, loaded:boolean, error?:string, source:string}[]} */
export function listPlugins() {
  return [...entries.values()].map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description || '',
    version: e.version,
    builtin: e.builtin,
    enabled: isEnabled(e.id),
    loaded: !!e.plugin,
    error: e.error,
    source: e.source,
  }));
}

/** Enables/disables a plugin (persisted). Emits `mdr:plugins-changed` so the reader can re-render. */
export function setPluginEnabled(id, enabled) {
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  writeDisabled();
  const entry = entries.get(id);
  if (entry) {
    if (!enabled) removeStyles(id);
    else if (!entry.builtin && !entry.plugin) importEntry(entry);
  }
  emitChange();
}

/** Subscribe to plugin changes (toggle, reload). Returns an unsubscribe function. */
export function onPluginsChanged(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---------------------------------------------------------------------------------------------
// Helpers shared by all plugins (exposed on ctx)

const scriptCache = new Map();
const styleCache = new Map();

/** Loads a classic <script> once; resolves when it has executed. */
export function loadScript(url) {
  const href = new URL(url, document.baseURI).href;
  let p = scriptCache.get(href);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = href;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptCache.delete(href);
        s.remove();
        reject(new Error('Could not load script ' + href));
      };
      document.head.append(s);
    });
    scriptCache.set(href, p);
  }
  return p;
}

/** Adds a stylesheet <link> once; resolves when it has loaded. */
export function loadStyle(url) {
  const href = new URL(url, document.baseURI).href;
  let p = styleCache.get(href);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = () => resolve();
      l.onerror = () => {
        styleCache.delete(href);
        l.remove();
        reject(new Error('Could not load stylesheet ' + href));
      };
      document.head.append(l);
    });
    styleCache.set(href, p);
  }
  return p;
}

/** URL of a file shipped with the app, e.g. appUrl('vendor/katex/katex.min.css'). */
export const appUrl = (path) => new URL(String(path).replace(/^\/+/, ''), APP_ROOT).href;

/** URL of a vendored library: vendorUrl('mermaid/mermaid.min.js') or vendorUrl('vendor/mermaid/…'). */
export const vendorUrl = (path) => appUrl('vendor/' + String(path).replace(/^\/+/, '').replace(/^vendor\//, ''));

function localUrlSync(path) {
  const p = String(path).replace(/\\/g, '/').replace(/^\/+/, '');
  return (urlPrefix || '') + p.split('/').map(encodeURIComponent).join('/').replace(/%3A/g, ':');
}

function dirname(p) {
  if (!p) return '';
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : i === 0 ? p.slice(0, 1) : '';
}

function resolvePath(base, rel) {
  rel = String(rel);
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(rel) || !base) return rel;
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const parts = base.split(/[\\/]/);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === '..') parts.length > 1 && parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join(sep);
}

const yieldToMain = () =>
  globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((r) => setTimeout(r, 0));

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const HOST_CSS = `
.mdr-plugin-error{--e-fg:#82071e;--e-bg:#fff5f5;--e-bd:#ffc1c0;--e-muted:#57606a;
  margin:1em 0;padding:.75em 1em;border:1px solid var(--e-bd);border-left-width:4px;border-radius:6px;
  background:var(--e-bg);color:var(--e-fg);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  text-align:left;break-inside:avoid;overflow:auto}
:root[data-theme="dark"] .mdr-plugin-error{--e-fg:#ffa198;--e-bg:#2d1214;--e-bd:#6e2a2c;--e-muted:#8b949e}
.mdr-plugin-error-title{font-weight:600;margin:0 0 .25em}
.mdr-plugin-error pre.mdr-plugin-error-message{margin:0;white-space:pre-wrap;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:none;padding:0;color:inherit;border:0}
.mdr-plugin-error details{margin-top:.5em;color:var(--e-muted)}
.mdr-plugin-error summary{cursor:pointer;user-select:none}
.mdr-plugin-error details pre{margin:.4em 0 0;max-height:24em;overflow:auto}
`;

function ensureHostStyles() {
  if (document.getElementById('mdr-plugin-host-css')) return;
  const s = document.createElement('style');
  s.id = 'mdr-plugin-host-css';
  s.textContent = HOST_CSS;
  document.head.append(s);
}

/** Builds the inline error box used by the host and by ctx.showError. */
function errorBox(pluginId, title, err, source) {
  ensureHostStyles();
  const box = document.createElement('div');
  box.className = 'mdr-plugin-error';
  box.setAttribute('role', 'alert');
  box.dataset.mdrPluginError = pluginId;
  box.dataset.mdrProcessed = pluginId;
  let html = `<div class="mdr-plugin-error-title">${escapeHtml(title)}</div>`;
  const msg = errorText(err).trim();
  if (msg) html += `<pre class="mdr-plugin-error-message">${escapeHtml(msg)}</pre>`;
  if (source != null && source !== '') {
    html += `<details><summary>Source</summary><pre><code>${escapeHtml(source)}</code></pre></details>`;
  }
  box.innerHTML = html;
  return box;
}

function injectStyles(entry, plugin) {
  if (!plugin.styles || document.querySelector(`style[data-mdr-plugin="${CSS.escape(entry.id)}"]`)) return;
  const s = document.createElement('style');
  s.dataset.mdrPlugin = entry.id;
  s.textContent = String(plugin.styles);
  document.head.append(s);
}

function removeStyles(id) {
  document.querySelector(`style[data-mdr-plugin="${CSS.escape(id)}"]`)?.remove();
}

function hasToken(el, attr, token) {
  const v = el.getAttribute(attr);
  return !!v && v.split(/\s+/).includes(token);
}

/**
 * The outermost element representing the code block of `el` (a <code> or <pre>): the reader's
 * `.code-block` wrapper (label + copy button) when present, else the <pre>. Replace this element
 * when a plugin turns a code block into something else.
 */
export function codeBlock(el) {
  const pre = el.closest('pre') || el;
  const w = pre.parentElement;
  return w && w.classList.contains('code-block') && w.querySelectorAll(':scope > pre').length === 1 ? w : pre;
}

function makeBaseCtx(input) {
  const theme = input.theme || document.documentElement.dataset.theme || 'light';
  const docPath = input.docPath || '';
  const docDir = input.docDir || dirname(docPath);
  return {
    ...input,
    mode: input.mode || 'reader',
    theme: theme === 'dark' ? 'dark' : 'light',
    docPath,
    docDir,
    loadScript,
    loadStyle,
    appUrl,
    vendorUrl,
    localUrl: localUrlSync,
    resolvePath: (rel) => resolvePath(docDir, rel),
    codeBlock,
    yieldToMain,
    escapeHtml,
  };
}

function pluginCtx(base, entry, root) {
  const id = entry.id;
  return Object.assign(Object.create(base), {
    pluginId: id,
    root,
    /** Marks `el` as processed by this plugin; returns false if it already was. */
    claim(el) {
      if (hasToken(el, 'data-mdr-processed', id)) return false;
      const v = el.getAttribute('data-mdr-processed');
      el.setAttribute('data-mdr-processed', v ? v + ' ' + id : id);
      return true;
    },
    isClaimed: (el) => hasToken(el, 'data-mdr-processed', id),
    /**
     * Shows an inline error box for `el`. options: {title, source, replace}
     * replace=true swaps `el` (e.g. the <pre>) for the box, so the source isn't shown twice.
     */
    showError(el, err, options = {}) {
      const box = errorBox(id, options.title || `${entry.name}: could not render this block`, err, options.source);
      if (options.replace && el?.parentNode) el.replaceWith(box);
      else if (el?.parentNode) el.before(box);
      else root.prepend(box);
      return box;
    },
  });
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function matches(root, selector, match) {
  if (selector && !root.querySelector(selector)) return false;
  if (match) {
    try { return !!match(root); } catch (e) { console.error(e); return true; }
  }
  return true;
}

/** Runs one plugin on root. Never rejects. */
async function runOne(entry, root, base) {
  try {
    // Built-ins: decide from the manifest before importing anything.
    if (entry.builtin && !entry.plugin && !matches(root, entry.selector, entry.match)) return;
    const plugin = entry.plugin || (await importEntry(entry));
    if (!plugin || !isEnabled(entry.id)) return;
    const selector = plugin.selector || undefined;
    const match = entry.builtin ? entry.match : (typeof plugin.match === 'function' ? plugin.match.bind(plugin) : undefined);
    if (!matches(root, selector, match)) return;
    injectStyles(entry, plugin);
    for (const old of root.querySelectorAll(`.mdr-plugin-error[data-mdr-plugin-error="${CSS.escape(entry.id)}"][data-mdr-host-error]`)) old.remove();
    await withTimeout(Promise.resolve().then(() => plugin.render(root, pluginCtx(base, entry, root))), RUN_TIMEOUT_MS, `Plugin "${entry.name}"`);
    if (entry.error && !entry.error.startsWith('Failed to load')) entry.error = undefined;
  } catch (err) {
    console.error(`[plugins] ${entry.id} failed:`, err);
    entry.error = errorText(err);
    try {
      const anchor = entry.selector ? root.querySelector(entry.selector) : null;
      const box = errorBox(entry.id, `Plugin "${entry.name}" failed`, err);
      box.dataset.mdrHostError = '';
      const block = anchor?.closest('pre') || anchor;
      if (block?.parentNode) block.before(box);
      else root.prepend(box);
    } catch {}
  }
}

async function runAll(root, input) {
  const base = makeBaseCtx(input);
  if (infoPromise && urlPrefix === null) await infoPromise;
  const tasks = [];
  // Built-ins start right away — they don't wait for the user plugin list.
  for (const entry of entries.values()) {
    if (entry.builtin && isEnabled(entry.id)) tasks.push(runOne(entry, root, base));
  }
  // User plugins: wait for the list, then for each import.
  tasks.push(
    (userListPromise || Promise.resolve()).then(() =>
      Promise.all(
        [...entries.values()]
          .filter((e) => !e.builtin && isEnabled(e.id))
          .map((e) => runOne(e, root, base)),
      ),
    ),
  );
  await Promise.all(tasks);
}

/**
 * Runs every enabled plugin whose selector matches inside `root`.
 * ctx: {mode:'reader'|'export', theme:'light'|'dark', docPath, docDir?}
 * Resolves when all plugins are done (errors are isolated and shown inline). Runs on the same
 * root are serialized; plugins are idempotent, so calling this again (e.g. after a theme change)
 * only re-renders what depends on the theme.
 */
export function runPlugins(root, ctx = {}) {
  if (!root) return Promise.resolve();
  loadPlugins();
  const prev = running.get(root);
  const p = (prev ? prev.catch(() => {}) : Promise.resolve()).then(() => runAll(root, ctx));
  running.set(root, p);
  p.finally(() => {
    if (running.get(root) === p) running.delete(root);
  });
  return p;
}
