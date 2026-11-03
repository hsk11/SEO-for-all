// Breadth-first site crawler.
//
// Crawls level by level so every page's depth is its true shortest click
// distance from the start URL. Within a level, pages are fetched with a
// bounded concurrency pool.

import { fetchUrl, checkUrl, DEFAULT_USER_AGENT } from './fetcher.js';
import { parseRobots, isAllowed } from './robots.js';
import { loadSitemaps } from './sitemap.js';
import { isInternalUrl, looksLikeNonHtml, normalizeUrl, originOf } from './url-utils.js';
import { analyzePage } from '../analyzer/page-analyzer.js';

/** Run `worker` over `items` with at most `limit` in flight. */
export async function mapPool(items, limit, worker, signal) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const isHtmlType = (contentType) => /text\/html|application\/xhtml\+xml/i.test(contentType || '');

function pageShell(url, depth, fetched) {
  return {
    url,
    finalUrl: fetched?.finalUrl ?? url,
    depth,
    status: fetched?.status ?? null,
    error: fetched?.error ?? null,
    contentType: fetched?.contentType ?? '',
    responseTimeMs: fetched?.responseTimeMs ?? 0,
    sizeBytes: fetched?.sizeBytes ?? 0,
    redirectChain: fetched?.redirectChain ?? [],
    isRedirect: false,
    redirectTarget: null,
    isHtml: false,
    blockedByRobots: false,
    analyzed: false,
    inlinks: 0,
    inSitemap: false,
  };
}

/**
 * @param {object} options
 * @param {string} options.startUrl
 * @param {object} options.settings   project settings (see projects/validation.js)
 * @param {(p: object) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 */
export async function crawlSite({ startUrl, settings, onProgress = () => {}, signal }) {
  const {
    maxPages = 100,
    maxDepth = 5,
    concurrency = 4,
    timeoutMs = 15000,
    respectRobots = true,
    includeSubdomains = false,
    checkExternalLinks = true,
    maxLinkChecks = 500,
    userAgent = DEFAULT_USER_AGENT,
    targetKeywords = [],
  } = settings;

  const fetchOptions = { timeoutMs, userAgent, signal };
  const origin = originOf(startUrl);
  const ctx = { rootUrl: startUrl, includeSubdomains, targetKeywords };

  // ---------------------------------------------------------- robots + sitemap
  onProgress({ phase: 'discovery', message: 'Reading robots.txt and sitemap.xml', percent: 2 });
  const robotsRes = await fetchUrl(`${origin}/robots.txt`, { ...fetchOptions, bodyFilter: () => true });
  const robotsFound = robotsRes.status === 200 && robotsRes.body != null && !isHtmlType(robotsRes.contentType);
  const robots = robotsFound ? parseRobots(robotsRes.body) : null;
  const sitemap = await loadSitemaps(origin, robots?.sitemaps ?? [], fetchOptions);
  const sitemapUrls = new Set(sitemap.urls);

  // ------------------------------------------------------------------- crawl
  const pages = new Map(); // url -> page record
  const seen = new Set([startUrl]);
  const linkSources = new Map(); // target url -> [{ page, anchor, nofollow, kind }]
  let level = [startUrl];
  let depth = 0;

  const addSource = (target, source) => {
    if (!linkSources.has(target)) linkSources.set(target, []);
    linkSources.get(target).push(source);
  };

  const crawlOne = async (url) => {
    if (pages.size >= maxPages) return [];
    if (respectRobots && robots && !isAllowed(robots, url, userAgent)) {
      const page = pageShell(url, depth, null);
      page.blockedByRobots = true;
      page.error = 'Blocked by robots.txt';
      pages.set(url, page);
      return [];
    }

    const fetched = await fetchUrl(url, fetchOptions);
    if (pages.size >= maxPages) return [];
    let page = pageShell(url, depth, fetched);
    pages.set(url, page);

    // A redirect gets its own record; the destination becomes a page of its own
    // (re-using the response we already have) if it is internal and new.
    if (fetched.redirectChain.length && normalizeUrl(fetched.finalUrl) !== url) {
      page.isRedirect = true;
      page.redirectTarget = fetched.finalUrl;
      page.status = fetched.redirectChain[0].status;
      const target = normalizeUrl(fetched.finalUrl);
      if (!target || !isInternalUrl(target, startUrl, ctx) || seen.has(target) || pages.size >= maxPages) return [];
      seen.add(target);
      page = pageShell(target, depth, { ...fetched, redirectChain: [] });
      pages.set(target, page);
    }

    // An empty 200 HTML body is still analysed (and flagged for everything it lacks).
    if (fetched.error || !isHtmlType(fetched.contentType) || fetched.body == null) return [];
    page.isHtml = true;
    if (!fetched.ok) return [];

    Object.assign(page, analyzePage(fetched, ctx), { analyzed: true });

    const discovered = [];
    for (const link of page.links) {
      addSource(link.url, { page: page.url, anchor: link.anchor, nofollow: link.nofollow, kind: 'link' });
      if (!link.internal || seen.has(link.url)) continue;
      seen.add(link.url);
      discovered.push(link.url);
    }
    for (const img of page.images) {
      if (/^https?:/i.test(img.src)) addSource(img.src, { page: page.url, anchor: img.alt || '', nofollow: false, kind: 'image' });
    }
    // Pages marked nofollow are still analysed but their links are not followed.
    return page.nofollowPage && respectRobots ? [] : discovered;
  };

  while (level.length && pages.size < maxPages && depth <= maxDepth) {
    signal?.throwIfAborted();
    const crawlable = level.filter((u) => !looksLikeNonHtml(u));
    const nextLevel = [];
    await mapPool(
      crawlable,
      concurrency,
      async (url) => {
        const found = await crawlOne(url);
        nextLevel.push(...found);
        onProgress({
          phase: 'crawling',
          message: `Crawling ${url}`,
          pagesCrawled: pages.size,
          pagesQueued: nextLevel.length + Math.max(0, crawlable.length - pages.size),
          percent: Math.min(70, 5 + Math.round((pages.size / maxPages) * 65)),
        });
      },
      signal,
    );
    level = nextLevel;
    depth++;
  }

  // Sitemap-only URLs (never reached by links) are orphan candidates.
  for (const page of pages.values()) {
    page.inSitemap = sitemapUrls.has(page.url) || sitemapUrls.has(page.finalUrl);
  }

  // ------------------------------------------------------------- link checks
  const links = await checkLinks({
    linkSources,
    pages,
    startUrl,
    ctx,
    checkExternalLinks,
    maxLinkChecks,
    concurrency: Math.max(concurrency, 4),
    fetchOptions,
    onProgress,
    signal,
  });

  // Inlinks: count distinct linking pages for each crawled page.
  for (const [target, sources] of linkSources) {
    const page = pages.get(target);
    if (page) page.inlinks = new Set(sources.filter((s) => s.kind === 'link' && s.page !== target).map((s) => s.page)).size;
  }

  return {
    startUrl,
    pages: [...pages.values()],
    links,
    robots: {
      found: robotsFound,
      status: robotsRes.status,
      error: robotsRes.error,
      sitemaps: robots?.sitemaps ?? [],
      content: robotsFound ? robotsRes.body.slice(0, 20000) : null,
    },
    sitemap: {
      found: sitemap.sitemaps.length > 0,
      sitemaps: sitemap.sitemaps,
      errors: sitemap.errors,
      urlCount: sitemap.urls.length,
      urls: sitemap.urls.slice(0, 5000),
    },
    limits: {
      maxPages,
      maxDepth,
      reachedPageLimit: pages.size >= maxPages,
    },
  };
}

async function checkLinks({ linkSources, pages, startUrl, ctx, checkExternalLinks, maxLinkChecks, concurrency, fetchOptions, onProgress, signal }) {
  const records = [];
  const toCheck = [];

  for (const [url, sources] of linkSources) {
    const internal = isInternalUrl(url, startUrl, ctx);
    const kind = sources.every((s) => s.kind === 'image') ? 'image' : 'link';
    const record = { url, internal, kind, status: null, ok: null, error: null, finalUrl: url, redirectChain: [], checked: false, sources };
    records.push(record);

    const crawled = pages.get(url);
    if (crawled && !crawled.blockedByRobots) {
      Object.assign(record, {
        status: crawled.status,
        ok: !crawled.error && crawled.status != null && (crawled.status < 400),
        error: crawled.error,
        finalUrl: crawled.isRedirect ? crawled.redirectTarget : crawled.finalUrl,
        redirectChain: crawled.redirectChain,
        checked: true,
      });
    } else if (internal || checkExternalLinks || kind === 'image') {
      toCheck.push(record);
    }
  }

  // Internal links and images first, so the cap trims external links before anything else.
  toCheck.sort((a, b) => Number(b.internal) - Number(a.internal) || (a.kind === 'image' ? -1 : 1));
  const batch = toCheck.slice(0, maxLinkChecks);
  let done = 0;

  await mapPool(
    batch,
    concurrency,
    async (record) => {
      const res = await checkUrl(record.url, fetchOptions);
      Object.assign(record, {
        status: res.status,
        ok: !res.error && res.status != null && res.status < 400,
        error: res.error,
        finalUrl: res.finalUrl,
        redirectChain: res.redirectChain,
        checked: true,
      });
      done++;
      onProgress({
        phase: 'links',
        message: `Checking links (${done}/${batch.length})`,
        linksChecked: done,
        linksTotal: batch.length,
        percent: 70 + Math.round((done / Math.max(1, batch.length)) * 20),
      });
    },
    signal,
  );

  return records;
}
