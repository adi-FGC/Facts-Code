/* No-flash theme boot. Externalized (not inline) because MV3 forbids inline
   scripts even with a CSP hash. Dark-first: a panel sits next to an editor,
   so dark is the right default. Runs before the CSS bundle paints. */
(function () {
  try {
    var t = localStorage.getItem('factstack-panel-theme') || 'dark';
    var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    var html = document.documentElement;
    html.dataset.theme = dark ? 'dark' : 'light';
    html.style.colorScheme = dark ? 'dark' : 'light';
  } catch (_) {
    /* private mode / sandbox — dark default already on <html> */
  }
})();
