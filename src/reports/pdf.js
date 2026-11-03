// PDF report built with PDFKit.
//
// PDFKit's built-in Helvetica only covers the WinAnsi character set. If a
// Unicode TTF font is available (PDF_FONT_PATH / PDF_FONT_BOLD_PATH, or a
// common system location) it is used instead so non-Latin titles render; if
// not, unsupported characters are replaced with "?".

import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { isBroken } from '../analyzer/evaluate.js';

const FONT_CANDIDATES = [
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/TTF/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'],
  ['/Library/Fonts/Arial Unicode.ttf', '/Library/Fonts/Arial Unicode.ttf'],
  ['C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\arialbd.ttf'],
];

function resolveFonts() {
  const fromEnv = process.env.PDF_FONT_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    const bold = process.env.PDF_FONT_BOLD_PATH;
    return { regular: fromEnv, bold: bold && fs.existsSync(bold) ? bold : fromEnv, unicode: true };
  }
  for (const [regular, bold] of FONT_CANDIDATES) {
    if (fs.existsSync(regular)) return { regular, bold: fs.existsSync(bold) ? bold : regular, unicode: true };
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold', unicode: false };
}

// Characters outside Latin-1 that WinAnsi (and thus Helvetica) still supports.
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

function makeSanitizer(unicode) {
  if (unicode) return (s) => String(s ?? '');
  return (s) =>
    String(s ?? '').replace(/[^\x00-\xff]/g, (ch) => {
      if (WIN_ANSI_EXTRA.has(ch)) return ch;
      if (ch === '→') return '->';
      if (ch === '←') return '<-';
      return '?';
    });
}

const PALETTE = {
  text: '#111827',
  muted: '#6b7280',
  faint: '#9ca3af',
  rule: '#e5e7eb',
  zebra: '#f9fafb',
  headerBg: '#1f2937',
  accent: '#2a78d6',
  track: '#cde2fb',
  good: '#0ca30c',
  warning: '#fab219',
  critical: '#d03b3b',
  notice: '#2a78d6',
};

const SEVERITY = {
  error: { label: 'Error', color: PALETTE.critical },
  warning: { label: 'Warning', color: PALETTE.warning },
  notice: { label: 'Notice', color: PALETTE.notice },
};

const scoreColor = (score) => (score >= 75 ? PALETTE.good : score >= 50 ? PALETTE.warning : PALETTE.critical);

/**
 * @returns {Promise<Buffer>}
 */
export function buildPdfReport(project, audit, result) {
  const fonts = resolveFonts();
  const t = makeSanitizer(fonts.unicode);
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 60, left: 45, right: 45 },
    bufferPages: true,
    info: { Title: t(`SEO Audit — ${project.name}`), Author: 'SEO Analyzer', Subject: t(audit.url) },
  });
  doc.registerFont('regular', fonts.regular);
  doc.registerFont('bold', fonts.bold);

  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  const ensureSpace = (h) => {
    if (doc.y + h > bottom()) doc.addPage();
  };

  const sectionTitle = (text, { newPage = false } = {}) => {
    if (newPage) doc.addPage();
    else ensureSpace(60);
    doc.moveDown(0.6);
    doc.font('bold').fontSize(15).fillColor(PALETTE.text).text(t(text), left, doc.y, { width });
    const y = doc.y + 3;
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(PALETTE.rule).stroke();
    doc.y = y + 8;
  };

  const paragraph = (text, { color = PALETTE.muted, size = 9.5, font = 'regular' } = {}) => {
    doc.font(font).fontSize(size).fillColor(color).text(t(text), left, doc.y, { width });
  };

  const severityBadge = (severity, x, y) => {
    const s = SEVERITY[severity];
    doc.circle(x + 3.5, y + 4.5, 3.5).fill(s.color);
    doc.font('regular').fontSize(8.5).fillColor(PALETTE.text).text(s.label, x + 11, y, { lineBreak: false });
  };

  /**
   * Draw a table with automatic page breaks and a repeated header.
   * columns: [{ header, width (fraction), align?, render?(row, x, y, w) }]
   */
  const table = (columns, rows, { fontSize = 8, maxRows = Infinity } = {}) => {
    const widths = columns.map((c) => c.width * width);
    const pad = 4;
    const drawHeader = () => {
      const h = 18;
      const y = doc.y;
      doc.rect(left, y, width, h).fill(PALETTE.headerBg);
      let x = left;
      columns.forEach((c, i) => {
        doc.font('bold').fontSize(fontSize).fillColor('#ffffff')
          .text(t(c.header), x + pad, y + 5, { width: widths[i] - pad * 2, align: c.align || 'left', lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.y = y + h;
    };

    ensureSpace(40);
    drawHeader();
    const shown = rows.slice(0, maxRows);
    shown.forEach((row, rowIndex) => {
      doc.font('regular').fontSize(fontSize);
      const cells = columns.map((c) => (c.render ? null : t(c.value(row))));
      const heights = cells.map((cell, i) => (cell == null ? 12 : doc.heightOfString(cell || ' ', { width: widths[i] - pad * 2 })));
      const h = Math.min(Math.max(...heights), 60) + pad * 2;
      if (doc.y + h > bottom()) {
        doc.addPage();
        drawHeader();
      }
      const y = doc.y;
      if (rowIndex % 2 === 1) doc.rect(left, y, width, h).fill(PALETTE.zebra);
      let x = left;
      columns.forEach((c, i) => {
        if (c.render) {
          c.render(row, x + pad, y + pad, widths[i] - pad * 2);
        } else {
          doc.font('regular').fontSize(fontSize).fillColor(c.color?.(row) ?? PALETTE.text)
            .text(cells[i], x + pad, y + pad, { width: widths[i] - pad * 2, height: h - pad * 2, align: c.align || 'left', ellipsis: true });
        }
        x += widths[i];
      });
      doc.y = y + h;
    });
    doc.x = left;
    if (rows.length > shown.length) {
      doc.moveDown(0.3);
      paragraph(`… and ${rows.length - shown.length} more rows. Download the Excel report for the complete list.`, { size: 8.5 });
    }
    if (!rows.length) paragraph('None found.', { size: 9 });
    doc.moveDown(0.5);
  };

  const { summary } = result;

  // ================================================================ COVER
  doc.rect(0, 0, doc.page.width, 120).fill(PALETTE.headerBg);
  doc.font('bold').fontSize(24).fillColor('#ffffff').text('SEO Audit Report', left, 38, { width });
  doc.font('regular').fontSize(12).fillColor('#d1d5db')
    .text(t(`${project.name}  ·  ${audit.url}`), left, 72, { width, ellipsis: true, lineBreak: false });
  doc.fontSize(9.5).text(
    t(`Generated ${new Date().toLocaleString('en-GB')}  ·  Audit finished ${new Date(audit.finishedAt || audit.createdAt).toLocaleString('en-GB')}`),
    left, 92, { width },
  );

  // Score ring
  const cx = left + 70;
  const cy = 215;
  const r = 55;
  doc.circle(cx, cy, r).lineWidth(12).strokeColor(PALETTE.rule).stroke();
  if (summary.score > 0) {
    const start = -Math.PI / 2;
    const end = start + (Math.PI * 2 * Math.min(summary.score, 99.9)) / 100;
    const steps = 80;
    doc.moveTo(cx + r * Math.cos(start), cy + r * Math.sin(start));
    for (let i = 1; i <= steps; i++) {
      const a = start + ((end - start) * i) / steps;
      doc.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    doc.lineWidth(12).lineCap('round').strokeColor(scoreColor(summary.score)).stroke();
    doc.lineCap('butt');
  }
  doc.font('bold').fontSize(34).fillColor(PALETTE.text).text(String(summary.score), cx - 50, cy - 22, { width: 100, align: 'center' });
  doc.font('regular').fontSize(9).fillColor(PALETTE.muted).text('out of 100', cx - 50, cy + 14, { width: 100, align: 'center' });
  doc.font('bold').fontSize(13).fillColor(PALETTE.text).text(summary.scoreLabel, cx - 60, cy + r + 14, { width: 120, align: 'center' });

  // Category bars
  const barX = left + 175;
  const barW = width - 175;
  let by = 160;
  doc.font('bold').fontSize(11).fillColor(PALETTE.text).text('Category scores', barX, by - 18);
  for (const cat of Object.values(summary.categoryScores)) {
    doc.font('regular').fontSize(9).fillColor(PALETTE.text).text(t(cat.label), barX, by, { width: 130, lineBreak: false });
    const trackX = barX + 130;
    const trackW = barW - 165;
    doc.roundedRect(trackX, by + 1, trackW, 8, 4).fill(PALETTE.track);
    if (cat.score > 0) doc.roundedRect(trackX, by + 1, Math.max(8, (trackW * cat.score) / 100), 8, 4).fill(PALETTE.accent);
    doc.font('bold').fontSize(9).fillColor(PALETTE.text).text(String(cat.score), trackX + trackW + 8, by, { width: 27, align: 'right' });
    by += 20;
  }

  // Stat tiles
  const tiles = [
    ['Pages crawled', summary.pagesCrawled],
    ['Errors', summary.errors],
    ['Warnings', summary.warnings],
    ['Notices', summary.notices],
    ['Broken links', summary.brokenLinks],
    ['Broken images', summary.brokenImages],
    ['Missing alt text', summary.imagesMissingAlt],
    ['Avg. response', `${summary.avgResponseTimeMs} ms`],
  ];
  const tileY = 315;
  const cols = 4;
  const gap = 10;
  const tileW = (width - gap * (cols - 1)) / cols;
  tiles.forEach(([label, value], i) => {
    const x = left + (i % cols) * (tileW + gap);
    const y = tileY + Math.floor(i / cols) * 62;
    doc.roundedRect(x, y, tileW, 52, 6).lineWidth(1).strokeColor(PALETTE.rule).stroke();
    doc.font('regular').fontSize(8.5).fillColor(PALETTE.muted).text(label, x + 10, y + 9, { width: tileW - 20 });
    doc.font('bold').fontSize(18).fillColor(PALETTE.text).text(String(value), x + 10, y + 23, { width: tileW - 20 });
  });
  doc.y = tileY + 2 * 62 + 4;
  doc.x = left;
  if (summary.reachedPageLimit) {
    paragraph(`Note: the crawl stopped at the configured limit of ${result.site.limits.maxPages} pages, so some pages were not analysed.`, { size: 8.5 });
  }

  // ================================================================ ISSUES
  sectionTitle(`Issues found (${result.issues.length} types)`);
  table(
    [
      { header: 'Severity', width: 0.13, render: (row, x, y) => severityBadge(row.severity, x, y) },
      { header: 'Issue', width: 0.5, value: (i) => i.title },
      { header: 'Category', width: 0.22, value: (i) => i.categoryLabel },
      { header: 'Affected', width: 0.15, align: 'right', value: (i) => `${i.affectedCount} / ${i.applicable}` },
    ],
    result.issues,
  );

  // Site overview facts
  sectionTitle('Site-wide checks');
  const probes = result.site.probes;
  const facts = [
    ['HTTPS', probes.https.usesHttps ? 'Yes' : 'No'],
    ['HTTP → HTTPS redirect', probes.https.httpRedirectsToHttps == null ? 'n/a' : probes.https.httpRedirectsToHttps ? 'Yes' : 'No'],
    ['www / non-www consolidated', probes.wwwCanonicalization == null ? 'n/a' : probes.wwwCanonicalization.consolidated ? 'Yes' : 'No'],
    ['robots.txt', result.site.robots.found ? 'Found' : 'Not found'],
    ['XML sitemap', result.site.sitemap.found ? `Found (${result.site.sitemap.urlCount} URLs)` : 'Not found'],
    ['Missing pages return 404', probes.notFoundHandling.returns404 ? 'Yes' : `No (HTTP ${probes.notFoundHandling.status ?? 'error'})`],
    ['Orphan pages (sitemap only)', String(result.structure.orphanPages.length)],
    ['Pages by depth', Object.entries(result.structure.depthDistribution).map(([d, c]) => `${d}: ${c}`).join('   ')],
  ];
  table(
    [
      { header: 'Check', width: 0.4, value: (f) => f[0] },
      { header: 'Result', width: 0.6, value: (f) => f[1] },
    ],
    facts,
    { fontSize: 8.5 },
  );

  // ========================================================= ISSUE DETAILS
  sectionTitle('Issue details & how to fix', { newPage: true });
  for (const issue of result.issues) {
    ensureSpace(90);
    const y = doc.y;
    severityBadge(issue.severity, left, y + 2);
    doc.font('bold').fontSize(11).fillColor(PALETTE.text).text(t(issue.title), left + 70, y, { width: width - 70 });
    doc.moveDown(0.15);
    paragraph(`${issue.categoryLabel} · ${issue.affectedCount} of ${issue.applicable} checked ${issue.scope === 'site' ? 'site checks' : 'URLs'} affected`, { size: 8.5, color: PALETTE.faint });
    doc.moveDown(0.2);
    paragraph(issue.description, { size: 9, color: PALETTE.text });
    doc.moveDown(0.2);
    doc.font('bold').fontSize(9).fillColor(PALETTE.text).text('How to fix: ', left, doc.y, { continued: true, width })
      .font('regular').fillColor(PALETTE.text).text(t(issue.recommendation), { width });
    doc.moveDown(0.3);
    const max = 8;
    for (const a of issue.affected.slice(0, max)) {
      ensureSpace(14);
      doc.font('regular').fontSize(8).fillColor(PALETTE.accent)
        .text(t(a.url), left + 10, doc.y, { width: width - 10, continued: Boolean(a.detail), lineBreak: true });
      if (a.detail) doc.fillColor(PALETTE.muted).text(t(`  —  ${a.detail}`), { width: width - 10 });
    }
    if (issue.affectedCount > max) {
      doc.font('regular').fontSize(8).fillColor(PALETTE.faint).text(`+ ${issue.affectedCount - max} more`, left + 10, doc.y, { width });
    }
    doc.x = left;
    doc.moveDown(0.9);
  }
  if (!result.issues.length) paragraph('No issues found.', { size: 10 });

  // ========================================================= BROKEN LINKS
  sectionTitle('Broken links & images', { newPage: true });
  const brokenRows = result.links.filter(isBroken).flatMap((l) =>
    [...new Set(l.sources.map((s) => s.page))].map((page) => ({ link: l, page })),
  );
  table(
    [
      { header: 'Broken URL', width: 0.4, value: (r) => r.link.url },
      { header: 'Type', width: 0.12, value: (r) => `${r.link.internal ? 'Internal' : 'External'}${r.link.kind === 'image' ? ' img' : ''}` },
      { header: 'Status', width: 0.12, value: (r) => r.link.status ?? r.link.error ?? 'Error', color: () => PALETTE.critical },
      { header: 'Found on', width: 0.36, value: (r) => r.page },
    ],
    brokenRows,
    { maxRows: 150 },
  );

  // ================================================================ PAGES
  sectionTitle('Pages overview');
  const pages = result.pages.filter((p) => !p.isRedirect && !p.blockedByRobots);
  table(
    [
      { header: 'URL', width: 0.36, value: (p) => p.url },
      { header: 'Status', width: 0.07, align: 'right', value: (p) => p.status ?? 'ERR' },
      { header: 'Title', width: 0.08, align: 'right', value: (p) => (p.analyzed ? `${p.titleLength}` : '–'), color: (p) => (p.analyzed && (!p.titleLength || p.titleLength > 60 || p.titleLength < 30) ? PALETTE.critical : PALETTE.text) },
      { header: 'Desc.', width: 0.08, align: 'right', value: (p) => (p.analyzed ? `${p.metaDescriptionLength}` : '–'), color: (p) => (p.analyzed && (!p.metaDescriptionLength || p.metaDescriptionLength > 160 || p.metaDescriptionLength < 70) ? PALETTE.critical : PALETTE.text) },
      { header: 'H1', width: 0.06, align: 'right', value: (p) => (p.analyzed ? p.h1.length : '–') },
      { header: 'Words', width: 0.08, align: 'right', value: (p) => p.wordCount ?? '–' },
      { header: 'No alt', width: 0.08, align: 'right', value: (p) => p.imagesMissingAlt ?? '–' },
      { header: 'Inlinks', width: 0.09, align: 'right', value: (p) => p.inlinks },
      { header: 'Issues', width: 0.1, align: 'right', value: (p) => p.issues?.length ?? 0 },
    ],
    pages,
    { maxRows: 200, fontSize: 7.5 },
  );
  paragraph('Title and Desc. show character counts; red values are outside the recommended range.', { size: 8 });

  // ============================================================= KEYWORDS
  sectionTitle('Keyword analysis', { newPage: true });
  if (result.keywords.targets.length) {
    doc.font('bold').fontSize(10.5).fillColor(PALETTE.text).text('Target keywords', left, doc.y);
    doc.moveDown(0.3);
    table(
      [
        { header: 'Keyword', width: 0.28, value: (k) => k.keyword },
        { header: 'Count', width: 0.1, align: 'right', value: (k) => k.count },
        { header: 'Density', width: 0.12, align: 'right', value: (k) => `${k.density}%` },
        { header: 'Pages', width: 0.1, align: 'right', value: (k) => k.pages },
        { header: 'In titles', width: 0.1, align: 'right', value: (k) => k.inTitle },
        { header: 'In H1', width: 0.1, align: 'right', value: (k) => k.inH1 },
        { header: 'In desc.', width: 0.1, align: 'right', value: (k) => k.inDescription },
        { header: 'In URL', width: 0.1, align: 'right', value: (k) => k.inUrl },
      ],
      result.keywords.targets,
    );
  }
  paragraph(`Site-wide keyword density across ${result.keywords.totalWords.toLocaleString('en-US')} words of visible text (stop words excluded).`, { size: 8.5 });
  doc.moveDown(0.4);
  const kwColumns = [
    { header: 'Keyword', width: 0.46, value: (k) => k.term },
    { header: 'Count', width: 0.18, align: 'right', value: (k) => k.count },
    { header: 'Density', width: 0.18, align: 'right', value: (k) => `${k.density}%` },
    { header: 'Pages', width: 0.18, align: 'right', value: (k) => k.pages },
  ];
  doc.font('bold').fontSize(10.5).fillColor(PALETTE.text).text('Top single keywords', left, doc.y);
  doc.moveDown(0.3);
  table(kwColumns, result.keywords.top, { maxRows: 25 });
  doc.font('bold').fontSize(10.5).fillColor(PALETTE.text).text('Top 2-word phrases', left, doc.y);
  doc.moveDown(0.3);
  table(kwColumns, result.keywords.bigrams, { maxRows: 15 });
  doc.font('bold').fontSize(10.5).fillColor(PALETTE.text).text('Top 3-word phrases', left, doc.y);
  doc.moveDown(0.3);
  table(kwColumns, result.keywords.trigrams, { maxRows: 10 });

  // ============================================================ STRUCTURE
  sectionTitle('Site structure', { newPage: true });
  doc.font('bold').fontSize(10.5).fillColor(PALETTE.text).text('URL tree', left, doc.y);
  doc.moveDown(0.3);
  let treeLines = 0;
  const maxTreeLines = 120;
  const walk = (node, level) => {
    if (treeLines >= maxTreeLines) return;
    ensureSpace(13);
    treeLines++;
    const label = level === 0 ? node.name : `/${node.name}`;
    doc.font(level === 0 ? 'bold' : 'regular').fontSize(8.5).fillColor(PALETTE.text)
      .text(t(label), left + level * 14, doc.y, { continued: true, width: width - level * 14 })
      .fillColor(PALETTE.faint).text(t(`  (${node.total})${node.page?.title ? `  ${node.page.title.slice(0, 70)}` : ''}`));
    node.children.forEach((c) => walk(c, level + 1));
  };
  walk(result.structure.tree, 0);
  if (treeLines >= maxTreeLines) paragraph('… tree truncated. See the Excel report for the full structure.', { size: 8 });
  doc.x = left;
  doc.moveDown(0.6);

  doc.font('bold').fontSize(10.5).fillColor(PALETTE.text).text(`Orphan pages (${result.structure.orphanPages.length})`, left, doc.y);
  doc.moveDown(0.3);
  table([{ header: 'URL listed in sitemap but not linked from any crawled page', width: 1, value: (u) => u }], result.structure.orphanPages, { maxRows: 50 });

  // ============================================================== FOOTERS
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - 38;
    doc.font('regular').fontSize(8).fillColor(PALETTE.faint);
    // Writing inside the bottom margin would trigger an automatic page break.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.text(t(`${project.name} · SEO audit`), left, y, { width: width / 2, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left + width / 2, y, { width: width / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
  return done;
}
