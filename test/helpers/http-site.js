// Helpers to spin up throwaway websites for tests and audit them.

import http from 'node:http';
import { crawlSite } from '../../src/crawler/crawler.js';
import { runSiteProbes } from '../../src/analyzer/site-probes.js';
import { evaluate } from '../../src/analyzer/evaluate.js';
import { DEFAULT_SETTINGS } from '../../src/projects/validation.js';

/** A complete, healthy HTML page; override any part. */
export function page({ title = 'A perfectly reasonable page title here', description, body = '', head = '', lang = 'en' } = {}) {
  const desc = description ?? 'A meta description that is long enough to be within the recommended range for search results.';
  return `<!doctype html><html${lang ? ` lang="${lang}"` : ''}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${title != null ? `<title>${title}</title>` : ''}${desc ? `<meta name="description" content="${desc}">` : ''}${head}
</head><body>${body}</body></html>`;
}

/**
 * Start a site from a route table. A route value can be:
 *   - a string            -> 200 text/html
 *   - { status, type, body, headers, delayMs }
 *   - (req, res, ctx) => void   full control
 * Unknown paths return 404 unless `fallback` is given.
 */
export async function startSite(routes, { fallback } = {}) {
  const sockets = new Set();
  const hits = [];
  let origin;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    hits.push({ method: req.method, path: url.pathname + url.search });
    const route = routes[url.pathname + url.search] ?? routes[url.pathname] ?? fallback;
    const ctx = { origin, url };
    try {
      if (route == null) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end(req.method === 'HEAD' ? undefined : page({ title: 'Not found', body: '<h1>404</h1>' }));
      }
      const spec = typeof route === 'function' ? await route(req, res, ctx) : route;
      if (res.headersSent || res.writableEnded || req.socket.destroyed) return;
      const r = typeof spec === 'string' ? { body: spec } : spec ?? {};
      if (r.delayMs) await new Promise((resolve) => setTimeout(resolve, r.delayMs));
      if (res.destroyed) return;
      res.writeHead(r.status ?? 200, { 'Content-Type': r.type ?? 'text/html; charset=utf-8', ...r.headers });
      const body = typeof r.body === 'function' ? r.body(ctx) : r.body;
      res.end(req.method === 'HEAD' ? undefined : body ?? '');
    } catch (err) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    url: `${origin}/`,
    port,
    hits,
    stop() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export const testSettings = (overrides = {}) => ({ ...DEFAULT_SETTINGS, timeoutMs: 3000, concurrency: 4, ...overrides });

/** Run probes + crawl + evaluation exactly like the audit runner does. */
export async function auditSite(startUrl, overrides = {}) {
  const settings = testSettings(overrides);
  const probes = await runSiteProbes(startUrl, { timeoutMs: settings.timeoutMs });
  const crawl = await crawlSite({ startUrl, settings });
  return evaluate(crawl, probes, settings);
}

export const pathOf = (url) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

export const pageAt = (result, path) => result.pages.find((p) => pathOf(p.url) === path);
export const issueOf = (result, id) => result.issues.find((i) => i.id === id);
export const affected = (result, id) => (issueOf(result, id)?.affected ?? []).map((a) => pathOf(a.url)).sort();
