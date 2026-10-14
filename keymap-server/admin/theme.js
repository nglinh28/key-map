'use strict';
// Runs before the page is drawn, so a saved light/dark choice (and a collapsed menu) never flashes the other state. No saved choice = follow the system.
(() => {
  try {
    const t = localStorage.getItem('ftAdminTheme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    if (localStorage.getItem('ftAdminNav') === 'collapsed') document.documentElement.dataset.nav = 'collapsed';
  } catch { /* private mode: follow the system, menu open */ }
})();
