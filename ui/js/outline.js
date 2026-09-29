// Outline panel: heading list with scroll-spy.
import { escapeHtml } from './util.js';

export function createOutline(listEl, scrollEl, { onNavigate }) {
  let items = [];     // [{id, el(heading), link}]
  let current = -1;
  let ticking = false;

  function set(headings, docEl) {
    const min = headings.reduce((m, x) => Math.min(m, x.level), 6);
    listEl.innerHTML = headings.map((x, i) =>
      `<a href="#${escapeHtml(x.id)}" data-i="${i}" class="l${x.level - min + 1}" style="--lvl:${x.level - min}" title="${escapeHtml(x.text)}">${escapeHtml(x.text)}</a>`
    ).join('');
    const links = listEl.children;
    items = headings.map((x, i) => ({ id: x.id, el: docEl.querySelector('#' + CSS.escape(x.id)), link: links[i] })).filter((x) => x.el);
    current = -1;
    spy();
  }

  function spy() {
    ticking = false;
    if (!items.length) return;
    const top = scrollEl.getBoundingClientRect().top + 72;
    let idx = 0;
    // Binary search the last heading above the reading line.
    let lo = 0, hi = items.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].el.getBoundingClientRect().top <= top) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    // At the very bottom, highlight the last heading that is visible.
    if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2) {
      const bottom = scrollEl.getBoundingClientRect().bottom;
      for (let i = items.length - 1; i > idx; i--) if (items[i].el.getBoundingClientRect().top < bottom) { idx = i; break; }
    }
    if (idx === current) return;
    items[current]?.link.classList.remove('current');
    current = idx;
    const link = items[idx].link;
    link.classList.add('current');
    // Keep the highlighted entry visible inside the outline.
    const lr = link.getBoundingClientRect(), pr = listEl.getBoundingClientRect();
    if (lr.top < pr.top || lr.bottom > pr.bottom) listEl.scrollTop += lr.top - pr.top - pr.height / 3;
  }

  scrollEl.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(spy); }
  }, { passive: true });

  listEl.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    onNavigate(items.find((x) => x.link === a)?.id ?? a.getAttribute('href').slice(1));
  });

  return { set, refresh: spy, get count() { return items.length; } };
}
