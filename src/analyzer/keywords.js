// Keyword extraction and density calculations.
//
// density(term) = occurrences * wordsInTerm / totalWords * 100
// which is the usual definition used by SEO tools for multi-word phrases.

const STOPWORDS = new Set(`
a about above after again against all also am an and any are aren't as at be because been before being
below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down
during each few for from further get got had hadn't has hasn't have haven't having he he'd he'll he's her
here here's hers herself him himself his how how's however i i'd i'll i'm i've if in into is isn't it it's
its itself just let's like may me might more most must mustn't my myself new no nor not now of off on once
one only or other ought our ours ourselves out over own per same say says shan't she she'd she'll she's
should shouldn't so some such than that that's the their theirs them themselves then there there's these
they they'd they'll they're they've this those through to too two under until up upon us use used using
very via was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which
while who who's whom why why's will with won't would wouldn't yet you you'd you'll you're you've your
yours yourself yourselves
`.trim().split(/\s+/));

/** Split text into lowercase word tokens (Unicode-aware, keeps inner apostrophes/hyphens). */
export function tokenize(text) {
  return (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || [])
    .map((t) => t.replace(/’/g, "'"));
}

function isContentWord(token) {
  return token.length > 1 && !STOPWORDS.has(token) && !/^\d+$/.test(token);
}

function countNgrams(tokens, n) {
  const counts = new Map();
  for (let i = 0; i + n <= tokens.length; i++) {
    const gram = tokens.slice(i, i + n);
    // Phrases must start and end with a content word ("the best" is noise).
    if (!isContentWord(gram[0]) || !isContentWord(gram[n - 1])) continue;
    if (n === 1 && !isContentWord(gram[0])) continue;
    const key = gram.join(' ');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function topTerms(counts, n, totalWords, limit, minCount) {
  return [...counts.entries()]
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count, density: round(totalWords ? (count * n * 100) / totalWords : 0) }));
}

export function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Count non-overlapping occurrences of a phrase (token sequence) in tokens. */
export function countPhrase(tokens, phraseTokens) {
  if (!phraseTokens.length) return 0;
  let count = 0;
  for (let i = 0; i + phraseTokens.length <= tokens.length; ) {
    let match = true;
    for (let j = 0; j < phraseTokens.length; j++) {
      if (tokens[i + j] !== phraseTokens[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      count++;
      i += phraseTokens.length;
    } else {
      i++;
    }
  }
  return count;
}

function containsPhrase(text, phraseTokens) {
  return countPhrase(tokenize(text), phraseTokens) > 0;
}

/**
 * Analyse keyword usage for one page.
 * @param {object} input
 * @param {string} input.text     visible body text
 * @param {string} input.title
 * @param {string} input.description
 * @param {string[]} input.h1     H1 texts
 * @param {string[]} input.headings  H2-H6 texts
 * @param {string} input.url
 * @param {string[]} input.altTexts
 * @param {string[]} targetKeywords  user-defined focus keywords
 */
export function analyzeKeywords(input, targetKeywords = []) {
  const tokens = tokenize(input.text);
  const totalWords = tokens.length;
  const minCount = totalWords > 200 ? 2 : 1;

  const result = {
    totalWords,
    uniqueWords: new Set(tokens).size,
    top: topTerms(countNgrams(tokens, 1), 1, totalWords, 25, minCount),
    bigrams: topTerms(countNgrams(tokens, 2), 2, totalWords, 15, 2),
    trigrams: topTerms(countNgrams(tokens, 3), 3, totalWords, 10, 2),
    targets: [],
  };

  const firstWords = tokens.slice(0, 100);
  const urlText = decodeURIComponentSafe(input.url || '').replace(/[-_/.]+/g, ' ');

  for (const keyword of targetKeywords) {
    const phrase = tokenize(keyword);
    if (!phrase.length) continue;
    const count = countPhrase(tokens, phrase);
    result.targets.push({
      keyword,
      count,
      density: round(totalWords ? (count * phrase.length * 100) / totalWords : 0),
      inTitle: containsPhrase(input.title, phrase),
      inDescription: containsPhrase(input.description, phrase),
      inH1: (input.h1 || []).some((h) => containsPhrase(h, phrase)),
      inHeadings: (input.headings || []).some((h) => containsPhrase(h, phrase)),
      inUrl: containsPhrase(urlText, phrase),
      inFirst100Words: countPhrase(firstWords, phrase) > 0,
      inImageAlt: (input.altTexts || []).some((a) => containsPhrase(a, phrase)),
    });
  }
  return result;
}

/** Merge per-page term counts into site-wide totals. */
export function aggregateKeywords(pages, targetKeywords = []) {
  const totals = { 1: new Map(), 2: new Map(), 3: new Map() };
  const pagesWithTerm = new Map();
  let totalWords = 0;

  for (const page of pages) {
    if (!page.keywords) continue;
    totalWords += page.keywords.totalWords;
    for (const [n, list] of [[1, page.keywords.top], [2, page.keywords.bigrams], [3, page.keywords.trigrams]]) {
      for (const { term, count } of list) {
        totals[n].set(term, (totals[n].get(term) || 0) + count);
        pagesWithTerm.set(term, (pagesWithTerm.get(term) || 0) + 1);
      }
    }
  }

  const build = (n, limit) =>
    topTerms(totals[n], n, totalWords, limit, 1).map((t) => ({ ...t, pages: pagesWithTerm.get(t.term) || 0 }));

  const targets = targetKeywords.map((keyword) => {
    let count = 0;
    const stats = { pages: 0, inTitle: 0, inDescription: 0, inH1: 0, inUrl: 0 };
    const phraseLength = tokenize(keyword).length || 1;
    for (const page of pages) {
      const t = page.keywords?.targets.find((x) => x.keyword === keyword);
      if (!t) continue;
      count += t.count;
      if (t.count > 0) stats.pages++;
      if (t.inTitle) stats.inTitle++;
      if (t.inDescription) stats.inDescription++;
      if (t.inH1) stats.inH1++;
      if (t.inUrl) stats.inUrl++;
    }
    return {
      keyword,
      count,
      density: round(totalWords ? (count * phraseLength * 100) / totalWords : 0),
      ...stats,
    };
  });

  return { totalWords, top: build(1, 50), bigrams: build(2, 30), trigrams: build(3, 20), targets };
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
