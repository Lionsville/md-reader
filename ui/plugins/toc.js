// Built-in plugin: [TOC] / [[_TOC_]] / ${toc} markers → a linked table of contents.
// The TOC lists the headings (with ids) of the enclosing document: the nearest
// <article> / [data-mdr-doc] ancestor of the marker, or the whole root.

const MARKER = /^\s*(\[toc\]|\[\[_?toc_?\]\]|\$\{toc\}|_toc_|toc)\s*$/i;

function isMarker(p) {
  if (p.childNodes.length !== 1) return false; // a lone text node or wikilink
  const t = p.textContent;
  if (t.length > 12 || !MARKER.test(t)) return false;
  // Bare "TOC" / "_TOC_" only count when they came from a [[wikilink]].
  if (/^\s*_?toc_?\s*$/i.test(t)) return !!p.querySelector('a[data-wikilink]');
  return true;
}

function headingText(h) {
  const c = h.cloneNode(true);
  c.querySelectorAll('a.anchor, .footnote-ref, sup').forEach((n) => n.remove());
  return c.textContent.trim();
}

export default {
  id: 'toc',
  name: 'Table of contents',
  description: 'Replaces a [TOC] paragraph with a table of contents.',
  version: '1.0.0',
  selector: 'p',
  match: (root) => [...root.querySelectorAll('p')].some(isMarker),
  styles: `
nav.mdr-toc{margin:1em 0;padding:.75em 1.25em;border:1px solid rgba(127,127,127,.25);border-radius:8px;break-inside:avoid}
nav.mdr-toc .mdr-toc-title{margin:0 0 .4em;font-weight:600}
nav.mdr-toc ul{margin:0;padding-left:1.25em;list-style:none}
nav.mdr-toc>ul{padding-left:0}
nav.mdr-toc li{margin:.15em 0}
nav.mdr-toc a{text-decoration:none}
nav.mdr-toc a:hover{text-decoration:underline}
`,

  render(root, ctx) {
    for (const p of root.querySelectorAll('p')) {
      if (!isMarker(p) || !ctx.claim(p)) continue;
      const scope = p.closest('article, [data-mdr-doc]') || root;
      let heads = [...scope.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')]
        .filter((h) => !h.closest('nav.mdr-toc, .footnotes'));
      // A single leading h1 is the document title — leave it out.
      if (heads.filter((h) => h.tagName === 'H1').length === 1 && heads[0]?.tagName === 'H1') heads = heads.slice(1);

      const nav = document.createElement('nav');
      nav.className = 'mdr-toc';
      nav.setAttribute('aria-label', 'Table of contents');
      ctx.claim(nav);
      const title = document.createElement('p');
      title.className = 'mdr-toc-title';
      title.textContent = 'Contents';
      ctx.claim(title);
      nav.append(title);

      if (heads.length) {
        const base = Math.min(...heads.map((h) => +h.tagName[1]));
        const rootList = document.createElement('ul');
        const stack = [{ level: base, list: rootList }];
        for (const h of heads) {
          const level = +h.tagName[1];
          while (stack.length > 1 && level < stack[stack.length - 1].level) stack.pop();
          let top = stack[stack.length - 1];
          while (level > top.level) {
            // Nest under the last item (create an empty one if the outline skips a level).
            let li = top.list.lastElementChild;
            if (!li) { li = document.createElement('li'); top.list.append(li); }
            const ul = document.createElement('ul');
            li.append(ul);
            top = { level: top.level + 1, list: ul };
            stack.push(top);
          }
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = '#' + h.id;
          a.textContent = headingText(h);
          li.append(a);
          top.list.append(li);
        }
        nav.append(rootList);
      }
      p.replaceWith(nav);
    }
  },
};
