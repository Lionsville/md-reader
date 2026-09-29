// Inserting a rendered document into the page + the small enhancements around it
// (front matter, table wrappers, code-block tools, image lightbox, spoilers).
import { h, icon, escapeHtml } from './util.js';

/** Put a rendered doc ({html, frontMatter}) into `el`. Synchronous and cheap. */
export function renderInto(el, doc) {
  let fm = '';
  if (doc.frontMatter && doc.frontMatter.length) {
    const rows = doc.frontMatter.map(([k, v]) => `<tr><th scope="row">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');
    fm = `<details class="front-matter"><summary>Metadata</summary><table>${rows}</table></details>`;
  }
  el.innerHTML = fm + doc.html;
  enhance(el);
}

/** Wrap tables (horizontal scroll) and code blocks (label + copy button). */
export function enhance(root) {
  for (const t of root.querySelectorAll('table')) {
    if (t.parentElement.classList.contains('table-wrap') || t.closest('.front-matter')) continue;
    const w = document.createElement('div');
    w.className = 'table-wrap';
    t.replaceWith(w);
    w.append(t);
  }
  // Paragraphs that contain nothing but an image (optionally linked) are centered.
  for (const img of root.querySelectorAll('p > img, p > a > img')) {
    const p = img.closest('p');
    if (p.children.length === 1 && p.textContent.trim() === '') p.classList.add('img-only');
  }
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.parentElement.classList.contains('code-block')) continue;
    const code = pre.firstElementChild?.tagName === 'CODE' ? pre.firstElementChild : null;
    const lang = code && /(?:^|\s)language-([^\s]+)/.exec(code.className)?.[1];
    const w = document.createElement('div');
    w.className = 'code-block';
    if (lang && lang !== 'text' && lang !== 'plain' && lang !== 'plaintext') w.dataset.lang = lang;
    pre.replaceWith(w);
    w.append(pre);
  }
}

/** Event delegation for things inside the document (one set of listeners for the page). */
export function installDocHandlers(root) {
  // Copy button: created lazily the first time a code block is hovered.
  root.addEventListener('mouseover', (e) => {
    const block = e.target.closest?.('.code-block');
    if (!block || block.querySelector(':scope > .code-copy') || !block.querySelector(':scope > pre')) return;
    block.append(h('button', { class: 'code-copy', type: 'button', 'aria-label': 'Copy code', title: 'Copy', html: icon('copy', '') + '<span>Copy</span>' }));
  });
  root.addEventListener('focusin', (e) => {
    const block = e.target.closest?.('.code-block');
    if (block && !block.querySelector(':scope > .code-copy')) block.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });

  root.addEventListener('click', (e) => {
    const copy = e.target.closest('.code-copy');
    if (copy) {
      const pre = copy.parentElement.querySelector(':scope > pre');
      if (pre) copyText(pre.textContent.replace(/\n$/, ''), copy);
      return;
    }
    const spoiler = e.target.closest('.spoiler');
    if (spoiler && !spoiler.classList.contains('revealed')) {
      spoiler.classList.add('revealed');
      e.preventDefault();
      return;
    }
    const img = e.target.closest('img');
    if (img && !img.closest('a') && img.naturalWidth > 0) {
      lightbox(img);
    }
  });
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.classList.add('done');
  btn.innerHTML = icon('check', '') + '<span>Copied</span>';
  setTimeout(() => {
    btn.classList.remove('done');
    btn.innerHTML = icon('copy', '') + '<span>Copy</span>';
  }, 1400);
}

function lightbox(img) {
  const prevFocus = document.activeElement;
  const big = h('img', { src: img.currentSrc || img.src, alt: img.alt || '' });
  const ov = h('div', { class: 'overlay lightbox', role: 'dialog', 'aria-label': img.alt || 'Image', tabindex: '-1' }, big);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); prevFocus?.focus?.({ preventScroll: true }); };
  const onKey = (e) => { if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } };
  ov.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  document.body.append(ov);
  ov.focus();
}

/** Nicely formatted error inside the content area. */
export function renderError(el, { title, detail, path, action }) {
  el.innerHTML = '';
  const box = h('div', { class: 'doc-error', role: 'alert' });
  box.innerHTML = icon(title && /not found|no longer|missing/i.test(title) ? 'missing' : 'warn') +
    `<h2>${escapeHtml(title)}</h2>` +
    (detail ? `<p>${escapeHtml(detail)}</p>` : '') +
    (path ? `<p><code>${escapeHtml(path)}</code></p>` : '');
  if (action) box.append(h('button', { class: 'btn', type: 'button', text: action.label, onclick: action.run }));
  el.append(box);
}
