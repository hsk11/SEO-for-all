// Projects dashboard.

import { api } from '../api.js';
import { html, raw, setHtml, fmt, auditStatusChip, toast, ICONS, loading, $ } from '../ui.js';
import { scoreRing } from '../charts.js';

export async function renderDashboard(root) {
  setHtml(root, loading('Loading projects…'));
  const projects = await api.listProjects();

  const draw = (list) => {
    const audited = list.filter((p) => p.latestCompletedAudit);
    const avgScore = audited.length
      ? Math.round(audited.reduce((s, p) => s + p.latestCompletedAudit.summary.score, 0) / audited.length)
      : null;
    const totalErrors = audited.reduce((s, p) => s + p.latestCompletedAudit.summary.errors, 0);
    const pagesAnalysed = audited.reduce((s, p) => s + p.latestCompletedAudit.summary.pagesCrawled, 0);
    const running = list.filter((p) => ['running', 'queued'].includes(p.latestAudit?.status)).length;

    setHtml(
      root,
      html`<div class="page-head">
          <div>
            <h1>Projects</h1>
            <div class="sub">Create a project for each website, run audits, and track SEO health over time.</div>
          </div>
          <a class="btn btn-primary" href="#/projects/new">+ New project</a>
        </div>

        ${list.length
          ? html`<div class="grid grid-4" style="margin-bottom:20px">
                <div class="card tile"><div class="tile-label">Projects</div><div class="tile-value">${list.length}</div><div class="tile-foot">${running ? `${running} audit(s) running` : `${audited.length} audited`}</div></div>
                <div class="card tile"><div class="tile-label">Average score</div><div class="tile-value">${avgScore ?? '–'}</div><div class="tile-foot">Latest audit per project</div></div>
                <div class="card tile"><div class="tile-label">Pages analysed</div><div class="tile-value">${fmt.num(pagesAnalysed)}</div><div class="tile-foot">Across latest audits</div></div>
                <div class="card tile"><div class="tile-label">Open errors</div><div class="tile-value">${fmt.num(totalErrors)}</div><div class="tile-foot">Error instances to fix</div></div>
              </div>
              <div class="grid grid-3">${list.map(projectCard)}</div>`
          : html`<div class="card empty-state">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21M8 10.5h5M10.5 8v5"/></svg>
              <h2>No projects yet</h2>
              <p>Add a website to run your first SEO audit: on-page SEO, broken links, metadata, images, keywords and site structure.</p>
              <a class="btn btn-primary" href="#/projects/new">Create your first project</a>
            </div>`}`,
    );
  };

  const projectCard = (p) => {
    const latest = p.latestCompletedAudit;
    const s = latest?.summary;
    return html`<div class="card project-card">
      <div class="top">
        ${scoreRing(s?.score ?? null, { size: 64, stroke: 7, label: false })}
        <div style="min-width:0">
          <a class="name" href="#/projects/${p.id}">${p.name}</a>
          <div class="url">${p.url}</div>
          <div style="margin-top:6px">${auditStatusChip(p.latestAudit)}</div>
        </div>
      </div>
      ${s
        ? html`<div class="row small" style="gap:16px">
            <span><strong>${fmt.num(s.pagesCrawled)}</strong> <span class="muted">pages</span></span>
            <span><strong>${fmt.num(s.errors)}</strong> <span class="muted">errors</span></span>
            <span><strong>${fmt.num(s.warnings)}</strong> <span class="muted">warnings</span></span>
            <span><strong>${fmt.num(s.brokenLinks)}</strong> <span class="muted">broken links</span></span>
          </div>`
        : html`<div class="small muted">No completed audit yet.</div>`}
      <div class="meta">
        <span>${latest ? `Audited ${fmt.relative(latest.finishedAt)}` : `Created ${fmt.relative(p.createdAt)}`}</span>
        <span class="actions">
          <a class="btn btn-sm" href="#/projects/${p.id}">Open</a>
          <button class="btn btn-sm btn-primary" data-run="${p.id}" ${['running', 'queued'].includes(p.latestAudit?.status) ? raw('disabled') : ''}>${raw(ICONS.play)} Run audit</button>
        </span>
      </div>
    </div>`;
  };

  draw(projects);

  root.addEventListener('click', onClick);
  async function onClick(e) {
    const btn = e.target.closest('[data-run]');
    if (!btn) return;
    btn.disabled = true;
    try {
      const audit = await api.startAudit(btn.dataset.run);
      toast('Audit started');
      location.hash = `#/audits/${audit.id}`;
    } catch (err) {
      toast(err.message, { error: true });
      btn.disabled = false;
    }
  }

  // Keep running-audit chips fresh while the dashboard is open.
  const timer = setInterval(async () => {
    if (!projects.some((p) => ['running', 'queued'].includes(p.latestAudit?.status))) return;
    try {
      const fresh = await api.listProjects();
      projects.splice(0, projects.length, ...fresh);
      if ($('.page-head', root)) draw(projects);
    } catch {}
  }, 3000);

  return () => {
    clearInterval(timer);
    root.removeEventListener('click', onClick);
  };
}
