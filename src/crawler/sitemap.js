// XML sitemap discovery and parsing (urlset + sitemapindex, one level deep).

import * as cheerio from 'cheerio';
import { fetchUrl } from './fetcher.js';
import { normalizeUrl } from './url-utils.js';

const MAX_CHILD_SITEMAPS = 20;
const MAX_SITEMAP_URLS = 50000;

export function parseSitemapXml(xml) {
  const $ = cheerio.load(xml, { xml: true });
  const urls = $('urlset > url > loc').map((_, el) => $(el).text().trim()).get();
  const children = $('sitemapindex > sitemap > loc').map((_, el) => $(el).text().trim()).get();
  return { urls, children };
}

/**
 * Fetch sitemaps declared in robots.txt (or /sitemap.xml as a fallback) and
 * return every page URL they list.
 */
export async function loadSitemaps(origin, declared, fetchOptions) {
  const candidates = declared.length ? declared : [`${origin}/sitemap.xml`];
  const found = [];
  const errors = [];
  const urls = new Set();
  const queue = [...candidates];
  const seen = new Set();

  while (queue.length && seen.size < MAX_CHILD_SITEMAPS) {
    const sitemapUrl = queue.shift();
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);
    const res = await fetchUrl(sitemapUrl, { ...fetchOptions, bodyFilter: () => true });
    if (!res.ok || !res.body) {
      errors.push({ url: sitemapUrl, status: res.status, error: res.error });
      continue;
    }
    let parsed;
    try {
      parsed = parseSitemapXml(res.body);
    } catch (err) {
      errors.push({ url: sitemapUrl, status: res.status, error: `Invalid XML: ${err.message}` });
      continue;
    }
    if (!parsed.urls.length && !parsed.children.length) {
      errors.push({ url: sitemapUrl, status: res.status, error: 'No <url> or <sitemap> entries found' });
      continue;
    }
    found.push({ url: sitemapUrl, urlCount: parsed.urls.length, childCount: parsed.children.length });
    for (const child of parsed.children) queue.push(child);
    for (const loc of parsed.urls) {
      const normalized = normalizeUrl(loc);
      if (normalized && urls.size < MAX_SITEMAP_URLS) urls.add(normalized);
    }
  }

  return { sitemaps: found, errors, urls: [...urls] };
}
