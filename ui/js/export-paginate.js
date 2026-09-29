// PDF export: pagination with Paged.js (loaded lazily) and measurement of the result
// (page numbers for the ToC and the bookmark positions for the PDF post-processing).

let pagedPromise = null;

/** Loads vendor/pagedjs/paged.min.js (the non-polyfill UMD build → window.PagedModule). */
export function loadPaged() {
  if (window.PagedModule) return Promise.resolve(window.PagedModule);
  if (!pagedPromise) {
    pagedPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../vendor/pagedjs/paged.min.js', import.meta.url).href;
      s.async = true;
      s.onload = () => (window.PagedModule ? resolve(window.PagedModule) : reject(new Error('Paged.js did not load')));
      s.onerror = () => {
        pagedPromise = null;
        s.remove();
        reject(new Error('Could not load Paged.js (vendor/pagedjs/paged.min.js). Run `npm run vendor`.'));
      };
      document.head.append(s);
    });
  }
  return pagedPromise;
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

/**
 * Paginates `content` (a DocumentFragment) into `host`.
 * @param {{content: DocumentFragment, stylesheets: object[], host: HTMLElement, onPage?: (n:number)=>void}} o
 * @returns {{promise: Promise<{previewer:any, pagesArea:HTMLElement, total:number}>, cancel: ()=>void, dispose: ()=>void}}
 */
export function paginate({ content, stylesheets, host, onPage }) {
  let previewer = null;
  let cancelled = false;
  const dispose = () => {
    try { previewer?.polisher?.destroy(); } catch {}
    try { previewer?.chunker?.pagesArea?.remove(); } catch {}
  };
  const cancel = () => {
    cancelled = true;
    if (previewer?.chunker) {
      // Paged.js has no public cancel: make the next render step reject.
      previewer.chunker.renderAsync = () => Promise.reject(new Cancelled());
    }
  };
  const promise = (async () => {
    const Paged = await loadPaged();
    if (cancelled) throw new Cancelled();
    previewer = new Paged.Previewer();
    let n = 0;
    previewer.on('page', () => onPage?.(++n));
    try {
      const flow = await previewer.preview(content, stylesheets, host);
      if (cancelled) throw new Cancelled();
      return { previewer, pagesArea: previewer.chunker.pagesArea, total: flow.total };
    } catch (e) {
      dispose();
      throw cancelled ? new Cancelled() : e;
    }
  })();
  return { promise, cancel, dispose };
}

/**
 * Locates elements on the rendered pages.
 * @param {HTMLElement} pagesArea
 */
export function makeLocator(pagesArea) {
  const pages = [...pagesArea.querySelectorAll('.pagedjs_page')];
  const index = new Map(pages.map((p, i) => [p, i]));
  const rectCache = new Map();
  const pageRect = (i) => {
    let r = rectCache.get(i);
    if (!r) rectCache.set(i, (r = pages[i].getBoundingClientRect()));
    return r;
  };
  /** @returns {{page:number, y:number}|null} page is 1-based, y a fraction of the page height */
  const locateEl = (el) => {
    const p = el?.closest('.pagedjs_page');
    if (!p || !index.has(p)) return null;
    const i = index.get(p);
    const pr = pageRect(i);
    const r = el.getBoundingClientRect();
    return { page: i + 1, y: Math.max(0, Math.min(1, (r.top - pr.top) / pr.height)) };
  };
  const byId = (id) => (id ? pagesArea.querySelector('#' + CSS.escape(id)) : null);
  const locate = (target) => locateEl(byId(String(target).replace(/^#/, '')));
  return { pages, pageRect, index, locateEl, locate, byId };
}

/** Writes the page numbers into the ToC (`.ex-toc-pg[data-target]`). */
export function fillTocNumbers(pagesArea, loc) {
  for (const span of pagesArea.querySelectorAll('.ex-toc-pg[data-target]')) {
    const l = loc.locate(span.dataset.target);
    span.textContent = l ? String(l.page) : '';
  }
}

/** Bookmarks for the PDF: [{title, level, page, y}]. */
export function outlineItems(entries, loc) {
  const out = [];
  for (const e of entries) {
    const l = loc.locate(e.target);
    if (l) out.push({ title: e.title, level: e.level, page: l.page, y: e.kind === 'heading' ? Math.max(0, l.y - 0.01) : 0 });
  }
  return out;
}
