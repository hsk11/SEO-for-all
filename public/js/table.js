// Reusable client-side data table with search, sort, filters and paging.

import { html, raw, setHtml, $ } from './ui.js';

/**
 * @param {HTMLElement} container
 * @param {object} options
 * @param {{ key: string, label: string, render?: (row) => any, sort?: (row) => any, className?: string, sortable?: boolean }[]} options.columns
 * @param {object[]} options.rows
 * @param {(row) => string} [options.searchText]  text matched by the search box
 * @param {{ key: string, label: string, options: {value: string, label: string}[], test: (row, value) => boolean }[]} [options.filters]
 * @param {(row) => void} [options.onRowClick]
 * @param {number} [options.pageSize]
 * @param {string} [options.emptyText]
 * @param {any} [options.toolbarExtra]  extra HTML for the toolbar
 * @param {{key: string, dir: 1|-1}} [options.initialSort]
 */
export function dataTable(container, options) {
  const {
    columns,
    rows,
    searchText,
    filters = [],
    onRowClick,
    pageSize = 50,
    emptyText = 'Nothing to show.',
    toolbarExtra = '',
    initialSort = null,
  } = options;
  const state = {
    query: '',
    sort: initialSort,
    page: 0,
    filters: Object.fromEntries(filters.map((f) => [f.key, f.initial ?? ''])),
  };

  const showToolbar = searchText || filters.length || toolbarExtra;
  setHtml(
    container,
    html`${showToolbar
      ? html`<div class="table-toolbar">
          ${searchText ? html`<input class="input search" type="search" placeholder="Search…" data-role="search" aria-label="Search">` : ''}
          ${filters.map(
            (f) => html`<select class="input" data-filter="${f.key}" aria-label="${f.label}">
              ${f.options.map((o) => html`<option value="${o.value}" ${o.value === state.filters[f.key] ? raw('selected') : ''}>${o.label}</option>`)}
            </select>`,
          )}
          <span class="spacer"></span>
          ${toolbarExtra}
        </div>`
      : ''}
      <div class="table-wrap"><table class="table"><thead></thead><tbody></tbody></table></div>
      <div class="table-foot" data-role="foot"></div>`,
  );

  const thead = $('thead', container);
  const tbody = $('tbody', container);
  const foot = $('[data-role="foot"]', container);

  const filtered = () => {
    const q = state.query.trim().toLowerCase();
    let list = rows.filter((row) => filters.every((f) => !state.filters[f.key] || f.test(row, state.filters[f.key])));
    if (q && searchText) list = list.filter((row) => searchText(row).toLowerCase().includes(q));
    if (state.sort) {
      const col = columns.find((c) => c.key === state.sort.key);
      const get = col.sort ?? ((r) => r[col.key]);
      list = [...list].sort((a, b) => {
        const va = get(a);
        const vb = get(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * state.sort.dir;
      });
    }
    return list;
  };

  const renderHead = () => {
    setHtml(
      thead,
      html`<tr>${columns.map((c) => {
        const sortable = c.sortable !== false;
        const arrow = state.sort?.key === c.key ? (state.sort.dir === 1 ? '▲' : '▼') : '';
        return html`<th class="${sortable ? 'sortable' : ''} ${c.className ?? ''}" data-key="${c.key}" ${sortable ? raw('tabindex="0"') : ''}>${c.label}${arrow ? html`<span class="arrow">${arrow}</span>` : ''}</th>`;
      })}</tr>`,
    );
  };

  const renderBody = () => {
    const list = filtered();
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    state.page = Math.min(state.page, pages - 1);
    const slice = list.slice(state.page * pageSize, (state.page + 1) * pageSize);
    if (!slice.length) {
      setHtml(tbody, html`<tr><td colspan="${columns.length}"><div class="empty">${rows.length ? 'No matches for the current search/filter.' : emptyText}</div></td></tr>`);
    } else {
      setHtml(
        tbody,
        slice.map(
          (row, i) => html`<tr class="${onRowClick ? 'clickable' : ''}" data-index="${state.page * pageSize + i}">
            ${columns.map((c) => html`<td class="${c.className ?? ''}">${c.render ? c.render(row) : row[c.key] ?? ''}</td>`)}
          </tr>`,
        ),
      );
    }
    tbody._rows = list;
    setHtml(
      foot,
      html`<span>${list.length === rows.length ? `${rows.length} rows` : `${list.length} of ${rows.length} rows`}</span>
      ${pages > 1
        ? html`<span class="row">
            <button class="btn btn-sm" data-page="prev" ${state.page === 0 ? raw('disabled') : ''}>Previous</button>
            <span>Page ${state.page + 1} of ${pages}</span>
            <button class="btn btn-sm" data-page="next" ${state.page >= pages - 1 ? raw('disabled') : ''}>Next</button>
          </span>`
        : ''}`,
    );
  };

  const toggleSort = (key) => {
    if (state.sort?.key === key) state.sort = { key, dir: -state.sort.dir };
    else state.sort = { key, dir: 1 };
    renderHead();
    renderBody();
  };
  thead.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (th) toggleSort(th.dataset.key);
  });
  thead.addEventListener('keydown', (e) => {
    const th = e.target.closest('th.sortable');
    if (th && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggleSort(th.dataset.key);
    }
  });
  container.addEventListener('input', (e) => {
    if (e.target.matches('[data-role="search"]')) {
      state.query = e.target.value;
      state.page = 0;
      renderBody();
    }
  });
  container.addEventListener('change', (e) => {
    if (e.target.matches('[data-filter]')) {
      state.filters[e.target.dataset.filter] = e.target.value;
      state.page = 0;
      renderBody();
    }
  });
  foot.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-page]');
    if (!btn) return;
    state.page += btn.dataset.page === 'next' ? 1 : -1;
    renderBody();
    container.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  if (onRowClick) {
    tbody.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      const tr = e.target.closest('tr[data-index]');
      if (tr) onRowClick(tbody._rows[Number(tr.dataset.index)]);
    });
  }

  renderHead();
  renderBody();
  return { refresh: renderBody };
}
