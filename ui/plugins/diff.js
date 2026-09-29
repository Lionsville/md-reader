// Built-in plugin: GitHub-style line highlighting for ```diff / ```patch blocks.
// No library: each line becomes a <span class="diff-line diff-add|diff-del|diff-hunk|diff-file|diff-meta">.

const SELECTOR = 'pre > code.language-diff, pre > code.language-patch';
const META = /^(diff |index |similarity |rename |copy |new file|deleted file|old mode|new mode|Binary files|\\ No newline)/;

function classify(line, next, state) {
  if (line.startsWith('@@')) { state.header = false; return 'diff-hunk'; }
  if (META.test(line)) { if (line.startsWith('diff ')) state.header = true; return 'diff-meta'; }
  if (line.startsWith('--- ') && (state.header || (next ?? '').startsWith('+++ '))) return 'diff-file';
  if (line.startsWith('+++ ') && state.header !== false) { state.header = false; return 'diff-file'; }
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return 'diff-ctx';
}

export default {
  id: 'diff',
  name: 'Diff highlighting',
  description: 'Colors whole lines of ```diff blocks.',
  version: '1.0.0',
  selector: SELECTOR,
  styles: `
code.mdr-diff{display:block;min-width:max-content}
.mdr-diff .diff-line{display:block;padding:0 16px;margin:0 -16px}
.mdr-diff .diff-add{background:rgba(46,160,67,.15);color:#116329}
.mdr-diff .diff-del{background:rgba(248,81,73,.15);color:#a40e26}
.mdr-diff .diff-hunk{background:rgba(84,174,255,.15);color:#0550ae}
.mdr-diff .diff-file{font-weight:600}
.mdr-diff .diff-meta{opacity:.7}
:root[data-theme="dark"] .mdr-diff .diff-add{color:#7ee787}
:root[data-theme="dark"] .mdr-diff .diff-del{color:#ffa198}
:root[data-theme="dark"] .mdr-diff .diff-hunk{color:#a5d6ff}
@media print{.mdr-diff .diff-line{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`,

  render(root, ctx) {
    for (const code of root.querySelectorAll(SELECTOR)) {
      if (!ctx.claim(code)) continue;
      const lines = code.textContent.replace(/\n$/, '').split('\n');
      const state = { header: null };
      const frag = document.createDocumentFragment();
      lines.forEach((line, i) => {
        const span = document.createElement('span');
        span.className = 'diff-line ' + classify(line, lines[i + 1], state);
        span.textContent = line + '\n';
        frag.append(span);
      });
      code.replaceChildren(frag);
      code.classList.add('mdr-diff');
    }
  },
};
