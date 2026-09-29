// Small popup menu anchored to a toolbar button. Keyboard navigable.
import { h, escapeHtml } from './util.js';

let openMenu = null;

/**
 * items: [{label, run, kbd?, checked?, disabled?} | '-' | {note}]
 */
export function showMenu(anchor, items) {
  if (openMenu) { const same = openMenu.anchor === anchor; openMenu.close(); if (same) return; }
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === '-') { menu.append(h('hr', { role: 'separator' })); continue; }
    if (it.note) { menu.append(h('div', { class: 'menu-note', text: it.note })); continue; }
    const radio = 'checked' in it;
    const b = h('button', {
      type: 'button', role: radio ? 'menuitemradio' : 'menuitem', tabindex: '-1',
      'aria-checked': radio ? String(!!it.checked) : null, disabled: it.disabled || null,
      html: (radio ? `<span class="check">${it.checked ? '✓' : ''}</span>` : '') +
        `<span class="label">${escapeHtml(it.label)}</span>` + (it.kbd ? `<kbd>${escapeHtml(it.kbd)}</kbd>` : ''),
    });
    b.addEventListener('click', () => { close(); it.run(); });
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  menu.style.top = r.bottom + 4 + 'px';
  menu.style.left = Math.max(6, Math.min(window.innerWidth - mw - 6, r.right - mw)) + 'px';
  anchor.setAttribute('aria-expanded', 'true');

  const buttons = () => [...menu.querySelectorAll('button:not(:disabled)')];
  const onKey = (e) => {
    const bs = buttons();
    const i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); bs[i < 0 ? bs.length - 1 : (i - 1 + bs.length) % bs.length]?.focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); anchor.focus(); }
    else return;
    e.stopPropagation();
  };
  const onDown = (e) => { if (!menu.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  function close() {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    openMenu = null;
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  openMenu = { anchor, close };
  menu.tabIndex = -1;
  menu.focus({ preventScroll: true });
}
