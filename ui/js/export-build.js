// PDF export: turns the bundle from `build_export` into one combined, paginatable document.
// Pure DOM work — no Tauri calls — so it is easy to reason about and test.

export const PAGE_SIZES = {
  A4: [210, 297],
  Letter: [215.9, 279.4],
  A5: [148, 210],
  Legal: [215.9, 355.6],
};

/** Page margins in mm: [top, right, bottom, left]. Top/bottom leave room for header/footer. */
export const MARGINS = {
  narrow: [15, 12, 15, 12],
  normal: [22, 20, 22, 20],
  wide: [28, 30, 28, 30],
};

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A CSS string literal. */
export const cssString = (s) =>
  '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, ' ') + '"';

// ---------------------------------------------------------------------------------------------
// Paths

const IS_WINDOWS_PATH = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');

export function dirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : i === 0 ? p.slice(0, 1) : '';
}

/** Resolve `rel` against directory `base`, normalizing `.` / `..`. Always returns `/` separators. */
export function resolvePath(base, rel) {
  const r = rel.replace(/\\/g, '/');
  const absolute = r.startsWith('/') || /^[a-zA-Z]:\//.test(r);
  const start = absolute ? '' : base.replace(/\\/g, '/');
  const parts = [];
  const all = (start ? start + '/' : '') + r;
  const lead = all.startsWith('//') ? '//' : all.startsWith('/') ? '/' : '';
  for (const seg of all.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 1 || (parts.length === 1 && !/^[a-zA-Z]:$/.test(parts[0]))) parts.pop();
    } else parts.push(seg);
  }
  return lead + parts.join('/');
}

/** Key for path lookups: forward slashes, case-insensitive (macOS/Windows default filesystems). */
const pathKey = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function fileUrl(p) {
  const fwd = p.replace(/\\/g, '/');
  const withRoot = IS_WINDOWS_PATH(p) ? '/' + fwd : fwd;
  return 'file://' + withRoot.split('/').map((s, i) => (i === 1 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ---------------------------------------------------------------------------------------------
// Documents

/**
 * Builds one `<section class="ex-doc markdown-body">` per document: ids made unique with the
 * document prefix, links between documents of the bundle rewritten to in-document anchors,
 * other relative links made absolute (file://).
 * @returns {HTMLElement[]}
 */
export function prepareDocs(bundle) {
  const byPath = new Map();
  for (const d of bundle.docs) byPath.set(pathKey(d.path), d);
  const lookup = (p) => byPath.get(pathKey(p)) || (!/\.[a-z0-9]+$/i.test(p) ? byPath.get(pathKey(p + '.md')) : undefined);

  return bundle.docs.map((doc) => {
    const section = document.createElement('section');
    section.className = 'ex-doc markdown-body';
    section.id = 'doc-' + doc.index;
    section.setAttribute('data-mdr-doc', ''); // scopes in-document plugins (e.g. [TOC]) per file
    section.dataset.title = doc.title;
    section.dataset.index = String(doc.index);
    if (bundle.mode === 'folder') {
      const trail = document.createElement('div');
      trail.className = 'ex-doc-path';
      trail.textContent = doc.relPath.split('/').join(' › ');
      section.append(trail);
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = doc.html;
    const frag = tpl.content;

    for (const a of frag.querySelectorAll('a.anchor')) a.remove();
    for (const img of frag.querySelectorAll('img[loading]')) img.removeAttribute('loading');
    for (const el of frag.querySelectorAll('details')) el.setAttribute('open', '');

    // Unique ids: headings already carry the prefix (markdown.rs), footnotes etc. don't.
    const idMap = new Map();
    for (const el of frag.querySelectorAll('[id]')) {
      if (!el.id.startsWith(doc.prefix)) {
        const next = doc.prefix + el.id;
        idMap.set(el.id, next);
        el.id = next;
      }
    }
    for (const a of frag.querySelectorAll('a[name]:not([id])')) a.id = doc.prefix + a.getAttribute('name');

    const dir = dirname(doc.path);
    for (const a of frag.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href').trim();
      a.setAttribute('href', rewriteHref(href, doc, dir, idMap, lookup));
    }
    section.append(frag);
    return section;
  });
}

function rewriteHref(href, doc, dir, idMap, lookup) {
  if (!href) return href;
  if (href.startsWith('#')) {
    const frag = safeDecode(href.slice(1));
    if (!frag) return '#doc-' + doc.index;
    if (idMap.has(frag)) return '#' + idMap.get(frag);
    return '#' + (frag.startsWith(doc.prefix) ? frag : doc.prefix + frag);
  }
  // Absolute URLs (http:, mailto:, mdr:, file:, …) stay as they are — but not "C:\…".
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:[\\/]/.test(href)) return href;
  const hashAt = href.indexOf('#');
  const frag = hashAt >= 0 ? safeDecode(href.slice(hashAt + 1)) : '';
  let pathPart = hashAt >= 0 ? href.slice(0, hashAt) : href;
  pathPart = safeDecode(pathPart.split('?')[0]);
  if (!pathPart) return href;
  const abs = resolvePath(dir, pathPart);
  const target = lookup(abs);
  if (target) {
    if (!frag) return '#doc-' + target.index;
    return '#' + (frag.startsWith(target.prefix) ? frag : target.prefix + frag);
  }
  return fileUrl(abs) + (frag ? '#' + encodeURIComponent(frag) : '');
}

// ---------------------------------------------------------------------------------------------
// Table of contents / outline

/**
 * Flat, level-annotated list of ToC entries.
 * @param {object} bundle
 * @param {{folders:boolean, headingDepth:number}} opts headingDepth 0 = files only, 1..6 = H1…Hn
 * @returns {{kind:'folder'|'file'|'heading', level:number, title:string, target:string}[]}
 */
export function tocEntries(bundle, { folders, headingDepth }) {
  const out = [];
  const folderMode = bundle.mode === 'folder';
  let prevTrail = [];
  for (const doc of bundle.docs) {
    let base = 0;
    if (folderMode) {
      const trail = doc.dirTrail || [];
      if (folders) {
        let same = 0;
        while (same < trail.length && same < prevTrail.length && trail[same] === prevTrail[same]) same++;
        for (let i = same; i < trail.length; i++) {
          out.push({ kind: 'folder', level: i, title: trail[i], target: '#doc-' + doc.index });
        }
        base = trail.length;
      }
      prevTrail = trail;
      out.push({ kind: 'file', level: base, title: doc.title, target: '#doc-' + doc.index });
      base += 1;
    }
    if (headingDepth <= 0) continue;
    // The first H1 is the document title (already listed as the file entry / on the cover).
    const titleH1 = doc.headings.find((h) => h.level === 1);
    const skip = titleH1 && titleH1.text === doc.title ? titleH1 : null;
    const hs = doc.headings.filter((h) => h !== skip && h.level <= headingDepth && h.text.trim());
    if (!hs.length) continue;
    // Nest by relative heading level, without gaps (an H3 directly below the title is level +0).
    const stack = [];
    for (const h of hs) {
      while (stack.length && stack[stack.length - 1] >= h.level) stack.pop();
      out.push({ kind: 'heading', level: base + stack.length, title: h.text, target: '#' + h.id });
      stack.push(h.level);
    }
  }
  return out;
}

export function tocHtml(entries, heading = 'Contents') {
  let html = `<nav class="ex-toc" id="ex-toc"><h1 class="ex-toc-title">${escapeHtml(heading)}</h1>`;
  for (const e of entries) {
    const lvl = Math.min(e.level, 8);
    const cls = `ex-toc-entry ex-toc-${e.kind} ex-toc-l${lvl}`;
    if (e.kind === 'folder') {
      html += `<div class="${cls}" style="--lvl:${lvl}"><a href="${escapeHtml(e.target)}">${escapeHtml(e.title)}</a></div>`;
    } else {
      html +=
        `<div class="${cls}" style="--lvl:${lvl}"><a href="${escapeHtml(e.target)}">` +
        `<span class="ex-toc-text">${escapeHtml(e.title)}</span><span class="ex-toc-leader" aria-hidden="true"></span>` +
        `<span class="ex-toc-pg" data-target="${escapeHtml(e.target)}"></span></a></div>`;
    }
  }
  return html + '</nav>';
}

export function coverHtml(title, subtitle, date) {
  return (
    `<section class="ex-cover" id="ex-cover"><div class="ex-cover-inner">` +
    `<h1 class="ex-cover-title">${escapeHtml(title)}</h1>` +
    (subtitle ? `<p class="ex-cover-sub">${escapeHtml(subtitle)}</p>` : '') +
    `<p class="ex-cover-date">${escapeHtml(date)}</p>` +
    `</div></section>`
  );
}

// ---------------------------------------------------------------------------------------------
// Page CSS

/** Page size in mm for the settings: [width, height]. */
export function pageSizeMm(s) {
  const [w, h] = PAGE_SIZES[s.pageSize] || PAGE_SIZES.A4;
  return s.orientation === 'landscape' ? [h, w] : [w, h];
}

/**
 * CSS page size in whole px. WebKit prints a document that is W px wide onto the paper by
 * scaling W → paper width, and cuts pages every floor(W × paperHeight / paperWidth) px. Pages
 * whose px height is exactly that number therefore land 1:1 on the sheets without drift, which
 * fractional mm-based sizes don't (A4 = 793.7 × 1122.5 px).
 */
export function pagePx(s) {
  const [w, h] = pageSizeMm(s);
  const ratio = h / w;
  let wpx = Math.round((w / 25.4) * 96);
  // Stay clear of float rounding differences at an integer boundary.
  for (let i = 0; i < 4; i++) {
    const frac = wpx * ratio - Math.floor(wpx * ratio);
    if (frac > 0.02 && frac < 0.98) break;
    wpx += 1;
  }
  return [wpx, Math.floor(wpx * ratio)];
}

/** The settings-dependent part of the paged-media CSS. */
export function pageCss(s, docTitle, singleFile) {
  const [w, h] = pagePx(s);
  const [mt, mr, mb, ml] = MARGINS[s.margins] || MARGINS.normal;
  const none = 'content: none;';
  const headerLeft = s.header ? `content: ${cssString(docTitle)};` : none;
  const headerRight = s.header && !singleFile ? 'content: string(section);' : none;
  const footer = s.pageNumbers ? 'content: counter(page) " / " counter(pages);' : none;
  return `
@page {
  size: ${w}px ${h}px;
  margin: ${mt}mm ${mr}mm ${mb}mm ${ml}mm;
  @top-left { ${headerLeft} }
  @top-right { ${headerRight} }
  @bottom-center { ${footer} }
}
@page cover {
  margin: 0;
  @top-left { content: none; }
  @top-right { content: none; }
  @bottom-center { content: none; }
}
@page toc {
  @top-right { ${s.header ? 'content: "Contents";' : none} }
}
:root { --ex-font-size: ${Number(s.fontSize) || 10.5}pt; }
${s.newPage ? '.ex-doc { break-before: page; }' : '.ex-doc + .ex-doc { margin-top: 2.2em; }'}
${s.header && !singleFile ? '.ex-doc { string-set: section attr(data-title); }' : ''}
`;
}
