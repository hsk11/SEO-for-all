// Minimal robots.txt parser implementing the RFC 9309 matching rules we need:
// group selection by user-agent, Allow/Disallow with `*` and `$` wildcards,
// longest-match wins (Allow wins ties), plus Sitemap: discovery.

function patternToRegex(pattern) {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '$') source += '$';
    else source += ch.replace(/[.+?^{}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${source}`);
}

export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
    } else if ((field === 'allow' || field === 'disallow') && current) {
      // An empty Disallow means "allow everything" and adds no rule.
      if (value) current.rules.push({ allow: field === 'allow', path: value, regex: patternToRegex(value) });
    }
  }
  return { groups, sitemaps };
}

function selectGroup(parsed, userAgent) {
  const ua = userAgent.toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const group of parsed.groups) {
    for (const agent of group.agents) {
      if (agent !== '*' && ua.includes(agent) && agent.length > bestLen) {
        best = group;
        bestLen = agent.length;
      }
    }
  }
  return best || parsed.groups.find((g) => g.agents.includes('*')) || null;
}

/** Returns true when `url` may be crawled by `userAgent` under `parsed` rules. */
export function isAllowed(parsed, url, userAgent = '*') {
  if (!parsed) return true;
  const group = selectGroup(parsed, userAgent);
  if (!group) return true;
  const { pathname, search } = new URL(url);
  const target = decodeURIComponentSafe(pathname) + search;
  let verdict = null;
  for (const rule of group.rules) {
    if (!rule.regex.test(target)) continue;
    const len = rule.path.length;
    if (!verdict || len > verdict.len || (len === verdict.len && rule.allow)) {
      verdict = { allow: rule.allow, len };
    }
  }
  return verdict ? verdict.allow : true;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
