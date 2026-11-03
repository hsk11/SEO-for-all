// File-based JSON database.
//
// Layout on disk (under DATA_DIR):
//   db.json               -> { version, projects: [], audits: [] }   (small metadata)
//   audits/<auditId>.json -> full crawl/analysis result for one audit (can be large)
//
// All mutations happen synchronously on the in-memory copy and are then flushed
// to disk through a serialized write queue using write-to-temp + rename, so the
// file on disk is never half-written even if the process dies mid-write.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DB_VERSION = 1;

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

async function writeFileAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, contents);
  await fs.rename(tmp, file);
}

function now() {
  return new Date().toISOString();
}

export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.dbFile = path.join(this.dataDir, 'db.json');
    this.auditDir = path.join(this.dataDir, 'audits');
    this.data = null;
    this.writeChain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.auditDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.dbFile, 'utf8');
      this.data = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot read database ${this.dbFile}: ${err.message}`);
      this.data = { version: DB_VERSION, projects: [], audits: [] };
      await this.flush();
    }
    this.data.projects ??= [];
    this.data.audits ??= [];
    return this;
  }

  /** Queue a write of the current in-memory snapshot. Resolves once it is on disk. */
  flush() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(() => writeFileAtomic(this.dbFile, snapshot));
    return this.writeChain;
  }

  // ---------------------------------------------------------------- projects

  listProjects() {
    return [...this.data.projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getProject(id) {
    const project = this.data.projects.find((p) => p.id === id);
    if (!project) throw new NotFoundError(`Project ${id} not found`);
    return project;
  }

  async createProject(fields) {
    const project = { id: crypto.randomUUID(), ...fields, createdAt: now(), updatedAt: now() };
    this.data.projects.push(project);
    await this.flush();
    return project;
  }

  async updateProject(id, fields) {
    const project = this.getProject(id);
    Object.assign(project, fields, { id, createdAt: project.createdAt, updatedAt: now() });
    await this.flush();
    return project;
  }

  async deleteProject(id) {
    this.getProject(id);
    const audits = this.data.audits.filter((a) => a.projectId === id);
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    this.data.audits = this.data.audits.filter((a) => a.projectId !== id);
    await this.flush();
    await Promise.all(audits.map((a) => this.#removeResultFile(a.id)));
  }

  // ------------------------------------------------------------------ audits

  listAudits({ projectId, status } = {}) {
    return this.data.audits
      .filter((a) => (!projectId || a.projectId === projectId) && (!status || a.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getAudit(id) {
    const audit = this.data.audits.find((a) => a.id === id);
    if (!audit) throw new NotFoundError(`Audit ${id} not found`);
    return audit;
  }

  async createAudit(projectId, fields = {}) {
    this.getProject(projectId);
    const audit = {
      id: crypto.randomUUID(),
      projectId,
      status: 'queued',
      progress: { phase: 'queued', message: 'Waiting to start', percent: 0 },
      summary: null,
      error: null,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      ...fields,
    };
    this.data.audits.push(audit);
    await this.flush();
    return audit;
  }

  async updateAudit(id, fields, { persist = true } = {}) {
    const audit = this.getAudit(id);
    Object.assign(audit, fields, { id, projectId: audit.projectId });
    if (persist) await this.flush();
    return audit;
  }

  async deleteAudit(id) {
    this.getAudit(id);
    this.data.audits = this.data.audits.filter((a) => a.id !== id);
    await this.flush();
    await this.#removeResultFile(id);
  }

  #resultFile(id) {
    // ids are UUIDs we generated; still guard against path tricks
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError(`Audit ${id} not found`);
    return path.join(this.auditDir, `${id}.json`);
  }

  async saveAuditResult(id, result) {
    await writeFileAtomic(this.#resultFile(id), JSON.stringify(result));
  }

  async getAuditResult(id) {
    this.getAudit(id);
    try {
      return JSON.parse(await fs.readFile(this.#resultFile(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw new NotFoundError(`No results stored for audit ${id}`);
      throw err;
    }
  }

  async #removeResultFile(id) {
    await fs.rm(this.#resultFile(id), { force: true });
  }

  /** Audits that were running when the server stopped can never finish; mark them failed. */
  async recoverInterruptedAudits() {
    let changed = false;
    for (const audit of this.data.audits) {
      if (audit.status === 'queued' || audit.status === 'running') {
        audit.status = 'failed';
        audit.error = 'Interrupted: the server stopped before this audit finished.';
        audit.finishedAt = now();
        changed = true;
      }
    }
    if (changed) await this.flush();
  }
}
