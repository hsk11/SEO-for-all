// API edge cases: error handling, validation boundaries, the audit queue,
// cancellation, conflicts, odd input and static file serving.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/db/store.js';
import { AuditRunner } from '../src/audit/runner.js';
import { createApp } from '../src/app.js';
import { startSite, page } from './helpers/http-site.js';

let dataDir;
let store;
let runner;
let server;
let base;
let fastSite;
let slowSite;

const quiet = { error() {}, log() {} };

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seo-api-edge-'));
  store = await new Store(dataDir).init();
  // One audit at a time so the queue can be observed.
  runner = new AuditRunner(store, { maxConcurrent: 1, logger: quiet });
  const app = createApp({ store, runner });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  fastSite = await startSite({ '/': page({ body: '<h1>Fast</h1><a href="/a">a</a>' }), '/a': page() });
  slowSite = await startSite({ '/': { delayMs: 800, body: page({ body: '<a href="/b">b</a>' }) }, '/b': { delayMs: 800, body: page() } });
});

after(async () => {
  for (const audit of store.listAudits()) {
    if (['queued', 'running'].includes(audit.status)) await runner.cancel(audit.id).catch(() => {});
  }
  await runner.whenIdle();
  await new Promise((resolve) => server.close(resolve));
  await fastSite.stop();
  await slowSite.stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function call(method, url, body, { raw } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined || raw ? { 'Content-Type': 'application/json' } : {},
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
}

const createProject = async (name, url, settings = {}) => {
  const res = await call('POST', '/api/projects', { name, url, settings });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

const waitFor = async (predicate, timeoutMs = 10000) => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('error handling', () => {
  test('unknown API routes return JSON 404', async () => {
    const res = await call('GET', '/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Not found');
  });

  test('unknown project and audit ids return JSON 404', async () => {
    for (const url of ['/api/projects/does-not-exist', '/api/audits/does-not-exist', '/api/audits/does-not-exist/report.pdf', '/api/projects/x/audits']) {
      const res = await call('GET', url);
      assert.equal(res.status, 404, url);
      assert.match(res.body.error, /not found/i, url);
    }
    assert.equal((await call('POST', '/api/projects/missing/audits', {})).status, 404);
    assert.equal((await call('DELETE', '/api/projects/missing')).status, 404);
    assert.equal((await call('POST', '/api/audits/missing/cancel', {})).status, 404);
  });

  test('malformed JSON returns a JSON 400', async () => {
    const res = await call('POST', '/api/projects', undefined, { raw: '{"name": "oops",' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Request body is not valid JSON.');
  });

  test('oversized bodies are rejected with 413', async () => {
    const res = await call('POST', '/api/projects', { name: 'x'.repeat(200_000), url: 'example.com' });
    assert.equal(res.status, 413);
    assert.ok(res.body.error);
  });

  test('path traversal in ids never touches the file system', async () => {
    const res = await call('GET', '/api/audits/..%2F..%2Fdb/results');
    assert.equal(res.status, 404);
    await assert.rejects(store.getAuditResult('../../db'), /not found/i);
  });
});

describe('validation boundaries', () => {
  const cases = [
    [{ name: '', url: 'example.com' }, 'name'],
    [{ name: '   ', url: 'example.com' }, 'name'],
    [{ name: 'x'.repeat(101), url: 'example.com' }, 'name'],
    [{ name: 'ok' }, 'url'],
    [{ name: 'ok', url: 'ftp://example.com' }, 'url'],
    [{ name: 'ok', url: 'http://' }, 'url'],
    [{ name: 'ok', url: 'nodot' }, 'url'],
    [{ name: 'ok', url: 'example.com', settings: { maxPages: 0 } }, 'maxPages'],
    [{ name: 'ok', url: 'example.com', settings: { maxPages: 2001 } }, 'maxPages'],
    [{ name: 'ok', url: 'example.com', settings: { maxPages: 1.5 } }, 'maxPages'],
    [{ name: 'ok', url: 'example.com', settings: { maxPages: 'lots' } }, 'maxPages'],
    [{ name: 'ok', url: 'example.com', settings: { maxDepth: -1 } }, 'maxDepth'],
    [{ name: 'ok', url: 'example.com', settings: { concurrency: 17 } }, 'concurrency'],
    [{ name: 'ok', url: 'example.com', settings: { timeoutMs: 999 } }, 'timeoutMs'],
    [{ name: 'ok', url: 'example.com', settings: { targetKeywords: Array.from({ length: 26 }, (_, i) => `kw${i}`) } }, 'targetKeywords'],
  ];
  for (const [body, field] of cases) {
    test(`rejects invalid ${field}: ${JSON.stringify(body).slice(0, 70)}`, async () => {
      const res = await call('POST', '/api/projects', body);
      assert.equal(res.status, 400);
      assert.ok(res.body.fields[field], `expected an error for ${field}, got ${JSON.stringify(res.body.fields)}`);
    });
  }

  test('accepts the limits and normalises values', async () => {
    const res = await call('POST', '/api/projects', {
      name: '  Edge  ',
      url: '  HTTP://Example.COM:80/path#frag ',
      settings: { maxPages: 2000, maxDepth: 0, concurrency: 16, timeoutMs: 60000, maxLinkChecks: 0, targetKeywords: 'SEO, seo ,  long   tail  , ,', checkExternalLinks: 'false' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Edge');
    assert.equal(res.body.url, 'http://example.com/path');
    assert.deepEqual(res.body.settings.targetKeywords, ['SEO', 'long tail']);
    assert.equal(res.body.settings.checkExternalLinks, false);
    assert.equal(res.body.settings.maxDepth, 0);
  });

  test('a rejected update leaves the project unchanged', async () => {
    const p = await createProject('Unchanged', 'example.org');
    const res = await call('PUT', `/api/projects/${p.id}`, { name: 'New name', settings: { maxPages: 99999 } });
    assert.equal(res.status, 400);
    assert.equal((await call('GET', `/api/projects/${p.id}`)).body.name, 'Unchanged');
  });

  test('stores odd and hostile names verbatim (escaping is the UI\'s job)', async () => {
    const name = '<img src=x onerror=alert(1)> Ünïcødé 日本';
    const p = await createProject(name, 'example.net');
    assert.equal((await call('GET', `/api/projects/${p.id}`)).body.name, name);
  });
});

describe('audit lifecycle', () => {
  test('audits queue when the concurrency limit is reached, then all complete', async () => {
    const slow = await createProject('Slow', slowSite.url);
    const fast = await createProject('Fast', fastSite.url);
    const a1 = (await call('POST', `/api/projects/${slow.id}/audits`, {})).body;
    const a2 = (await call('POST', `/api/projects/${fast.id}/audits`, {})).body;
    await waitFor(async () => (await call('GET', `/api/audits/${a1.id}`)).body.status === 'running');
    assert.equal((await call('GET', `/api/audits/${a2.id}`)).body.status, 'queued');

    // While running: results, reports and deletes are refused.
    assert.equal((await call('GET', `/api/audits/${a1.id}/results`)).status, 409);
    assert.equal((await call('GET', `/api/audits/${a1.id}/report.pdf`)).status, 409);
    assert.equal((await call('DELETE', `/api/audits/${a1.id}`)).status, 409);
    assert.equal((await call('DELETE', `/api/projects/${slow.id}`)).status, 409);
    const dup = await call('POST', `/api/projects/${slow.id}/audits`, {});
    assert.equal(dup.status, 409);
    assert.equal(dup.body.auditId, a1.id);

    // Progress is reported while running.
    const progress = (await call('GET', `/api/audits/${a1.id}`)).body.progress;
    assert.ok(progress.percent >= 0 && progress.percent <= 100);

    await runner.whenIdle();
    for (const id of [a1.id, a2.id]) {
      const audit = (await call('GET', `/api/audits/${id}`)).body;
      assert.equal(audit.status, 'completed', audit.error);
      assert.equal(audit.progress.percent, 100);
      assert.ok(new Date(audit.finishedAt) >= new Date(audit.startedAt));
    }
  });

  test('changing settings mid-audit does not affect the running audit', async () => {
    const p = await createProject('Snapshot', slowSite.url, { maxPages: 5 });
    const a = (await call('POST', `/api/projects/${p.id}/audits`, {})).body;
    await call('PUT', `/api/projects/${p.id}`, { settings: { maxPages: 1 } });
    await runner.whenIdle();
    const result = (await call('GET', `/api/audits/${a.id}/results`)).body;
    assert.equal(result.audit.settings.maxPages, 5);
    assert.equal(result.pages.length, 2);
  });

  test('cancelling a queued audit removes it from the queue', async () => {
    const blocker = await createProject('Blocker', slowSite.url);
    const queued = await createProject('Queued', fastSite.url);
    const b = (await call('POST', `/api/projects/${blocker.id}/audits`, {})).body;
    const q = (await call('POST', `/api/projects/${queued.id}/audits`, {})).body;
    const res = await call('POST', `/api/audits/${q.id}/cancel`, {});
    assert.equal(res.body.status, 'cancelled');
    await runner.whenIdle();
    assert.equal((await call('GET', `/api/audits/${q.id}`)).body.status, 'cancelled', 'never ran');
    assert.equal((await call('GET', `/api/audits/${b.id}`)).body.status, 'completed');
    assert.equal(store.getAudit(q.id).startedAt, null);
  });

  test('cancelling a running audit stops it; cancelling a finished one is a no-op', async () => {
    const p = await createProject('Cancel me', slowSite.url);
    const a = (await call('POST', `/api/projects/${p.id}/audits`, {})).body;
    await waitFor(async () => (await call('GET', `/api/audits/${a.id}`)).body.status === 'running');
    await call('POST', `/api/audits/${a.id}/cancel`, {});
    await runner.whenIdle();
    const audit = (await call('GET', `/api/audits/${a.id}`)).body;
    assert.equal(audit.status, 'cancelled');
    assert.equal((await call('GET', `/api/audits/${a.id}/results`)).status, 409);
    assert.equal((await call('GET', `/api/audits/${a.id}/report.xlsx`)).status, 409);

    // A cancelled audit can be deleted and a new one started.
    assert.equal((await call('POST', `/api/audits/${a.id}/cancel`, {})).body.status, 'cancelled');
    assert.equal((await call('DELETE', `/api/audits/${a.id}`)).status, 204);
    const again = await call('POST', `/api/projects/${p.id}/audits`, {});
    assert.equal(again.status, 202);
    await runner.whenIdle();
    assert.equal((await call('POST', `/api/audits/${again.body.id}/cancel`, {})).body.status, 'completed');
  });

  test('an audit of an unreachable site completes and still produces reports', async () => {
    const dead = await startSite({});
    const url = dead.url;
    await dead.stop();
    const p = await createProject('Ünïcødé ✓ 日本語 site', url, { timeoutMs: 1000 });
    const a = (await call('POST', `/api/projects/${p.id}/audits`, {})).body;
    await runner.whenIdle();
    const audit = (await call('GET', `/api/audits/${a.id}`)).body;
    assert.equal(audit.status, 'completed', audit.error);
    assert.equal(audit.summary.htmlPages, 0);

    const pdf = await fetch(`${base}/api/audits/${a.id}/report.pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    // Non-ASCII names: UTF-8 filename* for browsers, plus an ASCII-only fallback.
    const disposition = pdf.headers.get('content-disposition');
    assert.ok(disposition.includes(`filename*=UTF-8''${encodeURIComponent('seo-report-ünïcødé-日本語-site')}`), disposition);
    assert.match(disposition, /filename="seo-report-[\x20-\x7e]+\.pdf"/);

    const xlsx = await fetch(`${base}/api/audits/${a.id}/report.xlsx`);
    assert.equal(xlsx.status, 200);
    assert.equal(Buffer.from(await xlsx.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  });

  test('audit list filters by status and project', async () => {
    const all = (await call('GET', '/api/audits')).body;
    const completed = (await call('GET', '/api/audits?status=completed')).body;
    assert.ok(completed.length > 0 && completed.length < all.length);
    assert.ok(completed.every((a) => a.status === 'completed'));
    const projectId = completed[0].projectId;
    const forProject = (await call('GET', `/api/audits?projectId=${projectId}`)).body;
    assert.ok(forProject.every((a) => a.projectId === projectId));
    // newest first
    const times = all.map((a) => a.createdAt);
    assert.deepEqual(times, [...times].sort().reverse());
  });

  test('project list includes the latest audit summary', async () => {
    const projects = (await call('GET', '/api/projects')).body;
    const fast = projects.find((p) => p.name === 'Fast');
    assert.equal(fast.latestCompletedAudit.status, 'completed');
    assert.ok(typeof fast.latestCompletedAudit.summary.score === 'number');
    assert.equal(fast.auditCount, 1);
  });

  test('meta endpoint exposes defaults and the check catalogue without functions', async () => {
    const meta = (await call('GET', '/api/meta')).body;
    assert.equal(meta.defaults.maxPages, 100);
    assert.ok(meta.checks.page.length > 40);
    assert.ok(meta.checks.page.every((c) => c.id && c.title && c.recommendation && !('test' in c)));
  });
});

describe('static UI', () => {
  test('serves the app shell and assets but nothing outside public/', async () => {
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /<div class="container" id="view">/);
    assert.equal((await fetch(`${base}/js/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/css/styles.css`)).status, 200);
    for (const p of ['/../package.json', '/%2e%2e/package.json', '/src/app.js', '/data/db.json']) {
      const res = await fetch(base + p);
      assert.notEqual(res.status, 200, p);
    }
    assert.equal((await fetch(`${base}/`)).headers.get('x-powered-by'), null);
  });
});
