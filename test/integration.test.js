// End-to-end: real HTTP fixture site -> crawler -> evaluator -> store -> API -> reports.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureSite } from './fixtures/site.js';
import { Store } from '../src/db/store.js';
import { AuditRunner } from '../src/audit/runner.js';
import { createApp } from '../src/app.js';

let site;
let siteUrl;
let dataDir;
let store;
let runner;
let server;
let api;

const silentLogger = { error() {}, log() {} };

before(async () => {
  site = createFixtureSite();
  siteUrl = await site.start();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seo-analyzer-test-'));
  store = await new Store(dataDir).init();
  runner = new AuditRunner(store, { logger: silentLogger });
  const app = createApp({ store, runner });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  api = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  await runner.whenIdle();
  await new Promise((resolve) => server.close(resolve));
  await site.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const json = async (method, url, body) => {
  const res = await fetch(api + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

describe('API + full audit', () => {
  let project;
  let auditId;
  let result;

  test('rejects invalid projects with field errors', async () => {
    const res = await json('POST', '/projects', { name: '', url: 'not a url' });
    assert.equal(res.status, 400);
    assert.ok(res.body.fields.name);
    assert.ok(res.body.fields.url);
  });

  test('creates a project', async () => {
    const res = await json('POST', '/projects', {
      name: 'Fixture',
      url: siteUrl,
      settings: { targetKeywords: 'seo tools, blue gizmo', concurrency: 4 },
    });
    assert.equal(res.status, 201);
    project = res.body;
    assert.deepEqual(project.settings.targetKeywords, ['seo tools', 'blue gizmo']);
  });

  test('runs an audit to completion', async () => {
    const start = await json('POST', `/projects/${project.id}/audits`, {});
    assert.equal(start.status, 202);
    auditId = start.body.id;

    const dup = await json('POST', `/projects/${project.id}/audits`, {});
    assert.equal(dup.status, 409, 'only one audit per project at a time');

    await runner.whenIdle();
    const audit = await json('GET', `/audits/${auditId}`);
    assert.equal(audit.body.status, 'completed', audit.body.error);
    assert.ok(audit.body.summary.score > 0 && audit.body.summary.score < 100);

    const res = await json('GET', `/audits/${auditId}/results`);
    assert.equal(res.status, 200);
    result = res.body;
  });

  const issue = (id) => result.issues.find((i) => i.id === id);
  const affectedPaths = (id) => (issue(id)?.affected ?? []).map((a) => new URL(a.url).pathname).sort();

  test('crawls pages with correct depth and respects robots.txt', () => {
    const byPath = Object.fromEntries(result.pages.map((p) => [new URL(p.url).pathname, p]));
    assert.equal(byPath['/'].depth, 0);
    assert.equal(byPath['/blog/post-1'].depth, 2);
    assert.equal(byPath['/private/secret'].blockedByRobots, true);
    assert.equal(byPath['/old-page'].isRedirect, true);
    assert.equal(byPath['/old-page'].redirectChain.length, 2);
    assert.ok(!byPath['/files/brochure.pdf'], 'non-HTML files are link-checked, not crawled');
    assert.ok(!byPath['/deep/a/b/c/d'], 'maxDepth (5) is respected');
  });

  test('detects broken links and images', () => {
    const broken = result.links.filter((l) => l.checked && (l.status >= 400 || l.error)).map((l) => new URL(l.url).pathname).sort();
    assert.deepEqual(broken, ['/broken-page', '/ext-404', '/img/missing.png']);
    const external = result.links.find((l) => l.url.endsWith('/ext-ok'));
    assert.equal(external.internal, false);
    assert.equal(external.status, 200);
    assert.deepEqual(affectedPaths('links-broken'), ['/']);
    assert.deepEqual(affectedPaths('img-broken'), ['/']);
    assert.deepEqual(affectedPaths('http-4xx'), ['/broken-page']);
  });

  test('detects metadata problems', () => {
    assert.deepEqual(affectedPaths('title-too-short'), ['/about']);
    assert.deepEqual(affectedPaths('title-duplicate'), ['/blog/post-1', '/blog/post-2']);
    assert.deepEqual(affectedPaths('description-duplicate'), ['/blog/post-1', '/blog/post-2']);
    assert.ok(affectedPaths('description-missing').includes('/about'));
    assert.deepEqual(affectedPaths('lang-missing'), ['/blog/post-2']);
    assert.deepEqual(affectedPaths('h1-multiple'), ['/about']);
    assert.deepEqual(affectedPaths('heading-hierarchy'), ['/about']);
    assert.deepEqual(affectedPaths('img-alt-missing'), ['/about']);
    assert.deepEqual(affectedPaths('noindex'), ['/noindex']);
    assert.ok(!affectedPaths('canonical-missing').includes('/'));
  });

  test('detects structure, redirect and keyword problems', () => {
    assert.deepEqual(affectedPaths('redirect-chain'), ['/old-page']);
    assert.deepEqual(affectedPaths('redirect-temporary'), ['/old-page']);
    assert.deepEqual(affectedPaths('deep-page'), ['/deep/a/b', '/deep/a/b/c']);
    assert.deepEqual(result.structure.orphanPages.map((u) => new URL(u).pathname), ['/orphan']);
    assert.deepEqual(affectedPaths('keyword-stuffing'), ['/blog/post-1']);
    assert.match(issue('site-keyword-unused').affected[0].detail, /blue gizmo/);
    assert.ok(!issue('site-keyword-unused').affected[0].detail.includes('seo tools'));
    assert.ok(issue('site-no-https'));
    assert.ok(!issue('site-robots-missing') && !issue('site-sitemap-missing') && !issue('site-soft-404'));
  });

  test('scores each category between 0 and 100', () => {
    for (const cat of Object.values(result.summary.categoryScores)) {
      assert.ok(cat.score >= 0 && cat.score <= 100, `${cat.label}: ${cat.score}`);
    }
    assert.equal(result.summary.brokenLinks, 2);
    assert.equal(result.summary.brokenImages, 1);
  });

  test('generates a PDF report', async () => {
    const res = await fetch(`${api}/audits/${auditId}/report.pdf`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="?seo-report-fixture-\d{4}-\d{2}-\d{2}\.pdf"?/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  });

  test('generates an Excel report with every sheet', async () => {
    const res = await fetch(`${api}/audits/${auditId}/report.xlsx`);
    assert.equal(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString(), 'PK');
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const names = wb.worksheets.map((w) => w.name);
    for (const sheet of ['Summary', 'Issues', 'Issue details', 'Pages', 'Broken links', 'Images', 'Keywords', 'Site structure']) {
      assert.ok(names.includes(sheet), `missing sheet ${sheet}`);
    }
    assert.equal(wb.getWorksheet('Broken links').rowCount, 4); // header + 3 broken targets (1 source each)
  });

  test('persists to disk and survives a reload', async () => {
    const reloaded = await new Store(dataDir).init();
    assert.equal(reloaded.getProject(project.id).name, 'Fixture');
    assert.equal(reloaded.getAudit(auditId).status, 'completed');
    const stored = await reloaded.getAuditResult(auditId);
    assert.equal(stored.summary.score, result.summary.score);
  });

  test('lists completed audits for the reports page', async () => {
    const res = await json('GET', '/audits?status=completed');
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].projectName, 'Fixture');
  });

  test('updates project settings', async () => {
    const res = await json('PUT', `/projects/${project.id}`, { settings: { maxPages: 5 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.maxPages, 5);
    assert.deepEqual(res.body.settings.targetKeywords, ['seo tools', 'blue gizmo']);
  });

  test('cancels a running audit', async () => {
    const start = await json('POST', `/projects/${project.id}/audits`, {});
    await json('POST', `/audits/${start.body.id}/cancel`, {});
    await runner.whenIdle();
    const audit = await json('GET', `/audits/${start.body.id}`);
    assert.ok(['cancelled', 'completed'].includes(audit.body.status));
  });

  test('deletes a project with its audits and result files', async () => {
    const res = await json('DELETE', `/projects/${project.id}`);
    assert.equal(res.status, 204);
    assert.equal((await json('GET', `/projects/${project.id}`)).status, 404);
    assert.equal((await json('GET', `/audits/${auditId}`)).status, 404);
    await assert.rejects(fs.access(path.join(dataDir, 'audits', `${auditId}.json`)));
  });
});

describe('store recovery', () => {
  test('marks audits interrupted by a restart as failed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seo-analyzer-store-'));
    try {
      const s1 = await new Store(dir).init();
      const p = await s1.createProject({ name: 'x', url: 'https://x.com/', settings: {} });
      const a = await s1.createAudit(p.id);
      await s1.updateAudit(a.id, { status: 'running' });
      const s2 = await new Store(dir).init();
      await s2.recoverInterruptedAudits();
      assert.equal(s2.getAudit(a.id).status, 'failed');
      assert.match(s2.getAudit(a.id).error, /Interrupted/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
