// In-process audit job queue.
//
// Audits run in the background; their progress is written to the store so the
// UI can poll it. A limited number run at once, and each can be cancelled.

import { crawlSite } from '../crawler/crawler.js';
import { runSiteProbes } from '../analyzer/site-probes.js';
import { evaluate } from '../analyzer/evaluate.js';

const PROGRESS_FLUSH_MS = 1000;

export class AuditRunner {
  /**
   * @param {import('../db/store.js').Store} store
   * @param {{ maxConcurrent?: number, logger?: Console }} [options]
   */
  constructor(store, { maxConcurrent = 2, logger = console } = {}) {
    this.store = store;
    this.maxConcurrent = maxConcurrent;
    this.logger = logger;
    this.queue = [];
    this.active = new Map(); // auditId -> AbortController
    this.idleWaiters = [];
  }

  async start(projectId) {
    const project = this.store.getProject(projectId);
    const running = this.store
      .listAudits({ projectId })
      .find((a) => a.status === 'queued' || a.status === 'running');
    if (running) {
      const err = new Error('An audit is already in progress for this project.');
      err.status = 409;
      err.auditId = running.id;
      throw err;
    }
    const audit = await this.store.createAudit(projectId, {
      url: project.url,
      settings: structuredClone(project.settings),
    });
    this.queue.push(audit.id);
    this.#pump();
    return audit;
  }

  async cancel(auditId) {
    const audit = this.store.getAudit(auditId);
    if (audit.status === 'queued') {
      this.queue = this.queue.filter((id) => id !== auditId);
      await this.#finish(auditId, { status: 'cancelled', error: 'Cancelled by user.' });
    } else if (audit.status === 'running') {
      this.active.get(auditId)?.abort(new Error('Cancelled by user.'));
    }
    return this.store.getAudit(auditId);
  }

  isBusy() {
    return this.active.size > 0 || this.queue.length > 0;
  }

  /** Resolves once nothing is queued or running (used by tests and shutdown). */
  whenIdle() {
    if (!this.isBusy()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  #pump() {
    while (this.active.size < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift();
      const controller = new AbortController();
      this.active.set(id, controller);
      this.#run(id, controller.signal)
        .catch((err) => this.logger.error(`Audit ${id} crashed:`, err))
        .finally(() => {
          this.active.delete(id);
          this.#pump();
          if (!this.isBusy()) this.idleWaiters.splice(0).forEach((r) => r());
        });
    }
  }

  async #finish(id, fields) {
    await this.store.updateAudit(id, { ...fields, finishedAt: new Date().toISOString() });
  }

  async #run(id, signal) {
    const audit = this.store.getAudit(id);
    const settings = audit.settings;
    let lastFlush = 0;
    const progress = { phase: 'starting', message: 'Starting audit', percent: 1, pagesCrawled: 0, linksChecked: 0, linksTotal: 0 };

    const report = (update) => {
      Object.assign(progress, update);
      const nowMs = Date.now();
      const persist = nowMs - lastFlush > PROGRESS_FLUSH_MS;
      if (persist) lastFlush = nowMs;
      this.store.updateAudit(id, { progress: { ...progress } }, { persist }).catch(() => {});
    };

    await this.store.updateAudit(id, { status: 'running', startedAt: new Date().toISOString(), progress });

    try {
      report({ phase: 'probes', message: 'Checking HTTPS, host canonicalization and 404 handling', percent: 1 });
      const fetchOptions = { timeoutMs: settings.timeoutMs, signal };
      const probes = await runSiteProbes(audit.url, fetchOptions);
      signal.throwIfAborted();

      const crawl = await crawlSite({ startUrl: audit.url, settings, onProgress: report, signal });
      signal.throwIfAborted();

      report({ phase: 'analyzing', message: 'Scoring pages and building report', percent: 92 });
      const result = evaluate(crawl, probes, settings);
      result.audit = {
        id,
        projectId: audit.projectId,
        url: audit.url,
        settings,
        startedAt: this.store.getAudit(id).startedAt,
        finishedAt: new Date().toISOString(),
      };

      report({ phase: 'saving', message: 'Saving results', percent: 98 });
      await this.store.saveAuditResult(id, result);
      await this.#finish(id, {
        status: 'completed',
        summary: result.summary,
        progress: { ...progress, phase: 'done', message: 'Audit complete', percent: 100 },
      });
    } catch (err) {
      const cancelled = signal.aborted;
      const message = cancelled ? 'Cancelled by user.' : err?.message || String(err);
      if (!cancelled) this.logger.error(`Audit ${id} failed:`, err);
      await this.#finish(id, {
        status: cancelled ? 'cancelled' : 'failed',
        error: message,
        progress: { ...progress, phase: cancelled ? 'cancelled' : 'failed', message },
      }).catch(() => {});
    }
  }
}
