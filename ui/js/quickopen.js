// Quick open (Cmd/Ctrl+P): fuzzy file finder over the folder tree.
import { h, escapeHtml } from './util.js';

/** Fuzzy score of `q` against `s` (both lowercased). Returns null when not a subsequence. */
function score(q, s, orig) {
  let si = 0, total = 0, streak = 0;
  const pos = [];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === ' ') continue;
    const found = s.indexOf(c, si);
    if (found < 0) return null;
    const prev = orig[found - 1];
    let pts = 1;
    if (found === si && qi > 0) { streak++; pts += 4 + streak; } else streak = 0;
    if (found === 0 || prev === '/' || prev === '-' || prev === '_' || prev === ' ' || prev === '.') pts += 6;
    else if (orig[found] !== s[found] && prev === prev?.toLowerCase()) pts += 4; // camelCase hump
    total += pts - Math.min(3, (found - si) * 0.05);
    pos.push(found);
    si = found + 1;
  }
  return { total, pos };
}

function highlight(str, positions) {
  if (!positions?.length) return escapeHtml(str);
  const set = new Set(positions);
  let out = '';
  for (let i = 0; i < str.length; i++) out += set.has(i) ? `<b>${escapeHtml(str[i])}</b>` : escapeHtml(str[i]);
  return out;
}

export function rank(files, query, limit = 60) {
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, limit).map((f) => ({ f }));
  const out = [];
  for (const f of files) {
    const rel = f.rel.replace(/\\/g, '/');
    const lowRel = rel.toLowerCase();
    const nameStart = rel.length - f.name.length;
    // Prefer matches in the filename; fall back to the whole relative path.
    const n = score(q, f.name.toLowerCase(), f.name);
    const p = n ? null : score(q, lowRel, rel);
    if (!n && !p) continue;
    const s = n ? n.total * 2 + 10 - f.name.length * 0.02 : p.total - rel.length * 0.01;
    out.push({ f, s, namePos: n?.pos, relPos: p?.pos, nameStart });
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, limit);
}

export function showQuickOpen(files, { onOpen, current }) {
  if (document.querySelector('.overlay.qo-overlay')) return;
  const prevFocus = document.activeElement;
  const input = h('input', { type: 'text', placeholder: 'Go to file…', 'aria-label': 'Go to file', spellcheck: 'false', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'qo-list' });
  const list = h('ul', { class: 'qo-list', id: 'qo-list', role: 'listbox' });
  const ov = h('div', { class: 'overlay qo-overlay' }, h('div', { class: 'qo', role: 'dialog', 'aria-label': 'Go to file' }, [input, list]));
  let results = [], sel = 0;

  function draw() {
    // Without a query, list the current file last so the most useful choice is on top.
    results = rank(files, input.value);
    if (!input.value.trim() && current) {
      const i = results.findIndex((r) => r.f.path === current);
      if (i >= 0 && results.length > 1) results.push(results.splice(i, 1)[0]);
    }
    sel = 0;
    if (!results.length) { list.innerHTML = '<li class="qo-empty">No matching files</li>'; return; }
    list.innerHTML = results.map((r, i) => {
      const rel = r.f.rel.replace(/\\/g, '/');
      const dir = rel.slice(0, rel.length - r.f.name.length).replace(/\/$/, '');
      const pathHtml = r.relPos ? highlight(rel, r.relPos) : escapeHtml(dir || './');
      return `<li class="qo-item${i === sel ? ' sel' : ''}" role="option" id="qo-${i}" data-i="${i}" aria-selected="${i === sel}"><span class="n">${highlight(r.f.name, r.namePos)}</span><span class="p">${pathHtml}</span></li>`;
    }).join('');
    input.setAttribute('aria-activedescendant', 'qo-0');
  }

  function move(d) {
    if (!results.length) return;
    list.children[sel]?.classList.remove('sel');
    list.children[sel]?.setAttribute('aria-selected', 'false');
    sel = (sel + d + results.length) % results.length;
    const li = list.children[sel];
    li.classList.add('sel');
    li.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', li.id);
    li.scrollIntoView({ block: 'nearest' });
  }

  function close(restore = true) {
    ov.remove();
    if (restore) prevFocus?.focus?.({ preventScroll: true });
  }
  function choose(i, opts) {
    const r = results[i];
    close(false);
    if (r) onOpen(r.f.path, opts);
  }

  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); move(-1); }
    else if (e.key === 'PageDown') { e.preventDefault(); move(Math.min(10, results.length - 1 - sel) || 0); }
    else if (e.key === 'PageUp') { e.preventDefault(); move(-Math.min(10, sel)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel, { newWindow: e.metaKey || e.ctrlKey }); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.qo-item');
    if (li) choose(+li.dataset.i, { newWindow: e.metaKey || e.ctrlKey });
  });
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

  document.body.append(ov);
  draw();
  input.focus();
}
