// Hash router + app shell.

import { $, $$, setHtml, html, toast } from './ui.js';
import { renderDashboard } from './views/dashboard.js';
import { renderProjectForm } from './views/project-form.js';
import { renderProject } from './views/project.js';
import { renderAudit } from './views/audit.js';
import { renderReports } from './views/reports.js';

const routes = [
  { pattern: /^\/$/, view: renderDashboard, nav: 'dashboard' },
  { pattern: /^\/reports$/, view: renderReports, nav: 'reports' },
  { pattern: /^\/projects\/new$/, view: (root) => renderProjectForm(root, null), nav: 'new' },
  { pattern: /^\/projects\/([\w-]+)\/edit$/, view: (root, [id]) => renderProjectForm(root, id), nav: 'dashboard' },
  { pattern: /^\/projects\/([\w-]+)$/, view: (root, [id]) => renderProject(root, id), nav: 'dashboard' },
  { pattern: /^\/audits\/([\w-]+)(?:\/(\w+))?$/, view: (root, [id, tab]) => renderAudit(root, id, tab), nav: 'dashboard' },
];

let cleanup = null;
let renderToken = 0;

async function router() {
  const path = location.hash.replace(/^#/, '') || '/';
  const root = $('#view');
  const token = ++renderToken;

  // Re-rendering the same audit with a different tab is handled inside the view.
  if (cleanup?.handlesPath?.(path)) {
    cleanup.handlesPath(path, true);
    return;
  }
  if (typeof cleanup === 'function') cleanup();
  else cleanup?.dispose?.();
  cleanup = null;

  const route = routes.find((r) => r.pattern.test(path));
  $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.nav === route?.nav));
  if (!route) {
    setHtml(root, html`<div class="empty-state"><h2>Page not found</h2><p>That page doesn't exist.</p><a class="btn btn-primary" href="#/">Go to projects</a></div>`);
    return;
  }
  const params = path.match(route.pattern).slice(1);
  try {
    const result = await route.view(root, params);
    if (token !== renderToken) {
      // Navigation happened while this view was loading.
      if (typeof result === 'function') result();
      else result?.dispose?.();
      return;
    }
    cleanup = result ?? null;
  } catch (err) {
    console.error(err);
    if (token !== renderToken) return;
    setHtml(
      root,
      html`<div class="empty-state"><h2>${err.status === 404 ? 'Not found' : 'Something went wrong'}</h2>
        <p>${err.message}</p><a class="btn btn-primary" href="#/">Back to projects</a></div>`,
    );
  }
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------- theme
const THEMES = ['auto', 'light', 'dark'];
function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('#theme-toggle').textContent = `Theme: ${theme}`;
}
let theme = 'auto';
try {
  theme = localStorage.getItem('seo-theme') || 'auto';
} catch {}
applyTheme(theme);
$('#theme-toggle').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
  try {
    if (theme === 'auto') localStorage.removeItem('seo-theme');
    else localStorage.setItem('seo-theme', theme);
  } catch {}
});

window.addEventListener('hashchange', router);
window.addEventListener('unhandledrejection', (e) => {
  toast(e.reason?.message || 'Unexpected error', { error: true });
});
router();
