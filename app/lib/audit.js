// Audit grid renderer.
// Given a structured save (from save.js) + a classifier, renders every container
// as a panel with its slot grid. Cells are color-coded by classification bucket.
// Click a slot → invoke `onSelectSlot` callback with the slot + its container context
// so the host can populate the Item Detail right pane.

import { classify, displayName, iconUrl } from './classify.js';

// CSS class suffix per bucket — must match style.css `.cat-*` rules
const BUCKET_CSS = {
  Raw_Local:        'raw_local',
  Raw_Stellar:      'raw_stellar',
  Raw_Atmospheric:  'raw_atmospheric',
  Raw_Exotic:       'raw_exotic',
  Components:       'components',
  Curios:           'curios',
  Cooking:          'cooking',
  Trade:            'trade',
  Tech_Modules:     'tech_modules',
  Salvage_Charts:   'salvage_charts',
  Contraband:       'contraband',
  InstalledTech:    'installedtech',
  Uncategorized:    'uncategorized',
  Building:         'components',     // sub-bucket folded into Components display
  Cosmetics:        'curios',         // sub-bucket folded into Curios display
};

export function renderAudit(rootEl, structured, opts = {}) {
  const onSelect = opts.onSelectSlot || (() => {});
  rootEl.innerHTML = '';

  // Top toolbar: filter + count summary
  const toolbar = document.createElement('div');
  toolbar.className = 'audit-toolbar';
  toolbar.innerHTML = `
    <span class="audit-stat" data-audit-stat></span>
    <span class="audit-spacer"></span>
    <input class="audit-filter" data-audit-filter type="text" placeholder="filter items / containers…" />
    <span class="audit-legend">
      <span class="cat-badge cat-raw_local"       title="Common substances: Carbon, Oxygen, Sodium, Cobalt, Ferrite Dust, Tritium, Di-hydrogen">RAW · COMMON</span>
      <span class="cat-badge cat-raw_stellar"     title="Stellar metals + tradeables: Copper, Cadmium, Emeril, Indium (+ Activated), Pugneum, Gold, Silver, Platinum">STELLAR</span>
      <span class="cat-badge cat-raw_atmospheric" title="Atmospheric/catalyst gases: Sulphurine, Radon, Nitrogen, Dioxite, Phosphorus, Ammonia, Paraffinium, Uranium, Chlorine">ATMOSPHERIC</span>
      <span class="cat-badge cat-raw_exotic"      title="Exotic + flora + organic: Star Bulb, Solanium, Frost Crystal, Pearls, Crystal Sulphide, creature cores, Quicksilver">EXOTIC · ORGANIC</span>
      <span class="cat-badge cat-components"      title="Refined components + alloys: Glass, Aronium, Living Glass, Stasis Device, Antimatter, Microprocessor, Wiring Loom">COMPONENTS</span>
      <span class="cat-badge cat-curios"          title="Curiosities: Storm Crystal, Vent Gem, Hex Core, Fish Core, eggs, exhibit bones">CURIOS</span>
      <span class="cat-badge cat-cooking"         title="Cooked dishes, ingredients, fish, fishing bait, plant substances used for cooking">COOKING</span>
      <span class="cat-badge cat-trade"           title="Pure trade commodities (TRA_*) — by economy type">TRADE</span>
      <span class="cat-badge cat-tech_modules"    title="Procedural upgrade modules (^U_*) + S-class procedural techs (any class C/B/A/S/X)">TECH MODULES</span>
      <span class="cat-badge cat-salvage_charts"  title="Charts + tokens + salvage: Nav Data, Atlas Pass, Salvaged Frigate Module, Cargo Bulkhead, Multi-tool Expansion, Salvaged Data, Factory Override, Suspicious Tech">SALVAGE & CHARTS</span>
      <span class="cat-badge cat-contraband"      title="Illegal goods: NipNip, stolen items, smuggled commodities, faction tokens">CONTRABAND</span>
      <span class="cat-badge cat-uncategorized"   title="Unknown items — manual placement required, never auto-moved">UNCATEGORIZED</span>
    </span>`;
  rootEl.appendChild(toolbar);

  const grid = document.createElement('div');
  grid.className = 'audit-grid';
  rootEl.appendChild(grid);

  // Build the list of containers we want to render, with display labels.
  // The game calls these "Storage Containers". The localization key BLD_STORAGE_NAME
  // is what NMS displays in-game when the player hasn't renamed a container, so we
  // substitute the same label.
  const panels = [];
  for (const ch of structured.chests) {
    if (!ch.present) continue;
    const isDefaultName = !ch.name || !ch.name.trim() || ch.name === 'BLD_STORAGE_NAME';
    const label = isDefaultName ? `Storage Container ${ch.index}` : ch.name;
    panels.push({ kind: 'STORAGE', tag: `SC-${ch.index}`, label, container: ch });
  }
  if (structured.freighter.inventory) panels.push({ kind: 'FREIGHTER', tag: 'INV', label: 'Freighter Inventory', container: structured.freighter.inventory });
  if (structured.freighter.cargo)     panels.push({ kind: 'FREIGHTER', tag: 'CGO', label: 'Freighter Cargo',     container: structured.freighter.cargo });

  // Ships — only those the player actually owns (named or claimed-with-seed)
  for (const ship of structured.ships) {
    const hasName = ship.name && ship.name.trim().length > 0;
    const hasSeed = ship.seed && ship.seed !== '0x0';
    if (!hasName && !hasSeed) continue;
    const baseName = hasName ? ship.name : `Ship slot ${ship.index} (unclaimed)`;
    const label = ship.shipType ? `${baseName} · ${ship.shipType}` : baseName;
    if (ship.inventory) panels.push({ kind: 'SHIP', tag: 'INV', label: `${label} — Inventory`, container: ship.inventory });
    if (ship.cargo)     panels.push({ kind: 'SHIP', tag: 'CGO', label: `${label} — Cargo`,     container: ship.cargo });
  }

  // Exocrafts (vehicles) — Inventory only; vehicles have no cargo split
  if (structured.vehicles) {
    for (const v of structured.vehicles) {
      if (v.inventory) panels.push({ kind: 'EXOCRAFT', tag: 'INV', label: v.name && v.name.trim() ? v.name : `Exocraft ${v.index + 1}`, container: v.inventory });
    }
  }

  // Exosuit
  if (structured.exosuit.inventory) panels.push({ kind: 'EXOSUIT', tag: 'INV', label: 'Exosuit Inventory', container: structured.exosuit.inventory });
  if (structured.exosuit.cargo)     panels.push({ kind: 'EXOSUIT', tag: 'CGO', label: 'Exosuit Cargo',     container: structured.exosuit.cargo });

  // Tech inventories (ship/exosuit/freighter Tech, multi-tool weapons) are deliberately omitted —
  // they hold installed equipment, not loose items the organizer can move.

  // Stat
  const totalSlots = panels.reduce((a, p) => a + p.container.slots.length, 0);
  rootEl.querySelector('[data-audit-stat]').textContent =
    `${panels.length} containers · ${totalSlots} item entries`;

  // Render each panel
  for (const p of panels) {
    grid.appendChild(renderPanel(p, onSelect));
  }

  // Filter wiring
  const filterInput = rootEl.querySelector('[data-audit-filter]');
  filterInput.addEventListener('input', () => applyFilter(grid, filterInput.value.trim().toLowerCase()));
}

function renderPanel(panelDef, onSelect) {
  const { kind, tag, label, container, hardLocked } = panelDef;
  const root = document.createElement('div');
  root.className = 'audit-panel';
  if (hardLocked) root.classList.add('hard-locked');
  root.dataset.kindTag = `${kind}/${tag}`;
  root.dataset.label = label;

  const cap = container.capacity || (container.width * container.height) || container.slots.length;

  const header = document.createElement('div');
  header.className = 'audit-panel-header';
  header.innerHTML = `
    <span class="audit-panel-kind">${kind}</span>
    <span class="audit-panel-label">${escapeHtml(label)}</span>
    <span class="audit-panel-meta">${container.slots.length}/${cap}${hardLocked ? ' · LOCKED' : ''}</span>`;
  root.appendChild(header);

  // Determine grid columns. Prefer container.width if known; otherwise pick a sensible fit.
  const cols = container.width || pickColumnsForCount(container.slots.length, cap);
  const grid = document.createElement('div');
  grid.className = 'audit-cells';
  grid.style.setProperty('--cols', cols);

  // Render filled slots in their actual grid positions.
  // For containers we know the dimensions of, draw all valid positions; mark empty ones gray.
  const positions = new Map();
  for (const slot of container.slots) positions.set(`${slot.x},${slot.y}`, slot);

  if (container.width && container.height) {
    // Draw a position-accurate grid. Capacity may be < width*height (validSlots constraint).
    // For v1 we draw width*height cells; cells outside validSlots show as 'invalid' (very dim).
    const totalCells = container.width * container.height;
    const renderedCount = container.slots.length;
    // We can't know which exact positions are invalid without ValidSlotIndices in the snapshot.
    // For safety/simplicity: render all width*height cells, slots placed at their X/Y, rest empty.
    // Cap visualization to capacity when it's known and < total.
    const maxRender = Math.min(totalCells, Math.max(cap, renderedCount));
    for (let i = 0; i < maxRender; i++) {
      const x = i % container.width;
      const y = Math.floor(i / container.width);
      const slot = positions.get(`${x},${y}`);
      grid.appendChild(slot ? renderCell(slot, container, onSelect) : renderEmptyCell(x, y));
    }
  } else {
    // Unknown dimensions — just render filled slots in a fixed-column flow
    for (const slot of container.slots) grid.appendChild(renderCell(slot, container, onSelect));
  }

  root.appendChild(grid);
  return root;
}

function pickColumnsForCount(n, cap) {
  // Reasonable default for unknown dimensions
  if (cap >= 50) return 10;
  if (cap >= 24) return 8;
  if (cap >= 12) return 6;
  return Math.min(n, 4) || 4;
}

function renderCell(slot, container, onSelect) {
  const cls = classify(slot.id, slot.type);
  const cell = document.createElement('div');
  const bucket = BUCKET_CSS[cls.classification] || 'uncategorized';
  cell.className = `audit-cell cat-${bucket}`;
  cell.dataset.x = slot.x;
  cell.dataset.y = slot.y;
  cell.dataset.id = slot.id;

  const name = displayName(slot.id, cls);
  const amt = formatAmount(slot.amount, slot.max);
  const icon = iconUrl(slot.id);

  // Layout: optional icon thumbnail, then name (up to 2 lines), then amount on its own line.
  // The icon image is decorative (loading=lazy, draggable=false) and falls back gracefully when broken.
  const iconHtml = icon
    ? `<img class="ac-icon" src="${escapeHtml(icon)}" alt="" loading="lazy" draggable="false" onerror="this.remove()">`
    : '';
  cell.innerHTML = `
    ${iconHtml}
    <div class="ac-name" title="${escapeHtml(slot.id)} → ${escapeHtml(name)}">${escapeHtml(name)}</div>
    <div class="ac-amt">${escapeHtml(amt)}</div>`;

  if (cls.procedural) cell.dataset.procedural = '1';

  cell.addEventListener('click', () => {
    document.querySelectorAll('.audit-cell.selected').forEach(c => c.classList.remove('selected'));
    cell.classList.add('selected');
    onSelect({ slot, container, classification: cls });
  });
  return cell;
}

function renderEmptyCell(x, y) {
  const cell = document.createElement('div');
  cell.className = 'audit-cell empty';
  cell.dataset.x = x; cell.dataset.y = y;
  return cell;
}

function formatAmount(amount, max) {
  if (!max) return String(amount);
  if (amount === max) return `${amount}/${max}`;        // full
  if (max >= 10000) return `${(amount/1000).toFixed(1)}k/${(max/1000).toFixed(0)}k`;
  return `${amount}/${max}`;
}

function applyFilter(gridRoot, query) {
  if (!query) {
    gridRoot.querySelectorAll('.audit-panel').forEach(p => { p.style.display = ''; p.querySelectorAll('.audit-cell').forEach(c => c.classList.remove('dim')); });
    return;
  }
  gridRoot.querySelectorAll('.audit-panel').forEach(panel => {
    const label = (panel.dataset.label || '').toLowerCase();
    const kindTag = (panel.dataset.kindTag || '').toLowerCase();
    let panelHasMatch = label.includes(query) || kindTag.includes(query);
    panel.querySelectorAll('.audit-cell').forEach(cell => {
      if (cell.classList.contains('empty')) return;
      const id = (cell.dataset.id || '').toLowerCase();
      const matches = id.includes(query);
      cell.classList.toggle('dim', !matches && !panelHasMatch);
      if (matches) panelHasMatch = true;
    });
    panel.style.display = panelHasMatch ? '' : 'none';
  });
}

// ── Item Detail (right pane) renderer ──────────────────────────────────
export function renderItemDetail(rootEl, sel) {
  if (!sel) {
    rootEl.innerHTML = `
      <div class="empty-state">
        <div class="glyph">◌</div>
        <div class="msg">No item selected</div>
        <div class="hint">Click any slot in the Audit grid to inspect.</div>
      </div>`;
    return;
  }
  const { slot, container, classification: c } = sel;
  const bucket = BUCKET_CSS[c.classification] || 'uncategorized';
  const procBadge = c.procedural ? `<span class="cat-badge cat-tech_modules">${c.procedural}</span>` : '';

  const friendly = displayName(slot.id, c);
  const icon = iconUrl(slot.id);
  const iconHtml = icon
    ? `<img class="detail-icon" src="${escapeHtml(icon)}" alt="" draggable="false" onerror="this.remove()">`
    : '';
  rootEl.innerHTML = `
    <div class="detail-block">
      ${iconHtml}
      <div class="detail-name">${escapeHtml(friendly)}</div>
      <div class="detail-id">${escapeHtml(slot.id)}</div>
      <div class="detail-badges">
        <span class="cat-badge cat-${bucket}">${escapeHtml(c.classification)}</span>
        ${procBadge}
        ${c.legality === 'Illegal' ? '<span class="cat-badge cat-contraband">ILLEGAL</span>' : ''}
      </div>
    </div>
    <dl class="kv-list">
      <dt>TYPE</dt><dd>${escapeHtml(slot.type || '?')}</dd>
      <dt>AMOUNT</dt><dd>${escapeHtml(formatAmount(slot.amount, slot.max))}</dd>
      <dt>POSITION</dt><dd>x=${slot.x}, y=${slot.y}</dd>
      ${slot.installed ? '<dt>INSTALLED</dt><dd>true</dd>' : ''}
      ${slot.damage ? `<dt>DAMAGE</dt><dd>${slot.damage}</dd>` : ''}
      ${slot.seed ? `<dt>SEED</dt><dd>${escapeHtml(JSON.stringify(slot.seed))}</dd>` : ''}
    </dl>
    <div class="detail-section">
      <div class="label">CLASSIFICATION REASON</div>
      <div class="value">${escapeHtml(c.reason || '—')}</div>
    </div>
    ${c.name_key || c.category || c.product_category ? `
    <div class="detail-section">
      <div class="label">TAXONOMY</div>
      <dl class="kv-list">
        ${c.name_key      ? `<dt>NAME KEY</dt><dd>${escapeHtml(c.name_key)}</dd>` : ''}
        ${c.category      ? `<dt>CATEGORY</dt><dd>${escapeHtml(c.category)}</dd>` : ''}
        ${c.product_category ? `<dt>PRODUCT CAT</dt><dd>${escapeHtml(c.product_category)}</dd>` : ''}
        ${c.trade_category && c.trade_category !== 'None' ? `<dt>TRADE CAT</dt><dd>${escapeHtml(c.trade_category)}</dd>` : ''}
        ${c.wiki_category ? `<dt>WIKI CAT</dt><dd>${escapeHtml(c.wiki_category)}</dd>` : ''}
        ${c.rarity        ? `<dt>RARITY</dt><dd>${escapeHtml(c.rarity)}</dd>` : ''}
        ${c.base_value !== null && c.base_value !== undefined ? `<dt>BASE VALUE</dt><dd>${c.base_value.toLocaleString()}</dd>` : ''}
        ${c.stack_multiplier ? `<dt>STACK MULT</dt><dd>${c.stack_multiplier}</dd>` : ''}
      </dl>
    </div>` : ''}
    <div class="detail-section">
      <div class="label">LOCATION</div>
      <div class="value" style="font-size: var(--fs-xs); color: var(--fg-tertiary);">
        ${escapeHtml(container.path || '—')}<br>
        ${container.name ? escapeHtml(container.name) + ' · ' : ''}${escapeHtml(container.ssg || '?')}
      </div>
    </div>
    ${c.source_file ? `
    <div class="detail-section">
      <div class="label">SOURCE</div>
      <div class="value" style="font-size: var(--fs-xs); color: var(--fg-tertiary);">${escapeHtml(c.source_file)}</div>
    </div>` : ''}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[ch]));
}
