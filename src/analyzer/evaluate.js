// Turns a raw crawl into the final audit result: issues, scores, site
// structure and keyword summary.

import { PAGE_CHECKS, SITE_CHECKS, SEVERITY_WEIGHT, CATEGORIES, isOkHtmlPage } from './checks.js';
import { aggregateKeywords } from './keywords.js';

const DEFAULT_APPLIES = isOkHtmlPage;
const MAX_AFFECTED_STORED = 1000;

function countBy(values) {
  const map = new Map();
  for (const v of values) if (v) map.set(v, (map.get(v) || 0) + 1);
  return map;
}

function groupBrokenBySource(links, predicate) {
  const map = new Map();
  for (const link of links) {
    if (!predicate(link)) continue;
    for (const src of link.sources) {
      if (!map.has(src.page)) map.set(src.page, new Set());
      map.get(src.page).add(link.url);
    }
  }
  return new Map([...map].map(([k, v]) => [k, [...v]]));
}

export const isBroken = (link) => link.checked && (link.error != null || link.status == null || link.status >= 400);

export function scoreLabel(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 50) return 'Needs work';
  return 'Poor';
}

/** Build a URL-path tree for the site-structure view. */
export function buildSiteTree(pages, startUrl) {
  const root = { name: new URL(startUrl).host, path: '/', children: new Map(), page: null, count: 0 };
  for (const page of pages) {
    let url;
    try {
      url = new URL(page.url);
    } catch {
      continue;
    }
    const segments = url.pathname.split('/').filter(Boolean);
    let node = root;
    let path = '';
    for (const seg of segments) {
      path += `/${seg}`;
      if (!node.children.has(seg)) node.children.set(seg, { name: decodeSafe(seg), path, children: new Map(), page: null, count: 0 });
      node = node.children.get(seg);
    }
    node.count++;
    if (!node.page || url.search === '') {
      node.page = { url: page.url, status: page.status, title: page.title ?? null, depth: page.depth };
    }
  }
  const finalize = (node) => {
    const children = [...node.children.values()].map(finalize).sort((a, b) => a.name.localeCompare(b.name));
    const total = node.count + children.reduce((sum, c) => sum + c.total, 0);
    return { name: node.name, path: node.path, page: node.page, total, children };
  };
  return finalize(root);
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * @param {object} crawl   result of crawlSite()
 * @param {object} probes  result of runSiteProbes()
 * @param {object} settings
 */
export function evaluate(crawl, probes, settings) {
  const targetKeywords = settings.targetKeywords ?? [];
  const pages = crawl.pages;
  const htmlPages = pages.filter(DEFAULT_APPLIES);
  const indexable = htmlPages.filter((p) => !p.noindex);

  const ctx = {
    startUrl: crawl.startUrl,
    targetKeywords,
    // Duplicate detection only considers indexable pages; noindex duplicates are fine.
    titleCounts: countBy(indexable.map((p) => p.title?.toLowerCase())),
    descriptionCounts: countBy(indexable.map((p) => p.metaDescription?.toLowerCase())),
    contentCounts: countBy(indexable.map((p) => p.contentHash)),
    brokenLinksBySource: groupBrokenBySource(crawl.links, (l) => l.kind === 'link' && isBroken(l)),
    brokenImagesBySource: groupBrokenBySource(crawl.links, (l) => l.kind === 'image' && isBroken(l)),
    redirectLinksBySource: groupBrokenBySource(crawl.links, (l) => l.internal && l.kind === 'link' && !isBroken(l) && l.redirectChain.length > 0),
  };

  // ------------------------------------------------------------ page checks
  const results = [];
  const pageIssues = new Map(pages.map((p) => [p.url, []]));

  for (const check of PAGE_CHECKS) {
    const applies = check.applies ?? DEFAULT_APPLIES;
    let applicable = 0;
    const affected = [];
    for (const page of pages) {
      if (!applies(page, ctx)) continue;
      applicable++;
      const outcome = check.test(page, ctx);
      if (outcome) {
        affected.push({ url: page.url, detail: outcome === true ? '' : String(outcome) });
        pageIssues.get(page.url).push({ id: check.id, severity: check.severity, title: check.title, detail: outcome === true ? '' : String(outcome) });
      }
    }
    results.push(buildResult(check, 'page', applicable, affected));
  }

  // ------------------------------------------------------------ site checks
  const sitemapSet = new Set(crawl.sitemap.urls);
  const crawledSet = new Set(pages.flatMap((p) => [p.url, p.finalUrl]));
  const orphanPages = [...sitemapSet].filter((u) => !crawledSet.has(u));
  const keywordSummary = aggregateKeywords(htmlPages, targetKeywords);
  const homepage = pages.find((p) => p.depth === 0 && p.analyzed);

  const site = {
    probes,
    robots: crawl.robots,
    sitemap: crawl.sitemap,
    limits: crawl.limits,
    orphanPages,
    targetKeywords,
    keywordSummary,
    homepage,
  };
  for (const check of SITE_CHECKS) {
    const applies = check.applies ? check.applies(site) : true;
    const outcome = applies ? check.test(site) : false;
    const affected = outcome ? [{ url: crawl.startUrl, detail: outcome === true ? '' : String(outcome) }] : [];
    results.push(buildResult(check, 'site', applies ? 1 : 0, affected));
  }

  // ---------------------------------------------------------------- scoring
  const categoryScores = {};
  for (const [key, label] of Object.entries(CATEGORIES)) {
    const inCategory = results.filter((r) => r.category === key && r.applicable > 0);
    let total = 0;
    let lost = 0;
    for (const r of inCategory) {
      const w = SEVERITY_WEIGHT[r.severity];
      total += w;
      lost += w * (r.affectedCount / r.applicable);
    }
    const score = total ? Math.round(100 * (1 - lost / total)) : 100;
    categoryScores[key] = {
      label,
      score,
      weight: total,
      errors: inCategory.filter((r) => r.severity === 'error' && r.affectedCount).length,
      warnings: inCategory.filter((r) => r.severity === 'warning' && r.affectedCount).length,
      notices: inCategory.filter((r) => r.severity === 'notice' && r.affectedCount).length,
    };
  }
  const totalWeight = Object.values(categoryScores).reduce((s, c) => s + c.weight, 0);
  const overall = totalWeight
    ? Math.round(Object.values(categoryScores).reduce((s, c) => s + c.score * c.weight, 0) / totalWeight)
    : 0;

  const issues = results.filter((r) => r.affectedCount > 0).sort(
    (a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || b.affectedCount - a.affectedCount,
  );
  const passed = results.filter((r) => r.affectedCount === 0 && r.applicable > 0).map(({ affected, ...r }) => r);

  for (const page of pages) {
    page.issues = pageIssues.get(page.url) ?? [];
  }

  // -------------------------------------------------------------- structure
  const depthDistribution = {};
  const statusDistribution = {};
  for (const p of pages) {
    if (!p.blockedByRobots) depthDistribution[p.depth] = (depthDistribution[p.depth] || 0) + 1;
    const bucket = p.blockedByRobots ? 'blocked' : p.status == null ? 'error' : `${String(p.status)[0]}xx`;
    statusDistribution[bucket] = (statusDistribution[bucket] || 0) + 1;
  }

  const brokenLinks = crawl.links.filter(isBroken);
  const summary = {
    score: overall,
    scoreLabel: scoreLabel(overall),
    categoryScores,
    pagesCrawled: pages.length,
    htmlPages: htmlPages.length,
    indexablePages: indexable.length,
    redirects: pages.filter((p) => p.isRedirect).length,
    errorPages: pages.filter((p) => p.status >= 400 || (p.status == null && !p.blockedByRobots)).length,
    blockedPages: pages.filter((p) => p.blockedByRobots).length,
    linksFound: crawl.links.length,
    linksChecked: crawl.links.filter((l) => l.checked).length,
    brokenLinks: brokenLinks.filter((l) => l.kind === 'link').length,
    brokenImages: brokenLinks.filter((l) => l.kind === 'image').length,
    errors: issues.filter((i) => i.severity === 'error').reduce((s, i) => s + i.affectedCount, 0),
    warnings: issues.filter((i) => i.severity === 'warning').reduce((s, i) => s + i.affectedCount, 0),
    notices: issues.filter((i) => i.severity === 'notice').reduce((s, i) => s + i.affectedCount, 0),
    issueTypes: issues.length,
    passedChecks: passed.length,
    avgResponseTimeMs: htmlPages.length ? Math.round(htmlPages.reduce((s, p) => s + p.responseTimeMs, 0) / htmlPages.length) : 0,
    avgWordCount: htmlPages.length ? Math.round(htmlPages.reduce((s, p) => s + p.wordCount, 0) / htmlPages.length) : 0,
    imagesTotal: htmlPages.reduce((s, p) => s + p.imageCount, 0),
    imagesMissingAlt: htmlPages.reduce((s, p) => s + p.imagesMissingAlt, 0),
    reachedPageLimit: crawl.limits.reachedPageLimit,
  };

  return {
    summary,
    issues,
    passed,
    pages,
    links: crawl.links,
    keywords: keywordSummary,
    structure: {
      tree: buildSiteTree(pages.filter((p) => !p.isRedirect), crawl.startUrl),
      depthDistribution,
      statusDistribution,
      orphanPages,
      notInSitemap: crawl.sitemap.found
        ? indexable.filter((p) => !p.inSitemap).map((p) => p.url)
        : [],
      topLinkedPages: [...htmlPages].sort((a, b) => b.inlinks - a.inlinks).slice(0, 20).map((p) => ({ url: p.url, title: p.title, inlinks: p.inlinks })),
    },
    site: {
      robots: crawl.robots,
      sitemap: { ...crawl.sitemap, urls: undefined },
      probes,
      limits: crawl.limits,
    },
  };
}

function buildResult(check, scope, applicable, affected) {
  return {
    id: check.id,
    scope,
    category: check.category,
    categoryLabel: CATEGORIES[check.category],
    severity: check.severity,
    title: check.title,
    description: check.description,
    recommendation: check.recommendation,
    applicable,
    affectedCount: affected.length,
    affected: affected.slice(0, MAX_AFFECTED_STORED),
  };
}
