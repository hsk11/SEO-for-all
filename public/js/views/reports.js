// All completed audits across projects, with report downloads.

import { api } from '../api.js';
import { html, setHtml, $, fmt, loading, downloadButtons, scoreTone } from '../ui.js';
import { dataTable } from '../table.js';

export async function renderReports(root) {
  setHtml(root, loading('Loading reports…'));
  const [audits, projects] = await Promise.all([api.listAudits({ status: 'completed' }), api.listProjects()]);

  setHtml(
    root,
    html`<div class="page-head">
      <div><h1>Reports</h1><div class="sub">Every completed audit. Open the interactive report or download it as PDF or Excel.</div></div>
    </div>
    <div class="card" data-table></div>`,
  );

  const toneChip = (score) => {
    const tone = scoreTone(score);
    return html`<span class="chip chip-${tone === 'neutral' ? '' : tone}"><strong>${score}</strong>&nbsp;/ 100</span>`;
  };

  dataTable($('[data-table]', root), {
    rows: audits,
    searchText: (a) => `${a.projectName} ${a.url}`,
    initialSort: { key: 'finishedAt', dir: -1 },
    emptyText: 'No completed audits yet. Create a project and run an audit to generate a report.',
    filters: projects.length > 1
      ? [{
          key: 'project',
          label: 'Project',
          options: [{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: p.name }))],
          test: (a, v) => a.projectId === v,
        }]
      : [],
    columns: [
      { key: 'projectName', label: 'Project', render: (a) => html`<a href="#/projects/${a.projectId}"><strong>${a.projectName}</strong></a><div class="small muted break">${a.url}</div>` },
      { key: 'finishedAt', label: 'Date', className: 'nowrap', render: (a) => fmt.date(a.finishedAt) },
      { key: 'score', label: 'Score', sort: (a) => a.summary.score, render: (a) => toneChip(a.summary.score) },
      { key: 'pages', label: 'URLs', className: 'num', sort: (a) => a.summary.pagesCrawled, render: (a) => fmt.num(a.summary.pagesCrawled) },
      { key: 'errors', label: 'Errors', className: 'num', sort: (a) => a.summary.errors, render: (a) => fmt.num(a.summary.errors) },
      { key: 'warnings', label: 'Warnings', className: 'num', sort: (a) => a.summary.warnings, render: (a) => fmt.num(a.summary.warnings) },
      { key: 'broken', label: 'Broken links', className: 'num', sort: (a) => a.summary.brokenLinks, render: (a) => fmt.num(a.summary.brokenLinks) },
      {
        key: 'actions',
        label: 'Report',
        sortable: false,
        render: (a) => html`<span class="actions" style="flex-wrap:nowrap"><a class="btn btn-sm btn-primary" href="#/audits/${a.id}">View</a>${downloadButtons(a.id, { small: true })}</span>`,
      },
    ],
  });
}
