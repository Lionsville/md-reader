// Built-in plugin: Obsidian-style callouts.
//
//   > [!todo] Optional title          → callout (reuses the GitHub alert styles of markdown.css)
//   > [!faq]- Collapsed by default     → <details> (closed)
//   > [!tip]+ Expanded, foldable       → <details open>
//
// The five GitHub types (note, tip, important, warning, caution) are already turned into
// .markdown-alert by markdown.rs; for those this plugin only adds the foldable (-/+) variant.

const TYPES = {
  note: 'note', info: 'note', todo: 'note', abstract: 'note', summary: 'note', tldr: 'note', quote: 'note', cite: 'note',
  tip: 'tip', hint: 'tip', success: 'tip', check: 'tip', done: 'tip',
  important: 'important', example: 'important',
  warning: 'warning', attention: 'warning', question: 'warning', help: 'warning', faq: 'warning',
  caution: 'caution', failure: 'caution', fail: 'caution', missing: 'caution', danger: 'caution', error: 'caution', bug: 'caution',
};
const MARKER = /^\s*\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*/;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** Moves the nodes of `p` up to the first line break into a new element; returns it. */
function takeFirstLine(p, into) {
  while (p.firstChild) {
    const n = p.firstChild;
    if (n.nodeName === 'BR') { n.remove(); break; }
    if (n.nodeType === Node.TEXT_NODE && n.data.includes('\n')) {
      const i = n.data.indexOf('\n');
      into.append(n.data.slice(0, i));
      n.data = n.data.slice(i + 1);
      break;
    }
    into.append(n);
  }
  return into;
}

function build(type, fold, titleEl, bodyNodes) {
  const gh = TYPES[type] || 'note';
  const box = document.createElement(fold ? 'details' : 'div');
  box.className = `markdown-alert markdown-alert-${gh} markdown-callout`;
  box.dataset.callout = type;
  if (fold === '+') box.open = true;
  titleEl.classList.add('markdown-alert-title');
  // The title is a flex row (icon + text): keep mixed inline content in one flex item.
  const text = document.createElement('span');
  text.append(...titleEl.childNodes);
  titleEl.append(text);
  box.append(titleEl, ...bodyNodes);
  return box;
}

export default {
  id: 'callouts',
  name: 'Obsidian callouts',
  description: 'Styled and foldable callouts: > [!info], > [!todo]-, …',
  version: '1.0.0',
  selector: 'blockquote > p:first-child, .markdown-alert > .markdown-alert-title',
  styles: `
details.markdown-callout,.markdown-body details.markdown-callout{padding:.6em 1.1em;border:0;border-left:.25em solid var(--alert,#0969da);border-radius:0 6px 6px 0}
details.markdown-callout>summary.markdown-alert-title,.markdown-body details.markdown-callout[open]>summary.markdown-alert-title,.markdown-body details.markdown-callout>summary.markdown-alert-title{cursor:pointer;list-style:none;user-select:none;margin:0 0 .35em;padding:0;border:0;border-radius:0;background:none}
details.markdown-callout:not([open])>summary.markdown-alert-title,.markdown-body details.markdown-callout:not([open])>summary.markdown-alert-title{margin-bottom:0 !important}
details.markdown-callout>summary.markdown-alert-title::-webkit-details-marker{display:none}
details.markdown-callout>summary.markdown-alert-title::after{content:"";width:.45em;height:.45em;margin-left:.15em;border:solid currentColor;border-width:0 .12em .12em 0;transform:rotate(-45deg);transition:transform .15s;opacity:.8}
details.markdown-callout[open]>summary.markdown-alert-title::after{transform:rotate(45deg)}
@media print{details.markdown-callout>summary.markdown-alert-title::after{display:none}}
`,

  render(root, ctx) {
    // 1. Obsidian callouts: plain blockquotes whose first paragraph starts with [!type]
    for (const p of root.querySelectorAll('blockquote > p:first-child')) {
      const bq = p.parentElement;
      const first = p.firstChild;
      if (!first || first.nodeType !== Node.TEXT_NODE || !ctx.claim(bq)) continue;
      const m = MARKER.exec(first.data);
      if (!m) continue;
      const type = m[1].toLowerCase();
      const fold = m[2];
      first.data = first.data.slice(m[0].length);
      const title = takeFirstLine(p, document.createElement(fold ? 'summary' : 'p'));
      if (!title.textContent.trim()) title.textContent = cap(type);
      if (!p.textContent.trim() && !p.querySelector('img,video,audio,svg')) p.remove();
      const box = build(type, fold, title, [...bq.childNodes]);
      ctx.claim(box);
      bq.replaceWith(box);
    }

    // 2. GitHub alerts written as > [!warning]- Title (markdown.rs keeps the "-" in the title)
    for (const t of root.querySelectorAll('div.markdown-alert > p.markdown-alert-title:first-child')) {
      const alert = t.parentElement;
      if (!ctx.claim(alert)) continue;
      const m = /^\s*([-+])(?:\s+|$)/.exec(t.textContent);
      if (!m) continue;
      const type = (/markdown-alert-(\w+)/.exec(alert.className) || [])[1] || 'note';
      const summary = document.createElement('summary');
      summary.append(...t.childNodes);
      const lead = summary.firstChild;
      if (lead?.nodeType === Node.TEXT_NODE) lead.data = lead.data.replace(/^\s*[-+]\s*/, '');
      if (!summary.textContent.trim()) summary.textContent = cap(type);
      t.remove();
      const box = build(type, m[1], summary, [...alert.childNodes]);
      ctx.claim(box);
      alert.replaceWith(box);
    }
  },
};
