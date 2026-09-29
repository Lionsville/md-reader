// Thin, typed-by-convention wrapper around the Rust commands. All UI code talks to Rust via this.
const T = window.__TAURI__;
const invoke = T.core.invoke;

/** @returns {Promise<{path:string, dir:string, title:string, html:string, headings:{level:number,text:string,id:string}[], frontMatter:[string,string][]|null}>} */
export const renderFile = (path, idPrefix = '') => invoke('render_file', { path, idPrefix });
/** @returns {Promise<{name:string, path:string, isDir:boolean, children:any[]}>} */
export const scanFolder = (path) => invoke('scan_folder', { path });
/** @returns {Promise<{exists:boolean, isDir:boolean, isFile:boolean, isMarkdown:boolean}>} */
export const pathInfo = (path) => invoke('path_info', { path });
export const openWindow = (path = null) => invoke('open_window', { path });
export const openExport = (path, mode /* 'file' | 'folder' */) => invoke('open_export', { path, mode });
/** Changes arrive as the `fs-changed` event (payload: string[] of paths) on the current window. */
export const watchPath = (path) => invoke('watch_path', { path });
/** @returns {Promise<{platform:string, version:string, urlPrefix:string, pluginsDir:string}>} */
export const appInfo = () => invoke('app_info');
/** @returns {Promise<{id:string, file:string, url:string}[]>} user plugins */
export const pluginList = () => invoke('plugin_list');
/** Renders every doc for export; emits `export-progress` {done,total} to this window.
 * @returns {Promise<{title:string, rootPath:string, mode:string, docs:{index:number, path:string, relPath:string, title:string, depth:number, dirTrail:string[], prefix:string, html:string, headings:any[], error?:string}[]}>} */
export const buildExport = (path, mode) => invoke('build_export', { path, mode });
/** Prints this window's webview to a PDF, then adds bookmarks + title. Resolves once the file is written.
 * @returns {Promise<{path:string, pages:number, warning?:string}>} */
export const printToPdf = (opts /* {outPath, pageWidthMm, pageHeightMm, title?, outline?:[{title,level,page,y}]} */) => invoke('print_to_pdf', opts);

export const listen = (event, cb) => T.event.listen(event, (e) => cb(e.payload), { target: { kind: 'WebviewWindow', label: currentWindow().label } });
export const currentWindow = () => T.window.getCurrentWindow();
export const currentWebview = () => T.webview.getCurrentWebview();
export const dialog = T.dialog;   // open({directory, filters}), save({defaultPath, filters}), message()
export const opener = T.opener;   // openUrl(url), revealItemInDir(path), openPath(path)

/** Converts an absolute local path into a URL the webview can load (images, plugins). */
let _prefix = null;
export async function localUrl(path) {
  if (!_prefix) _prefix = (await appInfo()).urlPrefix;
  const p = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return _prefix + p.split('/').map(encodeURIComponent).join('/').replace(/%3A/g, ':');
}

/** Query-string parameters of this window (`path`, `mode`). */
export const params = new URLSearchParams(location.search);
