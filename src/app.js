// Express application: JSON API + static single-page UI.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { validateProject, DEFAULT_SETTINGS } from './projects/validation.js';
import { buildExcelReport } from './reports/excel.js';
import { buildPdfReport } from './reports/pdf.js';
import { checkCatalog } from './analyzer/checks.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const isActive = (audit) => audit.status === 'queued' || audit.status === 'running';

function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

function reportFilename(project, audit, ext) {
  // Keep letters from any script; Express adds an ASCII fallback + RFC 5987 filename*.
  const slug = project.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'site';
  const date = (audit.finishedAt || audit.createdAt).slice(0, 10);
  return `seo-report-${slug}-${date}.${ext}`;
}

/**
 * @param {{ store: import('./db/store.js').Store, runner: import('./audit/runner.js').AuditRunner }} deps
 */
export function createApp({ store, runner }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  const api = express.Router();

  const withLatestAudit = (project) => {
    const audits = store.listAudits({ projectId: project.id });
    const latestCompleted = audits.find((a) => a.status === 'completed') ?? null;
    return {
      ...project,
      auditCount: audits.length,
      latestAudit: audits[0] ?? null,
      latestCompletedAudit: latestCompleted,
    };
  };

  const withProjectName = (audit) => {
    const project = store.data.projects.find((p) => p.id === audit.projectId);
    return { ...audit, projectName: project?.name ?? '(deleted project)' };
  };

  // ------------------------------------------------------------- projects
  api.get('/projects', (req, res) => {
    res.json(store.listProjects().map(withLatestAudit));
  });

  api.post('/projects', async (req, res) => {
    const fields = validateProject(req.body);
    const project = await store.createProject(fields);
    res.status(201).json(withLatestAudit(project));
  });

  api.get('/projects/:id', (req, res) => {
    res.json(withLatestAudit(store.getProject(req.params.id)));
  });

  api.put('/projects/:id', async (req, res) => {
    const existing = store.getProject(req.params.id);
    const fields = validateProject(req.body, existing);
    res.json(withLatestAudit(await store.updateProject(existing.id, fields)));
  });

  api.delete('/projects/:id', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (store.listAudits({ projectId: project.id }).some(isActive)) {
      throw conflict('Cancel the running audit before deleting this project.');
    }
    await store.deleteProject(project.id);
    res.status(204).end();
  });

  // --------------------------------------------------------------- audits
  api.get('/projects/:id/audits', (req, res) => {
    store.getProject(req.params.id);
    res.json(store.listAudits({ projectId: req.params.id }));
  });

  api.post('/projects/:id/audits', async (req, res) => {
    const audit = await runner.start(req.params.id);
    res.status(202).json(audit);
  });

  api.get('/audits', (req, res) => {
    const { status, projectId } = req.query;
    res.json(store.listAudits({ status, projectId }).map(withProjectName));
  });

  api.get('/audits/:id', (req, res) => {
    res.json(withProjectName(store.getAudit(req.params.id)));
  });

  api.get('/audits/:id/results', async (req, res) => {
    const audit = store.getAudit(req.params.id);
    if (audit.status !== 'completed') throw conflict(`Audit is ${audit.status}; results are not available.`);
    res.json(await store.getAuditResult(audit.id));
  });

  api.post('/audits/:id/cancel', async (req, res) => {
    res.json(await runner.cancel(req.params.id));
  });

  api.delete('/audits/:id', async (req, res) => {
    const audit = store.getAudit(req.params.id);
    if (isActive(audit)) throw conflict('Cancel the audit before deleting it.');
    await store.deleteAudit(audit.id);
    res.status(204).end();
  });

  // -------------------------------------------------------------- reports
  const loadReportData = async (auditId) => {
    const audit = store.getAudit(auditId);
    if (audit.status !== 'completed') throw conflict('Reports are only available for completed audits.');
    const project = store.data.projects.find((p) => p.id === audit.projectId) ?? { name: 'Project' };
    const result = await store.getAuditResult(audit.id);
    return { audit, project, result };
  };

  api.get('/audits/:id/report.xlsx', async (req, res) => {
    const { audit, project, result } = await loadReportData(req.params.id);
    const buffer = await buildExcelReport(project, audit, result);
    res.attachment(reportFilename(project, audit, 'xlsx'));
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buffer);
  });

  api.get('/audits/:id/report.pdf', async (req, res) => {
    const { audit, project, result } = await loadReportData(req.params.id);
    const buffer = await buildPdfReport(project, audit, result);
    res.attachment(reportFilename(project, audit, 'pdf'));
    res.type('application/pdf').send(buffer);
  });

  // ----------------------------------------------------------------- misc
  api.get('/meta', (req, res) => {
    res.json({ defaults: DEFAULT_SETTINGS, checks: checkCatalog() });
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.use('/api', api);
  app.use(express.static(PUBLIC_DIR));
  // SPA uses hash routing, so only "/" needs to serve index.html.

  // App-level so it also catches body-parser errors (malformed JSON, 413),
  // which happen before the /api router runs. Express 5 forwards rejected
  // promises from async handlers here too.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const body = {
      error: status >= 500 ? 'Internal server error' : err.type === 'entity.parse.failed' ? 'Request body is not valid JSON.' : err.message,
    };
    if (err.errors) body.fields = err.errors;
    if (err.auditId) body.auditId = err.auditId;
    res.status(status).json(body);
  });

  return app;
}
