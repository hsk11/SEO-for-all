// File-database robustness and report generation edge cases.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { Store, NotFoundError } from '../src/db/store.js';
import { buildExcelReport } from '../src/reports/excel.js';
import { buildPdfReport } from '../src/reports/pdf.js';
import { startSite, page, auditSite } from './helpers/http-site.js';

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'seo-store-'));
}

describe('file database', () => {
  test('creates the data directory and database on first run', async () => {
    const dir = path.join(await tempDir(), 'nested', 'data');
    const store = await new Store(dir).init();
    assert.deepEqual(store.listProjects(), []);
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'db.json'), 'utf8'));
    assert.deepEqual(onDisk.projects, []);
  });

  test('refuses to start on a corrupt database instead of overwriting it', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'db.json'), '{"projects": [ broken');
    await assert.rejects(new Store(dir).init(), /Cannot read database/);
    assert.equal(await fs.readFile(path.join(dir, 'db.json'), 'utf8'), '{"projects": [ broken', 'file left untouched');
  });

  test('many concurrent writes are all persisted, with no temp files left behind', async () => {
    const dir = await tempDir();
    const store = await new Store(dir).init();
    await Promise.all(Array.from({ length: 60 }, (_, i) => store.createProject({ name: `p${i}`, url: 'https://x.com/', settings: {} })));
    const reloaded = await new Store(dir).init();
    assert.equal(reloaded.listProjects().length, 60);
    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('result files: save, load, missing and delete', async () => {
    const dir = await tempDir();
    const store = await new Store(dir).init();
    const p = await store.createProject({ name: 'p', url: 'https://x.com/', settings: {} });
    const a = await store.createAudit(p.id);
    await assert.rejects(store.getAuditResult(a.id), NotFoundError);
    await store.saveAuditResult(a.id, { hello: 'world' });
    assert.deepEqual(await store.getAuditResult(a.id), { hello: 'world' });
    await store.deleteAudit(a.id);
    await assert.rejects(fs.access(path.join(dir, 'audits', `${a.id}.json`)));
    assert.throws(() => store.getAudit(a.id), NotFoundError);
  });

  test('audits cannot be created for missing projects; ids are immutable on update', async () => {
    const store = await new Store(await tempDir()).init();
    await assert.rejects(store.createAudit('nope'), NotFoundError);
    const p = await store.createProject({ name: 'p', url: 'https://x.com/', settings: {} });
    const updated = await store.updateProject(p.id, { id: 'hijack', createdAt: '1999', name: 'q' });
    assert.equal(updated.id, p.id);
    assert.equal(updated.createdAt, p.createdAt);
    assert.equal(updated.name, 'q');
  });

  test('queued and running audits are failed on restart; finished ones untouched', async () => {
    const dir = await tempDir();
    const s1 = await new Store(dir).init();
    const p = await s1.createProject({ name: 'x', url: 'https://x.com/', settings: {} });
    const queued = await s1.createAudit(p.id);
    const running = await s1.createAudit(p.id);
    const done = await s1.createAudit(p.id);
    await s1.updateAudit(running.id, { status: 'running' });
    await s1.updateAudit(done.id, { status: 'completed' });
    const s2 = await new Store(dir).init();
    await s2.recoverInterruptedAudits();
    assert.equal(s2.getAudit(queued.id).status, 'failed');
    assert.equal(s2.getAudit(running.id).status, 'failed');
    assert.equal(s2.getAudit(done.id).status, 'completed');
  });
});

describe('reports', () => {
  const audit = (url) => ({ url, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  const pdfPageCount = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

  test('large sites: every page in Excel, PDF tables capped', async () => {
    // 260 pages, each linking to the next few pages, with long and non-Latin titles.
    const site = await startSite({}, {
      fallback: (req, res, { url }) => {
        const n = Number(url.pathname.split('/').pop()) || 0;
        const next = [1, 2, 3].map((d) => `<a href="/p/${n + d}">next ${d}</a>`).join(' ');
        return page({ title: `Página ${n} — ${'very long title words '.repeat(5)} 日本語 हिन्दी`, body: `<h1>Page ${n}</h1>${next}<img src="/img/${n}.png">` });
      },
    });
    try {
      const result = await auditSite(site.url, { maxPages: 260, maxDepth: 200, concurrency: 8, maxLinkChecks: 50 });
      assert.equal(result.pages.length, 260);

      const started = Date.now();
      const xlsx = await buildExcelReport({ name: 'Large' }, audit(site.url), result);
      const pdf = await buildPdfReport({ name: 'Large 日本' }, audit(site.url), result);
      assert.ok(Date.now() - started < 20000, 'reports build in reasonable time');

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx);
      assert.equal(wb.getWorksheet('Pages').rowCount, 261);
      assert.equal(wb.getWorksheet('Issues').rowCount, result.issues.length + 1);
      const titleCell = wb.getWorksheet('Pages').getRow(2).getCell(4).value;
      assert.match(String(titleCell), /日本語/, 'Excel keeps Unicode text');

      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      const pages = pdfPageCount(pdf);
      assert.ok(pages > 5 && pages < 60, `PDF has ${pages} pages`);
    } finally {
      await site.stop();
    }
  });

  test('a site with no issues renders "none found" sections', async () => {
    const site = await startSite({ '/': page({ body: '<h1>Only page</h1>' }) });
    try {
      const result = await auditSite(site.url);
      // Strip issues to simulate a perfect audit.
      const perfect = { ...result, issues: [], links: [], structure: { ...result.structure, orphanPages: [] } };
      const pdf = await buildPdfReport({ name: 'Perfect' }, audit(site.url), perfect);
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await buildExcelReport({ name: 'Perfect' }, audit(site.url), perfect));
      assert.equal(wb.getWorksheet('Issues').getRow(2).getCell(1).value, 'No items.');
      assert.equal(wb.getWorksheet('Broken links').getRow(2).getCell(1).value, 'No items.');
    } finally {
      await site.stop();
    }
  });

  test('Excel summary reflects the audit summary', async () => {
    const site = await startSite({ '/': page({ body: '<h1>x</h1><a href="/gone">gone</a>' }) });
    try {
      const result = await auditSite(site.url);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await buildExcelReport({ name: 'Summary' }, audit(site.url), result));
      const summary = wb.getWorksheet('Summary');
      const values = [];
      summary.eachRow((row) => values.push(`${row.getCell(1).value}=${JSON.stringify(row.getCell(2).value)}`));
      assert.ok(values.some((v) => v.startsWith('Overall score=') && v.includes(`${result.summary.score} / 100`)));
      assert.ok(values.some((v) => v === `Broken links=${result.summary.brokenLinks}`));
      const broken = wb.getWorksheet('Broken links');
      assert.equal(broken.getRow(2).getCell(4).value, 404);
    } finally {
      await site.stop();
    }
  });
});
