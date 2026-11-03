// Small SVG/HTML charts. Single-series charts use the accent hue; scores use
// the status ramp but always come with a number + text label.

import { html, raw, scoreTone, showTooltip, hideTooltip, fmt, escapeHtml } from './ui.js';

const TONE_COLOR = { good: 'var(--good)', warning: 'var(--warning)', critical: 'var(--critical)', neutral: 'var(--border-strong)' };

/** Circular score gauge (hero figure). */
export function scoreRing(score, { size = 120, stroke = 10, label = true } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const value = score == null ? 0 : Math.max(0, Math.min(100, score));
  const color = TONE_COLOR[scoreTone(score)];
  const big = Math.round(size * 0.3);
  return raw(`<svg class="score-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Score ${score ?? 'not available'} out of 100">
    <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
      stroke-linecap="round" stroke-dasharray="${(c * value) / 100} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text class="ring-value" x="50%" y="${label && size >= 90 ? '44%' : '50%'}" text-anchor="middle" dominant-baseline="central" font-size="${big}">${score ?? '–'}</text>
    ${label && size >= 90 ? `<text class="ring-sub" x="50%" y="71%" text-anchor="middle" font-size="${Math.round(size * 0.1)}">/ 100</text>` : ''}
  </svg>`);
}

/**
 * Horizontal bars, one series. rows: [{ label, value, max?, display?, tip? }]
 * Values are labelled at the bar tip so colour is never the only channel.
 */
export function barList(rows, { max } = {}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return html`<div class="bars">
    ${rows.map(
      (r) => html`<div class="bar-row" ${r.tip ? raw(`data-tip="${escapeHtml(r.tip)}"`) : ''}>
        <span class="bar-label" title="${r.label}">${r.label}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(r.value > 0 ? 2 : 0, (r.value / top) * 100)}%"></span></span>
        <span class="bar-value">${r.display ?? fmt.num(r.value)}</span>
      </div>`,
    )}
  </div>`;
}

/**
 * Score-over-time line chart for a project's completed audits (oldest → newest).
 * Includes a hover crosshair + tooltip; mounted via `mountTrend`.
 */
export function trendChart(points) {
  const W = 640;
  const H = 200;
  const pad = { l: 34, r: 40, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const x = (i) => pad.l + (points.length === 1 ? iw / 2 : (i * iw) / (points.length - 1));
  const y = (v) => pad.t + ih - (v / 100) * ih;

  const grid = [0, 25, 50, 75, 100]
    .map((v) => `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-text" x="${pad.l - 8}" y="${y(v)}" text-anchor="end" dominant-baseline="central">${v}</text>`)
    .join('');
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.score)}`).join('');
  const area = `${line}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const step = Math.max(1, Math.ceil(points.length / 6));
  const xLabels = points
    .map((p, i) => (i % step === 0 || i === points.length - 1 ? `<text class="axis-text" x="${x(i)}" y="${H - 6}" text-anchor="middle">${escapeHtml(fmt.shortDate(p.date))}</text>` : ''))
    .join('');
  const last = points[points.length - 1];

  return raw(`<svg class="chart trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="Score trend">
    ${grid}
    ${points.length > 1 ? `<path class="series-area" d="${area}"/>` : ''}
    <path class="series-line" d="${line}"/>
    <line class="crosshair" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>
    <circle class="series-dot hover-dot" r="5" visibility="hidden"/>
    <circle class="series-dot" cx="${x(points.length - 1)}" cy="${y(last.score)}" r="5"/>
    <text class="end-label" x="${x(points.length - 1) + 10}" y="${y(last.score)}" dominant-baseline="central">${last.score}</text>
    ${xLabels}
    <rect class="hit" x="${pad.l}" y="0" width="${iw}" height="${H}" fill="transparent"/>
  </svg>`);
}

export function mountTrend(container, points) {
  const svg = container.querySelector('svg.trend');
  if (!svg || !points.length) return;
  const W = 640;
  const pad = { l: 34, r: 40, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = 200 - pad.t - pad.b;
  const cross = svg.querySelector('.crosshair');
  const dot = svg.querySelector('.hover-dot');
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const i = points.length === 1 ? 0 : Math.round(((vx - pad.l) / iw) * (points.length - 1));
    const idx = Math.max(0, Math.min(points.length - 1, i));
    const p = points[idx];
    const px = pad.l + (points.length === 1 ? iw / 2 : (idx * iw) / (points.length - 1));
    const py = pad.t + ih - (p.score / 100) * ih;
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px);
    dot.setAttribute('cy', py);
    dot.setAttribute('visibility', 'visible');
    showTooltip(
      `<strong>Score ${p.score}</strong><br>${escapeHtml(fmt.date(p.date))}<br>${p.errors} errors · ${p.warnings} warnings · ${p.pages} pages`,
      e.clientX,
      e.clientY,
    );
  });
  svg.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    hideTooltip();
  });
}
