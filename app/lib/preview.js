// Preview tab renderer.
// Two view modes:
//   GRIDS  — per-container side-by-side BEFORE / AFTER cell grids with diff coloring
//   TABLES — summary tables of plan totals (overview / fallback)
//
// A container is shown ONLY if its before/after differs (sort: most-changed first).
// Diff coloring per cell:
//   added    → green   (empty before, filled after)
//   removed  → red     (filled before, empty after)
//   changed  → amber   (same id, different amount)
//   replaced → blue    (different id at same position)
//   unchanged → dim    (same id same amount, low contrast)

import { displayName, iconUrl } from './classify.js';
import { validatePlan } from './validate.js';

const BUCKET_CSS = {
  Raw_Local: 'raw_local', Raw_Stellar: 'raw_stellar', Raw_Atmospheric: 'raw_atmospheric', Raw_Exotic: 'raw_exotic',
  Components: 'components', Curios: 'curios', Cooking: 'cooking', Trade: 'trade',
  Tech_Modules: 'tech_modules', Salvage_Charts: 'salvage_charts', Contraband: 'contraband',
};

export function renderPreview(rootEl, plan) {
  if (!plan) {
    rootEl.innerHTML = `<div class="empty-state"><div class="msg">No plan generated</div><div class="hint">Use ▶ GENERATE PLAN in the Layout tab.</div></div>`;
    return;
  }
  const validation = validatePlan(plan);
  // Stash on plan for the Apply button to gate on. main.js reads state.plan.validation.
  plan.validation = validation;

  rootEl.innerHTML = `
    <div class="preview-toolbar">
      <span class="layout-stat">PREVIEW</span>
      <span class="preview-meta">preset: <b>${escapeHtml(plan.preset_label || plan.preset_id || '')}</b> · generated ${escapeHtml(new Date(plan.generated_at).toLocaleTimeString())}</span>
      <span class="audit-spacer"></span>
      <div class="preview-view-toggle">
        <button class="btn active" data-preview-view="grids">▦ GRIDS</button>
        <button class="btn" data-preview-view="tables">▤ TABLES</button>
      </div>
      ${validation.ok
        ? `<span class="cat-badge cat-components">VALIDATION PASS</span>`
        : `<span class="cat-badge cat-contraband">VALIDATION FAIL · ${validation.errors.length}</span>`}
    </div>

    ${renderValidationPanel(validation)}

    ${renderSummaryStrip(plan)}

    ${plan.summary.warnings.length ? renderWarnings(plan.summary.warnings) : ''}

    <div class="preview-pane" data-preview-pane="grids">
      ${renderGridsView(plan)}
    </div>
    <div class="preview-pane hidden" data-preview-pane="tables">
      ${renderTablesView(plan)}
    </div>
  `;

  // View toggle wiring
  rootEl.querySelectorAll('[data-preview-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.previewView;
      rootEl.querySelectorAll('[data-preview-view]').forEach(b => b.classList.toggle('active', b === btn));
      rootEl.querySelectorAll('[data-preview-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.previewPane !== target));
    });
  });
}

function renderSummaryStrip(plan) {
  const s = plan.summary;
  const cell = (k, v, warn) => `<div class="kv"><span class="k">${k}</span><span class="v ${warn ? 'warn' : ''}">${v}</span></div>`;
  return `<div class="preview-summary">
    ${cell('SOURCES WALKED', s.sources_walked.toLocaleString())}
    ${cell('SLOTS PULLED', s.slots_pulled.toLocaleString())}
    ${cell('RESERVES KEPT', s.slots_kept_as_reserve.toLocaleString())}
    ${cell('DEST CONTAINERS', s.destinations_used)}
    ${cell('STACKS PLACED', s.stacks_placed.toLocaleString())}
    ${cell('OVERFLOW', s.overflow_entries, s.overflow_entries > 0)}
    ${cell('SKIPPED', s.skipped_entries, s.skipped_entries > 0)}
    ${cell('AMOUNT IN', s.total_amount_in.toLocaleString())}
    ${cell('AMOUNT OUT', s.total_amount_out.toLocaleString())}
    ${cell('LEFT IN SOURCE', s.total_amount_overflowed.toLocaleString())}
  </div>`;
}

function renderWarnings(warnings) {
  return `<div class="preview-warnings">
    <header>WARNINGS</header>
    <ul>${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
  </div>`;
}

function renderValidationPanel(v) {
  const cls = v.ok ? 'pass' : 'fail';
  const headerText = v.ok
    ? `DRY-RUN VALIDATION · ${v.summary.pass}/${v.summary.total} checks passed`
    : `DRY-RUN VALIDATION · ${v.summary.fail} CHECK(S) FAILED — APPLY DISABLED`;
  const evidence = (c) => {
    if (!c.evidence) return '';
    const offenders = c.evidence.offenders || c.evidence.movedSkipped || [];
    if (!offenders.length) return '';
    return `<div class="check-evidence">first ${Math.min(offenders.length, 5)} offender(s): <code>${escapeHtml(JSON.stringify(offenders.slice(0, 5)))}</code></div>`;
  };
  return `<div class="validation-panel validation-${cls}">
    <header class="validation-header">${headerText}</header>
    <ul class="validation-list">
      ${v.checks.map(c => `
        <li class="validation-item ${c.ok ? 'ok' : 'fail'}${c.warning ? ' warn' : ''}">
          <span class="validation-marker">${c.ok ? '✓' : (c.warning ? '⚠' : '✗')}</span>
          <span class="validation-label">${escapeHtml(c.label)}</span>
          <span class="validation-detail">${escapeHtml(c.detail)}</span>
          ${evidence(c)}
        </li>
      `).join('')}
    </ul>
  </div>`;
}

// ── GRIDS view ────────────────────────────────────────────────────────────────────
function renderGridsView(plan) {
  // Compute per-container diffs and filter to only changed containers
  const dests = (plan.destinations || []).map(d => ({ kind: 'DEST', container: d, diff: diffSlots(d.slots_before, d.slots_after, d.width, d.height) }));
  const srcs  = (plan.sources || []).map(s => ({ kind: 'SOURCE', container: s, diff: diffSlots(s.slots_before, s.slots_after, s.width, s.height) }));

  const allPanels = [...dests, ...srcs].filter(p => p.diff.summary.changedCells > 0);

  if (allPanels.length === 0) {
    return `<div class="empty-state"><div class="msg">No changes</div><div class="hint">The plan is a no-op against your current save.</div></div>`;
  }

  // Sort: destinations first (highest churn first), then sources
  dests.sort((a, b) => b.diff.summary.changedCells - a.diff.summary.changedCells);
  srcs.sort((a, b) => b.diff.summary.changedCells - a.diff.summary.changedCells);
  const ordered = [...dests.filter(p => p.diff.summary.changedCells > 0), ...srcs.filter(p => p.diff.summary.changedCells > 0)];

  return `<div class="preview-grid-list">${ordered.map(panelHtml).join('')}</div>`;
}

function panelHtml({ kind, container, diff }) {
  const c = container;
  const labelHeader = kind === 'DEST'
    ? `<span class="cat-badge cat-tech_modules">SC ${c.chest_index}</span><span class="preview-panel-name">${escapeHtml(c.chest_name)}</span>`
    : `<span class="cat-badge cat-tech_modules">${escapeHtml(c.kind)}</span><span class="preview-panel-name">${escapeHtml(c.label)}</span>`;
  const buckets = (c.buckets || []).map(b => `<span class="cat-badge cat-${(BUCKET_CSS[b]||'uncategorized')}">${escapeHtml(b)}</span>`).join(' ');

  const beforeUsed = (c.slots_before || []).length;
  const afterUsed  = (c.slots_after  || []).length;
  const cap = c.capacity || (c.width * c.height);
  const delta = afterUsed - beforeUsed;
  const deltaText = delta === 0 ? '±0' : (delta > 0 ? `+${delta}` : `${delta}`);
  const deltaClass = delta > 0 ? 'pos' : (delta < 0 ? 'neg' : '');

  const ds = diff.summary;
  const diffMeta = [
    ds.added    ? `<span class="diff-pill added">+${ds.added} added</span>`     : '',
    ds.removed  ? `<span class="diff-pill removed">−${ds.removed} removed</span>` : '',
    ds.changed  ? `<span class="diff-pill changed">${ds.changed} changed</span>`   : '',
    ds.replaced ? `<span class="diff-pill replaced">${ds.replaced} replaced</span>` : '',
  ].filter(Boolean).join(' ');

  return `<section class="preview-panel">
    <header class="preview-panel-header">
      ${labelHeader}
      ${buckets ? `<span class="preview-panel-buckets">${buckets}</span>` : ''}
      <span class="audit-spacer"></span>
      <span class="preview-panel-stats">${beforeUsed}/${cap} → ${afterUsed}/${cap} <span class="delta ${deltaClass}">${deltaText}</span></span>
    </header>
    ${diffMeta ? `<div class="preview-panel-diffmeta">${diffMeta}</div>` : ''}
    <div class="preview-panel-grids">
      <div class="preview-side">
        <div class="preview-side-label">BEFORE</div>
        ${gridHtml(diff.cells, 'before', c.width, c.height)}
      </div>
      <div class="preview-arrow">→</div>
      <div class="preview-side">
        <div class="preview-side-label">AFTER</div>
        ${gridHtml(diff.cells, 'after', c.width, c.height)}
      </div>
    </div>
  </section>`;
}

function gridHtml(cells, side, width, height) {
  return `<div class="preview-cells" style="--cols:${width}">
    ${cells.map(cell => cellHtml(cell, side)).join('')}
  </div>`;
}

function cellHtml(cell, side) {
  const slot = cell[side];
  const kind = cell[`${side}Kind`];
  if (!slot) return `<div class="preview-cell empty diff-${kind}"></div>`;
  const name = displayName(slot.id) || trimId(slot.id);
  const amt = slot.amount.toLocaleString();
  const icon = iconUrl(slot.id);
  const iconHtml = icon
    ? `<img class="pc-icon" src="${escapeHtml(icon)}" alt="" loading="lazy" draggable="false" onerror="this.remove()">`
    : '';
  return `<div class="preview-cell diff-${kind}" title="${escapeHtml(slot.id)} — ${escapeHtml(name)} (${amt})">
    ${iconHtml}
    <div class="pc-name">${escapeHtml(trimDisplay(name))}</div>
    <div class="pc-amt">${amt}</div>
  </div>`;
}

function trimId(id) {
  if (!id) return '';
  const x = id.startsWith('^') ? id.slice(1) : id;
  if (/[\u0080-\uffff]/.test(x)) return '⌬ PROC';
  return x.length > 13 ? x.slice(0, 12) + '…' : x;
}
function trimDisplay(name) {
  if (!name) return '';
  return name.length > 16 ? name.slice(0, 15) + '…' : name;
}

// Compute a positional diff between two slot snapshots.
// Returns { cells: [{x,y,before,after,beforeKind,afterKind}], summary: {added, removed, changed, replaced, unchanged, changedCells} }
function diffSlots(beforeSlots, afterSlots, width, height) {
  const beforeMap = new Map((beforeSlots || []).map(s => [`${s.x},${s.y}`, s]));
  const afterMap  = new Map((afterSlots  || []).map(s => [`${s.x},${s.y}`, s]));
  const w = width  || 10;
  const h = height || 5;
  const cells = [];
  let added = 0, removed = 0, changed = 0, replaced = 0, unchanged = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = `${x},${y}`;
      const b = beforeMap.get(k);
      const a = afterMap.get(k);
      let beforeKind = 'empty', afterKind = 'empty';
      if (!b && !a) {
        // both empty — nothing to do, low-noise empty cell
      } else if (b && !a) {
        beforeKind = 'removed'; afterKind = 'empty'; removed++;
      } else if (!b && a) {
        beforeKind = 'empty'; afterKind = 'added'; added++;
      } else if (b && a) {
        if (b.id === a.id) {
          if (b.amount === a.amount) { beforeKind = 'unchanged'; afterKind = 'unchanged'; unchanged++; }
          else                       { beforeKind = 'changed';   afterKind = 'changed';   changed++; }
        } else {
          beforeKind = 'replaced-out'; afterKind = 'replaced-in'; replaced++;
        }
      }
      cells.push({ x, y, before: b || null, after: a || null, beforeKind, afterKind });
    }
  }
  return { cells, summary: { added, removed, changed, replaced, unchanged, changedCells: added + removed + changed + replaced } };
}

// ── TABLES view ────────────────────────────────────────────────────────────────────
function renderTablesView(plan) {
  return `
    <section class="preview-section">
      <header class="preview-section-header">DESTINATIONS · ${plan.destinations.length} storage containers</header>
      <table class="preview-table">
        <thead><tr><th>#</th><th>NAME</th><th>BUCKETS</th><th>STACKS ADDED</th><th>AMOUNT</th><th>USAGE</th></tr></thead>
        <tbody>
          ${plan.destinations.map(d => `<tr>
            <td>${d.chest_index}</td>
            <td>${escapeHtml(d.chest_name)}</td>
            <td>${(d.buckets || []).map(b => `<span class="cat-badge cat-${(BUCKET_CSS[b]||'uncategorized')}">${b}</span>`).join(' ')}</td>
            <td>${d.stacks_added}</td>
            <td>${d.total_amount_added.toLocaleString()}</td>
            <td>${d.stacks_added}/${d.capacity}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>

    <section class="preview-section">
      <header class="preview-section-header">SOURCES · ${plan.sources.length} containers walked</header>
      <table class="preview-table">
        <thead><tr><th>KIND</th><th>LABEL</th><th>SLOTS USED</th><th>PULLED</th><th>KEPT</th></tr></thead>
        <tbody>
          ${plan.sources.map(s => `<tr>
            <td><span class="cat-badge cat-tech_modules">${s.kind}</span></td>
            <td>${escapeHtml(s.label)}</td>
            <td>${s.slots_used_before}</td>
            <td>${s.slots_pulled}</td>
            <td>${s.slots_kept}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>

    ${plan.overflow.length ? `<section class="preview-section">
      <header class="preview-section-header">OVERFLOW · ${plan.overflow.length} entries</header>
      <table class="preview-table">
        <thead><tr><th>ITEM</th><th>AMOUNT</th><th>REASON</th><th>RESOLUTION</th></tr></thead>
        <tbody>
          ${plan.overflow.map(o => `<tr>
            <td>${escapeHtml(displayName(o.id) || o.id)}</td>
            <td>${(o.amount || 0).toLocaleString()}</td>
            <td>${escapeHtml(o.reason)}</td>
            <td>${escapeHtml(o.resolution || '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>` : ''}

    ${plan.skipped.length ? `<section class="preview-section">
      <header class="preview-section-header">SKIPPED · ${plan.skipped.length} items left in place</header>
      <table class="preview-table">
        <thead><tr><th>ITEM</th><th>AMOUNT</th><th>SOURCE</th><th>REASON</th></tr></thead>
        <tbody>
          ${plan.skipped.slice(0, 50).map(sk => `<tr>
            <td>${escapeHtml(displayName(sk.id) || sk.id)}</td>
            <td>${(sk.amount || 0).toLocaleString()}</td>
            <td><code>${escapeHtml(sk.source_path || '')}</code></td>
            <td>${escapeHtml(sk.reason)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${plan.skipped.length > 50 ? `<div class="layout-summary">… and ${plan.skipped.length - 50} more</div>` : ''}
    </section>` : ''}
  `;
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
