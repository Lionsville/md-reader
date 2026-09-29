// Built-in plugin: ```mermaid code blocks → SVG diagrams.
// mermaid (~5 MB) is only loaded the first time a document contains a diagram.

const BLOCKS = 'pre > code.language-mermaid, pre > code.language-mmd';
const DIAGRAMS = 'div.mermaid-diagram[data-mdr-source]';
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Helvetica, Arial, sans-serif';

let mermaidPromise = null;
let configuredTheme = null;
let queue = Promise.resolve(); // mermaid.render is not re-entrant: render one diagram at a time
let seq = 0;

function loadMermaid(ctx) {
  if (!mermaidPromise) {
    mermaidPromise = ctx.loadScript(ctx.vendorUrl('mermaid/mermaid.min.js')).then(() => {
      if (!window.mermaid) throw new Error('mermaid.min.js loaded but did not define `mermaid`');
      return window.mermaid;
    });
    mermaidPromise.catch(() => { mermaidPromise = null; });
  }
  return mermaidPromise;
}

function configure(mermaid, theme) {
  if (configuredTheme === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: theme === 'dark' ? 'dark' : 'default',
    securityLevel: 'strict',
    suppressErrorRendering: true,
    fontFamily: FONT,
  });
  configuredTheme = theme;
}

/** Removes the temporary nodes mermaid leaves in <body> when a render fails. */
function cleanup(id) {
  for (const sel of [`#${id}`, `#d${id}`, `#i${id}`]) document.querySelector(sel)?.remove();
}

function renderOne(mermaid, job, theme, ctx) {
  const run = async () => {
    if (!ctx.root.contains(job.el)) return; // the document was replaced meanwhile
    configure(mermaid, theme);
    const id = `mdr-mermaid-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, job.source);
      let div = job.el;
      if (!div.matches(DIAGRAMS)) {
        div = document.createElement('div');
        div.className = 'mermaid-diagram';
        div.setAttribute('data-mdr-processed', 'mermaid');
        div.setAttribute('role', 'img');
        div.dataset.mdrSource = job.source;
        job.el.replaceWith(div);
      }
      div.innerHTML = svg;
      div.dataset.mdrTheme = theme;
      const title = div.querySelector('svg > title')?.textContent;
      if (title) div.setAttribute('aria-label', title);
    } catch (err) {
      cleanup(id);
      const msg = (err && (err.message || err.str)) || String(err);
      ctx.showError(job.el, msg, { title: 'Mermaid: could not render this diagram', source: job.source, replace: true });
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

export default {
  id: 'mermaid',
  name: 'Mermaid diagrams',
  description: 'Renders ```mermaid code blocks as diagrams.',
  version: '1.0.0',
  selector: `${BLOCKS}, ${DIAGRAMS}`,
  styles: `
.mermaid-diagram{margin:1em 0;display:flex;justify-content:center;overflow-x:auto;break-inside:avoid;page-break-inside:avoid}
.mermaid-diagram>svg{max-width:100%;height:auto}
@media print{.mermaid-diagram{overflow:visible}}
`,

  async render(root, ctx) {
    // Printed documents always use the light theme.
    const theme = ctx.mode === 'export' ? 'light' : ctx.theme;
    const jobs = [];
    for (const code of root.querySelectorAll(BLOCKS)) {
      if (!ctx.claim(code)) continue;
      jobs.push({ el: ctx.codeBlock(code), source: code.textContent });
    }
    // Already rendered diagrams: re-render only when the theme changed.
    for (const div of root.querySelectorAll(DIAGRAMS)) {
      if (div.dataset.mdrTheme !== theme) jobs.push({ el: div, source: div.dataset.mdrSource });
    }
    if (!jobs.length) return;

    let mermaid;
    try {
      mermaid = await loadMermaid(ctx);
    } catch (err) {
      for (const job of jobs) ctx.showError(job.el, err, { title: 'Mermaid could not be loaded', source: job.source, replace: true });
      return;
    }
    await Promise.all(jobs.map((job) => renderOne(mermaid, job, theme, ctx)));
  },
};
