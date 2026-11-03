// Audit results: tabbed report with overview, issues, pages, metadata,
// links, images, keywords and site structure.

import { api } from '../api.js';
import {
  html, raw, setHtml, $, $$, fmt, toast, loading, severityBadge, severityIcon, httpStatusChip,
  externalLink, downloadButtons, auditStatusChip, ICONS, openDrawer,
} from '../ui.js';
import { scoreRing, barList } from '../charts.js';
import { dataTable } from '../table.js';
import { openPageDetail } from './page-detail.js';
import { progressCard } from './project.js';

const TABS = [
  ['overview', 'Overview'],
  ['issues', 'Issues'],
  ['pages', 'Pages'],
  ['metadata', 'Metadata'],
  ['links', 'Links'],
  ['images', 'Images'],
  ['keywords', 'Keywords'],
  ['structure', 'Structure'],
];

const isBroken = (l) => l.checked && (l.error != null || l.status == null || l.status >= 400);

export async function renderAudit(root, auditId, initialTab) {
  setHtml(root, loading('Loading audit…'));
  let audit = await api.getAudit(auditId);
  let disposed = false;
  let timer = null;

  // ------------------------------------------------- in-progress / failed
  if (audit.status !== 'completed') {
    const drawPending = () => {
      setHtml(
        root,
        html`<div class="breadcrumb"><a href="#/">Projects</a> / <a href="#/projects/${audit.projectId}">${audit.projectName}</a> / Audit</div>
        <div class="page-head"><div><h1>Audit</h1><div class="sub">${audit.url}</div></div>${auditStatusChip(audit)}</div>
        ${['running', 'queued'].includes(audit.status)
          ? progressCard(audit)
          : html`<div class="card empty-state">
              <h2>Audit ${audit.status}</h2>
              <p>${audit.error || 'No results are available for this audit.'}</p>
              <a class="btn btn-primary" href="#/projects/${audit.projectId}">Back to project</a>
            </div>`}`,
      );
    };
    drawPending();
    const poll = () => {
      timer = setTimeout(async () => {
        if (disposed) return;
        try {
          audit = await api.getAudit(auditId);
        } catch {
          return poll();
        }
        if (audit.status === 'completed') {
          toast(`Audit complete — score ${audit.summary.score}`);
          const next = await renderAudit(root, auditId, initialTab);
          handle.inner = next;
          return;
        }
        drawPending();
        if (['running', 'queued'].includes(audit.status)) poll();
      }, 1500);
    };
    if (['running', 'queued'].includes(audit.status)) poll();
    const onClick = async (e) => {
      const btn = e.target.closest('[data-cancel]');
      if (!btn) return;
      btn.disabled = true;
      await api.cancelAudit(auditId).catch((err) => toast(err.message, { error: true }));
    };
    root.addEventListener('click', onClick);
    const handle = {
      inner: null,
      dispose() {
        disposed = true;
        clearTimeout(timer);
        root.removeEventListener('click', onClick);
        this.inner?.dispose?.();
      },
      handlesPath(path, apply) {
        return this.inner?.handlesPath?.(path, apply) ?? false;
      },
    };
    return handle;
  }

  // ------------------------------------------------------------ completed
  const result = await api.getResults(auditId);
  const s = result.summary;
  const brokenCount = result.links.filter(isBroken).length;
  const htmlPages = result.pages.filter((p) => p.analyzed && !p.isRedirect);
  const imageRows = htmlPages.flatMap((p) => p.images.map((img) => ({ ...img, page: p.url })));

  const counts = {
    issues: result.issues.length,
    pages: result.pages.length,
    links: brokenCount,
    images: s.imagesMissingAlt + s.brokenImages,
  };

  setHtml(
    root,
    html`<div class="breadcrumb"><a href="#/">Projects</a> / <a href="#/projects/${audit.projectId}">${audit.projectName}</a> / Audit ${fmt.shortDate(audit.finishedAt)}</div>
    <div class="page-head">
      <div style="min-width:0">
        <h1>Audit results</h1>
        <div class="sub">${externalLink(audit.url)} · ${fmt.date(audit.finishedAt)} · took ${fmt.duration(audit.startedAt, audit.finishedAt)}</div>
      </div>
      <div class="actions">${downloadButtons(audit.id)}<button class="btn btn-primary" data-rerun>${raw(ICONS.play)} Re-run audit</button></div>
    </div>
    ${s.reachedPageLimit
      ? html`<div class="card card-pad small" style="margin-bottom:16px;border-left:3px solid var(--warning)">
          ${severityIcon('warning')} The crawl stopped at the page limit (${result.site.limits.maxPages} URLs). Some pages were not analysed —
          <a href="#/projects/${audit.projectId}/edit">raise the limit</a> for a complete audit.</div>`
      : ''}
    <nav class="tabs" role="tablist">${TABS.map(
      ([key, label]) => html`<a class="tab" role="tab" href="#/audits/${audit.id}/${key}" data-tab="${key}">${label}${counts[key] ? html`<span class="count">${fmt.num(counts[key])}</span>` : ''}</a>`,
    )}</nav>
    <div data-panel></div>`,
  );

  let panel = $('[data-panel]', root);
  const renderers = { overview, issues, pages, metadata, links, images, keywords, structure };
  let pendingIssueFocus = null;

  const show = (tab) => {
    const key = renderers[tab] ? tab : 'overview';
    $$('.tab', root).forEach((t) => t.classList.toggle('active', t.dataset.tab === key));
    // Fresh panel element so listeners from the previous tab don't pile up.
    const fresh = panel.cloneNode(false);
    panel.replaceWith(fresh);
    panel = fresh;
    if (key === 'issues') {
      const focus = pendingIssueFocus;
      pendingIssueFocus = null;
      issues(focus);
    } else {
      renderers[key]();
    }
  };

  // ------------------------------------------------------------- overview
  function overview() {
    const probes = result.site.probes;
    const statusRows = Object.entries(result.structure.statusDistribution).map(([k, v]) => ({ label: k === 'error' ? 'Failed' : k === 'blocked' ? 'Blocked (robots)' : k.toUpperCase(), value: v }));
    const depthRows = Object.entries(result.structure.depthDistribution).map(([d, v]) => ({ label: `Depth ${d}`, value: v, tip: `${v} URL(s) ${d} click(s) from the start page` }));
    const check = (ok, label, detail) => html`<div class="row" style="flex-wrap:nowrap;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--border)">
      <span style="flex:none">${ok == null ? html`<span class="chip">n/a</span>` : ok ? html`<span class="chip chip-good">✓ Pass</span>` : html`<span class="chip chip-critical">✕ Fail</span>`}</span>
      <div><div>${label}</div>${detail ? html`<div class="small muted break">${detail}</div>` : ''}</div></div>`;

    setHtml(
      panel,
      html`<div class="stack">
        <div class="grid grid-2">
          <div class="card card-pad">
            <div class="hero">
              ${scoreRing(s.score, { size: 150, stroke: 12 })}
              <div class="stack" style="gap:8px">
                <div class="muted small">Overall SEO score</div>
                <div class="label">${s.scoreLabel}</div>
                <div class="row" style="gap:16px">
                  <span class="sev">${severityIcon('error')} <strong>${fmt.num(s.errors)}</strong> errors</span>
                  <span class="sev">${severityIcon('warning')} <strong>${fmt.num(s.warnings)}</strong> warnings</span>
                  <span class="sev">${severityIcon('notice')} <strong>${fmt.num(s.notices)}</strong> notices</span>
                </div>
                <div class="small muted">${s.issueTypes} issue types · ${s.passedChecks} checks passed</div>
              </div>
            </div>
          </div>
          <div class="card card-pad">
            <h2 style="margin-bottom:14px">Category scores</h2>
            ${barList(
              Object.values(s.categoryScores).map((c) => ({
                label: c.label,
                value: c.score,
                tip: `${c.label}: ${c.score}/100 — ${c.errors} error, ${c.warnings} warning, ${c.notices} notice issue types`,
              })),
              { max: 100 },
            )}
          </div>
        </div>

        <div class="grid grid-4">
          ${tile('URLs crawled', fmt.num(s.pagesCrawled), `${fmt.num(s.htmlPages)} HTML · ${fmt.num(s.indexablePages)} indexable`)}
          ${tile('Broken links', fmt.num(s.brokenLinks), `${fmt.num(s.linksChecked)} of ${fmt.num(s.linksFound)} links checked`, 'links')}
          ${tile('Images missing alt', fmt.num(s.imagesMissingAlt), `of ${fmt.num(s.imagesTotal)} images · ${fmt.num(s.brokenImages)} broken`, 'images')}
          ${tile('Avg. response time', `${fmt.num(s.avgResponseTimeMs)} ms`, `Avg. ${fmt.num(s.avgWordCount)} words per page`)}
          ${tile('Error pages', fmt.num(s.errorPages), '4xx, 5xx or failed requests', 'pages')}
          ${tile('Redirects', fmt.num(s.redirects), 'Internal URLs that redirect', 'pages')}
          ${tile('Orphan pages', fmt.num(result.structure.orphanPages.length), 'In sitemap, not linked', 'structure')}
          ${tile('Blocked by robots', fmt.num(s.blockedPages), 'Not crawled', 'pages')}
        </div>

        <div class="grid grid-2">
          <div class="card">
            <div class="card-head"><h2>Top issues</h2><a class="small" href="#/audits/${audit.id}/issues">All ${result.issues.length} issues →</a></div>
            ${result.issues.length
              ? html`<div class="table-wrap"><table class="table"><tbody>${result.issues.slice(0, 8).map(
                  (i) => html`<tr class="clickable" data-goto-issue="${i.id}">
                    <td style="width:100px">${severityBadge(i.severity)}</td>
                    <td>${i.title}<div class="small muted">${i.categoryLabel}</div></td>
                    <td class="num nowrap"><strong>${fmt.num(i.affectedCount)}</strong> <span class="muted small">${i.scope === 'site' ? 'site' : i.affectedCount === 1 ? 'URL' : 'URLs'}</span></td>
                  </tr>`,
                )}</tbody></table></div>`
              : html`<div class="empty">No issues found — great job!</div>`}
          </div>
          <div class="card">
            <div class="card-head"><h2>Site-wide checks</h2></div>
            <div class="card-body" style="padding-top:4px">
              ${check(probes.https.usesHttps, 'Served over HTTPS')}
              ${check(probes.https.httpRedirectsToHttps, 'HTTP redirects to HTTPS', probes.https.httpStatus ? `http:// responded ${probes.https.httpStatus}` : null)}
              ${check(probes.wwwCanonicalization?.consolidated ?? null, 'www / non-www consolidated', probes.wwwCanonicalization ? `${probes.wwwCanonicalization.variant} → ${probes.wwwCanonicalization.status ?? probes.wwwCanonicalization.error}` : 'Not applicable for this host')}
              ${check(result.site.robots.found, 'robots.txt present', result.site.robots.found ? `${result.site.robots.sitemaps.length} sitemap reference(s)` : `HTTP ${result.site.robots.status ?? result.site.robots.error}`)}
              ${check(result.site.sitemap.found, 'XML sitemap present', result.site.sitemap.found ? `${fmt.num(result.site.sitemap.urlCount)} URLs in ${result.site.sitemap.sitemaps.length} sitemap(s)` : result.site.sitemap.errors.map((e) => e.error || `HTTP ${e.status}`).join(', '))}
              ${check(probes.notFoundHandling.returns404, 'Missing pages return 404', `Random URL → ${probes.notFoundHandling.status ?? probes.notFoundHandling.error}`)}
              ${check(probes.favicon.defaultPathOk || Boolean(result.pages.find((p) => p.depth === 0)?.favicon), 'Favicon available')}
            </div>
          </div>
        </div>

        <div class="grid grid-2">
          <div class="card card-pad"><h2 style="margin-bottom:14px">Response codes</h2>${barList(statusRows)}</div>
          <div class="card card-pad"><h2 style="margin-bottom:14px">Pages by crawl depth</h2>${barList(depthRows)}</div>
        </div>
      </div>`,
    );
  }

  function tile(label, value, foot, tab) {
    return html`<div class="card tile">
      <div class="tile-label">${label}</div>
      <div class="tile-value">${value}</div>
      <div class="tile-foot">${foot}${tab ? html` · <a href="#/audits/${audit.id}/${tab}">view</a>` : ''}</div>
    </div>`;
  }

  // --------------------------------------------------------------- issues
  function issues(focusId) {
    const categories = [...new Set(result.issues.map((i) => i.categoryLabel))];
    setHtml(
      panel,
      html`<div class="card">
        <div class="table-toolbar">
          <select class="input" data-f="severity" aria-label="Severity">
            <option value="">All severities</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="notice">Notices</option>
          </select>
          <select class="input" data-f="category" aria-label="Category">
            <option value="">All categories</option>${categories.map((c) => html`<option>${c}</option>`)}
          </select>
          <input class="input search" type="search" placeholder="Search issues or URLs…" data-f="q" aria-label="Search issues">
          <span class="spacer"></span><span class="small muted" data-f-count></span>
        </div>
        <div data-issue-list></div>
      </div>
      <details class="card" style="margin-top:16px">
        <summary class="card-head" style="cursor:pointer;border-bottom:0"><h2>Passed checks (${result.passed.length})</h2></summary>
        <div class="table-wrap"><table class="table"><tbody>${result.passed.map(
          (p) => html`<tr><td style="width:90px"><span class="chip chip-good">✓ Pass</span></td><td>${p.title}</td><td class="muted small">${p.categoryLabel}</td><td class="num small muted">${p.applicable} checked</td></tr>`,
        )}</tbody></table></div>
      </details>`,
    );

    const list = $('[data-issue-list]', panel);
    const filters = { severity: '', category: '', q: '' };

    const draw = () => {
      const q = filters.q.toLowerCase();
      const shown = result.issues.filter(
        (i) =>
          (!filters.severity || i.severity === filters.severity) &&
          (!filters.category || i.categoryLabel === filters.category) &&
          (!q || i.title.toLowerCase().includes(q) || i.affected.some((a) => a.url.toLowerCase().includes(q))),
      );
      $('[data-f-count]', panel).textContent = `${shown.length} of ${result.issues.length} issue types`;
      setHtml(
        list,
        shown.length
          ? shown.map(
              (i) => html`<details class="issue" data-issue="${i.id}" ${i.id === focusId ? raw('open') : ''}>
                <summary>
                  <span>${severityBadge(i.severity)}</span>
                  <span><strong>${i.title}</strong></span>
                  <span class="cat small muted">${i.categoryLabel}</span>
                  <span class="row nowrap" style="gap:8px"><span class="chip">${fmt.num(i.affectedCount)} ${i.scope === 'site' ? 'site' : `of ${fmt.num(i.applicable)}`}</span><span class="chev">${raw(ICONS.chevron)}</span></span>
                </summary>
                <div class="issue-body">
                  <p>${i.description}</p>
                  <div class="fix"><strong>How to fix:</strong> ${i.recommendation}</div>
                  <div class="affected-list"><table class="table"><thead><tr><th>${i.scope === 'site' ? 'Site' : 'Affected URL'}</th><th>Details</th></tr></thead><tbody>
                    ${i.affected
                      .filter((a) => !q || i.title.toLowerCase().includes(q) || a.url.toLowerCase().includes(q))
                      .slice(0, 300)
                      .map((a) => html`<tr class="clickable" data-page-url="${a.url}"><td class="url">${externalLink(a.url, i.scope === 'site' ? a.url : fmt.path(a.url))}</td><td class="small break">${a.detail}</td></tr>`)}
                  </tbody></table></div>
                  ${i.affectedCount > 300 ? html`<div class="small muted" style="margin-top:8px">Showing 300 of ${fmt.num(i.affectedCount)}. Download the Excel report for the complete list.</div>` : ''}
                </div>
              </details>`,
            )
          : html`<div class="empty">${result.issues.length ? 'No issues match the filters.' : 'No issues found.'}</div>`,
      );
    };
    panel.addEventListener('input', (e) => {
      const key = e.target.dataset?.f;
      if (key) {
        filters[key] = e.target.value;
        draw();
      }
    });
    draw();
    if (focusId) $(`[data-issue="${CSS.escape(focusId)}"]`, panel)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  // ---------------------------------------------------------------- pages
  function pages() {
    setHtml(panel, html`<div class="card" data-table></div>`);
    const typeOf = (p) => (p.blockedByRobots ? 'blocked' : p.isRedirect ? 'redirect' : p.status == null || p.status >= 400 ? 'error' : p.analyzed ? 'html' : 'other');
    dataTable($('[data-table]', panel), {
      rows: result.pages,
      searchText: (p) => `${p.url} ${p.title ?? ''}`,
      onRowClick: (p) => openPageDetail(p, result),
      initialSort: { key: 'depth', dir: 1 },
      filters: [
        {
          key: 'type',
          label: 'Type',
          options: [
            { value: '', label: 'All URLs' },
            { value: 'html', label: 'HTML pages (200)' },
            { value: 'issues', label: 'Pages with errors' },
            { value: 'noindex', label: 'Non-indexable' },
            { value: 'error', label: '4xx / 5xx / failed' },
            { value: 'redirect', label: 'Redirects' },
            { value: 'blocked', label: 'Blocked by robots.txt' },
          ],
          test: (p, v) =>
            v === 'issues' ? p.issues?.some((i) => i.severity === 'error') : v === 'noindex' ? p.noindex : typeOf(p) === v,
        },
      ],
      columns: [
        { key: 'url', label: 'URL', className: 'url', render: (p) => html`<div>${fmt.path(p.url)}</div>${p.title ? html`<div class="small muted">${p.title}</div>` : ''}` },
        { key: 'status', label: 'Status', render: (p) => httpStatusChip(p.status, p.error) },
        { key: 'depth', label: 'Depth', className: 'num' },
        { key: 'wordCount', label: 'Words', className: 'num', render: (p) => fmt.num(p.wordCount) },
        { key: 'inlinks', label: 'Inlinks', className: 'num' },
        { key: 'responseTimeMs', label: 'Response', className: 'num nowrap', render: (p) => `${fmt.num(p.responseTimeMs)} ms` },
        {
          key: 'issues',
          label: 'Issues',
          className: 'nowrap',
          sort: (p) => (p.issues ?? []).reduce((s, i) => s + ({ error: 100, warning: 10, notice: 1 })[i.severity], 0),
          render: (p) => {
            const c = { error: 0, warning: 0, notice: 0 };
            (p.issues ?? []).forEach((i) => c[i.severity]++);
            return html`<span class="row" style="gap:8px;flex-wrap:nowrap">${['error', 'warning', 'notice'].map((k) => (c[k] ? html`<span class="sev" title="${c[k]} ${k}(s)">${severityIcon(k)}${c[k]}</span>` : ''))}${!p.issues?.length ? html`<span class="muted">–</span>` : ''}</span>`;
          },
        },
      ],
    });
  }

  // ------------------------------------------------------------- metadata
  function metadata() {
    setHtml(panel, html`<div class="card" data-table></div>`);
    const lenChip = (len, min, max) =>
      !len ? html`<span class="chip chip-critical">missing</span>` : len > max || len < min ? html`<span class="chip chip-warning">${len}</span>` : html`<span class="chip chip-good">${len}</span>`;
    const has = (p, id) => p.issues?.some((i) => i.id === id);
    dataTable($('[data-table]', panel), {
      rows: htmlPages,
      searchText: (p) => `${p.url} ${p.title ?? ''} ${p.metaDescription ?? ''} ${p.h1.join(' ')}`,
      onRowClick: (p) => openPageDetail(p, result),
      filters: [
        {
          key: 'problem',
          label: 'Problem',
          options: [
            { value: '', label: 'All pages' },
            { value: 'title-missing', label: 'Title missing' },
            { value: 'title-too-long', label: 'Title too long' },
            { value: 'title-too-short', label: 'Title too short' },
            { value: 'title-duplicate', label: 'Duplicate title' },
            { value: 'description-missing', label: 'Description missing' },
            { value: 'description-too-long', label: 'Description too long' },
            { value: 'description-too-short', label: 'Description too short' },
            { value: 'description-duplicate', label: 'Duplicate description' },
            { value: 'h1-missing', label: 'H1 missing' },
            { value: 'h1-multiple', label: 'Multiple H1' },
            { value: 'canonical-missing', label: 'Canonical missing' },
            { value: 'og-missing', label: 'Open Graph incomplete' },
          ],
          test: has,
        },
      ],
      columns: [
        { key: 'url', label: 'URL', className: 'url', render: (p) => fmt.path(p.url) },
        { key: 'title', label: 'Title', render: (p) => html`<div>${p.title || html`<span class="muted">—</span>`}</div>` },
        { key: 'titleLength', label: 'Len', className: 'num', render: (p) => lenChip(p.titleLength, 30, 60) },
        { key: 'metaDescription', label: 'Meta description', render: (p) => html`<div class="small" style="max-width:340px">${p.metaDescription || html`<span class="muted">—</span>`}</div>` },
        { key: 'metaDescriptionLength', label: 'Len', className: 'num', render: (p) => lenChip(p.metaDescriptionLength, 70, 160) },
        { key: 'h1', label: 'H1', sort: (p) => p.h1[0] ?? '', render: (p) => html`<div class="small">${p.h1[0] || html`<span class="chip chip-warning">missing</span>`}${p.h1.length > 1 ? html` <span class="chip">+${p.h1.length - 1}</span>` : ''}</div>` },
        { key: 'canonical', label: 'Canonical', render: (p) => (!p.canonical ? html`<span class="muted small">none</span>` : p.canonical === p.url || p.canonical === p.finalUrl ? html`<span class="chip chip-good">self</span>` : html`<span class="small break">${p.canonical}</span>`) },
        { key: 'noindex', label: 'Index', render: (p) => (p.noindex ? html`<span class="chip">noindex</span>` : html`<span class="chip chip-good">index</span>`) },
      ],
    });
  }

  // ---------------------------------------------------------------- links
  function links() {
    setHtml(panel, html`<div class="card" data-table></div>`);
    const outcome = (l) => (!l.checked ? 'unchecked' : isBroken(l) ? 'broken' : l.redirectChain.length ? 'redirect' : 'ok');
    dataTable($('[data-table]', panel), {
      rows: result.links,
      searchText: (l) => l.url,
      onRowClick: (l) => openLinkSources(l),
      filters: [
        {
          key: 'result',
          label: 'Result',
          initial: brokenCount ? 'broken' : '',
          options: [
            { value: '', label: 'All links' },
            { value: 'broken', label: 'Broken' },
            { value: 'redirect', label: 'Redirects' },
            { value: 'ok', label: 'OK' },
            { value: 'unchecked', label: 'Not checked' },
          ],
          test: (l, v) => outcome(l) === v,
        },
        {
          key: 'type',
          label: 'Type',
          options: [
            { value: '', label: 'Internal & external' },
            { value: 'internal', label: 'Internal' },
            { value: 'external', label: 'External' },
            { value: 'image', label: 'Images' },
          ],
          test: (l, v) => (v === 'image' ? l.kind === 'image' : l.kind === 'link' && (v === 'internal') === l.internal),
        },
      ],
      columns: [
        { key: 'url', label: 'URL', className: 'url', render: (l) => html`${externalLink(l.url)}${l.redirectChain.length && !isBroken(l) ? html`<div class="small muted break">→ ${l.finalUrl}</div>` : ''}${l.error ? html`<div class="small muted">${l.error}</div>` : ''}` },
        { key: 'status', label: 'Status', render: (l) => (l.checked ? httpStatusChip(l.status, l.error) : html`<span class="chip">not checked</span>`) },
        { key: 'internal', label: 'Type', render: (l) => `${l.internal ? 'Internal' : 'External'}${l.kind === 'image' ? ' image' : ''}`, sort: (l) => `${l.internal}${l.kind}` },
        { key: 'sources', label: 'Found on', className: 'num nowrap', sort: (l) => new Set(l.sources.map((x) => x.page)).size, render: (l) => html`${new Set(l.sources.map((x) => x.page)).size} page(s)` },
      ],
      emptyText: 'No links found.',
    });
  }

  function openLinkSources(link) {
    const unique = [...new Map(link.sources.map((s) => [s.page + s.anchor, s])).values()];
    openDrawer(html`<div class="drawer-head"><div style="min-width:0">
        <div class="row" style="gap:8px;margin-bottom:4px">${link.checked ? httpStatusChip(link.status, link.error) : html`<span class="chip">not checked</span>`}<span class="chip">${link.internal ? 'Internal' : 'External'} ${link.kind}</span></div>
        <h2 class="break">${link.url}</h2>${link.error ? html`<div class="small muted">${link.error}</div>` : ''}
      </div><button class="btn btn-ghost" data-close aria-label="Close">${raw(ICONS.close)}</button></div>
      <div class="drawer-body">
        ${link.redirectChain.length ? html`<div class="card card-pad"><h3 style="margin-bottom:8px">Redirect chain</h3>${link.redirectChain.map((h) => html`<div class="small break">${h.status} ${h.url}</div>`)}<div class="small break"><strong>${link.status ?? ''}</strong> ${link.finalUrl}</div></div>` : ''}
        <div class="card"><div class="card-head"><h3>Found on ${unique.length} location(s)</h3></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Page</th><th>${link.kind === 'image' ? 'Alt text' : 'Anchor text'}</th><th></th></tr></thead><tbody>
        ${unique.map((s) => html`<tr><td class="url">${externalLink(s.page, fmt.path(s.page))}</td><td>${s.anchor || html`<span class="muted">(none)</span>`}</td><td>${s.nofollow ? html`<span class="chip">nofollow</span>` : ''}</td></tr>`)}
        </tbody></table></div></div>
      </div>`);
  }

  // --------------------------------------------------------------- images
  function images() {
    const brokenImages = new Set(result.links.filter((l) => l.kind === 'image' && isBroken(l)).map((l) => l.url));
    const altStatus = (i) => (!i.hasAltAttribute ? 'missing' : i.alt ? 'ok' : 'empty');
    setHtml(
      panel,
      html`<div class="grid grid-4" style="margin-bottom:16px">
        ${tile('Images found', fmt.num(imageRows.length), `on ${fmt.num(htmlPages.filter((p) => p.imageCount).length)} pages`)}
        ${tile('Missing alt attribute', fmt.num(imageRows.filter((i) => altStatus(i) === 'missing').length), 'Should be described')}
        ${tile('Empty alt (decorative)', fmt.num(imageRows.filter((i) => altStatus(i) === 'empty').length), 'OK if purely decorative')}
        ${tile('Broken images', fmt.num(brokenImages.size), 'Fail to load')}
      </div>
      <div class="card" data-table></div>`,
    );
    dataTable($('[data-table]', panel), {
      rows: imageRows,
      searchText: (i) => `${i.src} ${i.alt ?? ''} ${i.page}`,
      filters: [
        {
          key: 'alt',
          label: 'Alt text',
          initial: imageRows.some((i) => altStatus(i) === 'missing') ? 'missing' : '',
          options: [
            { value: '', label: 'All images' },
            { value: 'missing', label: 'Missing alt' },
            { value: 'empty', label: 'Empty alt' },
            { value: 'ok', label: 'Has alt text' },
            { value: 'broken', label: 'Broken' },
          ],
          test: (i, v) => (v === 'broken' ? brokenImages.has(i.src) : altStatus(i) === v),
        },
      ],
      columns: [
        { key: 'src', label: 'Image', className: 'url', render: (i) => html`${externalLink(i.src, i.src.split('/').pop() || i.src)}${brokenImages.has(i.src) ? html` <span class="chip chip-critical">broken</span>` : ''}` },
        { key: 'alt', label: 'Alt text', render: (i) => (altStatus(i) === 'missing' ? html`<span class="chip chip-warning">missing</span>` : altStatus(i) === 'empty' ? html`<span class="chip">empty</span>` : i.alt) },
        { key: 'size', label: 'Dimensions', sortable: false, render: (i) => (i.width && i.height ? `${i.width}×${i.height}` : html`<span class="muted small">not set</span>`) },
        { key: 'page', label: 'Page', className: 'url', render: (i) => externalLink(i.page, fmt.path(i.page)) },
      ],
      emptyText: 'No images found on the crawled pages.',
    });
  }

  // ------------------------------------------------------------- keywords
  function keywords() {
    const k = result.keywords;
    const yes = (n) => (n ? html`<span class="chip chip-good">${n}</span>` : html`<span class="chip chip-warning">0</span>`);
    const termBars = (list) =>
      list.length
        ? barList(list.slice(0, 15).map((t) => ({ label: t.term, value: t.density, display: `${t.density}%`, tip: `"${t.term}": ${t.count} occurrences on ${t.pages} page(s), ${t.density}% density` })))
        : html`<div class="muted small">Not enough content.</div>`;
    setHtml(
      panel,
      html`<div class="stack">
        <div class="card">
          <div class="card-head"><h2>Target keywords</h2><a class="small" href="#/projects/${audit.projectId}/edit">Edit keywords</a></div>
          ${k.targets.length
            ? html`<div class="table-wrap"><table class="table">
                <thead><tr><th>Keyword</th><th class="num">Occurrences</th><th class="num">Density</th><th class="num">Pages using</th><th class="num">In titles</th><th class="num">In H1</th><th class="num">In descriptions</th><th class="num">In URLs</th></tr></thead>
                <tbody>${k.targets.map(
                  (t) => html`<tr><td><strong>${t.keyword}</strong></td><td class="num">${fmt.num(t.count)}</td>
                    <td class="num">${t.density > 3 ? html`<span class="chip chip-warning" title="Possible keyword stuffing">${t.density}%</span>` : `${t.density}%`}</td>
                    <td class="num">${t.pages}</td><td class="num">${yes(t.inTitle)}</td><td class="num">${yes(t.inH1)}</td><td class="num">${yes(t.inDescription)}</td><td class="num">${yes(t.inUrl)}</td></tr>`,
                )}</tbody></table></div>`
            : html`<div class="empty">No target keywords set. <a href="#/projects/${audit.projectId}/edit">Add keywords</a> to check their density and placement.</div>`}
        </div>
        <div class="small muted">Density = occurrences × words in phrase ÷ ${fmt.num(k.totalWords)} total words of visible text. Stop words are excluded. A healthy density for a focus keyword is usually 0.5–2.5%.</div>
        <div class="grid grid-3">
          <div class="card card-pad"><h2 style="margin-bottom:14px">Top keywords</h2>${termBars(k.top)}</div>
          <div class="card card-pad"><h2 style="margin-bottom:14px">2-word phrases</h2>${termBars(k.bigrams)}</div>
          <div class="card card-pad"><h2 style="margin-bottom:14px">3-word phrases</h2>${termBars(k.trigrams)}</div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Keyword density by page</h2>
            <select class="input" data-kw-page aria-label="Page" style="max-width:420px">${htmlPages.map((p) => html`<option value="${p.url}">${fmt.path(p.url)}</option>`)}</select>
          </div>
          <div class="card-body" data-kw-body></div>
        </div>
      </div>`,
    );
    const drawPage = (url) => {
      const p = htmlPages.find((x) => x.url === url);
      if (!p) return setHtml($('[data-kw-body]', panel), html`<div class="muted">No HTML pages.</div>`);
      const pk = p.keywords;
      setHtml(
        $('[data-kw-body]', panel),
        html`<div class="small muted" style="margin-bottom:12px">${fmt.num(pk.totalWords)} words · ${fmt.num(pk.uniqueWords)} unique · <a href="#" data-open-page="${p.url}">open page details</a></div>
        ${pk.targets.length
          ? html`<div class="table-wrap" style="margin-bottom:16px"><table class="table"><thead><tr><th>Target keyword</th><th class="num">Count</th><th class="num">Density</th><th>Title</th><th>Description</th><th>H1</th><th>Headings</th><th>URL</th><th>First 100 words</th><th>Image alt</th></tr></thead>
              <tbody>${pk.targets.map((t) => html`<tr><td><strong>${t.keyword}</strong></td><td class="num">${t.count}</td><td class="num">${t.density}%</td>${['inTitle', 'inDescription', 'inH1', 'inHeadings', 'inUrl', 'inFirst100Words', 'inImageAlt'].map((f) => html`<td>${t[f] ? html`<span class="chip chip-good">✓</span>` : html`<span class="chip">✕</span>`}</td>`)}</tr>`)}</tbody></table></div>`
          : ''}
        <div class="grid grid-3">
          <div><h3 style="margin-bottom:10px">Keywords</h3>${termBars(pk.top)}</div>
          <div><h3 style="margin-bottom:10px">2-word phrases</h3>${termBars(pk.bigrams)}</div>
          <div><h3 style="margin-bottom:10px">3-word phrases</h3>${termBars(pk.trigrams)}</div>
        </div>`,
      );
    };
    $('[data-kw-page]', panel)?.addEventListener('change', (e) => drawPage(e.target.value));
    drawPage(htmlPages[0]?.url);
  }

  // ------------------------------------------------------------ structure
  function structure() {
    const st = result.structure;
    const treeNode = (node, depth = 0) => {
      const label = depth === 0 ? node.name : `/${node.name}`;
      const meta = html`<span class="seg">${label}</span>${node.page ? html` ${httpStatusChip(node.page.status)}` : ''}<span class="muted small">${node.total} URL${node.total === 1 ? '' : 's'}</span>${node.page?.title ? html`<span class="title small">${node.page.title}</span>` : ''}`;
      if (!node.children.length) return html`<div class="leaf">${meta}</div>`;
      return html`<details ${depth < 2 ? raw('open') : ''}><summary>${meta}</summary>${node.children.map((c) => treeNode(c, depth + 1))}</details>`;
    };
    const urlList = (urls, empty) =>
      urls.length
        ? html`<div class="table-wrap" style="max-height:300px;overflow:auto"><table class="table"><tbody>${urls.slice(0, 500).map((u) => html`<tr><td class="url">${externalLink(u)}</td></tr>`)}</tbody></table></div>`
        : html`<div class="empty small">${empty}</div>`;

    setHtml(
      panel,
      html`<div class="stack">
        <div class="grid grid-2">
          <div class="card card-pad"><h2 style="margin-bottom:14px">Pages by crawl depth</h2>
            ${barList(Object.entries(st.depthDistribution).map(([d, v]) => ({ label: d === '0' ? 'Start page' : `${d} click${d === '1' ? '' : 's'}`, value: v, tip: `${v} URL(s) at depth ${d}` })))}
            <div class="small muted" style="margin-top:12px">Important pages should be reachable within 3 clicks of the homepage.</div>
          </div>
          <div class="card">
            <div class="card-head"><h2>Most linked pages</h2><span class="small muted">internal inlinks</span></div>
            <div class="table-wrap" style="max-height:300px;overflow:auto"><table class="table"><tbody>${st.topLinkedPages.map((p) => html`<tr><td class="url">${fmt.path(p.url)}${p.title ? html`<div class="small muted">${p.title}</div>` : ''}</td><td class="num">${p.inlinks}</td></tr>`)}</tbody></table></div>
          </div>
        </div>
        <div class="card"><div class="card-head"><h2>URL structure</h2><span class="small muted">${fmt.num(result.pages.filter((p) => !p.isRedirect).length)} URLs</span></div>
          <div class="card-body tree">${treeNode(st.tree)}</div></div>
        <div class="grid grid-2">
          <div class="card"><div class="card-head"><h2>Orphan pages</h2><span class="chip">${st.orphanPages.length}</span></div>
            <div class="card-body small muted" style="padding-bottom:0">Listed in the sitemap but not reachable by following links.</div>${urlList(st.orphanPages, result.site.sitemap.found ? 'No orphan pages found.' : 'No sitemap found, so orphan pages cannot be detected.')}</div>
          <div class="card"><div class="card-head"><h2>Missing from sitemap</h2><span class="chip">${st.notInSitemap.length}</span></div>
            <div class="card-body small muted" style="padding-bottom:0">Indexable pages that are not listed in the XML sitemap.</div>${urlList(st.notInSitemap, result.site.sitemap.found ? 'Every indexable page is in the sitemap.' : 'No sitemap found.')}</div>
        </div>
        <div class="grid grid-2">
          <div class="card"><div class="card-head"><h2>robots.txt</h2>${result.site.robots.found ? html`<span class="chip chip-good">found</span>` : html`<span class="chip chip-critical">not found</span>`}</div>
            <div class="card-body">${result.site.robots.content ? html`<pre class="code">${result.site.robots.content}</pre>` : html`<div class="muted small">No robots.txt (${result.site.robots.status ? `HTTP ${result.site.robots.status}` : result.site.robots.error}).</div>`}</div></div>
          <div class="card"><div class="card-head"><h2>XML sitemaps</h2>${result.site.sitemap.found ? html`<span class="chip chip-good">${fmt.num(result.site.sitemap.urlCount)} URLs</span>` : html`<span class="chip chip-critical">not found</span>`}</div>
            <div class="card-body small">
              ${result.site.sitemap.sitemaps.map((sm) => html`<div style="padding:4px 0">${externalLink(sm.url)} <span class="muted">— ${sm.urlCount} URLs${sm.childCount ? `, ${sm.childCount} child sitemaps` : ''}</span></div>`)}
              ${result.site.sitemap.errors.map((e) => html`<div style="padding:4px 0"><span class="chip chip-critical">error</span> <span class="break">${e.url}</span> <span class="muted">— ${e.error || `HTTP ${e.status}`}</span></div>`)}
            </div></div>
        </div>
      </div>`,
    );
  }

  // --------------------------------------------------------------- events
  const onClick = async (e) => {
    const issueRow = e.target.closest('[data-goto-issue]');
    if (issueRow) {
      pendingIssueFocus = issueRow.dataset.gotoIssue;
      location.hash = `#/audits/${audit.id}/issues`;
      return;
    }
    const openPage = e.target.closest('[data-open-page]');
    if (openPage) {
      e.preventDefault();
      const page = result.pages.find((p) => p.url === openPage.dataset.openPage);
      if (page) openPageDetail(page, result);
      return;
    }
    const pageRow = e.target.closest('tr[data-page-url]');
    if (pageRow && !e.target.closest('a')) {
      const page = result.pages.find((p) => p.url === pageRow.dataset.pageUrl);
      if (page) openPageDetail(page, result);
      return;
    }
    if (e.target.closest('[data-rerun]')) {
      try {
        const next = await api.startAudit(audit.projectId);
        toast('Audit started');
        location.hash = `#/audits/${next.id}`;
      } catch (err) {
        toast(err.message, { error: true });
      }
    }
  };
  root.addEventListener('click', onClick);

  show(initialTab);

  const pathPattern = new RegExp(`^/audits/${auditId}(?:/(\\w+))?$`);
  return {
    dispose() {
      root.removeEventListener('click', onClick);
    },
    handlesPath(path, apply) {
      const m = pathPattern.exec(path);
      if (m && apply) show(m[1]);
      return Boolean(m);
    },
  };
}
