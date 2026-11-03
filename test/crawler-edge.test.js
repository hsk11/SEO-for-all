// Edge cases for the crawler + analyzers, each against a purpose-built site.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startSite, page, auditSite, pageAt, issueOf, affected, pathOf, testSettings } from './helpers/http-site.js';
import { crawlSite } from '../src/crawler/crawler.js';
import { analyzePage } from '../src/analyzer/page-analyzer.js';
import { analyzeKeywords } from '../src/analyzer/keywords.js';

/** Start a site, run `fn`, always stop the site. */
async function withSite(routes, fn, opts) {
  const site = await startSite(routes, opts);
  try {
    return await fn(site);
  } finally {
    await site.stop();
  }
}

const links = (...paths) => paths.map((p) => `<a href="${p}">${p}</a>`).join(' ');

describe('start URL edge cases', () => {
  test('start URL that redirects internally is followed and analysed at depth 0', () =>
    withSite({ '/': { status: 301, headers: { Location: '/home' } }, '/home': page({ body: '<h1>Home</h1>' }) }, async (site) => {
      const r = await auditSite(site.url);
      assert.equal(pageAt(r, '/').isRedirect, true);
      assert.equal(pageAt(r, '/home').depth, 0);
      assert.equal(pageAt(r, '/home').analyzed, true);
      assert.equal(r.summary.htmlPages, 1);
    }));

  test('start URL that redirects off-site produces an empty but valid audit', async () => {
    const other = await startSite({ '/': page({ body: 'elsewhere' }) });
    try {
      // "localhost" is a different host than 127.0.0.1, so it counts as external.
      const target = `http://localhost:${other.port}/`;
      await withSite({ '/': { status: 302, headers: { Location: target } } }, async (site) => {
        const r = await auditSite(site.url);
        assert.equal(r.summary.htmlPages, 0);
        assert.equal(r.pages.length, 1);
        assert.equal(pageAt(r, '/').redirectTarget, target);
        assert.ok(r.summary.score >= 0 && r.summary.score <= 100);
      });
    } finally {
      await other.stop();
    }
  });

  test('unreachable start URL completes with a fetch error instead of crashing', async () => {
    const site = await startSite({});
    const url = site.url;
    await site.stop();
    const r = await auditSite(url, { timeoutMs: 1000 });
    assert.equal(r.pages.length, 1);
    assert.match(pageAt(r, '/').error, /refused/i);
    assert.deepEqual(affected(r, 'fetch-failed'), ['/']);
    assert.ok(issueOf(r, 'site-robots-missing'));
    assert.equal(r.summary.htmlPages, 0);
  });

  test('non-HTML start URL is recorded but not analysed', () =>
    withSite({ '/': { type: 'application/json', body: '{"hello":"world"}' } }, async (site) => {
      const r = await auditSite(site.url);
      assert.equal(pageAt(r, '/').status, 200);
      assert.equal(pageAt(r, '/').analyzed, false);
      assert.equal(r.summary.htmlPages, 0);
    }));

  test('start URL blocked by robots.txt is not fetched', () =>
    withSite({ '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /' }, '/': page() }, async (site) => {
      const r = await auditSite(site.url);
      assert.equal(pageAt(r, '/').blockedByRobots, true);
      assert.equal(site.hits.filter((h) => h.path === '/' && h.method === 'GET').length, 1, 'only the site probe fetched /');
    }));
});

describe('HTTP edge cases', () => {
  test('redirect loops are reported as failed pages and broken links', () =>
    withSite(
      {
        '/': page({ body: links('/loop-a') }),
        '/loop-a': { status: 301, headers: { Location: '/loop-b' } },
        '/loop-b': { status: 301, headers: { Location: '/loop-a' } },
      },
      async (site) => {
        const r = await auditSite(site.url);
        assert.match(pageAt(r, '/loop-a').error, /loop/i);
        assert.deepEqual(affected(r, 'fetch-failed'), ['/loop-a']);
        assert.deepEqual(affected(r, 'links-broken'), ['/']);
      },
    ));

  test('excessively long redirect chains stop at the hop limit', () => {
    const routes = { '/': page({ body: links('/r0') }) };
    for (let i = 0; i < 15; i++) routes[`/r${i}`] = { status: 301, headers: { Location: `/r${i + 1}` } };
    return withSite(routes, async (site) => {
      const r = await auditSite(site.url);
      assert.match(pageAt(r, '/r0').error, /too many redirects/i);
      assert.ok(issueOf(r, 'fetch-failed'));
    });
  });

  test('slow pages time out (after one retry) and are reported', () =>
    withSite({ '/': page({ body: links('/slow') }), '/slow': { delayMs: 3000, body: page() } }, async (site) => {
      const r = await auditSite(site.url, { timeoutMs: 400 });
      assert.match(pageAt(r, '/slow').error, /timed out/i);
      assert.deepEqual(affected(r, 'fetch-failed'), ['/slow']);
      assert.equal(site.hits.filter((h) => h.path === '/slow').length, 2, 'retried once');
    }));

  test('a transient connection failure is retried and not reported', () => {
    let calls = 0;
    return withSite(
      {
        '/': page({ body: links('/flaky') }),
        '/flaky': (req) => {
          calls++;
          if (calls === 1) req.socket.destroy();
          return page({ body: '<h1>Recovered</h1>' });
        },
      },
      async (site) => {
        const r = await auditSite(site.url);
        assert.equal(pageAt(r, '/flaky').status, 200);
        assert.equal(pageAt(r, '/flaky').error, null);
        assert.ok(!issueOf(r, 'fetch-failed'));
        assert.equal(r.summary.brokenLinks, 0);
      },
    );
  });

  test('5xx pages are reported as server errors', () =>
    withSite({ '/': page({ body: links('/boom') }), '/boom': { status: 503, body: 'down' } }, async (site) => {
      const r = await auditSite(site.url);
      assert.deepEqual(affected(r, 'http-5xx'), ['/boom']);
      assert.ok(!affected(r, 'fetch-failed').includes('/boom'), 'not double-counted');
    }));

  test('servers that reject HEAD are checked again with GET', () =>
    withSite(
      {
        '/': page({ body: `${links('/doc.pdf', '/no-head.pdf')}` }),
        '/doc.pdf': (req) => ({ status: req.method === 'HEAD' ? 405 : 200, type: 'application/pdf', body: 'pdf' }),
        '/no-head.pdf': (req) => ({ status: req.method === 'HEAD' ? 404 : 200, type: 'application/pdf', body: 'pdf' }),
      },
      async (site) => {
        const r = await auditSite(site.url);
        const doc = r.links.find((l) => pathOf(l.url) === '/doc.pdf');
        assert.equal(doc.status, 200);
        assert.equal(r.links.find((l) => pathOf(l.url) === '/no-head.pdf').status, 200);
        assert.equal(r.summary.brokenLinks, 0);
        assert.ok(!pageAt(r, '/doc.pdf'), 'files are link-checked, not crawled');
      },
    ));
});

describe('content edge cases', () => {
  test('an empty 200 HTML page is analysed and flagged', () =>
    withSite({ '/': page({ body: links('/empty') }), '/empty': '' }, async (site) => {
      const r = await auditSite(site.url);
      const empty = pageAt(r, '/empty');
      assert.equal(empty.analyzed, true);
      assert.equal(empty.wordCount, 0);
      for (const id of ['title-missing', 'h1-missing', 'description-missing', 'viewport-missing', 'lang-missing']) {
        assert.ok(affected(r, id).includes('/empty'), id);
      }
    }));

  test('malformed HTML is still parsed', () =>
    withSite({ '/': '<html><head><title>Broken but fine</title><body><h1>Hi<p>unclosed <a href="/x">x' }, async (site) => {
      const r = await auditSite(site.url);
      const home = pageAt(r, '/');
      assert.equal(home.title, 'Broken but fine');
      assert.equal(home.h1.length, 1);
      assert.match(home.h1[0], /^Hi/);
      assert.ok(pageAt(r, '/x'), 'link inside unclosed tags was followed');
    }));

  test('charset declared only in <meta> is honoured', () => {
    const latin1 = Buffer.from(page({ title: 'Café crème brûlée', body: '<h1>Déjà vu</h1>' }).replace('utf-8', 'iso-8859-1'), 'latin1');
    return withSite({ '/': { type: 'text/html', body: latin1 } }, async (site) => {
      const r = await auditSite(site.url);
      assert.equal(pageAt(r, '/').title, 'Café crème brûlée');
      assert.deepEqual(pageAt(r, '/').h1, ['Déjà vu']);
    });
  });

  test('non-Latin content is tokenised and measured correctly', () =>
    withSite({ '/': page({ title: 'हिन्दी में एसईओ उपकरण', body: `<h1>日本語のページ</h1><p>${'एसईओ उपकरण '.repeat(30)}</p>` }) }, async (site) => {
      const r = await auditSite(site.url, { targetKeywords: ['एसईओ उपकरण'] });
      const home = pageAt(r, '/');
      assert.equal(home.titleLength, 'हिन्दी में एसईओ उपकरण'.length);
      const target = home.keywords.targets[0];
      assert.equal(target.count, 30);
      assert.ok(target.inTitle);
      assert.ok(home.keywords.top.some((t) => t.term === 'एसईओ'));
    }));

  test('pages larger than 1 MB are flagged and huge bodies are capped', () => {
    const big = page({ body: `<p>${'word '.repeat(250_000)}</p>` }); // ~1.25 MB
    const huge = page({ body: `<p>${'x'.repeat(6 * 1024 * 1024)}</p>` }); // 6 MB
    return withSite({ '/': page({ body: links('/big', '/huge') }), '/big': big, '/huge': huge }, async (site) => {
      const r = await auditSite(site.url);
      assert.ok(affected(r, 'page-too-large').includes('/big'));
      assert.ok(pageAt(r, '/huge').analyzed, 'truncated body is still analysed');
    });
  });

  test('duplicate titles are matched case-insensitively and ignore noindex pages', () =>
    withSite(
      {
        '/': page({ title: 'Home page of the duplicate title test site', body: links('/a', '/b', '/hidden') }),
        '/a': page({ title: 'Same Title For Two Different Pages Here' }),
        '/b': page({ title: 'SAME TITLE FOR TWO DIFFERENT PAGES HERE' }),
        '/hidden': page({ title: 'Same title for two different pages here', head: '<meta name="robots" content="noindex">' }),
      },
      async (site) => {
        const r = await auditSite(site.url);
        assert.deepEqual(affected(r, 'title-duplicate'), ['/a', '/b']);
      },
    ));

  test('canonical, duplicate content and multiple canonical tags', () => {
    const text = `<h1>Same</h1><p>${'identical sentence about products and services. '.repeat(20)}</p>`;
    return withSite(
      {
        '/': page({ body: links('/copy', '/multi'), head: '<link rel="canonical" href="/">' }),
        '/copy': page({ title: 'Copy of page one with some extra words', body: text, head: '<link rel="canonical" href="/original">' }),
        '/multi': page({ title: 'Page two with different title words', body: text, head: '<link rel="canonical" href="/multi"><link rel="canonical" href="/other">' }),
      },
      async (site) => {
        const r = await auditSite(site.url);
        assert.deepEqual(affected(r, 'canonical-other'), ['/copy']);
        assert.deepEqual(affected(r, 'canonical-multiple'), ['/multi']);
        assert.deepEqual(affected(r, 'content-duplicate'), ['/copy', '/multi']);
        assert.ok(!affected(r, 'canonical-missing').includes('/'));
      },
    );
  });

  test('X-Robots-Tag header marks a page noindex', () =>
    withSite({ '/': page({ body: links('/private-doc') }), '/private-doc': { headers: { 'X-Robots-Tag': 'noindex' }, body: page() } }, async (site) => {
      const r = await auditSite(site.url);
      assert.equal(pageAt(r, '/private-doc').noindex, true);
      assert.deepEqual(affected(r, 'noindex'), ['/private-doc']);
      assert.equal(r.summary.indexablePages, 1);
    }));

  test('images: data URIs ignored, data-src used, missing src tolerated', () =>
    withSite(
      {
        '/': page({ body: '<img src="data:image/png;base64,AAAA"><img data-src="/lazy.png" alt="Lazy"><img alt="no src"><img src="/real.png">' }),
        '/lazy.png': { type: 'image/png', body: 'x' },
        '/real.png': { type: 'image/png', body: 'x' },
      },
      async (site) => {
        const r = await auditSite(site.url);
        const srcs = pageAt(r, '/').images.map((i) => pathOf(i.src)).sort();
        assert.deepEqual(srcs, ['/lazy.png', '/real.png']);
        assert.equal(pageAt(r, '/').imagesMissingAlt, 1);
        assert.equal(r.summary.brokenImages, 0);
      },
    ));
});

describe('link discovery edge cases', () => {
  test('normalises relative, base-href, protocol-relative and junk links', () =>
    withSite(
      {
        '/': page({ body: links('/section/') }),
        '/section/': page({
          head: '<base href="/base/">',
          body: `
            <a href="child">relative to base</a>
            <a href="../up">dot-dot</a>
            <a href="/abs#frag">fragment</a>
            <a href="/abs">duplicate without fragment</a>
            <a href="#top">fragment only</a>
            <a href="mailto:a@b.com">mail</a><a href="tel:+123">tel</a><a href="javascript:void(0)">js</a>
            <a href="//localhost:1/proto-relative">external</a>
            <a href="  /spaced  ">spaced</a>
            <a href="">empty</a>`,
        }),
        '/base/child': page(),
        '/up': page(),
        '/abs': page(),
        '/spaced': page(),
      },
      async (site) => {
        const r = await auditSite(site.url, { checkExternalLinks: false });
        const section = pageAt(r, '/section/');
        const found = section.links.map((l) => (l.internal ? pathOf(l.url) : l.url));
        assert.deepEqual(
          [...new Set(found)].sort(),
          ['/abs', '/base/child', '/spaced', '/up', 'http://localhost:1/proto-relative'].sort(),
        );
        for (const p of ['/base/child', '/up', '/abs', '/spaced']) assert.equal(pageAt(r, p)?.status, 200, p);
        assert.equal(section.externalLinkCount, 1);
      },
    ));

  test('infinite URL spaces are bounded by maxPages', () =>
    withSite(
      {
        '/': page({ body: links('/list?page=1') }),
        '/list': (req, res, { url }) => {
          const n = Number(url.searchParams.get('page'));
          return page({ title: `Listing page number ${n} of the infinite list`, body: links(`/list?page=${n + 1}`) });
        },
      },
      async (site) => {
        const r = await auditSite(site.url, { maxPages: 8, maxDepth: 20 });
        assert.equal(r.pages.length, 8);
        assert.equal(r.summary.reachedPageLimit, true);
        assert.ok(!issueOf(r, 'site-orphan-pages'), 'orphan check is skipped for partial crawls');
      },
    ));

  test('maxDepth 0 crawls only the start page but still checks its links', () =>
    withSite({ '/': page({ body: links('/a', '/missing') }), '/a': page() }, async (site) => {
      const r = await auditSite(site.url, { maxDepth: 0 });
      assert.deepEqual(r.pages.map((p) => pathOf(p.url)), ['/']);
      assert.equal(r.links.find((l) => pathOf(l.url) === '/a').status, 200);
      assert.equal(r.links.find((l) => pathOf(l.url) === '/missing').status, 404);
      assert.equal(r.summary.brokenLinks, 1);
    }));

  test('respectRobots=false crawls disallowed paths and follows nofollow pages', () =>
    withSite(
      {
        '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private/' },
        '/': page({ body: links('/private/a', '/nf') }),
        '/private/a': page(),
        '/nf': page({ head: '<meta name="robots" content="nofollow">', body: links('/behind-nofollow') }),
        '/behind-nofollow': page(),
      },
      async (site) => {
        const strict = await auditSite(site.url);
        assert.equal(pageAt(strict, '/private/a').blockedByRobots, true);
        assert.ok(!pageAt(strict, '/behind-nofollow'), 'nofollow page links are not followed');

        const loose = await auditSite(site.url, { respectRobots: false });
        assert.equal(pageAt(loose, '/private/a').status, 200);
        assert.equal(pageAt(loose, '/behind-nofollow').status, 200);
      },
    ));

  test('external link checking can be disabled; maxLinkChecks caps extra requests', async () => {
    const ext = await startSite({ '/gone': { status: 410 } });
    try {
      await withSite({ '/': page({ body: `<a href="http://localhost:${ext.port}/gone">ext</a>${links('/file.zip')}` }), '/file.zip': { type: 'application/zip', body: 'z' } }, async (site) => {
        const off = await auditSite(site.url, { checkExternalLinks: false });
        const extLink = off.links.find((l) => !l.internal);
        assert.equal(extLink.checked, false);
        assert.equal(off.summary.brokenLinks, 0);

        const on = await auditSite(site.url);
        assert.equal(on.summary.brokenLinks, 1);

        const capped = await auditSite(site.url, { maxLinkChecks: 0 });
        assert.equal(capped.links.filter((l) => l.checked).length, 0, 'nothing beyond crawled pages was checked');
        assert.equal(capped.summary.brokenLinks, 0);
      });
    } finally {
      await ext.stop();
    }
  });
});

describe('robots.txt, sitemaps and site probes', () => {
  test('catch-all sites: HTML robots.txt/sitemap are "missing" and soft 404s are detected', () =>
    withSite({}, async (site) => {
      const r = await auditSite(site.url);
      assert.ok(issueOf(r, 'site-robots-missing'));
      assert.ok(issueOf(r, 'site-sitemap-missing'));
      assert.ok(issueOf(r, 'site-soft-404'));
    }, { fallback: page({ body: '<h1>Everything is 200</h1>' }) }));

  test('sitemap index with nested sitemaps, plus a broken child sitemap', () =>
    withSite(
      {
        '/robots.txt': { type: 'text/plain', body: (ctx) => `Sitemap: ${ctx.origin}/sitemap-index.xml` },
        '/sitemap-index.xml': {
          type: 'application/xml',
          body: (ctx) => `<sitemapindex><sitemap><loc>${ctx.origin}/s1.xml</loc></sitemap><sitemap><loc>${ctx.origin}/bad.xml</loc></sitemap></sitemapindex>`,
        },
        '/s1.xml': { type: 'application/xml', body: (ctx) => `<urlset><url><loc>${ctx.origin}/</loc></url><url><loc>${ctx.origin}/hidden-gem</loc></url></urlset>` },
        '/bad.xml': { type: 'application/xml', body: 'this is not xml at all' },
        '/': page({ body: links('/not-in-sitemap') }),
        '/not-in-sitemap': page(),
        '/hidden-gem': page(),
      },
      async (site) => {
        const r = await auditSite(site.url);
        assert.equal(r.site.sitemap.found, true);
        assert.equal(r.site.sitemap.urlCount, 2);
        assert.ok(r.site.sitemap.errors.some((e) => e.url.endsWith('/bad.xml')));
        assert.deepEqual(r.structure.orphanPages.map(pathOf), ['/hidden-gem']);
        assert.deepEqual(r.structure.notInSitemap.map(pathOf), ['/not-in-sitemap']);
        assert.ok(!issueOf(r, 'site-sitemap-not-in-robots'));
      },
    ));
});

describe('analyzer units for things that need special setups', () => {
  test('mixed content is detected on HTTPS pages only', () => {
    const html = page({ body: '<img src="http://cdn.example.com/a.png" alt="a"><script src="http://cdn.example.com/x.js"></script><img src="https://ok.example.com/b.png" alt="b">' });
    const ctx = { rootUrl: 'https://site.com/', targetKeywords: [] };
    const secure = analyzePage({ body: html, finalUrl: 'https://site.com/', headers: {} }, ctx);
    assert.equal(secure.mixedContent.length, 2);
    const plain = analyzePage({ body: html, finalUrl: 'http://site.com/', headers: {} }, ctx);
    assert.equal(plain.mixedContent.length, 0);
  });

  test('odd target keywords do not break keyword analysis', () => {
    const k = analyzeKeywords({ text: 'C++ tips. c tips! Tips tips', title: '', description: null, h1: [], headings: [], url: '', altTexts: [] }, ['!!!', 'C TIPS', '']);
    assert.equal(k.targets.length, 1, 'keywords without any word characters are skipped');
    assert.equal(k.targets[0].count, 2);
  });

  test('crawl can be cancelled mid-way', () =>
    withSite({ '/': page({ body: links('/slow') }), '/slow': { delayMs: 5000, body: page() } }, async (site) => {
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(new Error('cancelled')), 300);
      await assert.rejects(crawlSite({ startUrl: site.url, settings: testSettings({ timeoutMs: 10000 }), signal: controller.signal }));
      assert.ok(Date.now() - started < 3000, 'cancellation is prompt');
    }));
});
