# SEO-for-all

A self-hosted SEO analyzer. Create a project for a website, run an audit, explore the results in the browser, and download the report as **PDF** or **Excel**. Everything is stored locally in JSON files, so no database server is needed.

## Features

- **Projects**: one per website, with crawl settings and target keywords. Each project keeps its audit history and a score-over-time chart.
- **Crawler**: breadth-first, so each page's depth is its real click distance from the start page. It respects `robots.txt` and meta `nofollow`, records redirect chains, reads XML sitemaps (including sitemap indexes), and runs requests concurrently with a timeout.
- **On-page SEO checks** (50+), each with a severity, an explanation and how to fix it:
  - **Meta tags**: missing, short, long, duplicate or multiple titles and meta descriptions; `lang`; charset; favicon
  - **Content**: H1 missing or multiple, skipped heading levels, thin content, text-to-HTML ratio, duplicate content, keyword stuffing
  - **Links**: broken internal and external links, links to redirects, internal `nofollow`, dead-end pages, pages with few inlinks, orphan pages
  - **Images**: missing alt text, broken images, missing width/height, no lazy loading
  - **Technical**: 4xx and 5xx pages, failed fetches, redirect chains, temporary redirects, canonical problems, `noindex`, viewport, mixed content, URL format and length, crawl depth, HTTPS, HTTP→HTTPS redirect, www/non-www consolidation, robots.txt, sitemap, soft 404s
  - **Social & rich results**: Open Graph, Twitter card, JSON-LD and microdata (including invalid JSON-LD)
  - **Performance**: slow responses, large HTML documents
- **Keyword density**: top single words and 2- and 3-word phrases, site-wide and per page (stop words excluded). For each target keyword it shows density and whether it appears in the title, description, H1, headings, URL, first 100 words and image alt text.
- **Site structure**: URL tree, pages by depth, most-linked pages, orphan pages, indexable pages missing from the sitemap, and the robots.txt contents.
- **Scores**: an overall score from 0 to 100 plus a score for each category (see *Scoring* below).
- **Reports**:
  - **PDF**: summary, issues table, issue details with fixes, broken links, pages overview, keywords and site structure
  - **Excel**: 12 sheets: Summary, Issues, Issue details, Pages, Broken links, All links, Redirects, Images, Keywords, Keyword density by page, Site structure and Passed checks
- **UI**: a dashboard, project pages, live audit progress with cancel, a tabbed results view (Overview, Issues, Pages, Metadata, Links, Images, Keywords, Structure), a detail panel for each page, and a Reports page listing every completed audit. Light and dark themes; works on mobile.

## Quick start

Requires Node.js 20 or later.

```bash
npm install
npm start
# open http://127.0.0.1:3000
```

1. Click **New project** and enter a name, the website URL and (optionally) target keywords.
2. Click **Create & run audit**. Progress updates live.
3. Explore the results tabs, or download the **PDF** or **Excel** report. All past reports are listed under **Reports**.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. The crawler fetches any URL a user submits, so only expose it on a network (`0.0.0.0`) if you trust its users. |
| `DATA_DIR` | `./data` | Where the JSON database and audit results are stored |
| `MAX_CONCURRENT_AUDITS` | `2` | How many audits can run at the same time |
| `PDF_FONT_PATH` / `PDF_FONT_BOLD_PATH` | auto-detected | A Unicode TTF font for PDF reports. DejaVu Sans and Arial are found automatically in common system locations. Without one, PDFs use Helvetica, and characters outside Latin-1 (for example Hindi or CJK titles) are shown as `?`. |

These settings are per project, set in the project form:

- Max pages
- Max depth
- Concurrent requests
- Request timeout
- Maximum number of uncrawled links to check
- Whether to check external links
- Whether to respect robots.txt
- Whether to include subdomains

## Storage

```
data/
  db.json               projects + audit metadata (status, progress, summary)
  audits/<auditId>.json full results for one audit (pages, links, issues, keywords, structure)
```

Each write goes to a temporary file that is then renamed over the original, and writes are queued one at a time, so a crash can't leave a half-written file. If the server restarts during an audit, that audit is marked **failed** the next time the server starts. To back up or move your data, copy the `data/` folder.

## Scoring

Each check has a severity weight: error = 10, warning = 5, notice = 1. A check that applies to N pages and fails on F of them loses `weight × F / N`. Each category score is the share of its weighted checks that passed. The overall score is the average of the category scores, weighted by how much each category's checks weigh. Labels: 90+ Excellent, 75+ Good, 50+ Needs work, below 50 Poor.

## API

All endpoints are JSON under `/api`:

| Method | Path | Description |
|---|---|---|
| GET/POST | `/projects` | List or create projects |
| GET/PUT/DELETE | `/projects/:id` | Read, update or delete a project (deleting also removes its audits) |
| GET/POST | `/projects/:id/audits` | List a project's audits or start a new one (409 if one is already running) |
| GET | `/audits?status=completed&projectId=` | List audits across projects |
| GET/DELETE | `/audits/:id` | Audit status and progress, or delete the audit |
| POST | `/audits/:id/cancel` | Cancel a queued or running audit |
| GET | `/audits/:id/results` | Full results of a completed audit |
| GET | `/audits/:id/report.pdf` · `/report.xlsx` | Download a report |
| GET | `/meta` | Default settings and the full check catalogue |

## Development

```bash
npm run dev        # restart on file changes
npm test           # unit, integration, edge-case, API, store and report tests (~105 tests, no browser needed)
npm run test:e2e   # browser end-to-end tests (Playwright + headless Chromium)
npm run test:all   # both
```

Before the first `test:e2e` run, install the browser: `npx playwright install --with-deps chromium`.

| Suite | What it covers |
|---|---|
| `test/unit.test.js` | URL normalisation, robots.txt matching, sitemap parsing, tokenising, keyword density, page metadata extraction, input validation |
| `test/integration.test.js` | A full audit of the fixture website through the HTTP API. Checks that every planted issue is detected, that PDF and Excel reports are produced, and that data persists, updates, cancels and deletes correctly |
| `test/crawler-edge.test.js` | Crawler edge cases, each against its own small test site. Start URL that redirects (internally or to another domain), unreachable or non-HTML start URL, start blocked by robots.txt. Redirect loops and over-long chains, timeouts with a retry, dropped connections that recover, 5xx pages, servers that reject HEAD. Empty or malformed HTML, charset declared only in `<meta>`, Hindi/Japanese text, very large pages. Duplicates where `noindex` pages are excluded, canonical tags, X-Robots-Tag. Tricky links (`<base href>`, `../`, protocol-relative, fragments, mailto/tel/javascript). Endless pagination, max depth, robots.txt and nofollow on and off, skipping external links, the link-check cap. Catch-all sites and soft 404s, sitemap indexes with a broken child sitemap, mixed content, cancelling mid-crawl |
| `test/api-edge.test.js` | JSON 404, 400, 409 and 413 responses, malformed JSON, path traversal, every validation limit, audit queueing and concurrency limits, refusing actions while an audit runs, cancelling queued and running audits, settings saved with each audit, reports for an unreachable site, non-ASCII report file names, static file safety |
| `test/store-reports.test.js` | Refusing to overwrite a corrupt database, 60 concurrent writes, cleanup of result files, recovery after a restart, reports for a 260-page site with Unicode titles, empty reports |
| `test/e2e/ui.e2e.test.js` | The real UI in Chromium: form validation, create and run, live progress, script injection in project names shown as plain text, every results tab with its filters, search and sorting, the detail panels, deep links and back/forward, PDF and Excel downloads, re-runs and the score trend, confirmation dialogs, editing settings, cancelling an audit, the Reports page, not-found pages, theme persistence, no sideways scrolling at 400px on every screen, and no uncaught JS errors |

The integration and E2E tests audit a small fixture website (`test/fixtures/site.js`) that has known SEO problems built in. The edge-case tests use `test/helpers/http-site.js` to create a separate small site for each scenario.

### Project layout

```
src/
  server.js              entry point
  app.js                 Express API + static UI
  db/store.js            file-based JSON database
  crawler/               fetcher (redirects, retries), robots.txt, sitemap, BFS crawler
  analyzer/              page analyzer, keyword density, check catalogue, scoring, site probes
  audit/runner.js        background audit queue (progress, cancellation)
  reports/               excel.js, pdf.js
public/                  single-page UI (vanilla JS modules, no build step)
test/                    node:test suites + fixture site
```

## Limitations

- The crawler doesn't run JavaScript, so it only sees the HTML the server sends. Sites that render content in the browser (client-side SPAs) will look mostly empty.
- Site-wide keyword totals are built from each page's top terms, so very rare terms are under-counted.
- `npm audit` reports a moderate advisory in a glob/minimatch package that exceljs depends on indirectly. The vulnerable code only runs on glob patterns, never on user input or crawled data.
