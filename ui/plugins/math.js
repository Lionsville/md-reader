// Built-in plugin: TeX math with KaTeX.
// Handles what markdown.rs emits:
//   $x$            → <span data-math-style="inline">
//   $$x$$          → <span data-math-style="display">
//   $`x`$          → <code data-math-style="inline">
//   ```math        → <pre><code class="language-math" data-math-style="display">
// KaTeX (+ its CSS/fonts, + mhchem when \ce / \pu is used) is loaded on first use only.

const SELECTOR = '[data-math-style]';
let katexPromise = null;
let mhchemPromise = null;

function loadKatex(ctx) {
  if (!katexPromise) {
    katexPromise = Promise.all([
      ctx.loadScript(ctx.vendorUrl('katex/katex.min.js')),
      ctx.loadStyle(ctx.vendorUrl('katex/katex.min.css')),
    ]).then(() => {
      if (!window.katex) throw new Error('katex.min.js loaded but did not define `katex`');
      return window.katex;
    });
    katexPromise.catch(() => { katexPromise = null; });
  }
  return katexPromise;
}

function loadMhchem(ctx) {
  if (!mhchemPromise) {
    mhchemPromise = ctx.loadScript(ctx.vendorUrl('katex/mhchem.min.js'));
    mhchemPromise.catch(() => { mhchemPromise = null; });
  }
  return mhchemPromise;
}

export default {
  id: 'math',
  name: 'Math (KaTeX)',
  description: 'Typesets TeX math with KaTeX.',
  version: '1.0.0',
  selector: SELECTOR,
  styles: `
.math-display{display:block;margin:1em 0;overflow-x:auto;overflow-y:hidden;text-align:center}
.math-display>.katex-display{margin:0}
.katex-display{overflow-x:auto;overflow-y:hidden;padding:.1em 0}
.katex-error{color:#cf222e}
:root[data-theme="dark"] .katex-error{color:#ff7b72}
@media print{.math-display,.katex-display{overflow:visible;break-inside:avoid}}
`,

  async render(root, ctx) {
    const els = [...root.querySelectorAll(SELECTOR)].filter((el) => !ctx.isClaimed(el));
    if (!els.length) return;

    const katex = await loadKatex(ctx);
    if (els.some((el) => /\\(ce|pu)\s*\{/.test(el.textContent))) {
      try { await loadMhchem(ctx); } catch (e) { console.warn('[math] mhchem unavailable:', e); }
    }

    // One macro table per document, so \gdef / \newcommand carry over between formulas.
    const macros = {};
    let budget = performance.now();
    for (const el of els) {
      if (!ctx.claim(el)) continue; // a concurrent run got here first
      const display = el.dataset.mathStyle === 'display';
      const tex = el.textContent;
      let target = el;
      if (el.tagName === 'CODE') {
        // Replace the code element (and its <pre>) so code styling doesn't leak into the math.
        const host = el.parentElement?.tagName === 'PRE' ? ctx.codeBlock(el) : el;
        target = document.createElement(display && host !== el ? 'div' : 'span');
        target.dataset.mathStyle = el.dataset.mathStyle;
        ctx.claim(target);
        host.replaceWith(target);
      }
      target.classList.add('math', display ? 'math-display' : 'math-inline');
      target.dataset.mdrSource = tex;
      try {
        katex.render(tex.trim(), target, {
          displayMode: display,
          throwOnError: false,
          strict: 'ignore',
          trust: false,
          output: 'htmlAndMathml',
          macros,
        });
      } catch (err) {
        target.textContent = tex;
        target.classList.add('katex-error');
        target.title = String(err && err.message || err);
      }
      // Keep the UI responsive on documents with thousands of formulas.
      if (performance.now() - budget > 12) {
        await ctx.yieldToMain();
        budget = performance.now();
      }
    }
    // Printing measures the layout right after this resolves: wait for the KaTeX fonts.
    if (ctx.mode === 'export' && document.fonts?.ready) await document.fonts.ready;
  },
};
