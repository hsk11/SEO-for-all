// SEO rule engine: every check is declared once here, then evaluated against
// the crawl result to produce issues and scores.
//
// A check's `test` returns a falsy value when it passes, or a detail string
// (or `true`) when it fails.

export const SEVERITY_WEIGHT = { error: 10, warning: 5, notice: 1 };

export const CATEGORIES = {
  meta: 'Meta tags',
  content: 'Content',
  links: 'Links',
  images: 'Images',
  technical: 'Technical',
  social: 'Social & rich results',
  performance: 'Performance',
};

export const THRESHOLDS = {
  titleMin: 30,
  titleMax: 60,
  descriptionMin: 70,
  descriptionMax: 160,
  thinContentWords: 300,
  textRatioMin: 10,
  urlMaxLength: 115,
  maxLinksPerPage: 150,
  slowResponseMs: 1500,
  largePageBytes: 1024 * 1024,
  maxDepth: 3,
  keywordStuffingDensity: 3,
};

const T = THRESHOLDS;
const truncate = (s, n = 80) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Default scope: successfully fetched and parsed HTML pages (not redirects).
export const isOkHtmlPage = (p) => p.analyzed && !p.isRedirect;
// Every URL we actually requested, whatever the outcome.
const isFetched = (p) => !p.blockedByRobots;
// Narrow the default scope further.
const htmlPageWhere = (fn) => (p, ctx) => isOkHtmlPage(p) && fn(p, ctx);

/** Checks evaluated per crawled page. */
export const PAGE_CHECKS = [
  // ------------------------------------------------------------------ meta
  {
    id: 'title-missing', category: 'meta', severity: 'error',
    title: 'Missing title tag',
    description: 'The page has no <title> element, or it is empty. The title is the main headline shown in search results.',
    recommendation: 'Add a unique, descriptive <title> of 30–60 characters that includes the page\'s main keyword.',
    test: (p) => !p.title,
  },
  {
    id: 'title-too-long', category: 'meta', severity: 'warning',
    title: `Title too long (> ${T.titleMax} characters)`,
    description: 'Search engines truncate long titles (roughly 600px / 60 characters), hiding part of your message.',
    recommendation: `Shorten the title to at most ${T.titleMax} characters and put the most important words first.`,
    test: (p) => p.title && p.titleLength > T.titleMax && `${p.titleLength} chars: "${truncate(p.title)}"`,
  },
  {
    id: 'title-too-short', category: 'meta', severity: 'warning',
    title: `Title too short (< ${T.titleMin} characters)`,
    description: 'Very short titles miss the chance to describe the page and include relevant keywords.',
    recommendation: `Expand the title to ${T.titleMin}–${T.titleMax} characters with descriptive, keyword-rich wording.`,
    test: (p) => p.title && p.titleLength < T.titleMin && `${p.titleLength} chars: "${p.title}"`,
  },
  {
    id: 'title-multiple', category: 'meta', severity: 'warning',
    title: 'Multiple title tags',
    description: 'More than one <title> element was found. Search engines may pick the wrong one.',
    recommendation: 'Keep exactly one <title> element inside <head>.',
    test: (p) => p.titleCount > 1 && `${p.titleCount} title tags`,
  },
  {
    id: 'title-duplicate', category: 'meta', severity: 'warning',
    title: 'Duplicate title',
    description: 'The same title is used on several pages, making it hard for search engines to tell them apart.',
    recommendation: 'Write a unique title for every page.',
    // noindex pages don't compete in search, so duplicates there are harmless.
    applies: htmlPageWhere((p) => !p.noindex),
    test: (p, ctx) => {
      const n = p.title ? ctx.titleCounts.get(p.title.toLowerCase()) : 0;
      return n > 1 && `"${truncate(p.title, 60)}" used on ${n} pages`;
    },
  },
  {
    id: 'description-missing', category: 'meta', severity: 'warning',
    title: 'Missing meta description',
    description: 'No meta description was found. Search engines will generate a snippet themselves, often poorly.',
    recommendation: `Add a compelling meta description of ${T.descriptionMin}–${T.descriptionMax} characters summarising the page.`,
    test: (p) => !p.metaDescription,
  },
  {
    id: 'description-too-long', category: 'meta', severity: 'notice',
    title: `Meta description too long (> ${T.descriptionMax} characters)`,
    description: 'Long descriptions are truncated in search results.',
    recommendation: `Keep meta descriptions under ${T.descriptionMax} characters.`,
    test: (p) => p.metaDescription && p.metaDescriptionLength > T.descriptionMax && `${p.metaDescriptionLength} chars`,
  },
  {
    id: 'description-too-short', category: 'meta', severity: 'notice',
    title: `Meta description too short (< ${T.descriptionMin} characters)`,
    description: 'Short descriptions do not give searchers enough reason to click.',
    recommendation: `Expand the meta description to ${T.descriptionMin}–${T.descriptionMax} characters.`,
    test: (p) => p.metaDescription && p.metaDescriptionLength < T.descriptionMin && `${p.metaDescriptionLength} chars: "${p.metaDescription}"`,
  },
  {
    id: 'description-multiple', category: 'meta', severity: 'warning',
    title: 'Multiple meta descriptions',
    description: 'More than one meta description tag was found.',
    recommendation: 'Keep exactly one <meta name="description"> tag.',
    test: (p) => p.metaDescriptionCount > 1 && `${p.metaDescriptionCount} description tags`,
  },
  {
    id: 'description-duplicate', category: 'meta', severity: 'warning',
    title: 'Duplicate meta description',
    description: 'The same meta description is used on several pages.',
    recommendation: 'Write a unique meta description for every page.',
    // noindex pages don't compete in search, so duplicates there are harmless.
    applies: htmlPageWhere((p) => !p.noindex),
    test: (p, ctx) => {
      const n = p.metaDescription ? ctx.descriptionCounts.get(p.metaDescription.toLowerCase()) : 0;
      return n > 1 && `Used on ${n} pages`;
    },
  },
  {
    id: 'lang-missing', category: 'meta', severity: 'warning',
    title: 'Missing language attribute',
    description: 'The <html> element has no lang attribute, which helps search engines and screen readers.',
    recommendation: 'Add a lang attribute, e.g. <html lang="en">.',
    test: (p) => !p.lang,
  },
  {
    id: 'charset-missing', category: 'meta', severity: 'notice',
    title: 'Missing charset declaration',
    description: 'No <meta charset> was found; characters may render incorrectly.',
    recommendation: 'Add <meta charset="utf-8"> as the first element in <head>.',
    test: (p) => !p.charset && !/charset=/i.test(p.contentType),
  },

  // --------------------------------------------------------------- content
  {
    id: 'h1-missing', category: 'content', severity: 'warning',
    title: 'Missing H1 heading',
    description: 'The page has no <h1>. The H1 tells users and search engines what the page is about.',
    recommendation: 'Add one H1 that describes the page topic and includes the main keyword.',
    test: (p) => p.h1.length === 0 || p.h1.every((h) => !h),
  },
  {
    id: 'h1-multiple', category: 'content', severity: 'notice',
    title: 'Multiple H1 headings',
    description: 'More than one H1 can dilute the main topic of the page.',
    recommendation: 'Use a single H1 and structure the rest of the content with H2–H6.',
    test: (p) => p.h1.length > 1 && `${p.h1.length} H1 tags`,
  },
  {
    id: 'heading-hierarchy', category: 'content', severity: 'notice',
    title: 'Skipped heading levels',
    description: 'Heading levels are skipped (e.g. H2 followed by H4), which weakens the document outline.',
    recommendation: 'Nest headings in order: H1 → H2 → H3 without skipping levels.',
    test: (p) => p.headingSkips.length > 0 && p.headingSkips.slice(0, 3).join('; '),
  },
  {
    id: 'content-thin', category: 'content', severity: 'warning',
    title: `Thin content (< ${T.thinContentWords} words)`,
    description: 'Pages with little text rarely rank well for competitive queries.',
    recommendation: 'Expand the content with useful, original information that answers the searcher\'s intent.',
    test: (p) => p.wordCount < T.thinContentWords && `${p.wordCount} words`,
  },
  {
    id: 'text-ratio-low', category: 'content', severity: 'notice',
    title: `Low text-to-HTML ratio (< ${T.textRatioMin}%)`,
    description: 'Most of the page weight is markup or scripts rather than readable content.',
    recommendation: 'Reduce inline code and markup bloat, or add more meaningful text.',
    test: (p) => p.textHtmlRatio < T.textRatioMin && `${p.textHtmlRatio}%`,
  },
  {
    id: 'content-duplicate', category: 'content', severity: 'warning',
    title: 'Duplicate content',
    description: 'The visible text of this page is identical to another page.',
    recommendation: 'Make the content unique, or consolidate the pages with a canonical tag or 301 redirect.',
    // noindex pages don't compete in search, so duplicates there are harmless.
    applies: htmlPageWhere((p) => !p.noindex),
    test: (p, ctx) => {
      const n = p.contentHash ? ctx.contentCounts.get(p.contentHash) : 0;
      return n > 1 && `Identical text on ${n} pages`;
    },
  },
  {
    id: 'keyword-stuffing', category: 'content', severity: 'warning',
    title: `Possible keyword stuffing (target keyword density > ${T.keywordStuffingDensity}%)`,
    description: 'A target keyword appears unnaturally often, which search engines may treat as spam.',
    recommendation: 'Write naturally; use synonyms and related terms instead of repeating the same phrase.',
    applies: htmlPageWhere((p, ctx) => ctx.targetKeywords.length > 0 && p.wordCount >= 100),
    test: (p) => {
      const stuffed = p.keywords.targets.filter((t) => t.density > T.keywordStuffingDensity);
      return stuffed.length > 0 && stuffed.map((t) => `"${t.keyword}" ${t.density}%`).join(', ');
    },
  },

  // ----------------------------------------------------------------- links
  {
    id: 'links-broken', category: 'links', severity: 'error',
    title: 'Page has broken links',
    description: 'Links on this page point to URLs that return an error (4xx/5xx) or do not respond.',
    recommendation: 'Fix or remove the broken links. See the Broken links report for each target.',
    test: (p, ctx) => {
      const broken = ctx.brokenLinksBySource.get(p.url);
      return broken?.length > 0 && `${broken.length} broken: ${broken.slice(0, 3).map((b) => truncate(b, 70)).join(', ')}`;
    },
  },
  {
    id: 'links-to-redirects', category: 'links', severity: 'notice',
    title: 'Internal links to redirects',
    description: 'Internal links point to URLs that redirect, wasting crawl budget and adding latency.',
    recommendation: 'Update the links to point directly to the final URL.',
    test: (p, ctx) => {
      const n = ctx.redirectLinksBySource.get(p.url)?.length;
      return n > 0 && `${n} link(s) to redirecting URLs`;
    },
  },
  {
    id: 'links-internal-nofollow', category: 'links', severity: 'notice',
    title: 'Nofollow internal links',
    description: 'rel="nofollow" on internal links stops link equity flowing through your own site.',
    recommendation: 'Remove nofollow from internal links unless there is a specific reason.',
    test: (p) => p.internalNofollowCount > 0 && `${p.internalNofollowCount} nofollow internal link(s)`,
  },
  {
    id: 'links-too-many', category: 'links', severity: 'notice',
    title: `Too many links (> ${T.maxLinksPerPage})`,
    description: 'Pages with a very large number of links dilute the value passed to each one.',
    recommendation: 'Trim navigation and in-content links to the most useful ones.',
    test: (p) => p.links.length > T.maxLinksPerPage && `${p.links.length} links`,
  },
  {
    id: 'links-no-internal', category: 'links', severity: 'warning',
    title: 'No outgoing internal links',
    description: 'The page is a dead end: it links to no other page on the site.',
    recommendation: 'Add contextual links to related pages to help users and crawlers.',
    test: (p) => p.internalLinkCount === 0,
  },
  {
    id: 'page-low-inlinks', category: 'links', severity: 'notice',
    title: 'Only one internal link points to this page',
    description: 'Pages with few incoming internal links are seen as less important and may be crawled less often.',
    recommendation: 'Link to this page from other relevant pages and navigation.',
    applies: htmlPageWhere((p, ctx) => p.url !== ctx.startUrl && p.depth > 0),
    test: (p) => p.inlinks <= 1 && `${p.inlinks} inlink(s)`,
  },

  // ---------------------------------------------------------------- images
  {
    id: 'img-alt-missing', category: 'images', severity: 'warning',
    title: 'Images missing alt attribute',
    description: 'Images without an alt attribute are invisible to search engines and screen readers.',
    recommendation: 'Add descriptive alt text to every meaningful image (use alt="" only for purely decorative images).',
    applies: htmlPageWhere((p) => p.imageCount > 0),
    test: (p) => {
      if (!p.imagesMissingAlt) return false;
      const examples = p.images.filter((i) => !i.hasAltAttribute).slice(0, 3).map((i) => truncate(i.src.split('/').pop(), 40));
      return `${p.imagesMissingAlt} of ${p.imageCount} images (${examples.join(', ')})`;
    },
  },
  {
    id: 'img-broken', category: 'images', severity: 'error',
    title: 'Broken images',
    description: 'Images on this page fail to load.',
    recommendation: 'Fix the image URLs or upload the missing files.',
    applies: htmlPageWhere((p) => p.imageCount > 0),
    test: (p, ctx) => {
      const broken = ctx.brokenImagesBySource.get(p.url);
      return broken?.length > 0 && `${broken.length}: ${broken.slice(0, 3).map((b) => truncate(b, 60)).join(', ')}`;
    },
  },
  {
    id: 'img-no-dimensions', category: 'images', severity: 'notice',
    title: 'Images without width/height',
    description: 'Missing dimensions cause layout shifts (CLS), a Core Web Vitals metric.',
    recommendation: 'Set width and height attributes (or CSS aspect-ratio) on images.',
    applies: htmlPageWhere((p) => p.imageCount > 0),
    test: (p) => {
      const n = p.images.filter((i) => !i.width || !i.height).length;
      return n > 0 && `${n} of ${p.imageCount} images`;
    },
  },

  // ------------------------------------------------------------- technical
  {
    id: 'http-4xx', category: 'technical', severity: 'error',
    title: 'Page returns 4xx client error',
    description: 'The URL is linked from your site but returns a client error (e.g. 404 Not Found).',
    recommendation: 'Restore the page, 301-redirect it to a relevant page, or remove links pointing to it.',
    applies: isFetched,
    test: (p) => p.status >= 400 && p.status < 500 && `HTTP ${p.status}`,
  },
  {
    id: 'http-5xx', category: 'technical', severity: 'error',
    title: 'Page returns 5xx server error',
    description: 'The server failed to respond correctly for this URL.',
    recommendation: 'Check server logs and fix the underlying error.',
    applies: isFetched,
    test: (p) => p.status >= 500 && `HTTP ${p.status}`,
  },
  {
    id: 'fetch-failed', category: 'technical', severity: 'error',
    title: 'Page could not be fetched',
    description: 'The request failed (timeout, DNS, TLS or connection error, or a redirect loop).',
    recommendation: 'Make sure the URL is reachable, responds within a reasonable time and redirects to a final page.',
    applies: isFetched,
    // 4xx/5xx responses are reported by their own checks.
    test: (p) => (p.status == null ? p.error || 'No response' : p.status < 400 && p.error),
  },
  {
    id: 'redirect-chain', category: 'technical', severity: 'warning',
    title: 'Redirect chain (2+ hops)',
    description: 'The URL redirects several times before reaching its destination, losing link equity and speed.',
    recommendation: 'Redirect directly to the final destination in a single hop.',
    applies: (p) => p.isRedirect,
    test: (p) => p.redirectChain.length > 1 && `${p.redirectChain.length} hops → ${truncate(p.redirectTarget, 70)}`,
  },
  {
    id: 'redirect-temporary', category: 'technical', severity: 'notice',
    title: 'Temporary redirect (302/307)',
    description: 'Temporary redirects tell search engines the move is not permanent, so the old URL may stay indexed.',
    recommendation: 'Use a 301/308 redirect if the move is permanent.',
    applies: (p) => p.isRedirect,
    test: (p) => p.redirectChain.some((r) => r.status === 302 || r.status === 307) && `→ ${truncate(p.redirectTarget, 70)}`,
  },
  {
    id: 'canonical-missing', category: 'technical', severity: 'notice',
    title: 'Missing canonical tag',
    description: 'Without rel="canonical", duplicate URL variants (parameters, trailing slashes) may compete with each other.',
    recommendation: 'Add a self-referencing <link rel="canonical"> to every indexable page.',
    test: (p) => !p.canonical,
  },
  {
    id: 'canonical-multiple', category: 'technical', severity: 'warning',
    title: 'Multiple canonical tags',
    description: 'Conflicting canonical tags are ignored by search engines.',
    recommendation: 'Keep exactly one canonical tag per page.',
    test: (p) => p.canonicalCount > 1 && `${p.canonicalCount} canonical tags`,
  },
  {
    id: 'canonical-other', category: 'technical', severity: 'notice',
    title: 'Canonical points to another URL',
    description: 'This page declares a different URL as canonical, so it will likely not be indexed itself.',
    recommendation: 'Verify this is intentional (e.g. a duplicate or parameter variant).',
    test: (p) => p.canonical && p.canonical !== p.url && p.canonical !== p.finalUrl && `→ ${truncate(p.canonical, 80)}`,
  },
  {
    id: 'noindex', category: 'technical', severity: 'notice',
    title: 'Page is set to noindex',
    description: 'A robots meta tag or X-Robots-Tag header prevents this page from appearing in search results.',
    recommendation: 'Remove noindex if the page should be found in search.',
    test: (p) => p.noindex && (p.metaRobots || p.xRobotsTag),
  },
  {
    id: 'viewport-missing', category: 'technical', severity: 'warning',
    title: 'Missing viewport meta tag',
    description: 'Without a viewport tag the page is not mobile-friendly, which hurts mobile-first indexing.',
    recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    test: (p) => !p.viewport,
  },
  {
    id: 'mixed-content', category: 'technical', severity: 'error',
    title: 'Mixed content (HTTP resources on HTTPS page)',
    description: 'Insecure resources are blocked or flagged by browsers on HTTPS pages.',
    recommendation: 'Load every resource over HTTPS.',
    test: (p) => p.mixedContent.length > 0 && `${p.mixedContent.length}: ${p.mixedContent.slice(0, 2).map((u) => truncate(u, 60)).join(', ')}`,
  },
  {
    id: 'url-too-long', category: 'technical', severity: 'notice',
    title: `URL too long (> ${T.urlMaxLength} characters)`,
    description: 'Long URLs are hard to read and share and may be truncated in results.',
    recommendation: 'Use short, descriptive URLs.',
    applies: isFetched,
    test: (p) => p.url.length > T.urlMaxLength && `${p.url.length} chars`,
  },
  {
    id: 'url-format', category: 'technical', severity: 'notice',
    title: 'URL contains uppercase letters or underscores',
    description: 'Mixed-case URLs can create duplicates; underscores are not treated as word separators.',
    recommendation: 'Use lowercase URLs with hyphens between words.',
    applies: isFetched,
    test: (p) => {
      const path = new URL(p.url).pathname;
      const problems = [];
      if (/[A-Z]/.test(path)) problems.push('uppercase');
      if (path.includes('_')) problems.push('underscores');
      return problems.length > 0 && problems.join(', ');
    },
  },
  {
    id: 'deep-page', category: 'technical', severity: 'notice',
    title: `Page is deep in the site (> ${T.maxDepth} clicks from start)`,
    description: 'Pages many clicks away from the homepage get less crawl attention and authority.',
    recommendation: 'Flatten your structure or add links from higher-level pages.',
    applies: isFetched,
    test: (p) => p.depth > T.maxDepth && `Depth ${p.depth}`,
  },
  {
    id: 'structured-data-missing', category: 'social', severity: 'notice',
    title: 'No structured data',
    description: 'No JSON-LD or microdata was found. Structured data enables rich results in search.',
    recommendation: 'Add schema.org JSON-LD appropriate for the page (Organization, Article, Product, BreadcrumbList…).',
    test: (p) => p.structuredData.jsonLdCount === 0 && p.structuredData.microdataCount === 0,
  },
  {
    id: 'structured-data-invalid', category: 'social', severity: 'warning',
    title: 'Invalid JSON-LD',
    description: 'A JSON-LD block could not be parsed, so search engines will ignore it.',
    recommendation: 'Fix the JSON syntax and validate with Google\'s Rich Results Test.',
    test: (p) => p.structuredData.invalidJsonLd > 0 && `${p.structuredData.invalidJsonLd} invalid block(s)`,
  },
  {
    id: 'og-missing', category: 'social', severity: 'notice',
    title: 'Incomplete Open Graph tags',
    description: 'og:title, og:description and og:image control how the page looks when shared on social networks.',
    recommendation: 'Add og:title, og:description, og:image and og:url meta tags.',
    test: (p) => {
      const missing = ['title', 'description', 'image'].filter((k) => !p.og[k]);
      return missing.length > 0 && `Missing og:${missing.join(', og:')}`;
    },
  },
  {
    id: 'twitter-missing', category: 'social', severity: 'notice',
    title: 'Missing Twitter/X card',
    description: 'No twitter:card meta tag was found.',
    recommendation: 'Add <meta name="twitter:card" content="summary_large_image"> plus title/description/image.',
    test: (p) => !p.twitter.card,
  },

  // ----------------------------------------------------------- performance
  {
    id: 'slow-response', category: 'performance', severity: 'warning',
    title: `Slow response (> ${T.slowResponseMs} ms)`,
    description: 'The server took a long time to deliver the HTML. Speed is a ranking and UX factor.',
    recommendation: 'Improve server response time with caching, a CDN, or backend optimisation.',
    test: (p) => p.responseTimeMs > T.slowResponseMs && `${p.responseTimeMs} ms`,
  },
  {
    id: 'page-too-large', category: 'performance', severity: 'warning',
    title: 'Large HTML document (> 1 MB)',
    description: 'Very large HTML slows down downloading and parsing.',
    recommendation: 'Remove inline assets, reduce DOM size, and paginate long lists.',
    test: (p) => p.sizeBytes > T.largePageBytes && `${(p.sizeBytes / 1024).toFixed(0)} KB`,
  },
  {
    id: 'img-no-lazy', category: 'performance', severity: 'notice',
    title: 'Many images without lazy loading',
    description: 'Pages with many images load faster when off-screen images use loading="lazy".',
    recommendation: 'Add loading="lazy" to images below the fold.',
    applies: htmlPageWhere((p) => p.imageCount > 5),
    test: (p) => {
      const n = p.images.filter((i) => i.loading !== 'lazy').length;
      return n > 5 && `${n} of ${p.imageCount} images load eagerly`;
    },
  },
];

/** Checks evaluated once for the whole site. */
export const SITE_CHECKS = [
  {
    id: 'site-no-https', category: 'technical', severity: 'error',
    title: 'Site is not served over HTTPS',
    description: 'HTTPS is a confirmed ranking signal and browsers mark HTTP sites as "Not secure".',
    recommendation: 'Install a TLS certificate and redirect all HTTP traffic to HTTPS.',
    test: (s) => !s.probes.https.usesHttps,
  },
  {
    id: 'site-http-not-redirected', category: 'technical', severity: 'warning',
    title: 'HTTP version does not redirect to HTTPS',
    description: 'The http:// version of the site is reachable without redirecting, creating duplicate content.',
    recommendation: 'Add a site-wide 301 redirect from HTTP to HTTPS.',
    applies: (s) => s.probes.https.usesHttps && s.probes.https.httpStatus != null,
    test: (s) => s.probes.https.httpRedirectsToHttps === false && `http:// answered ${s.probes.https.httpStatus}`,
  },
  {
    id: 'site-www-duplicate', category: 'technical', severity: 'warning',
    title: 'www and non-www versions both resolve',
    description: 'Both host variants serve content without redirecting, splitting ranking signals.',
    recommendation: 'Choose one preferred host and 301-redirect the other to it.',
    applies: (s) => s.probes.wwwCanonicalization != null,
    test: (s) => !s.probes.wwwCanonicalization.consolidated && `${s.probes.wwwCanonicalization.variant} answered ${s.probes.wwwCanonicalization.status}`,
  },
  {
    id: 'site-robots-missing', category: 'technical', severity: 'warning',
    title: 'robots.txt not found',
    description: 'A robots.txt file tells crawlers what to crawl and where your sitemap is.',
    recommendation: 'Create /robots.txt and reference your XML sitemap in it.',
    test: (s) => !s.robots.found && (s.robots.status ? `HTTP ${s.robots.status}` : s.robots.error || true),
  },
  {
    id: 'site-sitemap-missing', category: 'technical', severity: 'warning',
    title: 'XML sitemap not found',
    description: 'No valid XML sitemap was found in robots.txt or at /sitemap.xml.',
    recommendation: 'Generate an XML sitemap and submit it in Google Search Console.',
    test: (s) => !s.sitemap.found && (s.sitemap.errors.map((e) => `${e.url}: ${e.error || `HTTP ${e.status}`}`).join('; ') || true),
  },
  {
    id: 'site-sitemap-not-in-robots', category: 'technical', severity: 'notice',
    title: 'Sitemap not referenced in robots.txt',
    description: 'Declaring the sitemap in robots.txt helps all search engines find it.',
    recommendation: 'Add a "Sitemap: https://example.com/sitemap.xml" line to robots.txt.',
    applies: (s) => s.robots.found && s.sitemap.found,
    test: (s) => s.robots.sitemaps.length === 0,
  },
  {
    id: 'site-soft-404', category: 'technical', severity: 'warning',
    title: 'Missing pages do not return 404 (soft 404)',
    description: 'A random non-existent URL returned a non-404 status, so error pages may get indexed.',
    recommendation: 'Return a real 404 (or 410) status code for pages that do not exist.',
    applies: (s) => s.probes.notFoundHandling.status != null,
    test: (s) => !s.probes.notFoundHandling.returns404 && `Random URL returned HTTP ${s.probes.notFoundHandling.status}`,
  },
  {
    id: 'site-favicon-missing', category: 'meta', severity: 'notice',
    title: 'No favicon',
    description: 'Search results on mobile show the site favicon next to your listing.',
    recommendation: 'Add a favicon and reference it with <link rel="icon">.',
    test: (s) => !s.probes.favicon.defaultPathOk && !s.homepage?.favicon,
  },
  {
    id: 'site-orphan-pages', category: 'links', severity: 'notice',
    title: 'Orphan pages in sitemap',
    description: 'URLs listed in the sitemap were not reached by following links from the start page.',
    recommendation: 'Link to these pages from relevant content or navigation, or remove them from the sitemap.',
    applies: (s) => s.sitemap.found && !s.limits.reachedPageLimit,
    test: (s) => s.orphanPages.length > 0 && `${s.orphanPages.length} URL(s), e.g. ${s.orphanPages.slice(0, 3).join(', ')}`,
  },
  {
    id: 'site-keyword-unused', category: 'content', severity: 'warning',
    title: 'Target keyword not used in any title or H1',
    description: 'One or more target keywords do not appear in any page title or H1 heading.',
    recommendation: 'Create or optimise a page that targets each keyword in its title, H1 and content.',
    applies: (s) => s.targetKeywords.length > 0,
    test: (s) => {
      const unused = s.keywordSummary.targets.filter((t) => t.inTitle === 0 && t.inH1 === 0).map((t) => `"${t.keyword}"`);
      return unused.length > 0 && unused.join(', ');
    },
  },
];

const stripFns = ({ test, applies, ...meta }) => meta;

export function checkCatalog() {
  return {
    page: PAGE_CHECKS.map(stripFns),
    site: SITE_CHECKS.map(stripFns),
  };
}
