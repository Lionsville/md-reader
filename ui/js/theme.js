// Loaded synchronously in <head> so the first paint already has the right theme.
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('mdr.theme') || 'system'; } catch (e) {}
  var dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
