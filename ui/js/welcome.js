// Welcome screen (window opened without a path) + the recent files/folders list.
import { pathInfo } from './api.js';
import { h, icon, store, escapeHtml, basename, dirname, normPath, isMac } from './util.js';

const KEY = 'mdr.recent';
const MAX = 12;

export function addRecent(path, kind) {
  const list = store.get(KEY, []).filter((r) => r && normPath(r.path) !== normPath(path));
  list.unshift({ path, kind, t: Date.now() });
  store.set(KEY, list.slice(0, MAX));
}
function removeRecent(path) {
  store.set(KEY, store.get(KEY, []).filter((r) => r && normPath(r.path) !== normPath(path)));
}

const LOGO = `<svg class="wl-logo" viewBox="0 0 64 64" aria-hidden="true">
  <rect x="4" y="4" width="56" height="56" rx="14" fill="var(--accent)"/>
  <path d="M15 44V20h6l7 9.5 7-9.5h6v24h-6V30l-7 9.3-7-9.3v14z" fill="#fff"/>
  <path d="M44.5 20h5v14.5h5.2l-7.7 9.5-7.7-9.5h5.2z" fill="#fff" opacity=".9"/>
</svg>`;

/**
 * Render the welcome screen into `el`.
 * actions: {openFile(), openFolder(), open(path)}
 */
export function renderWelcome(el, actions, version) {
  const mod = isMac ? '⌘' : 'Ctrl';
  const recent = store.get(KEY, []).filter((r) => r && r.path);
  const list = h('ul', { class: 'wl-recent', 'aria-label': 'Recent files and folders' });

  function row(r) {
    const li = h('li');
    const open = h('button', {
      class: 'open', type: 'button', title: r.path,
      html: icon(r.kind === 'folder' ? 'folder' : 'doc', 'i ic') +
        `<span class="txt"><span class="n">${escapeHtml(basename(r.path))}</span><span class="p">‎${escapeHtml(dirname(r.path))}‎</span></span>`,
      onclick: () => actions.open(r.path),
    });
    const rm = h('button', {
      class: 'rm', type: 'button', 'aria-label': `Remove ${basename(r.path)} from recent`, title: 'Remove from list', html: icon('close'),
      onclick: () => { removeRecent(r.path); li.remove(); if (!list.children.length) list.replaceWith(empty()); },
    });
    li.append(open, rm);
    return li;
  }
  const empty = () => h('div', { class: 'wl-empty', text: 'No recent documents yet.' });

  for (const r of recent) list.append(row(r));

  const inner = h('div', { class: 'welcome-inner' }, [
    h('div', { class: 'wl-head', html: LOGO + `<div><h1>MD Reader</h1><p>A fast, native markdown reader${version ? ' · v' + escapeHtml(version) : ''}</p></div>` }),
    h('div', { class: 'wl-actions' }, [
      h('button', { class: 'btn primary', type: 'button', html: icon('doc') + '<span>Open File…</span>', title: `${mod}${isMac ? '' : '+'}O`, onclick: actions.openFile }),
      h('button', { class: 'btn', type: 'button', html: icon('folder') + '<span>Open Folder…</span>', title: `${mod}${isMac ? '⇧' : '+Shift+'}O`, onclick: actions.openFolder }),
    ]),
    h('section', { class: 'wl-section' }, [h('h2', { text: 'Recent' }), recent.length ? list : empty()]),
    h('p', { class: 'wl-hint', html: `Drop a markdown, PDF or HTML file, or a folder, anywhere on this window to open it.<br><kbd>${mod}</kbd> <kbd>O</kbd> open file · <kbd>${mod}</kbd> <kbd>${isMac ? '⇧' : 'Shift'}</kbd> <kbd>O</kbd> open folder` }),
  ]);
  el.innerHTML = '';
  el.append(h('div', { class: 'welcome' }, inner));

  // Drop entries that no longer exist (after first paint; cheap IPC calls in parallel).
  if (recent.length) {
    setTimeout(async () => {
      const infos = await Promise.all(recent.map((r) => pathInfo(r.path).catch(() => null)));
      recent.forEach((r, i) => {
        if (infos[i] && !infos[i].exists) {
          removeRecent(r.path);
          [...list.children].find((li) => li.querySelector('.open')?.title === r.path)?.remove();
        }
      });
      if (!list.children.length && list.isConnected) list.replaceWith(empty());
    }, 0);
  }
}
