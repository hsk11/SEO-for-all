// Excel (.xlsx) report: one workbook, one sheet per report section.

import ExcelJS from 'exceljs';
import { isBroken } from '../analyzer/evaluate.js';

const COLORS = {
  header: 'FF1F2937',
  headerText: 'FFFFFFFF',
  error: 'FFFBE3E3',
  warning: 'FFFFF4D6',
  notice: 'FFE6F0FB',
  good: 'FF0CA30C',
  ok: 'FFFAB219',
  bad: 'FFD03B3B',
};

const SEVERITY_LABEL = { error: 'Error', warning: 'Warning', notice: 'Notice' };

function scoreColor(score) {
  if (score >= 75) return COLORS.good;
  if (score >= 50) return COLORS.ok;
  return COLORS.bad;
}

function addTable(workbook, name, columns, rows, { severityKey } = {}) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 20, style: c.style }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: COLORS.headerText } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.header } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;

  for (const row of rows) {
    const added = sheet.addRow(row);
    const sev = severityKey && row[severityKey]?.toLowerCase?.();
    if (sev && COLORS[sev]) {
      added.getCell(severityKey).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS[sev] } };
    }
    added.alignment = { vertical: 'top', wrapText: false };
  }
  if (rows.length) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  } else {
    sheet.addRow({ [columns[0].key]: 'No items.' });
  }
  for (const c of columns) {
    if (c.wrap) sheet.getColumn(c.key).alignment = { wrapText: true, vertical: 'top' };
  }
  return sheet;
}

function urlCell(url) {
  return url ? { text: url, hyperlink: url } : '';
}

/**
 * @param {object} project
 * @param {object} audit   audit metadata from the store
 * @param {object} result  full audit result
 * @returns {Promise<Buffer>}
 */
export async function buildExcelReport(project, audit, result) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SEO Analyzer';
  wb.created = new Date();
  const { summary } = result;

  // ------------------------------------------------------------- Summary
  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 32 }, { width: 70 }];
  s.mergeCells('A1:B1');
  s.getCell('A1').value = `SEO Audit Report — ${project.name}`;
  s.getCell('A1').font = { size: 16, bold: true };
  const meta = [
    ['Website', urlCell(audit.url)],
    ['Audit date', new Date(audit.finishedAt || audit.createdAt).toLocaleString('en-GB')],
    ['Pages crawled', summary.pagesCrawled],
    ['Overall score', `${summary.score} / 100 (${summary.scoreLabel})`],
  ];
  meta.forEach(([k, v], i) => {
    const row = s.getRow(i + 3);
    row.getCell(1).value = k;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = v;
  });
  const scoreCell = s.getCell('B6');
  scoreCell.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  scoreCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: scoreColor(summary.score) } };

  let r = 8;
  s.getCell(`A${r}`).value = 'Category scores';
  s.getCell(`A${r}`).font = { bold: true, size: 13 };
  r++;
  for (const cat of Object.values(summary.categoryScores)) {
    s.getCell(`A${r}`).value = cat.label;
    const c = s.getCell(`B${r}`);
    c.value = `${cat.score} / 100  —  ${cat.errors} error, ${cat.warnings} warning, ${cat.notices} notice issue types`;
    c.font = { color: { argb: scoreColor(cat.score) }, bold: true };
    r++;
  }
  r++;
  s.getCell(`A${r}`).value = 'Key statistics';
  s.getCell(`A${r}`).font = { bold: true, size: 13 };
  r++;
  const stats = [
    ['HTML pages analysed', summary.htmlPages],
    ['Indexable pages', summary.indexablePages],
    ['Redirects', summary.redirects],
    ['Error pages (4xx/5xx/failed)', summary.errorPages],
    ['Blocked by robots.txt', summary.blockedPages],
    ['Unique links found', summary.linksFound],
    ['Links checked', summary.linksChecked],
    ['Broken links', summary.brokenLinks],
    ['Broken images', summary.brokenImages],
    ['Images missing alt', `${summary.imagesMissingAlt} of ${summary.imagesTotal}`],
    ['Errors (instances)', summary.errors],
    ['Warnings (instances)', summary.warnings],
    ['Notices (instances)', summary.notices],
    ['Passed checks', summary.passedChecks],
    ['Average response time', `${summary.avgResponseTimeMs} ms`],
    ['Average word count', summary.avgWordCount],
  ];
  if (summary.reachedPageLimit) stats.push(['Note', `Crawl stopped at the page limit (${result.site.limits.maxPages}). Increase it in project settings for a full audit.`]);
  for (const [k, v] of stats) {
    s.getCell(`A${r}`).value = k;
    s.getCell(`B${r}`).value = v;
    s.getCell(`B${r}`).alignment = { horizontal: 'left' };
    r++;
  }

  // -------------------------------------------------------------- Issues
  addTable(
    wb,
    'Issues',
    [
      { header: 'Severity', key: 'severity', width: 11 },
      { header: 'Category', key: 'category', width: 22 },
      { header: 'Issue', key: 'title', width: 50 },
      { header: 'Affected', key: 'affected', width: 10 },
      { header: 'Checked', key: 'applicable', width: 10 },
      { header: 'Description', key: 'description', width: 70, wrap: true },
      { header: 'How to fix', key: 'recommendation', width: 70, wrap: true },
    ],
    result.issues.map((i) => ({
      severity: SEVERITY_LABEL[i.severity],
      category: i.categoryLabel,
      title: i.title,
      affected: i.affectedCount,
      applicable: i.applicable,
      description: i.description,
      recommendation: i.recommendation,
    })),
    { severityKey: 'severity' },
  );

  addTable(
    wb,
    'Issue details',
    [
      { header: 'Severity', key: 'severity', width: 11 },
      { header: 'Issue', key: 'title', width: 45 },
      { header: 'URL', key: 'url', width: 70 },
      { header: 'Detail', key: 'detail', width: 80 },
    ],
    result.issues.flatMap((i) =>
      i.affected.map((a) => ({ severity: SEVERITY_LABEL[i.severity], title: i.title, url: urlCell(a.url), detail: a.detail })),
    ),
    { severityKey: 'severity' },
  );

  // --------------------------------------------------------------- Pages
  const pages = result.pages.filter((p) => !p.isRedirect && !p.blockedByRobots);
  addTable(
    wb,
    'Pages',
    [
      { header: 'URL', key: 'url', width: 60 },
      { header: 'Status', key: 'status', width: 8 },
      { header: 'Depth', key: 'depth', width: 7 },
      { header: 'Title', key: 'title', width: 50 },
      { header: 'Title length', key: 'titleLength', width: 12 },
      { header: 'Meta description', key: 'metaDescription', width: 60 },
      { header: 'Description length', key: 'metaDescriptionLength', width: 12 },
      { header: 'H1', key: 'h1', width: 40 },
      { header: 'H1 count', key: 'h1Count', width: 9 },
      { header: 'Words', key: 'wordCount', width: 9 },
      { header: 'Text/HTML %', key: 'textHtmlRatio', width: 11 },
      { header: 'Images', key: 'imageCount', width: 9 },
      { header: 'Missing alt', key: 'imagesMissingAlt', width: 11 },
      { header: 'Internal links', key: 'internalLinkCount', width: 12 },
      { header: 'External links', key: 'externalLinkCount', width: 12 },
      { header: 'Inlinks', key: 'inlinks', width: 9 },
      { header: 'Canonical', key: 'canonical', width: 50 },
      { header: 'Indexable', key: 'indexable', width: 10 },
      { header: 'Meta robots', key: 'metaRobots', width: 16 },
      { header: 'Lang', key: 'lang', width: 8 },
      { header: 'Structured data', key: 'schema', width: 25 },
      { header: 'Response (ms)', key: 'responseTimeMs', width: 13 },
      { header: 'Size (KB)', key: 'sizeKb', width: 10 },
      { header: 'In sitemap', key: 'inSitemap', width: 10 },
      { header: 'Issues', key: 'issueCount', width: 8 },
    ],
    pages.map((p) => ({
      url: urlCell(p.url),
      status: p.status ?? p.error ?? '',
      depth: p.depth,
      title: p.title ?? '',
      titleLength: p.analyzed ? p.titleLength : '',
      metaDescription: p.metaDescription ?? '',
      metaDescriptionLength: p.analyzed ? p.metaDescriptionLength : '',
      h1: p.h1?.[0] ?? '',
      h1Count: p.h1?.length ?? '',
      wordCount: p.wordCount ?? '',
      textHtmlRatio: p.textHtmlRatio ?? '',
      imageCount: p.imageCount ?? '',
      imagesMissingAlt: p.imagesMissingAlt ?? '',
      internalLinkCount: p.internalLinkCount ?? '',
      externalLinkCount: p.externalLinkCount ?? '',
      inlinks: p.inlinks,
      canonical: p.canonical ?? '',
      indexable: p.analyzed ? (p.noindex ? 'No' : 'Yes') : '',
      metaRobots: p.metaRobots ?? '',
      lang: p.lang ?? '',
      schema: p.structuredData?.types.join(', ') ?? '',
      responseTimeMs: p.responseTimeMs,
      sizeKb: Math.round((p.sizeBytes / 1024) * 10) / 10,
      inSitemap: p.inSitemap ? 'Yes' : 'No',
      issueCount: p.issues?.length ?? 0,
    })),
  );

  // -------------------------------------------------------- Broken links
  const brokenRows = [];
  for (const link of result.links.filter(isBroken)) {
    for (const src of link.sources) {
      brokenRows.push({
        url: urlCell(link.url),
        type: link.internal ? 'Internal' : 'External',
        kind: link.kind === 'image' ? 'Image' : 'Link',
        status: link.status ?? '',
        error: link.error ?? '',
        source: urlCell(src.page),
        anchor: src.anchor,
      });
    }
  }
  addTable(
    wb,
    'Broken links',
    [
      { header: 'Broken URL', key: 'url', width: 60 },
      { header: 'Type', key: 'type', width: 10 },
      { header: 'Kind', key: 'kind', width: 8 },
      { header: 'Status', key: 'status', width: 8 },
      { header: 'Error', key: 'error', width: 30 },
      { header: 'Found on page', key: 'source', width: 60 },
      { header: 'Anchor / alt text', key: 'anchor', width: 40 },
    ],
    brokenRows,
  );

  // ----------------------------------------------------------- All links
  addTable(
    wb,
    'All links',
    [
      { header: 'URL', key: 'url', width: 70 },
      { header: 'Type', key: 'type', width: 10 },
      { header: 'Kind', key: 'kind', width: 8 },
      { header: 'Status', key: 'status', width: 9 },
      { header: 'Result', key: 'result', width: 14 },
      { header: 'Redirects to', key: 'finalUrl', width: 60 },
      { header: 'Linked from (pages)', key: 'sources', width: 12 },
    ],
    result.links.map((l) => ({
      url: urlCell(l.url),
      type: l.internal ? 'Internal' : 'External',
      kind: l.kind === 'image' ? 'Image' : 'Link',
      status: l.status ?? '',
      result: !l.checked ? 'Not checked' : isBroken(l) ? 'Broken' : l.redirectChain.length ? 'Redirect' : 'OK',
      finalUrl: l.redirectChain.length ? l.finalUrl : '',
      sources: new Set(l.sources.map((s) => s.page)).size,
    })),
  );

  // ----------------------------------------------------------- Redirects
  addTable(
    wb,
    'Redirects',
    [
      { header: 'URL', key: 'url', width: 60 },
      { header: 'Status', key: 'status', width: 8 },
      { header: 'Target', key: 'target', width: 60 },
      { header: 'Hops', key: 'hops', width: 7 },
      { header: 'Chain', key: 'chain', width: 80 },
    ],
    result.pages.filter((p) => p.isRedirect).map((p) => ({
      url: urlCell(p.url),
      status: p.status,
      target: urlCell(p.redirectTarget),
      hops: p.redirectChain.length,
      chain: p.redirectChain.map((h) => `${h.status} ${h.url}`).join(' → '),
    })),
  );

  // -------------------------------------------------------------- Images
  addTable(
    wb,
    'Images',
    [
      { header: 'Page', key: 'page', width: 55 },
      { header: 'Image', key: 'src', width: 60 },
      { header: 'Alt text', key: 'alt', width: 45 },
      { header: 'Alt status', key: 'altStatus', width: 14 },
      { header: 'Width', key: 'width', width: 8 },
      { header: 'Height', key: 'height', width: 8 },
    ],
    pages.flatMap((p) =>
      (p.images ?? []).map((img) => ({
        page: urlCell(p.url),
        src: urlCell(img.src),
        alt: img.alt ?? '',
        altStatus: !img.hasAltAttribute ? 'Missing' : img.alt ? 'OK' : 'Empty (decorative)',
        width: img.width ?? '',
        height: img.height ?? '',
      })),
    ),
  );

  // ------------------------------------------------------------ Keywords
  const kw = wb.addWorksheet('Keywords');
  kw.columns = [{ width: 36 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 4 }, { width: 36 }, { width: 12 }, { width: 12 }, { width: 12 }];
  const writeBlock = (startRow, startCol, title, rows) => {
    kw.getCell(startRow, startCol).value = title;
    kw.getCell(startRow, startCol).font = { bold: true, size: 12 };
    const headers = ['Term', 'Count', 'Density %', 'Pages'];
    headers.forEach((h, i) => {
      const c = kw.getCell(startRow + 1, startCol + i);
      c.value = h;
      c.font = { bold: true, color: { argb: COLORS.headerText } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.header } };
    });
    rows.forEach((t, i) => {
      [t.term, t.count, t.density, t.pages].forEach((v, j) => {
        kw.getCell(startRow + 2 + i, startCol + j).value = v;
      });
    });
    return startRow + 3 + rows.length;
  };
  let kr = 1;
  if (result.keywords.targets.length) {
    kw.getCell(kr, 1).value = 'Target keywords';
    kw.getCell(kr, 1).font = { bold: true, size: 12 };
    kr++;
    const th = ['Keyword', 'Occurrences', 'Density %', 'Pages using', 'In titles', 'In H1', 'In descriptions', 'In URLs'];
    th.forEach((h, i) => {
      const c = kw.getCell(kr, i + 1 + (i >= 4 ? 1 : 0));
      c.value = h;
      c.font = { bold: true, color: { argb: COLORS.headerText } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.header } };
    });
    kr++;
    for (const t of result.keywords.targets) {
      [t.keyword, t.count, t.density, t.pages, t.inTitle, t.inH1, t.inDescription, t.inUrl].forEach((v, i) => {
        kw.getCell(kr, i + 1 + (i >= 4 ? 1 : 0)).value = v;
      });
      kr++;
    }
    kr++;
  }
  const leftEnd = writeBlock(kr, 1, 'Top keywords (1 word)', result.keywords.top);
  const rightEnd = writeBlock(kr, 6, 'Top phrases (2 words)', result.keywords.bigrams);
  writeBlock(Math.max(leftEnd, rightEnd) + 1, 1, 'Top phrases (3 words)', result.keywords.trigrams);

  // Per-page keyword density
  addTable(
    wb,
    'Keyword density by page',
    [
      { header: 'Page', key: 'page', width: 60 },
      { header: 'Words', key: 'words', width: 9 },
      { header: 'Rank', key: 'rank', width: 6 },
      { header: 'Keyword', key: 'term', width: 30 },
      { header: 'Count', key: 'count', width: 8 },
      { header: 'Density %', key: 'density', width: 10 },
    ],
    pages.filter((p) => p.keywords).flatMap((p) =>
      p.keywords.top.slice(0, 10).map((t, i) => ({ page: urlCell(p.url), words: p.wordCount, rank: i + 1, term: t.term, count: t.count, density: t.density })),
    ),
  );

  // ----------------------------------------------------------- Structure
  const st = wb.addWorksheet('Site structure');
  st.columns = [{ width: 70 }, { width: 14 }, { width: 50 }];
  let sr = 1;
  const heading = (text) => {
    st.getCell(sr, 1).value = text;
    st.getCell(sr, 1).font = { bold: true, size: 12 };
    sr++;
  };
  heading('Pages by crawl depth');
  for (const [depth, count] of Object.entries(result.structure.depthDistribution)) {
    st.getCell(sr, 1).value = `Depth ${depth}`;
    st.getCell(sr, 2).value = count;
    sr++;
  }
  sr++;
  heading('Responses by status');
  for (const [status, count] of Object.entries(result.structure.statusDistribution)) {
    st.getCell(sr, 1).value = status;
    st.getCell(sr, 2).value = count;
    sr++;
  }
  sr++;
  heading('URL tree');
  const walk = (node, level) => {
    st.getCell(sr, 1).value = `${'    '.repeat(level)}${level ? '/' : ''}${node.name}`;
    st.getCell(sr, 2).value = node.total;
    st.getCell(sr, 3).value = node.page?.title ?? '';
    sr++;
    node.children.forEach((c) => walk(c, level + 1));
  };
  walk(result.structure.tree, 0);
  sr++;
  heading(`Orphan pages (in sitemap, not linked) — ${result.structure.orphanPages.length}`);
  result.structure.orphanPages.forEach((u) => (st.getCell(sr++, 1).value = urlCell(u)));
  sr++;
  heading(`Indexable pages missing from sitemap — ${result.structure.notInSitemap.length}`);
  result.structure.notInSitemap.forEach((u) => (st.getCell(sr++, 1).value = urlCell(u)));

  // -------------------------------------------------------------- Passed
  addTable(
    wb,
    'Passed checks',
    [
      { header: 'Category', key: 'category', width: 22 },
      { header: 'Check', key: 'title', width: 55 },
      { header: 'Items checked', key: 'applicable', width: 14 },
    ],
    result.passed.map((p) => ({ category: p.categoryLabel, title: p.title, applicable: p.applicable })),
  );

  return Buffer.from(await wb.xlsx.writeBuffer());
}
