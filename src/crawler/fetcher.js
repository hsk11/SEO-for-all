// HTTP fetching with manual redirect tracking, timeouts and a body-size cap.

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (compatible; SEOAnalyzerBot/1.0; +https://github.com/seo-analyzer)';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function parseCharset(contentType) {
  const match = /charset=["']?([\w-]+)/i.exec(contentType || '');
  return match ? match[1].toLowerCase() : null;
}

async function readBody(response, limit) {
  if (!response.body) return { buffer: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      truncated = true;
      chunks.push(value.subarray(0, value.byteLength - (size - limit)));
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  return { buffer: Buffer.concat(chunks.map((c) => Buffer.from(c))), truncated };
}

// Pages often declare their encoding only in <meta charset>, not the header.
function sniffCharset(buffer) {
  const head = buffer.subarray(0, 2048).toString('latin1');
  const match = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return match ? match[1].toLowerCase() : null;
}

function decode(buffer, contentType) {
  const charset = parseCharset(contentType) || sniffCharset(buffer) || 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function describeError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'Request timed out';
  const cause = err?.cause;
  if (cause?.code === 'ENOTFOUND') return 'DNS lookup failed (host not found)';
  if (cause?.code === 'ECONNREFUSED') return 'Connection refused';
  if (cause?.code === 'ECONNRESET') return 'Connection reset';
  if (cause?.code && /CERT|SSL|TLS/i.test(cause.code)) return `TLS/SSL error (${cause.code})`;
  if (cause?.code) return `${cause.code}${cause.message ? `: ${cause.message}` : ''}`;
  return err?.message || 'Request failed';
}

/**
 * Fetch a URL, following redirects manually so every hop is recorded.
 *
 * @returns {Promise<{
 *   url: string, finalUrl: string, status: number|null, ok: boolean,
 *   redirectChain: {url: string, status: number}[], headers: Record<string,string>,
 *   contentType: string, responseTimeMs: number, sizeBytes: number,
 *   body: string|null, truncated: boolean, error: string|null
 * }>}
 */
export async function fetchUrl(url, options = {}) {
  const { retries = 1, signal } = options;
  let result = await fetchOnce(url, options);
  // Network-level failures (no HTTP status) are often transient under load;
  // retry before reporting a URL as unreachable.
  for (let attempt = 0; attempt < retries && result.error && result.status == null; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    signal?.throwIfAborted();
    result = await fetchOnce(url, options);
  }
  return result;
}

async function fetchOnce(url, options) {
  const {
    method = 'GET',
    timeoutMs = 15000,
    userAgent = DEFAULT_USER_AGENT,
    maxRedirects = 10,
    readBody: wantBody = method === 'GET',
    bodyFilter = (contentType) => /html|xml|text\/plain/i.test(contentType),
    signal,
  } = options;

  const redirectChain = [];
  const started = performance.now();
  let current = url;

  const result = {
    url,
    finalUrl: url,
    status: null,
    ok: false,
    redirectChain,
    headers: {},
    contentType: '',
    responseTimeMs: 0,
    sizeBytes: 0,
    body: null,
    truncated: false,
    error: null,
  };

  try {
    for (let hop = 0; ; hop++) {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const response = await fetch(current, {
        method,
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.8',
        },
      });

      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => {});
        redirectChain.push({ url: current, status: response.status });
        if (hop >= maxRedirects) {
          result.status = response.status;
          result.error = `Too many redirects (>${maxRedirects})`;
          break;
        }
        const next = new URL(location, current).href;
        if (redirectChain.some((r) => r.url === next)) {
          result.status = response.status;
          result.error = 'Redirect loop detected';
          break;
        }
        current = next;
        continue;
      }

      result.finalUrl = current;
      result.status = response.status;
      result.ok = response.ok;
      result.headers = Object.fromEntries(response.headers.entries());
      result.contentType = response.headers.get('content-type') || '';
      const declaredLength = Number(response.headers.get('content-length')) || 0;

      if (wantBody && method === 'GET' && bodyFilter(result.contentType)) {
        const { buffer, truncated } = await readBody(response, MAX_BODY_BYTES);
        result.sizeBytes = Math.max(buffer.byteLength, declaredLength);
        result.truncated = truncated;
        result.body = decode(buffer, result.contentType);
      } else {
        result.sizeBytes = declaredLength;
        await response.body?.cancel().catch(() => {});
      }
      break;
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    result.error = describeError(err);
  }

  result.responseTimeMs = Math.round(performance.now() - started);
  return result;
}

/**
 * Lightweight link check: HEAD first, falling back to GET for servers that
 * reject or mishandle HEAD.
 */
export async function checkUrl(url, options = {}) {
  const head = await fetchUrl(url, { ...options, method: 'HEAD', readBody: false });
  const retry =
    head.error ||
    [400, 403, 404, 405, 406, 429, 500, 501, 503].includes(head.status);
  if (!retry) return head;
  const get = await fetchUrl(url, { ...options, method: 'GET', readBody: false });
  // Prefer the GET answer unless it also failed at the network level and HEAD didn't.
  return get.error && !head.error ? head : get;
}
