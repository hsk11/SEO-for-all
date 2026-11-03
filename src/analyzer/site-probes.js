// Site-wide probes that need their own requests (not discoverable by crawling).

import crypto from 'node:crypto';
import { fetchUrl } from '../crawler/fetcher.js';

function swapWww(url) {
  const u = new URL(url);
  u.hostname = u.hostname.startsWith('www.') ? u.hostname.slice(4) : `www.${u.hostname}`;
  return u.href;
}

export async function runSiteProbes(startUrl, fetchOptions) {
  const start = new URL(startUrl);
  const home = `${start.origin}/`;
  const opts = { ...fetchOptions, readBody: false };

  const [homeRes, httpRes, wwwRes, missingRes] = await Promise.all([
    fetchUrl(home, { ...fetchOptions }),
    start.protocol === 'https:' ? fetchUrl(home.replace(/^https:/, 'http:'), opts) : Promise.resolve(null),
    // Only meaningful for real hostnames, not IPs or localhost.
    start.hostname.includes('.') && !/^[\d.]+$/.test(start.hostname) ? fetchUrl(swapWww(home), opts) : Promise.resolve(null),
    fetchUrl(`${start.origin}/seo-analyzer-check-${crypto.randomBytes(6).toString('hex')}`, opts),
  ]);

  const homeFinal = homeRes.finalUrl ? new URL(homeRes.finalUrl) : null;

  // Favicon: declared in HTML is checked by the crawler; here we probe the default path.
  const faviconRes = await fetchUrl(`${start.origin}/favicon.ico`, opts);

  return {
    https: {
      usesHttps: (homeFinal?.protocol ?? start.protocol) === 'https:',
      httpRedirectsToHttps: httpRes ? Boolean(httpRes.finalUrl?.startsWith('https:')) : null,
      httpStatus: httpRes?.status ?? null,
      httpError: httpRes?.error ?? null,
    },
    wwwCanonicalization: wwwRes
      ? {
          variant: swapWww(home),
          status: wwwRes.status,
          error: wwwRes.error,
          // Good: the variant redirects to the primary host, or doesn't resolve at all.
          consolidated:
            Boolean(wwwRes.error) ||
            (wwwRes.redirectChain.length > 0 && new URL(wwwRes.finalUrl).hostname === (homeFinal?.hostname ?? start.hostname)),
        }
      : null,
    notFoundHandling: {
      testedUrl: missingRes.url,
      status: missingRes.status,
      error: missingRes.error,
      // A random URL answering 200 is a "soft 404".
      returns404: missingRes.status === 404 || missingRes.status === 410,
    },
    favicon: {
      defaultPathStatus: faviconRes.status,
      defaultPathOk: faviconRes.ok,
    },
    homepage: {
      status: homeRes.status,
      responseTimeMs: homeRes.responseTimeMs,
      error: homeRes.error,
      headers: {
        server: homeRes.headers?.server ?? null,
        'content-encoding': homeRes.headers?.['content-encoding'] ?? null,
        'strict-transport-security': homeRes.headers?.['strict-transport-security'] ?? null,
        'cache-control': homeRes.headers?.['cache-control'] ?? null,
      },
    },
  };
}
