// Validation and defaults for project input coming from the API.

import { normalizeStartUrl } from '../crawler/url-utils.js';

export class ValidationError extends Error {
  constructor(errors) {
    super(Object.values(errors).join(' '));
    this.name = 'ValidationError';
    this.status = 400;
    this.errors = errors;
  }
}

export const DEFAULT_SETTINGS = Object.freeze({
  maxPages: 100,
  maxDepth: 5,
  concurrency: 4,
  timeoutMs: 15000,
  respectRobots: true,
  includeSubdomains: false,
  checkExternalLinks: true,
  maxLinkChecks: 500,
  targetKeywords: [],
});

const LIMITS = {
  maxPages: [1, 2000],
  maxDepth: [0, 20],
  concurrency: [1, 16],
  timeoutMs: [1000, 60000],
  maxLinkChecks: [0, 5000],
};

function toInt(value, [min, max], field, errors, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors[field] = `${field} must be a whole number between ${min} and ${max}.`;
    return fallback;
  }
  return n;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === 'on' || value === '1' || value === 1;
}

function parseKeywords(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,\n]/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const kw = String(raw).trim().replace(/\s+/g, ' ').slice(0, 80);
    if (kw && !seen.has(kw.toLowerCase())) {
      seen.add(kw.toLowerCase());
      out.push(kw);
    }
  }
  return out;
}

/**
 * Validate a create/update payload. With `partial`, missing fields keep the
 * values from `existing`.
 */
export function validateProject(input = {}, existing = null) {
  const errors = {};
  const base = existing ?? { name: '', url: '', description: '', settings: DEFAULT_SETTINGS };

  const name = input.name !== undefined ? String(input.name).trim() : base.name;
  if (!name) errors.name = 'Project name is required.';
  else if (name.length > 100) errors.name = 'Project name must be at most 100 characters.';

  let url = base.url;
  if (input.url !== undefined) {
    url = normalizeStartUrl(input.url);
    if (!url) errors.url = 'Enter a valid website URL, e.g. https://example.com.';
  } else if (!url) {
    errors.url = 'Website URL is required.';
  }

  const description = input.description !== undefined ? String(input.description).trim().slice(0, 500) : base.description ?? '';

  const s = input.settings ?? {};
  const prev = { ...DEFAULT_SETTINGS, ...base.settings };
  const settings = {
    maxPages: toInt(s.maxPages, LIMITS.maxPages, 'maxPages', errors, prev.maxPages),
    maxDepth: toInt(s.maxDepth, LIMITS.maxDepth, 'maxDepth', errors, prev.maxDepth),
    concurrency: toInt(s.concurrency, LIMITS.concurrency, 'concurrency', errors, prev.concurrency),
    timeoutMs: toInt(s.timeoutMs, LIMITS.timeoutMs, 'timeoutMs', errors, prev.timeoutMs),
    maxLinkChecks: toInt(s.maxLinkChecks, LIMITS.maxLinkChecks, 'maxLinkChecks', errors, prev.maxLinkChecks),
    respectRobots: toBool(s.respectRobots, prev.respectRobots),
    includeSubdomains: toBool(s.includeSubdomains, prev.includeSubdomains),
    checkExternalLinks: toBool(s.checkExternalLinks, prev.checkExternalLinks),
    targetKeywords: s.targetKeywords !== undefined ? parseKeywords(s.targetKeywords) : prev.targetKeywords,
  };
  if (settings.targetKeywords.length > 25) errors.targetKeywords = 'At most 25 target keywords are allowed.';

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { name, url, description, settings };
}
