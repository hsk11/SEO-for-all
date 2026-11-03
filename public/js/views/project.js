// Project detail: live audit progress, score trend and audit history.

import { api } from '../api.js';
import { html, raw, setHtml, $, fmt, auditStatusChip, toast, confirmDialog, ICONS, loading, downloadButtons, externalLink } from '../ui.js';
import { trendChart, mountTrend, scoreRing } from '../charts.js';
import { dataTable } from '../table.js';

export function progressCard(audit) {
  const p = audit.progress ?? {};
  const counters = [
    p.pagesCrawled ? `${fmt.num(p.pagesCrawled)} URLs crawled` : null,
    p.linksTotal ? `${fmt.num(p.linksChecked)} / ${fmt.num(p.linksTotal)} links checked` : null,
  ].filter(Boolean);
  return html`<div class="card card-pad" data-progress>
    <div class="row" style="justify-content:space-between">
      <div class="row"><span class="spinner"></span><h2>Audit ${audit.status === 'queued' ? 'queued' : 'in progress'}</h2></div>
      <button class="btn btn-sm btn-danger" data-cancel="${audit.id}">Cancel</button>
    </div>
    <div class="progress" style="margin:16px 0 8px"><div style="width:${p.percent ?? 0}%"></div></div>
    <div class="row small" style="justify-content:space-between">
      <span class="muted break">${p.message ?? ''}</span>
      <span class="nowrap"><strong>${p.percent ?? 0}%</strong></span>
    </div>
    ${counters.length ? html`<div class="small muted" style="margin-top:6px">${counters.join(' · ')}</div>` : ''}
  </div>`;
}

export async function renderProject(root, projectId) {
  setHtml(root, loading());
  let project = await api.getProject(projectId);
  let audits = await api.listProjectAudits(projectId);
  let timer = null;
  let disposed = false;

  const active = () => audits.find((a) => a.status === 'running' || a.status === 'queued');

  const draw = () => {
    const completed = audits.filter((a) => a.status === 'completed');
    const latest = completed[0];
    const s = latest?.summary;
    const running = active();
    const trendPoints = [...completed].reverse().map((a) => ({
      score: a.summary.score,
      date: a.finishedAt,
      errors: a.summary.errors,
      warnings: a.summary.warnings,
      pages: a.summary.pagesCrawled,
    }));
    const kw = project.settings.targetKeywords;

    setHtml(
      root,
      html`<div class="breadcrumb"><a href="#/">Projects</a> / ${project.name}</div>
      <div class="page-head">
        <div style="min-width:0">
          <h1>${project.name}</h1>
          <div class="sub">${externalLink(project.url)} ${project.description ? html` · ${project.description}` : ''}</div>
        </div>
        <div class="actions">
          <a class="btn" href="#/projects/${project.id}/edit">${raw(ICONS.edit)} Settings</a>
          <button class="btn btn-danger" data-delete-project>${raw(ICONS.trash)} Delete</button>
          <button class="btn btn-primary" data-run ${running ? raw('disabled') : ''}>${raw(ICONS.play)} Run audit</button>
        </div>
      </div>

      <div class="stack">
        ${running ? progressCard(running) : ''}

        ${latest
          ? html`<div class="grid grid-2">
              <div class="card card-pad">
                <div class="row" style="justify-content:space-between;margin-bottom:12px">
                  <h2>Latest audit</h2>
                  <span class="muted small">${fmt.date(latest.finishedAt)}</span>
                </div>
                <div class="hero">
                  ${scoreRing(s.score, { size: 116 })}
                  <div class="stack" style="gap:6px">
                    <div class="label">${s.scoreLabel}</div>
                    <div class="small muted">${fmt.num(s.pagesCrawled)} URLs crawled · ${fmt.num(s.issueTypes)} issue types</div>
                    <div class="row small" style="gap:14px">
                      <span><strong>${fmt.num(s.errors)}</strong> errors</span>
                      <span><strong>${fmt.num(s.warnings)}</strong> warnings</span>
                      <span><strong>${fmt.num(s.notices)}</strong> notices</span>
                    </div>
                    <div class="actions" style="margin-top:6px">
                      <a class="btn btn-sm btn-primary" href="#/audits/${latest.id}">View results</a>
                      ${downloadButtons(latest.id, { small: true })}
                    </div>
                  </div>
                </div>
              </div>
              <div class="card card-pad">
                <div class="row" style="justify-content:space-between;margin-bottom:8px">
                  <h2>Score over time</h2>
                  <span class="muted small">${completed.length} completed audit${completed.length === 1 ? '' : 's'}</span>
                </div>
                ${trendPoints.length > 1
                  ? html`<div data-trend>${trendChart(trendPoints)}</div>`
                  : html`<div class="empty small">Run another audit to see how the score changes over time.</div>`}
              </div>
            </div>`
          : !running
            ? html`<div class="card empty-state">
                <h2>No audits yet</h2>
                <p>Run the first audit to analyse ${project.url}.</p>
                <button class="btn btn-primary" data-run>${raw(ICONS.play)} Run first audit</button>
              </div>`
            : ''}

        <div class="card card-pad">
          <h2 style="margin-bottom:10px">Configuration</h2>
          <div class="row small" style="gap:20px">
            <span><span class="muted">Max pages</span> <strong>${project.settings.maxPages}</strong></span>
            <span><span class="muted">Max depth</span> <strong>${project.settings.maxDepth}</strong></span>
            <span><span class="muted">External links</span> <strong>${project.settings.checkExternalLinks ? 'checked' : 'skipped'}</strong></span>
            <span><span class="muted">robots.txt</span> <strong>${project.settings.respectRobots ? 'respected' : 'ignored'}</strong></span>
            <span><span class="muted">Target keywords</span> ${kw.length ? kw.map((k) => html`<span class="chip">${k}</span> `) : html`<strong>none</strong>`}</span>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Audit history</h2></div>
          <div data-history></div>
        </div>
      </div>`,
    );

    const trendEl = $('[data-trend]', root);
    if (trendEl) mountTrend(trendEl, trendPoints);

    dataTable($('[data-history]', root), {
      rows: audits,
      emptyText: 'No audits yet.',
      pageSize: 20,
      columns: [
        { key: 'createdAt', label: 'Started', render: (a) => fmt.date(a.startedAt || a.createdAt), sort: (a) => a.createdAt },
        { key: 'status', label: 'Status', render: (a) => html`${auditStatusChip(a)}${a.error && a.status !== 'cancelled' ? html`<div class="small muted" style="max-width:260px">${a.error}</div>` : ''}` },
        { key: 'score', label: 'Score', className: 'num', render: (a) => (a.summary ? html`<strong>${a.summary.score}</strong>` : '–'), sort: (a) => a.summary?.score },
        { key: 'pages', label: 'URLs', className: 'num', render: (a) => fmt.num(a.summary?.pagesCrawled), sort: (a) => a.summary?.pagesCrawled },
        { key: 'errors', label: 'Errors', className: 'num', render: (a) => fmt.num(a.summary?.errors), sort: (a) => a.summary?.errors },
        { key: 'warnings', label: 'Warnings', className: 'num', render: (a) => fmt.num(a.summary?.warnings), sort: (a) => a.summary?.warnings },
        { key: 'broken', label: 'Broken links', className: 'num', render: (a) => fmt.num(a.summary?.brokenLinks), sort: (a) => a.summary?.brokenLinks },
        { key: 'duration', label: 'Duration', render: (a) => fmt.duration(a.startedAt, a.finishedAt), sortable: false },
        {
          key: 'actions',
          label: '',
          sortable: false,
          render: (a) => html`<span class="actions" style="justify-content:flex-end;flex-wrap:nowrap">
            ${a.status === 'completed' ? html`<a class="btn btn-sm" href="#/audits/${a.id}">View</a>${downloadButtons(a.id, { small: true })}` : ''}
            ${['running', 'queued'].includes(a.status) ? html`<a class="btn btn-sm" href="#/audits/${a.id}">Progress</a>` : ''}
            ${!['running', 'queued'].includes(a.status) ? html`<button class="btn btn-sm btn-ghost btn-danger" data-delete-audit="${a.id}" title="Delete audit" aria-label="Delete audit">${raw(ICONS.trash)}</button>` : ''}
          </span>`,
        },
      ],
    });
  };

  const refresh = async () => {
    [project, audits] = await Promise.all([api.getProject(projectId), api.listProjectAudits(projectId)]);
    if (!disposed) draw();
  };

  const poll = () => {
    clearTimeout(timer);
    if (disposed || !active()) return;
    timer = setTimeout(async () => {
      try {
        const audit = await api.getAudit(active().id);
        if (audit.status === 'running' || audit.status === 'queued') {
          const card = $('[data-progress]', root);
          if (card) card.outerHTML = progressCard(audit).toString();
        } else {
          await refresh();
          if (audit.status === 'completed') toast(`Audit complete — score ${audit.summary.score}`);
          if (audit.status === 'failed') toast(`Audit failed: ${audit.error}`, { error: true });
        }
      } catch {}
      poll();
    }, 1500);
  };

  draw();
  poll();

  root.addEventListener('click', onClick);
  async function onClick(e) {
    const run = e.target.closest('[data-run]');
    const cancel = e.target.closest('[data-cancel]');
    const delAudit = e.target.closest('[data-delete-audit]');
    const delProject = e.target.closest('[data-delete-project]');
    try {
      if (run) {
        run.disabled = true;
        await api.startAudit(projectId);
        await refresh();
        toast('Audit started');
        poll();
      } else if (cancel) {
        cancel.disabled = true;
        await api.cancelAudit(cancel.dataset.cancel);
        toast('Cancelling audit…');
        setTimeout(refresh, 800);
      } else if (delAudit) {
        const ok = await confirmDialog({ title: 'Delete audit?', message: 'The audit and its results will be permanently removed.', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        await api.deleteAudit(delAudit.dataset.deleteAudit);
        await refresh();
        toast('Audit deleted');
      } else if (delProject) {
        const ok = await confirmDialog({
          title: `Delete “${project.name}”?`,
          message: `This permanently deletes the project and all ${audits.length} of its audits and reports.`,
          confirmLabel: 'Delete project',
          danger: true,
        });
        if (!ok) return;
        await api.deleteProject(projectId);
        toast('Project deleted');
        location.hash = '#/';
      }
    } catch (err) {
      toast(err.message, { error: true });
      if (run) run.disabled = false;
    }
  }

  return () => {
    disposed = true;
    clearTimeout(timer);
    root.removeEventListener('click', onClick);
  };
}
