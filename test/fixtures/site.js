// A tiny local website with deliberate SEO problems, used by the tests.
// Serve it on 127.0.0.1; links to "localhost" count as external links.

import http from 'node:http';

const layout = ({ title, description, body, head = '', lang = 'en' }) => `<!doctype html>
<html${lang ? ` lang="${lang}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${title != null ? `<title>${title}</title>` : ''}
${description ? `<meta name="description" content="${description}">` : ''}
${head}
</head>
<body>${body}</body>
</html>`;

const filler = (n, word = 'content') =>
  Array.from({ length: n }, (_, i) => `${word} paragraph sentence number ${i} explains useful details for readers`).join('. ');

export function createFixtureSite() {
  let port;
  const ext = () => `http://localhost:${port}`;

  const routes = {
    '/': () =>
      layout({
        title: 'Acme Widgets — Quality SEO Tools and Widgets',
        description: 'Acme builds quality widgets and SEO tools for small businesses. Browse our catalogue, read the blog and get in touch today.',
        head: `<link rel="canonical" href="http://127.0.0.1:${port}/">
<meta property="og:title" content="Acme"><meta property="og:description" content="Widgets"><meta property="og:image" content="/img/ok.png">
<meta name="twitter:card" content="summary">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>
<link rel="icon" href="/favicon.ico">`,
        body: `<h1>Acme SEO tools</h1>
<p>${filler(40, 'widgets')}</p>
<img src="/img/ok.png" alt="Acme logo" width="10" height="10">
<img src="/img/missing.png" alt="Missing image" width="10" height="10">
<a href="/about">About</a>
<a href="/blog/">Blog</a>
<a href="/broken-page">Broken</a>
<a href="/old-page">Old page</a>
<a href="/noindex">Hidden</a>
<a href="/private/secret">Private</a>
<a href="/files/brochure.pdf">Brochure</a>
<a href="${ext()}/ext-ok">External OK</a>
<a href="${ext()}/ext-404">External broken</a>
<a href="mailto:hi@example.com">Mail</a>`,
      }),
    '/about': () =>
      layout({
        title: 'About',
        body: `<h1>About us</h1><h1>Second heading</h1><h3>Skipped level</h3>
<p>Short page.</p>
<img src="/img/ok.png">
<a href="/">Home</a>`,
      }),
    '/blog/': () =>
      layout({
        title: 'Blog — Acme Widgets articles about SEO tools',
        description: 'Articles about widgets and SEO tools.',
        body: `<h1>Blog</h1><p>${filler(10)}</p><a href="/blog/post-1">Post 1</a> <a href="/blog/post-2">Post 2</a> <a href="/">Home</a>`,
      }),
    '/blog/post-1': () =>
      layout({
        title: 'Same Title For Both Blog Posts On The Acme Site Here!!',
        description: 'Duplicate description used on two posts of the Acme blog for testing purposes only.',
        body: `<h1>Post one about seo tools</h1><p>${'seo tools are great. '.repeat(40)}</p><a href="/blog/">Blog</a>`,
      }),
    '/blog/post-2': () =>
      layout({
        title: 'Same Title For Both Blog Posts On The Acme Site Here!!',
        description: 'Duplicate description used on two posts of the Acme blog for testing purposes only.',
        lang: '',
        body: `<h1>Post two</h1><p>${filler(5)}</p><a href="/deep/a">Deep</a><a href="/blog/">Blog</a>`,
      }),
    '/deep/a': () => layout({ title: 'Deep A page of the Acme Widgets website', body: '<h1>A</h1><a href="/deep/a/b">B</a>' }),
    '/deep/a/b': () => layout({ title: 'Deep B page of the Acme Widgets website', body: '<h1>B</h1><a href="/deep/a/b/c">C</a>' }),
    '/deep/a/b/c': () => layout({ title: 'Deep C page of the Acme Widgets website', body: '<h1>C</h1><a href="/deep/a/b/c/d">D</a>' }),
    '/deep/a/b/c/d': () => layout({ title: 'Deep D page of the Acme Widgets website', body: '<h1>D</h1><a href="/">Home</a>' }),
    '/noindex': () =>
      layout({ title: 'Hidden page that should not be indexed ok', head: '<meta name="robots" content="noindex, follow">', body: '<h1>Hidden</h1><a href="/">Home</a>' }),
    '/orphan': () => layout({ title: 'Orphan page only listed in the sitemap', body: '<h1>Orphan</h1>' }),
    '/private/secret': () => layout({ title: 'Secret', body: 'secret' }),
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const host = req.headers.host.split(':')[0];
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (host === 'localhost') {
      if (url.pathname === '/ext-ok') return send(200, 'text/html', '<p>ok</p>');
      return send(404, 'text/html', 'not found');
    }
    if (url.pathname === '/robots.txt') {
      return send(200, 'text/plain', `User-agent: *\nDisallow: /private/\n\nSitemap: http://127.0.0.1:${port}/sitemap.xml\n`);
    }
    if (url.pathname === '/sitemap.xml') {
      const locs = ['/', '/about', '/blog/', '/orphan'].map((p) => `<url><loc>http://127.0.0.1:${port}${p}</loc></url>`).join('');
      return send(200, 'application/xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`);
    }
    if (url.pathname === '/old-page') return send(301, 'text/html', '', { Location: '/old-page-2' });
    if (url.pathname === '/old-page-2') return send(302, 'text/html', '', { Location: '/about' });
    if (url.pathname === '/img/ok.png' || url.pathname === '/favicon.ico') return send(200, 'image/png', Buffer.alloc(10));
    if (url.pathname === '/files/brochure.pdf') return send(200, 'application/pdf', Buffer.alloc(10));
    const route = routes[url.pathname];
    if (route) return send(200, 'text/html; charset=utf-8', route());
    return send(404, 'text/html', layout({ title: 'Not found', body: '<h1>404</h1>' }));
  });

  return {
    async start(listenPort = 0) {
      await new Promise((resolve) => server.listen(listenPort, '127.0.0.1', resolve));
      port = server.address().port;
      return `http://127.0.0.1:${port}/`;
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
    get port() {
      return port;
    },
  };
}
