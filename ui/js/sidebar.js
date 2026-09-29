// Folder tree (sidebar): lazy rendering of expanded nodes only, filter, keyboard navigation.
import { icon, store, escapeHtml, normPath, relativePath } from './util.js';

export function createTree(treeEl, filterEl, { rootPath, onOpen }) {
  const expKey = 'mdr.expanded:' + rootPath;
  let root = null;
  let expanded = new Set(store.get(expKey, null) || []);
  let firstRun = store.get(expKey, null) === null;
  let active = null;          // normalized active file path
  let focusIdx = -1;
  let rows = [];              // [{node, depth}] currently visible, in order
  let filter = '';
  let allFiles = [];          // [{name, path, rel}]
  const filePaths = new Set();
  const dirPaths = new Set();
  const parents = new Map();  // norm path -> parent dir node

  treeEl.tabIndex = 0;

  function index(node, parent) {
    if (parent) parents.set(normPath(node.path), parent);
    if (node.isDir) {
      dirPaths.add(normPath(node.path));
      for (const c of node.children) index(c, node);
    } else {
      filePaths.add(normPath(node.path));
      allFiles.push({ name: node.name, path: node.path, rel: relativePath(node.path, rootPath) });
    }
  }

  function setData(node) {
    root = node;
    allFiles = [];
    filePaths.clear(); dirPaths.clear(); parents.clear();
    index(node, null);
    if (firstRun) {
      // First time this folder is opened: expand the top-level folders when the tree is small.
      if (allFiles.length <= 60) for (const c of node.children) if (c.isDir) expanded.add(normPath(c.path));
      firstRun = false;
      saveExpanded();
    }
    render();
  }

  function saveExpanded() {
    // Only keep dirs that still exist.
    store.set(expKey, [...expanded].filter((p) => dirPaths.has(p)));
  }

  const matches = (name) => name.toLowerCase().includes(filter);
  function dirHasMatch(node) {
    return node.children.some((c) => (c.isDir ? dirHasMatch(c) : matches(c.name)));
  }

  function collect(node, depth, out) {
    for (const c of node.children) {
      if (filter) {
        if (c.isDir ? !dirHasMatch(c) : !matches(c.name)) continue;
      }
      out.push({ node: c, depth });
      if (c.isDir && (filter || expanded.has(normPath(c.path)))) collect(c, depth + 1, out);
    }
  }

  function label(name) {
    if (!filter) return escapeHtml(name);
    const i = name.toLowerCase().indexOf(filter);
    if (i < 0) return escapeHtml(name);
    return escapeHtml(name.slice(0, i)) + '<mark>' + escapeHtml(name.slice(i, i + filter.length)) + '</mark>' + escapeHtml(name.slice(i + filter.length));
  }

  function render() {
    if (!root) return;
    const scroll = treeEl.scrollTop;
    rows = [];
    collect(root, 0, rows);
    if (!rows.length) {
      treeEl.innerHTML = `<div class="tree-empty">${filter ? 'No matching files' : 'No markdown files'}</div>`;
      treeEl.removeAttribute('aria-activedescendant');
      return;
    }
    let html = '';
    rows.forEach(({ node, depth }, i) => {
      const np = normPath(node.path);
      if (node.isDir) {
        const open = filter || expanded.has(np);
        html += `<div class="ti dir" id="ti-${i}" role="treeitem" aria-level="${depth + 1}" aria-expanded="${open}" data-i="${i}" style="--depth:${depth}" title="${escapeHtml(node.name)}">` +
          icon('chevron', 'i chev') + icon('folder', 'i ic') + `<span class="name">${label(node.name)}</span></div>`;
      } else {
        const act = np === active;
        html += `<div class="ti file${act ? ' active' : ''}" id="ti-${i}" role="treeitem" aria-level="${depth + 1}" aria-selected="${act}" data-i="${i}" style="--depth:${depth}" title="${escapeHtml(relativePath(node.path, rootPath))}">` +
          icon('doc', 'i ic') + `<span class="name">${label(node.name)}</span></div>`;
      }
    });
    treeEl.innerHTML = html;
    treeEl.scrollTop = scroll;
    if (focusIdx >= rows.length) focusIdx = rows.length - 1;
    const ai = rows.findIndex((r) => !r.node.isDir && normPath(r.node.path) === active);
    if (focusIdx < 0) focusIdx = ai >= 0 ? ai : 0;
    markFocus(false);
  }

  function markFocus(scroll = true) {
    treeEl.querySelector('.ti.focus')?.classList.remove('focus');
    const el = treeEl.querySelector(`[data-i="${focusIdx}"]`);
    if (!el) return;
    el.classList.add('focus');
    treeEl.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }

  function toggle(node, open = !expanded.has(normPath(node.path))) {
    const np = normPath(node.path);
    if (open) expanded.add(np); else expanded.delete(np);
    saveExpanded();
    render();
  }

  function activate(i) {
    const r = rows[i];
    if (!r) return;
    focusIdx = i;
    if (r.node.isDir) { if (!filter) toggle(r.node); markFocus(); }
    else onOpen(r.node.path);
  }

  treeEl.addEventListener('click', (e) => {
    const el = e.target.closest('.ti');
    if (!el) return;
    const i = +el.dataset.i;
    if (e.metaKey || e.ctrlKey) { const r = rows[i]; if (r && !r.node.isDir) onOpen(r.node.path, { newWindow: true }); return; }
    activate(i);
  });

  treeEl.addEventListener('keydown', (e) => {
    if (!rows.length) return;
    const r = rows[focusIdx];
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': focusIdx = Math.min(rows.length - 1, focusIdx + 1); markFocus(); break;
      case 'ArrowUp':
        if (focusIdx === 0 && filterEl) { filterEl.focus(); break; }
        focusIdx = Math.max(0, focusIdx - 1); markFocus(); break;
      case 'Home': focusIdx = 0; markFocus(); break;
      case 'End': focusIdx = rows.length - 1; markFocus(); break;
      case 'ArrowRight':
        if (r?.node.isDir) {
          if (!filter && !expanded.has(normPath(r.node.path))) toggle(r.node, true);
          else if (rows[focusIdx + 1]?.depth > r.depth) { focusIdx++; markFocus(); }
        }
        break;
      case 'ArrowLeft':
        if (r?.node.isDir && !filter && expanded.has(normPath(r.node.path))) toggle(r.node, false);
        else if (r && r.depth > 0) {
          for (let j = focusIdx - 1; j >= 0; j--) if (rows[j].depth < r.depth) { focusIdx = j; break; }
          markFocus();
        }
        break;
      case 'Enter': case ' ': activate(focusIdx); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  });

  if (filterEl) {
    filterEl.addEventListener('input', () => {
      filter = filterEl.value.trim().toLowerCase();
      focusIdx = -1;
      render();
      if (filter) { const fi = rows.findIndex((r) => !r.node.isDir); focusIdx = fi; markFocus(); }
    });
    filterEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); treeEl.focus(); if (focusIdx < 0) focusIdx = 0; markFocus(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const r = rows[focusIdx]?.node.isDir === false ? rows[focusIdx] : rows.find((x) => !x.node.isDir);
        if (r) onOpen(r.node.path);
      } else if (e.key === 'Escape' && filterEl.value) {
        e.preventDefault(); e.stopPropagation();
        filterEl.value = ''; filterEl.dispatchEvent(new Event('input'));
      }
    });
  }

  /** Mark `path` active; expand its ancestors and scroll it into view. */
  function setActive(path, { reveal = true } = {}) {
    active = path ? normPath(path) : null;
    let changed = false;
    if (active) {
      for (let p = parents.get(active); p && p !== root; p = parents.get(normPath(p.path))) {
        const np = normPath(p.path);
        if (!expanded.has(np)) { expanded.add(np); changed = true; }
      }
    }
    if (changed) saveExpanded();
    focusIdx = -1;
    render();
    if (reveal) treeEl.querySelector('.ti.active')?.scrollIntoView({ block: 'nearest' });
  }

  return {
    setData,
    setActive,
    files: () => allFiles,
    hasFile: (p) => filePaths.has(normPath(p)),
    hasDir: (p) => dirPaths.has(normPath(p)),
    firstFile: () => allFiles[0]?.path || null,
    /** First file at or below directory `dir`. */
    firstFileIn: (dir) => allFiles.find((f) => normPath(f.path).startsWith(normPath(dir) + '/'))?.path || null,
    focus: () => { treeEl.focus(); markFocus(); },
    focusFilter: () => { filterEl?.focus(); filterEl?.select(); },
  };
}
