// Example user plugin: a "1,234 words · 6 min read" line at the top of every document.
//
// Install: copy this file into the MD Reader plugins folder (Plugins… → Open plugins folder),
// then click "Reload plugins".
//
// Shows: a plugin without a selector (runs on every document), ctx.mode (skipped in PDF
// export), and idempotency by updating its own element instead of adding a second one.

const WORDS_PER_MINUTE = 230;

function countWords(root) {
  // Count prose only: skip code, math, diagrams and our own badge.
  const skip = 'pre, code, .katex, .math, .mermaid-diagram, .mdr-reading-time, .front-matter, script, style';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let words = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const m = n.data.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    if (m) words += m.length;
  }
  return words;
}

export default {
  id: 'reading-time',
  name: 'Reading time',
  description: 'Shows the word count and estimated reading time at the top of each document.',
  version: '1.0.0',
  // No selector: render() is called for every document.

  styles: `
.mdr-reading-time{margin:0 0 1em;font-size:.85em;color:var(--md-muted,#59636e)}
`,

  render(root, ctx) {
    if (ctx.mode === 'export') return; // don't print it

    const words = countWords(root);
    const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
    const text = `${words.toLocaleString()} words · ${minutes} min read`;

    let badge = root.querySelector(':scope > .mdr-reading-time');
    if (!badge) {
      badge = document.createElement('p');
      badge.className = 'mdr-reading-time';
      ctx.claim(badge);
      // Directly below the title when the document starts with one.
      const h1 = root.querySelector(':scope > h1');
      const atTop = h1 && (h1 === root.firstElementChild || h1.previousElementSibling?.matches('.front-matter'));
      if (atTop) h1.after(badge);
      else root.prepend(badge);
    }
    badge.textContent = text;
  },
};
