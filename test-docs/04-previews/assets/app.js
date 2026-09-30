// Demo + self-check for MD Reader's sandboxed HTML preview.
let n = 0;
document.getElementById('inc').addEventListener('click', () => {
  document.getElementById('count').textContent = ++n;
});

const ctx = document.getElementById('c').getContext('2d');
(function frame(t) {
  ctx.clearRect(0, 0, 480, 120);
  for (let i = 0; i < 24; i++) {
    const x = 10 + i * 20, y = 60 + Math.sin(t / 400 + i / 3) * 40;
    ctx.fillStyle = `hsl(${(i * 15 + t / 20) % 360} 70% 50%)`;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
  }
  requestAnimationFrame(frame);
})(0);

// Each check passes when the page is properly isolated.
const checks = [
  ['No Tauri API in this page', () => typeof window.__TAURI__ === 'undefined' && typeof window.__TAURI_INTERNALS__ === 'undefined'],
  ['Cannot reach the reader window', () => { try { void parent.document.title; return false; } catch { return true; } }],
  ['Opaque origin (no shared storage)', () => { try { localStorage.getItem('x'); return false; } catch { return true; } }],
  ['IPC endpoint blocked', async () => {
    for (const url of ['ipc://localhost/app_info', 'http://ipc.localhost/app_info']) {
      try { await fetch(url, { method: 'POST', body: '{}' }); return false; } catch {}
    }
    return true;
  }],
  ['Files outside this folder blocked', async () => {
    try { const r = await fetch('../README.md'); return !r.ok; } catch { return true; }
  }],
  ['Files in this folder load', async () => {
    try { const r = await fetch('assets/style.css'); return r.ok; } catch { return false; }
  }],
];
const list = document.getElementById('checks');
for (const [label, fn] of checks) {
  const li = document.createElement('li');
  li.textContent = label + ' …';
  list.append(li);
  Promise.resolve().then(fn).catch(() => false).then((ok) => {
    li.textContent = (ok ? '✓ ' : '✗ ') + label;
    li.className = ok ? 'pass' : 'fail';
  });
}
