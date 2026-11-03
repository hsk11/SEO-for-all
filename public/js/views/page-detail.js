// Slide-over drawer with everything we know about a single URL.

import { html, raw, fmt, openDrawer, severityBadge, httpStatusChip, externalLink, ICONS } from '../ui.js';

const yesNo = (v) => (v ? '✓ Yes' : '✕ No');

function lengthNote(len, min, max) {
  if (!len) return html`<span class="chip chip-critical">missing</span>`;
  if (len > max) return html`<span class="chip chip-warning">${len} chars · too long</span>`;
  if (len < min) return html`<span class="chip chip-warning">${len} chars · too short</span>`;
  return html`<span class="chip chip-good">${len} chars</span>`;
}

function section(title, body) {
  return html`<div class="card"><div class="card-head"><h3>${title}</h3></div><div class="card-body">${body}</div></div>`;
}

function smallTable(headers, rows) {
  if (!rows.length) return html`<div class="muted small">None.</div>`;
  return html`<div class="table-wrap" style="max-height:340px;overflow:auto"><table class="table">
    <thead><tr>${headers.map((h) => html`<th>${h}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody>
  </table></div>`;
}

export function openPageDetail(page, result) {
  const sources = result.links.find((l) => l.url === page.url)?.sources.filter((s) => s.kind === 'link') ?? [];
  const brokenTargets = new Set(result.links.filter((l) => l.checked && (l.error || l.status == null || l.status >= 400)).map((l) => l.url));

  const header = html`<div class="drawer-head">
    <div style="min-width:0">
      <div class="row" style="gap:8px;margin-bottom:4px">${httpStatusChip(page.status, page.error)}
        ${page.isRedirect ? html`<span class="chip chip-warning">Redirect</span>` : ''}
        ${page.noindex ? html`<span class="chip">noindex</span>` : ''}
        ${page.blockedByRobots ? html`<span class="chip">Blocked by robots.txt</span>` : ''}
      </div>
      <h2 class="break">${page.title || fmt.path(page.url)}</h2>
      <div class="small">${externalLink(page.url)} ${raw(ICONS.external)}</div>
    </div>
    <button class="btn btn-ghost" data-close aria-label="Close">${raw(ICONS.close)}</button>
  </div>`;

  const overview = html`<div class="kv">
    <div>Status</div><div>${page.status ?? '–'} ${page.error ? html`<span class="muted">(${page.error})</span>` : ''}</div>
    <div>Crawl depth</div><div>${page.depth}</div>
    <div>Response time</div><div>${fmt.num(page.responseTimeMs)} ms</div>
    <div>Size</div><div>${fmt.bytes(page.sizeBytes)}</div>
    <div>Content type</div><div>${page.contentType || '–'}</div>
    <div>Linked from</div><div>${page.inlinks} page(s)</div>
    <div>In sitemap</div><div>${yesNo(page.inSitemap)}</div>
    ${page.isRedirect ? html`<div>Redirects to</div><div>${externalLink(page.redirectTarget)}</div>
      <div>Chain</div><div>${page.redirectChain.map((h) => html`<div class="small">${h.status} → ${h.url}</div>`)}</div>` : ''}
    ${page.analyzed
      ? html`<div>Words</div><div>${fmt.num(page.wordCount)} (text/HTML ${page.textHtmlRatio}%)</div>
        <div>Links</div><div>${page.internalLinkCount} internal · ${page.externalLinkCount} external · ${page.nofollowLinkCount} nofollow</div>
        <div>Images</div><div>${page.imageCount} (${page.imagesMissingAlt} missing alt)</div>
        <div>Indexable</div><div>${page.noindex ? `✕ No — ${page.metaRobots || page.xRobotsTag}` : '✓ Yes'}</div>
        <div>Canonical</div><div>${page.canonical ? externalLink(page.canonical) : html`<span class="muted">none</span>`}</div>
        <div>Language</div><div>${page.lang || html`<span class="muted">not set</span>`}</div>
        <div>Viewport</div><div>${page.viewport || html`<span class="muted">not set</span>`}</div>
        <div>Charset</div><div>${page.charset || html`<span class="muted">not set</span>`}</div>
        <div>Structured data</div><div>${page.structuredData.types.length ? page.structuredData.types.join(', ') : html`<span class="muted">none</span>`}${page.structuredData.invalidJsonLd ? html` <span class="chip chip-critical">${page.structuredData.invalidJsonLd} invalid JSON-LD</span>` : ''}</div>
        <div>hreflang</div><div>${page.hreflang.length ? page.hreflang.map((h) => `${h.lang}`).join(', ') : html`<span class="muted">none</span>`}</div>`
      : ''}
  </div>`;

  const issues = page.issues?.length
    ? html`<div class="stack" style="gap:10px">${page.issues
        .slice()
        .sort((a, b) => ['error', 'warning', 'notice'].indexOf(a.severity) - ['error', 'warning', 'notice'].indexOf(b.severity))
        .map((i) => html`<div class="row" style="align-items:flex-start;flex-wrap:nowrap">
          <span style="width:92px;flex:none">${severityBadge(i.severity)}</span>
          <div><div><strong>${i.title}</strong></div>${i.detail ? html`<div class="small muted break">${i.detail}</div>` : ''}</div>
        </div>`)}</div>`
    : html`<div class="muted">No issues on this page.</div>`;

  let body = html`${section(`Issues (${page.issues?.length ?? 0})`, issues)}${section('Overview', overview)}`;

  if (page.analyzed) {
    const meta = html`<div class="kv">
      <div>Title</div><div>${page.title || html`<span class="muted">missing</span>`}<div style="margin-top:4px">${lengthNote(page.titleLength, 30, 60)}</div></div>
      <div>Meta description</div><div>${page.metaDescription || html`<span class="muted">missing</span>`}<div style="margin-top:4px">${lengthNote(page.metaDescriptionLength, 70, 160)}</div></div>
      <div>Meta keywords</div><div>${page.metaKeywords || html`<span class="muted">none</span>`}</div>
      <div>Meta robots</div><div>${page.metaRobots || html`<span class="muted">none (index, follow)</span>`}</div>
      ${page.xRobotsTag ? html`<div>X-Robots-Tag</div><div>${page.xRobotsTag}</div>` : ''}
      ${['title', 'description', 'image', 'url', 'type'].map((k) => html`<div>og:${k}</div><div>${page.og[k] || html`<span class="muted">missing</span>`}</div>`)}
      <div>twitter:card</div><div>${page.twitter.card || html`<span class="muted">missing</span>`}</div>
    </div>`;

    const outline = page.headingOutline.length
      ? html`<div class="outline">${page.headingOutline.map(
          (h) => html`<div style="padding-left:${(h.level - 1) * 16}px"><span class="lvl">H${h.level}</span>${h.text || html`<span class="muted">(empty)</span>`}</div>`,
        )}</div>`
      : html`<div class="muted">No headings.</div>`;

    const images = smallTable(
      ['Image', 'Alt text', ''],
      page.images.map((img) => [
        externalLink(img.src, img.src.split('/').pop() || img.src),
        img.hasAltAttribute ? img.alt || html`<span class="muted">(empty)</span>` : html`<span class="chip chip-warning">missing</span>`,
        brokenTargets.has(img.src) ? html`<span class="chip chip-critical">broken</span>` : '',
      ]),
    );

    const links = smallTable(
      ['Link', 'Anchor text', 'Type', ''],
      page.links.map((l) => [
        externalLink(l.url, fmt.path(l.url) === '/' || !l.internal ? l.url : fmt.path(l.url)),
        l.anchor || html`<span class="muted">(none)</span>`,
        html`${l.internal ? 'Internal' : 'External'}${l.nofollow ? html` <span class="chip">nofollow</span>` : ''}`,
        brokenTargets.has(l.url) ? html`<span class="chip chip-critical">broken</span>` : '',
      ]),
    );

    const k = page.keywords;
    const kwTable = (list) =>
      smallTable(['Term', 'Count', 'Density'], list.slice(0, 15).map((t) => [t.term, html`<span class="num">${t.count}</span>`, html`<span class="num">${t.density}%</span>`]));
    const targets = k.targets.length
      ? smallTable(
          ['Keyword', 'Count', 'Density', 'Title', 'Desc.', 'H1', 'URL', 'First 100 words'],
          k.targets.map((t) => [t.keyword, t.count, `${t.density}%`, yesNo(t.inTitle), yesNo(t.inDescription), yesNo(t.inH1), yesNo(t.inUrl), yesNo(t.inFirst100Words)]),
        )
      : '';

    body = html`${body}
      ${section('Metadata', meta)}
      ${section(`Headings (${page.headingOutline.length})`, outline)}
      ${section('Keyword density', html`<div class="small muted" style="margin-bottom:10px">${fmt.num(k.totalWords)} words · ${fmt.num(k.uniqueWords)} unique</div>
        ${targets ? html`<h3 style="margin-bottom:6px">Target keywords</h3>${targets}<div style="height:14px"></div>` : ''}
        <div class="grid grid-2"><div><h3 style="margin-bottom:6px">Keywords</h3>${kwTable(k.top)}</div><div><h3 style="margin-bottom:6px">Phrases</h3>${kwTable([...k.bigrams, ...k.trigrams].sort((a, b) => b.count - a.count))}</div></div>`)}
      ${section(`Images (${page.images.length})`, images)}
      ${section(`Outgoing links (${page.links.length})`, links)}`;
  }

  if (sources.length) {
    const unique = [...new Map(sources.map((s) => [s.page, s])).values()];
    body = html`${body}${section(`Linked from (${unique.length})`, smallTable(['Page', 'Anchor text'], unique.map((s) => [externalLink(s.page, fmt.path(s.page)), s.anchor || html`<span class="muted">(none)</span>`])))}`;
  }

  openDrawer(html`${header}<div class="drawer-body">${body}</div>`);
}
