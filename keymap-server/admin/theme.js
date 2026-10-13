'use strict';
// Runs before the page is drawn, so a saved light/dark choice never flashes the other theme. No saved choice = follow the system.
(() => {
  try {
    const t = localStorage.getItem('ftAdminTheme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch { /* private mode: follow the system */ }
})();
