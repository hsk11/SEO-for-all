// Create / edit project form.

import { api } from '../api.js';
import { html, raw, setHtml, $, $$, toast, loading } from '../ui.js';

export async function renderProjectForm(root, projectId) {
  setHtml(root, loading());
  const [meta, project] = await Promise.all([api.meta(), projectId ? api.getProject(projectId) : null]);
  const s = { ...meta.defaults, ...project?.settings };
  const isEdit = Boolean(project);

  const checked = (v) => (v ? raw('checked') : '');

  setHtml(
    root,
    html`<div class="breadcrumb"><a href="#/">Projects</a>${isEdit ? html` / <a href="#/projects/${project.id}">${project.name}</a>` : ''} / ${isEdit ? 'Settings' : 'New project'}</div>
    <div class="page-head"><div><h1>${isEdit ? 'Project settings' : 'New project'}</h1>
      <div class="sub">${isEdit ? 'Changes apply to the next audit you run.' : 'Tell us which website to analyse and how deep to crawl it.'}</div></div></div>

    <form class="form card card-pad" novalidate>
      <div class="field">
        <label for="f-name">Project name</label>
        <input class="input" id="f-name" name="name" maxlength="100" required value="${project?.name ?? ''}" placeholder="My company website">
        <div class="error-text" data-error="name" hidden></div>
      </div>
      <div class="field">
        <label for="f-url">Website URL</label>
        <input class="input" id="f-url" name="url" required value="${project?.url ?? ''}" placeholder="https://example.com">
        <div class="hint">The crawl starts here and follows internal links on the same domain.</div>
        <div class="error-text" data-error="url" hidden></div>
      </div>
      <div class="field">
        <label for="f-desc">Description <span class="muted">(optional)</span></label>
        <input class="input" id="f-desc" name="description" maxlength="500" value="${project?.description ?? ''}">
      </div>
      <div class="field">
        <label for="f-kw">Target keywords <span class="muted">(optional)</span></label>
        <textarea class="input" id="f-kw" name="targetKeywords" placeholder="seo audit tool, broken link checker">${(s.targetKeywords || []).join(', ')}</textarea>
        <div class="hint">Comma or line separated, up to 25. Each is checked for density and placement in titles, H1s, descriptions and URLs.</div>
        <div class="error-text" data-error="targetKeywords" hidden></div>
      </div>

      <fieldset class="fieldset">
        <legend>Crawl settings</legend>
        <div class="grid grid-3">
          ${numberField('maxPages', 'Max pages', s.maxPages, 1, 2000, 'Stop after this many URLs.')}
          ${numberField('maxDepth', 'Max depth', s.maxDepth, 0, 20, 'Clicks from the start URL.')}
          ${numberField('concurrency', 'Concurrent requests', s.concurrency, 1, 16, 'Be gentle with small servers.')}
          ${numberField('timeoutMs', 'Request timeout (ms)', s.timeoutMs, 1000, 60000, 'Per request.')}
          ${numberField('maxLinkChecks', 'Max link checks', s.maxLinkChecks, 0, 5000, 'Uncrawled links to verify.')}
        </div>
        <label class="checkbox"><input type="checkbox" name="checkExternalLinks" ${checked(s.checkExternalLinks)}>
          <span><strong>Check external links</strong><br><span class="muted small">Verify that outgoing links to other sites still work.</span></span></label>
        <label class="checkbox"><input type="checkbox" name="respectRobots" ${checked(s.respectRobots)}>
          <span><strong>Respect robots.txt</strong><br><span class="muted small">Skip URLs disallowed for crawlers and honour meta nofollow.</span></span></label>
        <label class="checkbox"><input type="checkbox" name="includeSubdomains" ${checked(s.includeSubdomains)}>
          <span><strong>Include subdomains</strong><br><span class="muted small">Treat blog.example.com etc. as part of the site.</span></span></label>
      </fieldset>

      <div class="actions">
        <button class="btn btn-primary" type="submit">${isEdit ? 'Save changes' : 'Create project'}</button>
        ${!isEdit ? html`<button class="btn" type="submit" data-and-run>Create &amp; run audit</button>` : ''}
        <a class="btn btn-ghost" href="${isEdit ? `#/projects/${project.id}` : '#/'}">Cancel</a>
      </div>
    </form>`,
  );

  const form = $('form', root);
  $('#f-name', root).focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const andRun = e.submitter?.hasAttribute('data-and-run');
    const data = new FormData(form);
    const body = {
      name: data.get('name'),
      url: data.get('url'),
      description: data.get('description'),
      settings: {
        targetKeywords: data.get('targetKeywords'),
        maxPages: data.get('maxPages'),
        maxDepth: data.get('maxDepth'),
        concurrency: data.get('concurrency'),
        timeoutMs: data.get('timeoutMs'),
        maxLinkChecks: data.get('maxLinkChecks'),
        checkExternalLinks: data.has('checkExternalLinks'),
        respectRobots: data.has('respectRobots'),
        includeSubdomains: data.has('includeSubdomains'),
      },
    };
    $$('[data-error]', form).forEach((el) => (el.hidden = true));
    $$('.invalid', form).forEach((el) => el.classList.remove('invalid'));
    $$('button[type="submit"]', form).forEach((b) => (b.disabled = true));
    try {
      const saved = isEdit ? await api.updateProject(project.id, body) : await api.createProject(body);
      if (andRun) {
        const audit = await api.startAudit(saved.id);
        toast('Project created — audit started');
        location.hash = `#/audits/${audit.id}`;
      } else {
        toast(isEdit ? 'Settings saved' : 'Project created');
        location.hash = `#/projects/${saved.id}`;
      }
    } catch (err) {
      $$('button[type="submit"]', form).forEach((b) => (b.disabled = false));
      if (err.fields) {
        for (const [field, message] of Object.entries(err.fields)) {
          const target = $(`[data-error="${field}"]`, form);
          const input = form.elements[field];
          input?.classList.add('invalid');
          if (target) {
            target.textContent = message;
            target.hidden = false;
          } else {
            toast(message, { error: true });
          }
        }
        form.querySelector('.invalid')?.focus();
      } else {
        toast(err.message, { error: true });
      }
    }
  });
}

function numberField(name, label, value, min, max, hint) {
  return html`<div class="field">
    <label for="f-${name}">${label}</label>
    <input class="input" type="number" id="f-${name}" name="${name}" min="${min}" max="${max}" value="${value}">
    <div class="hint">${hint}</div>
    <div class="error-text" data-error="${name}" hidden></div>
  </div>`;
}
