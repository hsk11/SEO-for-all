// Extracts every on-page SEO signal we report on from one HTML document.

import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { analyzeKeywords, round } from './keywords.js';
import { isInternalUrl, normalizeUrl } from '../crawler/url-utils.js';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function metaContent($, selector) {
  const els = $(selector);
  return { value: els.length ? clean(els.first().attr('content')) : null, count: els.length };
}

function extractVisibleText($) {
  const $body = $('body').clone();
  $body.find('script, style, noscript, template, svg, iframe, canvas, object').remove();
  // Put spaces between block elements so words don't glue together.
  $body.find('*').each((_, el) => {
    $(el).append(' ');
  });
  return clean($body.text());
}

function headingOutline($) {
  const outline = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    outline.push({ level: Number(el.tagName.slice(1)), text: clean($(el).text()).slice(0, 200) });
  });
  return outline;
}

function headingSkips(outline) {
  const skips = [];
  let previous = 0;
  for (const h of outline) {
    if (previous && h.level > previous + 1) skips.push(`H${previous} → H${h.level} ("${h.text.slice(0, 60)}")`);
    previous = h.level;
  }
  return skips;
}

function structuredData($) {
  const types = new Set();
  let jsonLdCount = 0;
  let invalid = 0;
  const collectTypes = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(collectTypes);
    const t = node['@type'];
    if (t) [].concat(t).forEach((x) => types.add(String(x)));
    if (node['@graph']) collectTypes(node['@graph']);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    jsonLdCount++;
    try {
      collectTypes(JSON.parse($(el).text()));
    } catch {
      invalid++;
    }
  });
  $('[itemscope][itemtype]').each((_, el) => {
    const itemtype = $(el).attr('itemtype') || '';
    types.add(itemtype.split('/').pop());
  });
  return {
    jsonLdCount,
    invalidJsonLd: invalid,
    microdataCount: $('[itemscope]').length,
    types: [...types].filter(Boolean),
  };
}

/**
 * @param {object} fetched  result of fetchUrl() for this page
 * @param {object} ctx      { rootUrl, includeSubdomains, targetKeywords }
 */
export function analyzePage(fetched, ctx) {
  const html = fetched.body || '';
  const $ = cheerio.load(html);
  const pageUrl = fetched.finalUrl;
  const baseHref = $('base[href]').attr('href');
  const base = normalizeUrl(baseHref, pageUrl) || pageUrl;
  const isHttps = pageUrl.startsWith('https:');

  // --- metadata
  const titles = $('head title, title').filter((_, el) => $(el).parents('svg').length === 0);
  const title = titles.length ? clean(titles.first().text()) : null;
  const description = metaContent($, 'meta[name="description" i]');
  const keywordsMeta = metaContent($, 'meta[name="keywords" i]');
  const robotsMeta = metaContent($, 'meta[name="robots" i], meta[name="googlebot" i]');
  const xRobotsTag = fetched.headers?.['x-robots-tag'] || null;
  const canonicalEls = $('link[rel~="canonical" i]');
  const canonicalHref = canonicalEls.first().attr('href');
  const canonical = canonicalEls.length ? normalizeUrl(canonicalHref, base) || clean(canonicalHref) : null;
  const viewport = metaContent($, 'meta[name="viewport" i]').value;
  const charset =
    $('meta[charset]').attr('charset') ||
    /charset=([\w-]+)/i.exec($('meta[http-equiv="content-type" i]').attr('content') || '')?.[1] ||
    null;
  const lang = clean($('html').attr('lang')) || null;
  const favicon = $('link[rel~="icon" i], link[rel="shortcut icon" i]').attr('href') || null;

  const robotsDirectives = `${robotsMeta.value || ''},${xRobotsTag || ''}`.toLowerCase();
  const noindex = /\bnoindex\b|\bnone\b/.test(robotsDirectives);
  const nofollowPage = /\bnofollow\b|\bnone\b/.test(robotsDirectives);

  const og = {};
  $('meta[property^="og:" i]').each((_, el) => {
    og[$(el).attr('property').toLowerCase().slice(3)] = clean($(el).attr('content'));
  });
  const twitter = {};
  $('meta[name^="twitter:" i]').each((_, el) => {
    twitter[$(el).attr('name').toLowerCase().slice(8)] = clean($(el).attr('content'));
  });

  const hreflang = $('link[rel="alternate" i][hreflang]')
    .map((_, el) => ({ lang: $(el).attr('hreflang'), href: normalizeUrl($(el).attr('href'), base) }))
    .get();

  // --- headings
  const outline = headingOutline($);
  const h1 = outline.filter((h) => h.level === 1).map((h) => h.text);
  const headingCounts = Object.fromEntries([1, 2, 3, 4, 5, 6].map((l) => [`h${l}`, outline.filter((h) => h.level === l).length]));

  // --- images
  const images = $('img')
    .map((_, el) => {
      const $el = $(el);
      const rawSrc = $el.attr('src') || $el.attr('data-src') || '';
      const alt = $el.attr('alt');
      return {
        src: normalizeUrl(rawSrc, base) || rawSrc,
        alt: alt === undefined ? null : clean(alt),
        hasAltAttribute: alt !== undefined,
        width: $el.attr('width') || null,
        height: $el.attr('height') || null,
        loading: $el.attr('loading') || null,
      };
    })
    .get()
    .filter((img) => img.src && !img.src.startsWith('data:'));

  // --- links
  const links = [];
  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = normalizeUrl($el.attr('href'), base);
    if (!href) return;
    const rel = ($el.attr('rel') || '').toLowerCase();
    const anchor = clean($el.text()) || clean($el.find('img').attr('alt')) || clean($el.attr('title')) || '';
    links.push({
      url: href,
      anchor: anchor.slice(0, 150),
      nofollow: /\bnofollow\b/.test(rel) || /\b(sponsored|ugc)\b/.test(rel),
      internal: isInternalUrl(href, ctx.rootUrl, ctx),
    });
  });

  // --- mixed content (http resources on an https page)
  const mixedContent = [];
  if (isHttps) {
    $('img[src], script[src], link[rel~="stylesheet" i][href], iframe[src], video[src], audio[src], source[src]').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('href') || '';
      if (/^http:\/\//i.test(src)) mixedContent.push(src);
    });
  }

  // --- content
  const text = extractVisibleText($);
  const keywords = analyzeKeywords(
    {
      text,
      title,
      description: description.value,
      h1,
      headings: outline.filter((h) => h.level > 1).map((h) => h.text),
      url: pageUrl,
      altTexts: images.map((i) => i.alt).filter(Boolean),
    },
    ctx.targetKeywords,
  );
  const htmlBytes = Buffer.byteLength(html);
  const textBytes = Buffer.byteLength(text);
  const normalizedText = text.toLowerCase().replace(/\s+/g, ' ');

  const internalLinks = links.filter((l) => l.internal);
  const externalLinks = links.filter((l) => !l.internal);

  return {
    title,
    titleLength: title ? title.length : 0,
    titleCount: titles.length,
    metaDescription: description.value,
    metaDescriptionLength: description.value ? description.value.length : 0,
    metaDescriptionCount: description.count,
    metaKeywords: keywordsMeta.value,
    metaRobots: robotsMeta.value,
    xRobotsTag,
    noindex,
    nofollowPage,
    canonical,
    canonicalCount: canonicalEls.length,
    lang,
    charset,
    viewport,
    favicon,
    og,
    twitter,
    hreflang,
    headings: headingCounts,
    headingOutline: outline.slice(0, 100),
    headingSkips: headingSkips(outline),
    h1,
    images,
    imageCount: images.length,
    imagesMissingAlt: images.filter((i) => !i.hasAltAttribute).length,
    imagesEmptyAlt: images.filter((i) => i.hasAltAttribute && !i.alt).length,
    links,
    internalLinkCount: internalLinks.length,
    externalLinkCount: externalLinks.length,
    nofollowLinkCount: links.filter((l) => l.nofollow).length,
    internalNofollowCount: internalLinks.filter((l) => l.nofollow).length,
    structuredData: structuredData($),
    mixedContent: [...new Set(mixedContent)],
    wordCount: keywords.totalWords,
    textHtmlRatio: htmlBytes ? round((textBytes / htmlBytes) * 100, 1) : 0,
    contentHash: keywords.totalWords >= 50 ? crypto.createHash('sha1').update(normalizedText).digest('hex') : null,
    keywords,
  };
}
