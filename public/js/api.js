// Thin client for the JSON API.

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.fields = data?.fields ?? null;
    this.data = data;
  }
}

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

export const api = {
  meta: () => request('GET', '/meta'),
  listProjects: () => request('GET', '/projects'),
  getProject: (id) => request('GET', `/projects/${id}`),
  createProject: (body) => request('POST', '/projects', body),
  updateProject: (id, body) => request('PUT', `/projects/${id}`, body),
  deleteProject: (id) => request('DELETE', `/projects/${id}`),
  listProjectAudits: (id) => request('GET', `/projects/${id}/audits`),
  startAudit: (projectId) => request('POST', `/projects/${projectId}/audits`),
  listAudits: (query = {}) => request('GET', `/audits?${new URLSearchParams(query)}`),
  getAudit: (id) => request('GET', `/audits/${id}`),
  getResults: (id) => request('GET', `/audits/${id}/results`),
  cancelAudit: (id) => request('POST', `/audits/${id}/cancel`),
  deleteAudit: (id) => request('DELETE', `/audits/${id}`),
  reportUrl: (id, format) => `/api/audits/${id}/report.${format}`,
};
