import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed } from '../src/crawler/robots.js';
import { normalizeUrl, normalizeStartUrl, isInternalUrl, looksLikeNonHtml } from '../src/crawler/url-utils.js';
import { tokenize, countPhrase, analyzeKeywords } from '../src/analyzer/keywords.js';
import { analyzePage } from '../src/analyzer/page-analyzer.js';
import { parseSitemapXml } from '../src/crawler/sitemap.js';
import { validateProject, ValidationError } from '../src/projects/validation.js';

describe('url utils', () => {
  test('normalizeUrl resolves, strips fragments and rejects non-http schemes', () => {
    assert.equal(normalizeUrl('/a/b#top', 'https://Example.com:443/x'), 'https://example.com/a/b');
    assert.equal(normalizeUrl('mailto:me@example.com', 'https://example.com'), null);
    assert.equal(normalizeUrl('javascript:void(0)', 'https://example.com'), null);
    assert.equal(normalizeUrl('#section', 'https://example.com'), null);
  });

  test('normalizeStartUrl adds a scheme and rejects junk', () => {
    assert.equal(normalizeStartUrl('example.com'), 'https://example.com/');
    assert.equal(normalizeStartUrl('http://localhost:3000'), 'http://localhost:3000/');
    assert.equal(normalizeStartUrl('not a url'), null);
    assert.equal(normalizeStartUrl(''), null);
  });

  test('isInternalUrl treats www as the same site and subdomains only on request', () => {
    assert.ok(isInternalUrl('https://www.example.com/a', 'https://example.com/'));
    assert.ok(!isInternalUrl('https://blog.example.com/', 'https://example.com/'));
    assert.ok(isInternalUrl('https://blog.example.com/', 'https://example.com/', { includeSubdomains: true }));
    assert.ok(!isInternalUrl('https://example.org/', 'https://example.com/'));
  });

  test('looksLikeNonHtml detects file downloads', () => {
    assert.ok(looksLikeNonHtml('https://x.com/file.PDF'));
    assert.ok(!looksLikeNonHtml('https://x.com/page.html'));
    assert.ok(!looksLikeNonHtml('https://x.com/blog/'));
  });
});

describe('robots.txt', () => {
  const robots = parseRobots(`
    User-agent: *
    Disallow: /private/
    Allow: /private/public-page
    Disallow: /*.json$

    User-agent: SEOAnalyzerBot
    Disallow: /bot-only/

    Sitemap: https://example.com/sitemap.xml
  `);

  test('extracts sitemaps', () => {
    assert.deepEqual(robots.sitemaps, ['https://example.com/sitemap.xml']);
  });

  test('applies longest-match rules for the generic group', () => {
    assert.equal(isAllowed(robots, 'https://example.com/private/x', 'OtherBot'), false);
    assert.equal(isAllowed(robots, 'https://example.com/private/public-page', 'OtherBot'), true);
    assert.equal(isAllowed(robots, 'https://example.com/data.json', 'OtherBot'), false);
    assert.equal(isAllowed(robots, 'https://example.com/data.json?x=1', 'OtherBot'), true);
    assert.equal(isAllowed(robots, 'https://example.com/', 'OtherBot'), true);
  });

  test('a specific user-agent group replaces the generic one', () => {
    const ua = 'Mozilla/5.0 (compatible; SEOAnalyzerBot/1.0)';
    assert.equal(isAllowed(robots, 'https://example.com/bot-only/a', ua), false);
    assert.equal(isAllowed(robots, 'https://example.com/private/x', ua), true);
  });
});

describe('sitemap parsing', () => {
  test('reads urlset and sitemapindex entries', () => {
    const urlset = parseSitemapXml('<urlset><url><loc> https://a.com/1 </loc></url><url><loc>https://a.com/2</loc></url></urlset>');
    assert.deepEqual(urlset.urls, ['https://a.com/1', 'https://a.com/2']);
    const index = parseSitemapXml('<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>');
    assert.deepEqual(index.children, ['https://a.com/s1.xml']);
  });
});

describe('keywords', () => {
  test('tokenize is unicode aware and keeps contractions', () => {
    assert.deepEqual(tokenize("Don't stop — café SEO-tools 2024!"), ["don't", 'stop', 'café', 'seo-tools', '2024']);
  });

  test('countPhrase counts non-overlapping phrase matches', () => {
    assert.equal(countPhrase(tokenize('seo tools and more seo tools seo'), tokenize('seo tools')), 2);
  });

  test('analyzeKeywords computes density and placement of target keywords', () => {
    const k = analyzeKeywords(
      {
        text: 'Best seo tools for you. Our seo tools help. Other words here to pad the text a little bit more.',
        title: 'SEO Tools that work',
        description: 'Nothing relevant',
        h1: ['Great SEO tools'],
        headings: [],
        url: 'https://x.com/seo-tools',
        altTexts: [],
      },
      ['SEO tools', 'missing phrase'],
    );
    const [hit, miss] = k.targets;
    assert.equal(hit.count, 2);
    assert.equal(hit.density, Math.round(((2 * 2 * 100) / k.totalWords) * 100) / 100);
    assert.ok(hit.inTitle && hit.inH1 && hit.inUrl && hit.inFirst100Words);
    assert.ok(!hit.inDescription);
    assert.equal(miss.count, 0);
    assert.ok(k.top.every((t) => !['for', 'you', 'our'].includes(t.term)), 'stop words are excluded');
  });
});

describe('page analyzer', () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>Hello</title><title>Second</title>
    <meta name="description" content="A description">
    <meta name="robots" content="noindex,nofollow">
    <link rel="canonical" href="/canonical">
    <meta property="og:title" content="OG">
    <script type="application/ld+json">{"@type":"Product"}</script>
    <script type="application/ld+json">{broken</script>
  </head><body>
    <h1>One</h1><h3>Skip</h3>
    <img src="/a.png"><img src="/b.png" alt=""><img src="/c.png" alt="Cat">
    <a href="/in" rel="nofollow">In</a><a href="https://other.com/x">Out</a>
    <script>var hidden = "do not count me";</script>
    <p>Visible words here</p>
  </body></html>`;
  const page = analyzePage(
    { body: html, finalUrl: 'https://site.com/page', headers: {}, contentType: 'text/html' },
    { rootUrl: 'https://site.com/', targetKeywords: [] },
  );

  test('extracts metadata', () => {
    assert.equal(page.title, 'Hello');
    assert.equal(page.titleCount, 2);
    assert.equal(page.metaDescription, 'A description');
    assert.equal(page.canonical, 'https://site.com/canonical');
    assert.equal(page.lang, 'en');
    assert.ok(page.noindex && page.nofollowPage);
    assert.equal(page.og.title, 'OG');
  });

  test('extracts headings, images, links and structured data', () => {
    assert.deepEqual(page.h1, ['One']);
    assert.equal(page.headingSkips.length, 1);
    assert.equal(page.imageCount, 3);
    assert.equal(page.imagesMissingAlt, 1);
    assert.equal(page.imagesEmptyAlt, 1);
    assert.equal(page.internalLinkCount, 1);
    assert.equal(page.externalLinkCount, 1);
    assert.equal(page.internalNofollowCount, 1);
    assert.deepEqual(page.structuredData.types, ['Product']);
    assert.equal(page.structuredData.invalidJsonLd, 1);
  });

  test('ignores script contents in word counts', () => {
    assert.ok(!page.keywords.top.some((t) => t.term === 'hidden'));
  });
});

describe('project validation', () => {
  test('applies defaults and normalizes input', () => {
    const p = validateProject({ name: '  Site ', url: 'example.com', settings: { targetKeywords: 'a, b\nA, c ', maxPages: '50' } });
    assert.equal(p.name, 'Site');
    assert.equal(p.url, 'https://example.com/');
    assert.deepEqual(p.settings.targetKeywords, ['a', 'b', 'c']);
    assert.equal(p.settings.maxPages, 50);
    assert.equal(p.settings.respectRobots, true);
  });

  test('reports field errors', () => {
    assert.throws(
      () => validateProject({ name: '', url: 'nope', settings: { maxPages: 0 } }),
      (err) => err instanceof ValidationError && Boolean(err.errors.name && err.errors.url && err.errors.maxPages),
    );
  });

  test('partial updates keep existing values', () => {
    const existing = validateProject({ name: 'A', url: 'a.com', settings: { maxPages: 10 } });
    const updated = validateProject({ name: 'B' }, existing);
    assert.equal(updated.url, 'https://a.com/');
    assert.equal(updated.settings.maxPages, 10);
  });
});
