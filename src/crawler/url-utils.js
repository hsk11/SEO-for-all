// URL helpers shared by the crawler and analyzers.

const NON_HTML_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'rtf', 'odt',
  'zip', 'rar', 'gz', 'tgz', '7z', 'tar', 'dmg', 'exe', 'msi', 'apk',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'tif', 'tiff',
  'mp3', 'wav', 'ogg', 'mp4', 'webm', 'mov', 'avi', 'mkv',
  'css', 'js', 'mjs', 'json', 'xml', 'rss', 'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

/**
 * Resolve `href` against `base` and normalize it for de-duplication:
 * drops the fragment, lowercases scheme/host, strips default ports.
 * Returns null for non-http(s) links (mailto:, tel:, javascript:, data: ...).
 */
export function normalizeUrl(href, base) {
  if (href == null) return null;
  const trimmed = String(href).trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  let url;
  try {
    url = base ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  // WHATWG URL already lowercases host and drops default ports.
  return url.href;
}

/** Normalize a user-entered site URL ("example.com" -> "https://example.com/"). */
export function normalizeStartUrl(input) {
  let value = String(input ?? '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  if (!url.hostname.includes('.') && url.hostname !== 'localhost' && !/^[\d.]+$/.test(url.hostname)) {
    return null;
  }
  return url.href;
}

function bareHost(hostname) {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

/**
 * Is `url` part of the site rooted at `rootUrl`?
 * www/non-www variants are treated as the same site; other subdomains only
 * when includeSubdomains is set.
 */
export function isInternalUrl(url, rootUrl, { includeSubdomains = false } = {}) {
  let target;
  let root;
  try {
    target = new URL(url);
    root = new URL(rootUrl);
  } catch {
    return false;
  }
  const t = bareHost(target.hostname);
  const r = bareHost(root.hostname);
  if (t === r) return target.port === root.port;
  return includeSubdomains && t.endsWith(`.${r}`);
}

export function looksLikeNonHtml(url) {
  try {
    const { pathname } = new URL(url);
    const match = /\.([a-z0-9]{1,5})$/i.exec(pathname);
    return Boolean(match && NON_HTML_EXTENSIONS.has(match[1].toLowerCase()));
  } catch {
    return false;
  }
}

export function originOf(url) {
  return new URL(url).origin;
}
