// Entry point: `npm start`

import { Store } from './db/store.js';
import { AuditRunner } from './audit/runner.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 3000;
// Bound to localhost by default: the crawler fetches arbitrary URLs on request,
// so don't expose it on the network unless you mean to (HOST=0.0.0.0).
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || './data';
const MAX_CONCURRENT_AUDITS = Number(process.env.MAX_CONCURRENT_AUDITS) || 2;

const store = await new Store(DATA_DIR).init();
await store.recoverInterruptedAudits();
const runner = new AuditRunner(store, { maxConcurrent: MAX_CONCURRENT_AUDITS });
const app = createApp({ store, runner });

const server = app.listen(PORT, HOST, () => {
  console.log(`SEO Analyzer running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Data directory: ${store.dataDir}`);
});

const shutdown = async () => {
  server.close();
  await store.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
