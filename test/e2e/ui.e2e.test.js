// Browser end-to-end tests: drives the real UI in headless Chromium against
// a real server, a real file database and the local fixture website.
//
//   npx playwright install chromium   # once
//   npm run test:e2e

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { Store } from '../../src/db/store.js';
import { AuditRunner } from '../../src/audit/runner.js';
import { createApp } from '../../src/app.js';
import { createFixtureSite } from '../fixtures/site.js';
import { startSite, page as htmlPage } from '../helpers/http-site.js';

const XSS_NAME = '<img src=x onerror="window.__xss=1">Acme';

let browser;
let context;
let page;
let server;
let base;
let dataDir;
let runner;
let fixture;
let fixtureUrl;
let slowSite;
let downloadsDir;
const pageErrors = [];

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seo-e2e-'));
  downloadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seo-e2e-dl-'));
  const store = await new Store(dataDir).init();
  runner = new AuditRunner(store, { logger: { error() {}, log() {} } });
  const app = createApp({ store, runner });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/`;
  fixture = createFixtureSite();
  fixtureUrl = await fixture.start();
  slowSite = await startSite({ '/': { delayMs: 4000, body: htmlPage() } });

  try {
    browser = await chromium.launch();
  } catch (err) {
    throw new Error(`Could not launch Chromium. Run "npx playwright install --with-deps chromium" first.\n${err.message}`);
  }
  context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.setDefaultTimeout(15000);
});

after(async () => {
  await browser?.close();
  await runner?.whenIdle();
  await new Promise((resolve) => server?.close(resolve));
  await fixture?.stop();
  await slowSite?.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(downloadsDir, { recursive: true, force: true });
});

const go = async (hash) => {
  await page.goto(base + hash);
};
const api = async (p) => (await page.request.get(base + 'api' + p)).json();
const text = (sel) => page.locator(sel).innerText();
const rows = (scope = '[data-table]') => page.locator(`${scope} tbody tr[data-index]`);
const confirm = async (answer) => {
  await page.locator('.dialog').waitFor();
  await page.click(`.dialog [data-answer="${answer}"]`);
  await page.locator('.dialog').waitFor({ state: 'detached' });
};

let projectId;
let auditId;

describe('UI end-to-end', () => {
  test('dashboard shows an empty state on first run', async () => {
    await go('#/');
    await page.getByRole('heading', { name: 'No projects yet' }).waitFor();
    await page.click('text=Create your first project');
    await page.locator('form').waitFor();
    assert.match(page.url(), /#\/projects\/new$/);
  });

  test('project form shows inline validation errors', async () => {
    await page.click('button[type=submit]:not([data-and-run])');
    await page.locator('[data-error="name"]:not([hidden])').waitFor();
    assert.match(await text('[data-error="url"]'), /valid website URL/);
    assert.equal(await page.locator('#f-name.invalid').count(), 1);

    await page.fill('#f-name', 'Something');
    await page.fill('#f-url', 'example.com');
    await page.fill('#f-maxPages', '99999');
    await page.click('button[type=submit]:not([data-and-run])');
    await page.locator('[data-error="maxPages"]:not([hidden])').waitFor();
    assert.equal(await page.locator('[data-error="name"]').isHidden(), true, 'fixed errors are cleared');
    assert.match(page.url(), /#\/projects\/new$/, 'stays on the form');
  });

  test('create & run audit shows live progress then results', async () => {
    await page.fill('#f-name', XSS_NAME);
    await page.fill('#f-url', fixtureUrl);
    await page.fill('#f-maxPages', '100');
    await page.fill('#f-kw', 'seo tools, blue gizmo');
    await page.click('button[data-and-run]');
    await page.waitForURL(/#\/audits\//);
    auditId = page.url().split('/audits/')[1];
    await page.locator('.tabs').waitFor({ timeout: 60000 });
    const audit = await api(`/audits/${auditId}`);
    projectId = audit.projectId;
    assert.equal(audit.status, 'completed');
    assert.equal(await page.locator('.hero .ring-value').textContent(), String(audit.summary.score));
  });

  test('user-supplied names are rendered as text, never as HTML', async () => {
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.ok((await text('.breadcrumb')).includes(XSS_NAME));
    assert.equal(await page.locator('.breadcrumb img').count(), 0);
  });

  test('overview shows scores, tiles, top issues and site checks', async () => {
    assert.equal(await page.locator('.tab.active').innerText(), 'Overview');
    assert.equal(await page.locator('.bar-row').filter({ hasText: /Meta tags|Content|Links|Images|Technical|Social|Performance/ }).count() >= 7, true);
    const brokenTile = page.locator('.tile').filter({ hasText: 'Broken links' });
    assert.equal(await brokenTile.locator('.tile-value').innerText(), '2');
    assert.ok((await page.locator('[data-goto-issue]').count()) > 0);
    const https = page.locator('.card').filter({ hasText: 'Site-wide checks' });
    assert.match(await https.innerText(), /Served over HTTPS/);
    assert.match(await https.innerText(), /robots\.txt present/);
  });

  test('clicking a top issue opens it on the Issues tab', async () => {
    const first = page.locator('[data-goto-issue]').first();
    const issueId = await first.getAttribute('data-goto-issue');
    await first.click();
    await page.waitForURL(/\/issues$/);
    await page.locator(`.issue[data-issue="${issueId}"][open]`).waitFor();
  });

  test('issues can be filtered by severity, category and search', async () => {
    const all = await page.locator('.issue').count();
    await page.selectOption('[data-f="severity"]', 'error');
    const errors = await page.locator('.issue').count();
    assert.ok(errors > 0 && errors < all);
    for (const sev of await page.locator('.issue summary .sev').allInnerTexts()) assert.match(sev, /Error/);

    await page.selectOption('[data-f="severity"]', '');
    await page.selectOption('[data-f="category"]', 'Images');
    assert.ok((await page.locator('.issue .cat').allInnerTexts()).every((c) => c === 'Images'));

    await page.selectOption('[data-f="category"]', '');
    await page.fill('[data-f="q"]', 'post-1');
    const filtered = await page.locator('.issue').count();
    assert.ok(filtered > 0 && filtered < all);
    await page.fill('[data-f="q"]', 'zzz-no-match');
    await page.getByText('No issues match the filters.').waitFor();
    await page.fill('[data-f="q"]', '');

    await page.locator('details.card summary').filter({ hasText: 'Passed checks' }).click();
    assert.ok((await page.locator('.chip-good').filter({ hasText: 'Pass' }).count()) > 10);
  });

  test('an affected URL opens the page detail drawer', async () => {
    await page.locator('.issue[data-issue="title-too-short"] summary').click();
    await page.locator('.issue[data-issue="title-too-short"] tr[data-page-url]').first().click();
    await page.locator('.drawer').waitFor();
    assert.match(await text('.drawer'), /Title too short/);
    assert.match(await text('.drawer'), /Headings/);
    await page.keyboard.press('Escape');
    await page.locator('.drawer').waitFor({ state: 'detached' });
  });

  test('pages tab: search, filters, sorting and drawer', async () => {
    await page.click('.tab[data-tab="pages"]');
    await page.waitForURL(/\/pages$/);
    await page.locator('[data-filter="type"]').waitFor();
    const total = await rows().count();
    assert.equal(total, (await api(`/audits/${auditId}/results`)).pages.length);

    await page.selectOption('[data-filter="type"]', 'redirect');
    assert.equal(await rows().count(), 1);
    await page.selectOption('[data-filter="type"]', 'blocked');
    assert.match(await rows().first().innerText(), /\/private\/secret/);
    await page.selectOption('[data-filter="type"]', 'error');
    assert.match(await rows().first().innerText(), /broken-page/);
    await page.selectOption('[data-filter="type"]', '');

    await page.fill('[data-role="search"]', 'deep');
    assert.equal(await rows().count(), 3);
    await page.fill('[data-role="search"]', '');

    // Sort by words descending: first row has the most words.
    await page.click('th[data-key="wordCount"]');
    await page.click('th[data-key="wordCount"]');
    assert.match(await page.locator('th[data-key="wordCount"]').innerText(), /▼/);
    const firstWords = Number((await rows().first().locator('td').nth(3).innerText()).replace(/,/g, ''));
    const secondWords = Number((await rows().nth(1).locator('td').nth(3).innerText()).replace(/,/g, '').replace('–', '0'));
    assert.ok(firstWords >= secondWords);

    await rows().first().click();
    await page.locator('.drawer').waitFor();
    await page.click('.drawer [data-close]');
    await page.locator('.drawer').waitFor({ state: 'detached' });
  });

  test('metadata tab filters by problem type', async () => {
    await page.click('.tab[data-tab="metadata"]');
    await page.locator('[data-filter="problem"]').waitFor();
    await page.selectOption('[data-filter="problem"]', 'title-duplicate');
    assert.equal(await rows().count(), 2);
    await page.selectOption('[data-filter="problem"]', 'description-missing');
    assert.ok((await rows().count()) >= 1);
  });

  test('links tab defaults to broken links and drills into sources', async () => {
    await page.click('.tab[data-tab="links"]');
    await page.locator('[data-filter="result"]').waitFor();
    assert.equal(await page.locator('[data-filter="result"]').inputValue(), 'broken');
    assert.equal(await rows().count(), 3); // 2 links + 1 image
    await page.selectOption('[data-filter="type"]', 'external');
    assert.equal(await rows().count(), 1);
    await rows().first().click();
    await page.locator('.drawer').waitFor();
    assert.match(await text('.drawer'), /Found on 1 location/);
    await page.keyboard.press('Escape');
    await page.selectOption('[data-filter="result"]', '');
    await page.selectOption('[data-filter="type"]', '');
    assert.ok((await rows().count()) > 3);
  });

  test('images, keywords and structure tabs render their data', async () => {
    await page.click('.tab[data-tab="images"]');
    await page.locator('[data-filter="alt"]').waitFor();
    assert.equal(await page.locator('[data-filter="alt"]').inputValue(), 'missing');
    assert.equal(await rows().count(), 1);

    await page.click('.tab[data-tab="keywords"]');
    await page.locator('[data-kw-page]').waitFor();
    const targets = page.locator('.card').filter({ hasText: 'Target keywords' }).first().locator('tbody tr');
    assert.equal(await targets.count(), 2);
    const options = await page.locator('[data-kw-page] option').count();
    assert.ok(options > 3);
    await page.selectOption('[data-kw-page]', { index: 3 });
    await page.locator('[data-kw-body]').filter({ hasText: 'words' }).waitFor();

    await page.click('.tab[data-tab="structure"]');
    await page.locator('.tree').waitFor();
    assert.match(await text('.tree'), /\/blog/);
    const orphans = page.locator('.card').filter({ hasText: 'Orphan pages' });
    assert.match(await orphans.innerText(), /\/orphan/);
    const blog = page.locator('.tree details').filter({ hasText: '/post-1' }).first();
    assert.equal(await blog.getAttribute('open'), '');
    await blog.locator('> summary').click();
    assert.equal(await blog.getAttribute('open'), null, 'tree nodes collapse');
  });

  test('deep links to a tab work on a fresh load', async () => {
    await go(`#/audits/${auditId}/keywords`);
    await page.locator('.tab.active[data-tab="keywords"]').waitFor();
    await page.goBack();
    await page.goForward();
    await page.locator('.tab.active[data-tab="keywords"]').waitFor();
  });

  test('PDF and Excel reports download with valid contents', async () => {
    await go(`#/audits/${auditId}`);
    await page.locator('.tabs').waitFor();
    for (const [fmt, magic] of [['pdf', '%PDF-'], ['xlsx', 'PK']]) {
      const [download] = await Promise.all([page.waitForEvent('download'), page.click(`.page-head a[href$="report.${fmt}"]`)]);
      assert.match(download.suggestedFilename(), new RegExp(`^seo-report-.+\\.${fmt}$`));
      const file = path.join(downloadsDir, download.suggestedFilename());
      await download.saveAs(file);
      const buf = await fs.readFile(file);
      assert.ok(buf.length > 1000);
      assert.equal(buf.subarray(0, magic.length).toString(), magic);
    }
  });

  test('re-running an audit adds history and a score trend', async () => {
    await page.click('[data-rerun]');
    await page.waitForURL((url) => !url.href.endsWith(auditId) && /#\/audits\//.test(url.href));
    await page.locator('.tabs').waitFor({ timeout: 60000 });
    await go(`#/projects/${projectId}`);
    await page.locator('[data-history] tbody tr[data-index]').nth(1).waitFor();
    assert.equal(await rows('[data-history]').count(), 2);
    await page.locator('[data-trend] svg').waitFor();
    // Hovering the chart shows a tooltip.
    await page.locator('[data-trend] svg').hover();
    await page.locator('.tooltip:not([hidden])').waitFor();
  });

  test('deleting an audit asks for confirmation', async () => {
    await page.locator('[data-delete-audit]').first().click();
    await confirm('no');
    assert.equal(await rows('[data-history]').count(), 2, 'cancel keeps it');
    await page.locator('[data-delete-audit]').first().click();
    await confirm('yes');
    await page.locator('.toast').filter({ hasText: 'Audit deleted' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-history] tbody tr[data-index]').length === 1);
  });

  test('editing settings validates and saves', async () => {
    await page.click('a[href$="/edit"]');
    await page.locator('form').waitFor();
    assert.equal(await page.inputValue('#f-name'), XSS_NAME);
    assert.match(await page.inputValue('#f-kw'), /seo tools, blue gizmo/);
    await page.fill('#f-maxDepth', '99');
    await page.click('button[type=submit]');
    await page.locator('[data-error="maxDepth"]:not([hidden])').waitFor();
    await page.fill('#f-maxDepth', '3');
    await page.uncheck('input[name="checkExternalLinks"]');
    await page.click('button[type=submit]');
    await page.waitForURL(new RegExp(`#/projects/${projectId}$`));
    const config = page.locator('.card').filter({ hasText: 'Configuration' });
    await config.waitFor();
    assert.match(await config.innerText(), /Max depth\s*3/);
    assert.match(await config.innerText(), /External links\s*skipped/);
  });

  test('a running audit can be cancelled from the project page', async () => {
    const res = await page.request.post(base + 'api/projects', { data: { name: 'Slow site', url: slowSite.url } });
    const slow = await res.json();
    await go(`#/projects/${slow.id}`);
    await page.click('button[data-run]');
    await page.locator('[data-progress]').waitFor();
    await page.click('[data-cancel]');
    await page.locator('[data-history] .chip').filter({ hasText: 'Cancelled' }).waitFor({ timeout: 20000 });
    assert.equal(await page.locator('[data-progress]').count(), 0);
    assert.equal(await page.locator('button[data-run]').first().isEnabled(), true);
  });

  test('reports page lists completed audits with a project filter', async () => {
    await go('#/reports');
    await rows().first().waitFor();
    const completed = (await api('/audits?status=completed')).length;
    assert.equal(await rows().count(), completed);
    await page.selectOption('[data-filter="project"]', projectId);
    assert.equal(await rows().count(), 1);
    await rows().first().locator('a.btn-primary').click();
    await page.locator('.tabs').waitFor();
  });

  test('dashboard cards reflect the latest audits', async () => {
    await go('#/');
    await page.locator('.project-card').nth(1).waitFor();
    assert.equal(await page.locator('.project-card').count(), 2);
    const card = page.locator('.project-card').filter({ hasText: 'Acme' });
    assert.match(await card.innerText(), /Completed/);
    assert.match(await card.locator('.ring-value').textContent(), /^\d+$/);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
  });

  test('unknown routes show a not-found page', async () => {
    await go('#/definitely/not/a/route');
    await page.getByRole('heading', { name: 'Page not found' }).waitFor();
    await go('#/projects/00000000-0000-0000-0000-000000000000');
    await page.getByRole('heading', { name: 'Not found' }).waitFor();
  });

  test('theme toggle cycles and persists across reloads', async () => {
    await go('#/');
    await page.locator('#theme-toggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await page.locator('#theme-toggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.locator('#theme-toggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), undefined);
  });

  test('phone-width layout never scrolls horizontally', async () => {
    await page.setViewportSize({ width: 400, height: 800 });
    const tabs = ['', '/issues', '/pages', '/metadata', '/links', '/images', '/keywords', '/structure'].map((t) => `#/audits/${auditId}${t}`);
    for (const hash of ['#/', `#/projects/${projectId}`, '#/reports', '#/projects/new', ...tabs]) {
      await go(hash);
      await page.locator('.page-head, .breadcrumb').first().waitFor();
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${hash} overflows by ${overflow}px`);
    }
    await page.setViewportSize({ width: 1360, height: 900 });
  });

  test('deleting a project asks for confirmation and removes it', async () => {
    await go(`#/projects/${projectId}`);
    await page.click('[data-delete-project]');
    await confirm('yes');
    await page.waitForURL(/#\/$/);
    await page.locator('.project-card').first().waitFor();
    assert.equal(await page.locator('.project-card').count(), 1);
    const res = await page.request.get(`${base}api/projects/${projectId}`);
    assert.equal(res.status(), 404);
  });

  test('no uncaught JavaScript errors happened', () => {
    assert.deepEqual(pageErrors, []);
  });
});
