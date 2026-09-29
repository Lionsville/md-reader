// Copies the lazily-loaded third-party libraries into ui/vendor.
// They are only fetched by the webview when a document actually needs them.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'ui', 'vendor');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const copy = (from, to) => cpSync(join(nm, from), join(out, to), { recursive: true });

copy('mermaid/dist/mermaid.min.js', 'mermaid/mermaid.min.js');
copy('katex/dist/katex.min.js', 'katex/katex.min.js');
copy('katex/dist/katex.min.css', 'katex/katex.min.css');
copy('katex/dist/fonts', 'katex/fonts');
copy('katex/dist/contrib/mhchem.min.js', 'katex/mhchem.min.js');
copy('pagedjs/dist/paged.min.js', 'pagedjs/paged.min.js');

console.log('vendor libraries copied to ui/vendor');
