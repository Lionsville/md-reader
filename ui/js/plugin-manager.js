// Plugin manager dialog: list/toggle plugins, show errors, open the plugins folder, reload.
import * as api from './api.js';
import { listPlugins, setPluginEnabled, reloadPlugins, pluginsReady, loadStyle, appUrl, onPluginsChanged } from './plugins.js';

const TEMPLATE = `// my-plugin.js — put this file in the plugins folder, then "Reload plugins".
export default {
  id: 'my-plugin',
  name: 'My plugin',
  description: 'Uppercases \`\`\`shout code blocks.',
  selector: 'pre > code.language-shout',
  render(root, ctx) {
    for (const code of root.querySelectorAll(this.selector)) {
      if (!ctx.claim(code)) continue;          // idempotent: skip processed blocks
      const div = document.createElement('div');
      div.textContent = code.textContent.toUpperCase();
      ctx.codeBlock(code).replaceWith(div);    // replaces the <pre> (and its wrapper)
    }
  },
};`;

let dialog = null;
let unsubscribe = null;
let infoCache = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fileName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

function row(p) {
  const id = esc(p.id);
  const meta = [p.builtin ? 'Built-in' : esc(fileName(p.source)), p.version ? 'v' + esc(p.version) : '']
    .filter(Boolean).join(' · ');
  const status = !p.enabled ? '<span class="pm-badge pm-off">Disabled</span>'
    : p.error ? '<span class="pm-badge pm-err">Error</span>' : '';
  return `
  <li class="pm-item${p.enabled ? '' : ' is-disabled'}${p.error ? ' has-error' : ''}">
    <div class="pm-text">
      <div class="pm-name">${esc(p.name)} ${status}</div>
      ${p.description ? `<div class="pm-desc">${esc(p.description)}</div>` : ''}
      <div class="pm-meta" title="${esc(p.source)}">${meta}</div>
      ${p.error ? `<pre class="pm-error">${esc(p.error)}</pre>` : ''}
    </div>
    <label class="pm-switch" title="${p.enabled ? 'Disable' : 'Enable'} ${esc(p.name)}">
      <input type="checkbox" data-id="${id}" ${p.enabled ? 'checked' : ''} aria-label="Enable ${esc(p.name)}">
      <span class="pm-slider" aria-hidden="true"></span>
    </label>
  </li>`;
}

function renderList() {
  if (!dialog) return;
  const all = listPlugins();
  const builtins = all.filter((p) => p.builtin);
  const users = all.filter((p) => !p.builtin);
  const dir = infoCache?.pluginsDir || '';
  dialog.querySelector('.pm-builtin').innerHTML = builtins.map(row).join('');
  dialog.querySelector('.pm-user').innerHTML = users.length
    ? users.map(row).join('')
    : `<li class="pm-empty">No user plugins installed. Put <code>.js</code> files in the plugins folder${dir ? `:<br><code class="pm-path">${esc(dir)}</code>` : '.'}</li>`;
  dialog.querySelector('.pm-user-count').textContent = users.length ? `(${users.length})` : '';
}

function setStatus(text) {
  const el = dialog?.querySelector('.pm-status');
  if (el) el.textContent = text || '';
}

async function openFolder() {
  const info = infoCache || (infoCache = await api.appInfo());
  const dir = info.pluginsDir;
  if (!dir) return setStatus('The plugins folder is not available.');
  try {
    await api.opener.openPath(dir);
  } catch (err) {
    // openPath needs an opener scope for the folder; revealing it in Finder/Explorer never does.
    try {
      await api.opener.revealItemInDir(dir);
    } catch (err2) {
      console.error(err, err2);
      setStatus('Could not open the folder: ' + dir);
    }
  }
}

function build() {
  const d = document.createElement('dialog');
  d.className = 'plugin-manager';
  d.setAttribute('aria-labelledby', 'pm-title');
  d.innerHTML = `
    <form method="dialog" class="pm-head">
      <h2 id="pm-title">Plugins</h2>
      <button class="pm-close" value="close" aria-label="Close" title="Close (Esc)">✕</button>
    </form>
    <div class="pm-body">
      <p class="pm-intro">Plugins render special blocks such as diagrams and math. They only load when a document uses them.</p>
      <h3>Built-in</h3>
      <ul class="pm-list pm-builtin"></ul>
      <h3>User plugins <span class="pm-user-count"></span></h3>
      <ul class="pm-list pm-user"></ul>
      <p class="pm-warning"><strong>Only install plugins you trust.</strong> User plugins are JavaScript files that run with the same privileges as the app and can read files on your computer.</p>
      <details class="pm-howto">
        <summary>Writing a plugin</summary>
        <p>A plugin is an ES module in the plugins folder whose default export has an <code>id</code>, a <code>name</code>, an optional CSS <code>selector</code> and a <code>render(root, ctx)</code> function. See <code>docs/PLUGINS.md</code> for the full API.</p>
        <pre><code>${esc(TEMPLATE)}</code></pre>
        <button type="button" class="pm-btn pm-copy">Copy template</button>
      </details>
    </div>
    <div class="pm-foot">
      <span class="pm-status" role="status"></span>
      <button type="button" class="pm-btn pm-open">Open plugins folder</button>
      <button type="button" class="pm-btn pm-reload">Reload plugins</button>
      <button type="button" class="pm-btn pm-primary pm-done">Done</button>
    </div>`;

  d.addEventListener('change', (e) => {
    const input = e.target.closest('input[type=checkbox][data-id]');
    if (!input) return;
    setPluginEnabled(input.dataset.id, input.checked);
  });
  d.querySelector('.pm-open').addEventListener('click', openFolder);
  d.querySelector('.pm-reload').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    setStatus('Reloading…');
    try {
      await reloadPlugins();
      const n = listPlugins().filter((p) => !p.builtin).length;
      setStatus(`Reloaded — ${n} user plugin${n === 1 ? '' : 's'}.`);
    } catch (err) {
      setStatus('Reload failed: ' + (err?.message || err));
    } finally {
      btn.disabled = false;
    }
  });
  d.querySelector('.pm-done').addEventListener('click', () => d.close());
  d.querySelector('.pm-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(TEMPLATE);
      setStatus('Template copied.');
    } catch {
      setStatus('Could not copy to the clipboard.');
    }
  });
  // Click on the backdrop closes the dialog.
  d.addEventListener('click', (e) => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
  d.addEventListener('close', () => {
    unsubscribe?.();
    unsubscribe = null;
  });
  return d;
}

/** Opens the plugin manager as a modal dialog (re-uses it when already open). */
export async function showPluginManager() {
  // Stylesheet first so the dialog never flashes unstyled.
  await loadStyle(appUrl('css/plugins.css')).catch((e) => console.error(e));
  if (!dialog) {
    dialog = build();
    document.body.append(dialog);
  }
  if (!dialog.open) {
    setStatus('');
    renderList();
    dialog.showModal();
    unsubscribe?.();
    unsubscribe = onPluginsChanged(renderList);
  }
  // Fill in user plugins and the folder path as they arrive.
  api.appInfo().then((info) => { infoCache = info; renderList(); }).catch(() => {});
  await pluginsReady();
  renderList();
}
