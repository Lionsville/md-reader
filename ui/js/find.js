// Find in page: custom find bar. Uses the CSS Custom Highlight API when available,
// falling back to wrapping matches in <mark class="find-hit">.
import { h, icon, isMac } from './util.js';

const HAS_HL = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';

export function createFind(hostEl, docEl, scrollEl) {
  let bar = null, input, countEl;
  let ranges = [];      // Range[] (highlight mode) or <mark>[] (fallback)
  let cur = -1;
  let query = '';

  function build() {
    input = h('input', { type: 'text', placeholder: 'Find in document', 'aria-label': 'Find in document', spellcheck: 'false', autocomplete: 'off' });
    countEl = h('span', { class: 'count', 'aria-live': 'polite' });
    const btn = (name, label, fn) => h('button', { class: 'tb-btn', type: 'button', 'aria-label': label, title: label, html: icon(name), onclick: fn });
    bar = h('div', { class: 'findbar', role: 'search' }, [
      input, countEl,
      btn('up', `Previous match (${isMac ? '⇧⌘G' : 'Shift+Ctrl+G'})`, () => step(-1)),
      btn('down', `Next match (${isMac ? '⌘G' : 'Ctrl+G'})`, () => step(1)),
      btn('close', 'Close (Esc)', close),
    ]);
    let t;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => search(input.value, true), ranges.length > 2000 ? 120 : 30); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (input.value !== query) search(input.value, true); else step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    });
  }

  function open() {
    if (!bar) build();
    if (!bar.isConnected) hostEl.append(bar);
    // Align with the right edge of the document pane (the outline may sit to its right).
    bar.style.right = Math.max(8, hostEl.getBoundingClientRect().right - scrollEl.getBoundingClientRect().right + 16) + 'px';
    const sel = String(window.getSelection() || '').trim();
    if (sel && sel.length < 200 && !sel.includes('\n')) input.value = sel;
    input.focus();
    input.select();
    if (input.value && input.value !== query) search(input.value, true);
  }

  function close() {
    clear();
    query = '';
    bar?.remove();
    scrollEl.focus({ preventScroll: true });
  }

  function clear() {
    if (HAS_HL) {
      CSS.highlights.delete('find');
      CSS.highlights.delete('find-current');
    } else {
      for (const m of ranges) {
        const p = m.parentNode;
        if (!p) continue;
        m.replaceWith(...m.childNodes);
        p.normalize();
      }
    }
    ranges = [];
    cur = -1;
  }

  /** Collect text nodes of the document into one string so matches can span elements. */
  function textIndex() {
    const nodes = [], starts = [];
    let text = '';
    const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest('.code-copy, script, style, .katex-mathml, svg title')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push(n); starts.push(text.length); text += n.data;
    }
    return { nodes, starts, text };
  }

  function locate(idx, starts) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  function search(q, scrollToFirst) {
    const keepPos = scrollToFirst ? null : cur;
    clear();
    query = q;
    if (!q) { update(); return; }
    const { nodes, starts, text } = textIndex();
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const found = [];
    for (let m; (m = re.exec(text)) && found.length < 10000;) {
      if (!m[0].length) { re.lastIndex++; continue; }
      const a = locate(m.index, starts), b = locate(m.index + m[0].length - 1, starts);
      const r = document.createRange();
      r.setStart(nodes[a], m.index - starts[a]);
      r.setEnd(nodes[b], m.index + m[0].length - starts[b]);
      found.push(r);
    }
    if (HAS_HL) {
      ranges = found;
      if (found.length) CSS.highlights.set('find', new Highlight(...found));
    } else {
      // Wrap back-to-front so earlier ranges stay valid.
      for (let i = found.length - 1; i >= 0; i--) {
        const r = found[i];
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        try { mark.append(r.extractContents()); r.insertNode(mark); ranges[i] = mark; } catch { /* spans odd structure */ }
      }
      ranges = ranges.filter(Boolean);
    }
    if (ranges.length) {
      cur = keepPos != null && keepPos >= 0 ? Math.min(keepPos, ranges.length - 1) : firstVisible();
      focusCurrent(scrollToFirst);
    }
    update();
  }

  /** Start from the first match below the current viewport top, like browsers do. */
  function firstVisible() {
    const top = scrollEl.getBoundingClientRect().top;
    for (let i = 0; i < ranges.length; i++) if (ranges[i].getBoundingClientRect().top >= top) return i;
    return 0;
  }

  function focusCurrent(scroll = true) {
    if (HAS_HL) {
      CSS.highlights.set('find-current', new Highlight(ranges[cur]));
    } else {
      bar && docEl.querySelectorAll('mark.find-hit.current').forEach((m) => m.classList.remove('current'));
      ranges[cur].classList.add('current');
    }
    if (!scroll) return;
    const rect = ranges[cur].getBoundingClientRect();
    const box = scrollEl.getBoundingClientRect();
    if (rect.top < box.top + 50 || rect.bottom > box.bottom - 30) {
      scrollEl.scrollTop += rect.top - box.top - box.height / 3;
    }
    // Horizontally scrolled containers (code blocks, tables).
    const container = (HAS_HL ? ranges[cur].startContainer.parentElement : ranges[cur]).closest?.('pre, .table-wrap');
    if (container) {
      const cr = container.getBoundingClientRect(), r2 = ranges[cur].getBoundingClientRect();
      if (r2.left < cr.left || r2.right > cr.right) container.scrollLeft += r2.left - cr.left - cr.width / 3;
    }
  }

  function step(dir) {
    if (!bar?.isConnected) { open(); return; }
    if (input.value !== query) { search(input.value, true); return; }
    if (!ranges.length) return;
    cur = (cur + dir + ranges.length) % ranges.length;
    focusCurrent(true);
    update();
  }

  function update() {
    if (!bar) return;
    const n = ranges.length;
    countEl.textContent = !query ? '' : n ? `${cur + 1} of ${n}${n >= 10000 ? '+' : ''}` : 'No results';
    bar.classList.toggle('nohit', !!query && !n);
  }

  return {
    open, close, step,
    get isOpen() { return !!bar?.isConnected; },
    /** Document re-rendered: re-run the current search without jumping. */
    refresh() { if (bar?.isConnected && query) { ranges = []; search(query, false); } else { ranges = []; cur = -1; } },
  };
}
