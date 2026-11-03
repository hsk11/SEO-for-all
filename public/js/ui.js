// DOM + formatting helpers shared by all views.

// ------------------------------------------------------------ safe templating
class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

/** Mark a string as trusted HTML (never pass user/crawled data here). */
export const raw = (value) => new SafeHtml(String(value ?? ''));

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderValue(value) {
  if (value == null || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escapeHtml(value);
}

/** Tagged template: interpolations are escaped unless wrapped in raw()/html``. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += renderValue(v) + strings[i + 1];
  });
  return new SafeHtml(out);
}

export function setHtml(el, content) {
  el.innerHTML = renderValue(content);
  return el;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

// ----------------------------------------------------------------- formatting
export const fmt = {
  num: (n) => (n == null ? '–' : Number(n).toLocaleString()),
  date: (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–'),
  shortDate: (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '–'),
  relative(iso) {
    if (!iso) return 'never';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
    return fmt.shortDate(iso);
  },
  duration(startIso, endIso) {
    if (!startIso || !endIso) return '–';
    const s = Math.round((new Date(endIso) - new Date(startIso)) / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  },
  bytes: (b) => (b == null ? '–' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`),
  path(url) {
    try {
      const u = new URL(url);
      return u.pathname + u.search || '/';
    } catch {
      return url;
    }
  },
};

// ------------------------------------------------------------ status helpers
export function scoreTone(score) {
  if (score == null) return 'neutral';
  if (score >= 75) return 'good';
  if (score >= 50) return 'warning';
  return 'critical';
}

export const SEVERITY = {
  error: { label: 'Error', color: 'var(--critical)' },
  warning: { label: 'Warning', color: 'var(--warning)' },
  notice: { label: 'Notice', color: 'var(--notice)' },
};

const SEV_ICONS = {
  error: '<circle cx="8" cy="8" r="7" fill="var(--critical)"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  warning: '<path d="M8 1.5 15 14H1z" fill="var(--warning)" stroke="var(--warning)" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v3.5" stroke="#111" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.8" r="0.95" fill="#111"/>',
  notice: '<circle cx="8" cy="8" r="7" fill="var(--notice)"/><path d="M8 7.2v4" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="4.8" r="1" fill="#fff"/>',
};

/** Severity is always icon + label, never colour alone. */
export function severityBadge(severity) {
  const s = SEVERITY[severity];
  return html`<span class="sev">${raw(`<svg class="sev-icon" viewBox="0 0 16 16" aria-hidden="true">${SEV_ICONS[severity]}</svg>`)}${s.label}</span>`;
}

export function severityIcon(severity) {
  return raw(`<svg class="sev-icon" viewBox="0 0 16 16" aria-label="${SEVERITY[severity].label}">${SEV_ICONS[severity]}</svg>`);
}

export function auditStatusChip(audit) {
  if (!audit) return html`<span class="chip">Not audited</span>`;
  switch (audit.status) {
    case 'completed':
      return html`<span class="chip chip-good">✓ Completed</span>`;
    case 'running':
      return html`<span class="chip chip-info"><span class="dot pulse" style="background:var(--accent)"></span>Running ${audit.progress?.percent ?? 0}%</span>`;
    case 'queued':
      return html`<span class="chip chip-info">Queued</span>`;
    case 'failed':
      return html`<span class="chip chip-critical">✕ Failed</span>`;
    case 'cancelled':
      return html`<span class="chip">Cancelled</span>`;
    default:
      return html`<span class="chip">${audit.status}</span>`;
  }
}

export function httpStatusChip(status, error) {
  if (status == null) return html`<span class="chip chip-critical" title="${error || ''}">${error ? 'Error' : '–'}</span>`;
  const tone = status >= 400 ? 'chip-critical' : status >= 300 ? 'chip-warning' : 'chip-good';
  return html`<span class="chip ${tone}">${status}</span>`;
}

// ------------------------------------------------------------------- toasts
export function toast(message, { error = false, timeout = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), timeout);
}

// ------------------------------------------------------------------- modals
export function openDrawer(content, { onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  setHtml(backdrop, html`<div class="drawer" role="dialog" aria-modal="true">${content}</div>`);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  return { el: backdrop, close };
}

/** In-page confirmation dialog. Resolves true/false. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop center';
    setHtml(
      backdrop,
      html`<div class="dialog" role="alertdialog" aria-modal="true">
        <h2>${title}</h2>
        <p>${message}</p>
        <div class="actions" style="justify-content:flex-end">
          <button class="btn" data-answer="no">Cancel</button>
          <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-answer="yes">${confirmLabel}</button>
        </div>
      </div>`,
    );
    const finish = (answer) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(answer);
    };
    const onKey = (e) => e.key === 'Escape' && finish(false);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(false);
      const btn = e.target.closest('[data-answer]');
      if (btn) finish(btn.dataset.answer === 'yes');
    });
    document.addEventListener('keydown', onKey);
    document.body.append(backdrop);
    $('[data-answer="yes"]', backdrop).focus();
  });
}

// ------------------------------------------------------------------ tooltip
let tooltipEl = null;
export function showTooltip(content, x, y) {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'tooltip';
    document.body.append(tooltipEl);
  }
  setHtml(tooltipEl, content);
  tooltipEl.hidden = false;
  const { width, height } = tooltipEl.getBoundingClientRect();
  const left = Math.min(window.innerWidth - width - 8, x + 14);
  const top = y - height - 12 < 8 ? y + 16 : y - height - 12;
  tooltipEl.style.left = `${Math.max(8, left)}px`;
  tooltipEl.style.top = `${top}px`;
}
export function hideTooltip() {
  if (tooltipEl) tooltipEl.hidden = true;
}

/** Elements with data-tip="..." show a tooltip on hover. */
document.addEventListener('pointerover', (e) => {
  const target = e.target.closest?.('[data-tip]');
  if (target) showTooltip(escapeHtml(target.dataset.tip), e.clientX, e.clientY);
});
document.addEventListener('pointermove', (e) => {
  const target = e.target.closest?.('[data-tip]');
  if (target) showTooltip(escapeHtml(target.dataset.tip), e.clientX, e.clientY);
});
document.addEventListener('pointerout', (e) => {
  if (e.target.closest?.('[data-tip]')) hideTooltip();
});

export function loading(text = 'Loading…') {
  return html`<div class="loading"><span class="spinner"></span> <span style="margin-left:8px">${text}</span></div>`;
}

export function downloadButtons(auditId, { small = false } = {}) {
  const cls = small ? 'btn btn-sm' : 'btn';
  return html`<a class="${cls}" href="/api/audits/${auditId}/report.pdf" download>${raw(ICONS.download)} PDF</a>
    <a class="${cls}" href="/api/audits/${auditId}/report.xlsx" download>${raw(ICONS.download)} Excel</a>`;
}

export const ICONS = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M14 3h7v7M10 14 21 3M21 14v7H3V3h7"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

/** Link to a crawled URL; anything that isn't http(s) is shown as plain text. */
export function externalLink(url, label) {
  if (!/^https?:\/\//i.test(url || '')) return html`<span class="break">${label ?? url}</span>`;
  return html`<a href="${url}" target="_blank" rel="noopener noreferrer" class="break">${label ?? url}</a>`;
}
