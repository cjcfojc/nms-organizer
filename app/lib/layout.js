// Layout tab UI: preset selector, per-chest config, operational reserves, exclusions.
// Holds the editable layout config in memory; emits change events the host can subscribe to.
//
// Public:
//   renderLayout(rootEl, structured, opts)
//     opts.initialPreset    — preset object to start with
//     opts.onChange(config) — fired whenever user mutates the config
//     opts.onGeneratePlan(config) — fired when user clicks Generate Plan
//
// State is purely DOM-driven; readConfig() builds a fresh config object from the inputs.

import { loadPresetIndex, loadPreset, getCustomPresets, saveCustomPreset, BUCKETS, clonePreset, validatePreset } from './presets.js';
import { locText } from './classify.js';

// Curated common-reserve items. All IDs verified against taxonomy via verify_presets.js.
// Used to populate a datalist autocomplete in the reserves editor — users can pick a
// friendly name and get the correct ID, or still type a custom ID manually.
const COMMON_RESERVES = [
  // Pulse / launch
  { id: 'ROCKETSUB',     group: 'Pulse / Launch',  note: 'Tritium' },
  { id: 'JELLY',         group: 'Pulse / Launch',  note: 'Di-Hydrogen Jelly' },
  { id: 'LAUNCHFUEL',    group: 'Pulse / Launch',  note: 'Starship Launch Fuel' },
  // Hyperdrive
  { id: 'HYPERFUEL1',    group: 'Hyperdrive',      note: 'Warp Cell' },
  { id: 'HYPERFUEL2',    group: 'Hyperdrive',      note: 'Warp Hypercore' },
  { id: 'ANTIMATTER',    group: 'Hyperdrive',      note: 'Antimatter (warp craft)' },
  { id: 'AM_HOUSING',    group: 'Hyperdrive',      note: 'Antimatter Housing' },
  // Shields / repair
  { id: 'CATALYST2',     group: 'Shields / Repair',note: 'Sodium Nitrate' },
  { id: 'CATALYST1',     group: 'Shields / Repair',note: 'Sodium' },
  { id: 'SHIPCHARGE',    group: 'Shields / Repair',note: 'Starshield Battery' },
  { id: 'REPAIRKIT',     group: 'Shields / Repair',note: 'Repair Kit' },
  // Charge / ammo
  { id: 'POWERCELL',     group: 'Charge / Ammo',   note: 'Ion Battery' },
  { id: 'SUBFUEL',       group: 'Charge / Ammo',   note: 'Hydrothermal Fuel Cell' },
  { id: 'AMMO',          group: 'Charge / Ammo',   note: 'Projectile Ammunition' },
  // Curio / exotic
  { id: 'GEODE_SPACE',   group: 'Curio / Exotic',  note: 'Tritium Hypercluster' },
  // Freighter
  { id: 'FRIGATE_FUEL_1',group: 'Freighter',       note: 'Frigate Fuel — 50T' },
  { id: 'FRIGATE_FUEL_2',group: 'Freighter',       note: 'Frigate Fuel — 100T' },
  { id: 'FRIGATE_FUEL_3',group: 'Freighter',       note: 'Frigate Fuel — 200T' },
  { id: 'FRIG_BOOST_SPD',group: 'Freighter',       note: 'Fuel Oxidiser' },
  // Vehicle
  { id: 'RADIO1',        group: 'Vehicle',         note: 'Uranium' },
];

function reservesDatalistHtml() {
  return `<datalist id="reserves-datalist">
    ${COMMON_RESERVES.map(r => `<option value="${r.id}" label="${escapeAttr(r.note)} — ${r.group}">${escapeHtml(r.note)} (${r.group})</option>`).join('')}
  </datalist>`;
}

// Look up the friendly note for a given ID (used to render the read-only note column).
function reserveNoteFor(id, fallbackNote) {
  if (fallbackNote) return fallbackNote;
  const r = COMMON_RESERVES.find(x => x.id === id);
  if (r) return r.note;
  // Fall back to LOC display name if available
  return locText(id + '_NAME') || '';
}

let currentConfig = null;
let savedStructured = null;
let onChangeCb = null;
let onGenerateCb = null;

export async function renderLayout(rootEl, structured, opts = {}) {
  savedStructured = structured;
  onChangeCb = opts.onChange || (() => {});
  onGenerateCb = opts.onGeneratePlan || (() => {});

  rootEl.innerHTML = `
    <div class="layout-toolbar">
      <span class="layout-stat">PRESET</span>
      <select class="layout-preset" data-layout-preset></select>
      <span class="layout-preset-desc" data-layout-desc></span>
      <span class="audit-spacer"></span>
      <button class="btn" data-layout-reset title="Reset chests/sources to current preset">RESET</button>
      <button class="btn" data-layout-save  title="Save current config as a custom preset">SAVE AS…</button>
      <button class="btn primary" data-layout-generate>▶ GENERATE PLAN</button>
    </div>
    <div class="layout-body" data-layout-body></div>
  `;

  // Populate preset dropdown
  const sel = rootEl.querySelector('[data-layout-preset]');
  try {
    const idx = await loadPresetIndex();
    const custom = getCustomPresets();
    sel.innerHTML = `
      <optgroup label="Built-in">
        ${idx.map(p => `<option value="${escapeAttr(p.id)}" data-builtin="1">${escapeHtml(p.label)}</option>`).join('')}
      </optgroup>
      ${custom.length ? `
        <optgroup label="Custom">
          ${custom.map(p => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.label)}</option>`).join('')}
        </optgroup>` : ''}
    `;
  } catch (err) {
    sel.innerHTML = `<option>(failed to load presets)</option>`;
    Log.error('layout', 'Preset index load failed', { error: err.message });
    return;
  }

  // Initial preset
  const initialId = (opts.initialPreset && opts.initialPreset.id) || sel.value || 'the_vault';
  sel.value = initialId;
  await loadPresetIntoUI(rootEl, initialId);

  sel.addEventListener('change', () => loadPresetIntoUI(rootEl, sel.value));
  rootEl.querySelector('[data-layout-reset]').addEventListener('click', () => loadPresetIntoUI(rootEl, sel.value));
  rootEl.querySelector('[data-layout-save]').addEventListener('click', () => saveAsCustom(rootEl));
  rootEl.querySelector('[data-layout-generate]').addEventListener('click', () => {
    const cfg = readConfig(rootEl);
    Log.info('layout', `Generating plan from preset "${cfg.id}"`);
    onGenerateCb(cfg);
  });
}

async function loadPresetIntoUI(rootEl, presetId) {
  let preset;
  try {
    preset = clonePreset(await loadPreset(presetId));
  } catch (err) {
    Log.error('layout', `Failed to load preset "${presetId}"`, { error: err.message });
    return;
  }
  // Runtime validation against current taxonomy. Any bad ID surfaces as error.
  if (window.__taxonomyIds) {
    const v = validatePreset(preset, window.__taxonomyIds);
    if (!v.ok) {
      Log.error('layout', `Preset "${preset.label}" has ${v.errors.length} validation error(s)`, { preset: preset.id });
      for (const err of v.errors) Log.error('layout', `  • ${err}`);
    } else {
      Log.debug('layout', `Preset "${preset.label}" validated OK against taxonomy`);
    }
  }
  // Merge preset names with the save's existing container names: PRESERVE player-given names,
  // only fall back to preset suggestions for unnamed (BLD_STORAGE_NAME / empty) containers.
  // Original preset suggestion is kept on each chest as `_preset_name` for the per-row "↻" button.
  mergePresetWithSaveNames(preset, savedStructured);
  currentConfig = preset;
  Log.info('layout', `Loaded preset "${preset.label}"`);
  const desc = rootEl.querySelector('[data-layout-desc]');
  if (desc) desc.textContent = preset.description || '';
  renderConfigBody(rootEl.querySelector('[data-layout-body]'), preset);
  onChangeCb(preset);
}

function mergePresetWithSaveNames(preset, structured) {
  if (!structured || !Array.isArray(preset.chests)) return;
  for (const c of preset.chests) {
    c._preset_name = c.name;
    const live = (structured.chests || []).find(x => x.index === c.index);
    const isPlayerNamed = live && live.present && live.name && live.name.trim()
                          && live.name !== 'BLD_STORAGE_NAME';
    if (isPlayerNamed) c.name = live.name;
  }
}

function renderConfigBody(bodyEl, preset) {
  if (!savedStructured) {
    bodyEl.innerHTML = `<div class="empty-state"><div class="msg">Open a save first to configure layout.</div></div>`;
    return;
  }
  const s = savedStructured;
  bodyEl.innerHTML = `
    ${reservesDatalistHtml()}
    <div class="layout-grid">
      ${renderSourcesSection(preset, s)}
      ${renderChestsSection(preset, s)}
      ${renderStackCapsSection(preset)}
      ${renderReservesSection(preset)}
      ${renderExclusionsSection(preset, s)}
    </div>
  `;
  attachConfigHandlers(bodyEl);
}

// Per-bucket stack caps: max stacks of any single item that the organizer will route
// into a chest assigned to that bucket. Excess goes to the configured overflow strategy.
function renderStackCapsSection(preset) {
  const caps = preset.bucket_stack_caps || {};
  const CAP_OPTIONS = [null, 1, 2, 3, 5, 10, 15, 20];
  const optHtml = (current) => CAP_OPTIONS.map(v => {
    const sel = (v === current) || (v === null && (current === null || current === undefined));
    const label = v === null ? 'no limit' : String(v);
    return `<option value="${v === null ? '' : v}" ${sel ? 'selected' : ''}>${label}</option>`;
  }).join('');
  return `
    <section class="layout-section layout-section-wide">
      <header class="layout-section-header">
        STACK LIMITS
        <small>— max stacks per item per bucket. Excess routes to your overflow choice (set in the chests section).</small>
      </header>
      <div class="layout-section-body">
        <div class="bucket-caps-grid">
          ${BUCKETS.map(b => {
            const cur = (b.id in caps) ? caps[b.id] : null;
            return `
              <label class="bucket-cap-row" data-bucket-cap="${escapeAttr(b.id)}">
                <span class="cat-badge cat-${b.id.toLowerCase()}">${escapeHtml(b.label)}</span>
                <select data-cap-bucket="${escapeAttr(b.id)}">${optHtml(cur)}</select>
              </label>
            `;
          }).join('')}
        </div>
      </div>
    </section>
  `;
}

function renderSourcesSection(preset, s) {
  const src = preset.sources || {};
  const summary = [
    src.chests === 'all'    ? `all 10 storage containers` : (Array.isArray(src.chests) ? `${src.chests.length} chests` : 'no chests'),
    src.freighter_inventory ? 'freighter inv' : null,
    src.freighter_cargo     ? 'freighter cargo' : null,
    src.ships === 'all'     ? `${countRealShips(s)} ships` : (Array.isArray(src.ships) ? `${src.ships.length} ships` : 'no ships'),
    src.vehicles === 'all'  ? `${countRealVehicles(s)} exocrafts` : 'no exocrafts',
    src.exosuit_general     ? 'exosuit general' : null,
    src.exosuit_cargo       ? 'exosuit cargo' : null,
  ].filter(Boolean).join(' · ');

  return `
    <section class="layout-section">
      <header class="layout-section-header">PULL FROM</header>
      <div class="layout-section-body">
        <label class="layout-toggle"><input type="checkbox" data-src-key="chests"              ${src.chests === 'all' ? 'checked' : ''}> All 10 storage containers</label>
        <label class="layout-toggle"><input type="checkbox" data-src-key="freighter_inventory" ${src.freighter_inventory ? 'checked' : ''}> Freighter Inventory</label>
        <label class="layout-toggle"><input type="checkbox" data-src-key="freighter_cargo"     ${src.freighter_cargo ? 'checked' : ''}> Freighter Cargo</label>
        <label class="layout-toggle"><input type="checkbox" data-src-key="ships"               ${src.ships === 'all' ? 'checked' : ''}> All ships (except excluded)</label>
        <label class="layout-toggle"><input type="checkbox" data-src-key="vehicles"            ${src.vehicles === 'all' ? 'checked' : ''}> All exocrafts</label>
        <label class="layout-toggle"><input type="checkbox" data-src-key="exosuit_general"     ${src.exosuit_general ? 'checked' : ''}> <span class="warn-text">Exosuit General</span> <small>(off by default)</small></label>
        <label class="layout-toggle"><input type="checkbox" data-src-key="exosuit_cargo"       ${src.exosuit_cargo ? 'checked' : ''}> <span class="warn-text">Exosuit Cargo</span> <small>(off by default)</small></label>
        <div class="layout-summary">${escapeHtml(summary)}</div>
      </div>
    </section>
  `;
}

// Per-chest "buckets" cell: chips for each selected bucket + a small dropdown that lists
// only the not-yet-selected buckets (so the user can add). Empty buckets array → user sees a
// warning. Each chest can hold items from any number of buckets (1+).
function renderBucketsCell(c, present) {
  const selected = Array.isArray(c.buckets) ? c.buckets : [];
  const remaining = BUCKETS.filter(b => !selected.includes(b.id));
  const chips = selected.map(bid => {
    const meta = BUCKETS.find(b => b.id === bid);
    const label = meta ? meta.label : bid;
    return `<span class="bucket-chip cat-${bid.toLowerCase()}" data-bucket-chip="${escapeAttr(bid)}">
              <span class="bucket-chip-label">${escapeHtml(label)}</span>
              <button class="bucket-chip-x" data-bucket-remove="${escapeAttr(bid)}" title="Remove" ${present ? '' : 'disabled'}>×</button>
            </span>`;
  }).join('');
  const addOptions = [`<option value="">+</option>`,
    ...remaining.map(b => `<option value="${escapeAttr(b.id)}">${escapeHtml(b.label)}</option>`)].join('');
  const addSelect = remaining.length
    ? `<select class="bucket-add-sel" data-bucket-add ${present ? '' : 'disabled'}>${addOptions}</select>`
    : '';
  const empty = selected.length === 0
    ? `<span class="bucket-chip-empty" title="No buckets assigned — items will not be routed here">— none —</span>`
    : '';
  return `<div class="cc-buckets-cell">${empty}${chips}${addSelect}</div>`;
}

function renderChestsSection(preset, s) {
  const overflowOptions = [`<option value="">— none —</option>`,
    ...(preset.chests || []).map(c => `<option value="${c.index}">SC ${c.index} (${escapeHtml(c.name)})</option>`)].join('');

  const builtCount = (preset.chests || []).filter(c => {
    const live = (s.chests || []).find(x => x.index === c.index);
    return live && live.present;
  }).length;
  const total = (preset.chests || []).length;
  const builtSummary = builtCount === total
    ? `${total} of ${total} containers built in your save`
    : `<span class="warn-text">⚠ ${builtCount} of ${total} containers built — others will be skipped</span>`;

  const anyDifferentName = (preset.chests || []).some(c => c._preset_name && c._preset_name !== c.name);

  return `
    <section class="layout-section layout-section-wide">
      <header class="layout-section-header">
        <span>STORAGE CONTAINER ASSIGNMENTS</span>
        <small>· ${builtSummary}</small>
        <span class="audit-spacer"></span>
        <button class="btn icon" data-reset-names ${anyDifferentName ? '' : 'disabled'}
                title="Replace all container names with the preset's suggestions (overrides player-named ones)">
          ↻ RESET NAMES TO PRESET
        </button>
      </header>
      <div class="layout-section-body">
        <div class="layout-summary" style="margin-bottom: var(--sp-2);">
          Names default to what your save already uses. Use ↻ on a row to apply the preset's suggested name for that container, or the button above to apply all preset names.
        </div>
        <div class="chest-config-table">
          <div class="chest-config-row chest-config-head">
            <span class="cc-idx">#</span>
            <span class="cc-name">NAME</span>
            <span class="cc-bucket">BUCKETS  <small style="color: var(--fg-tertiary); font-weight: 400;">(any number per container)</small></span>
            <span class="cc-cap">CAP</span>
          </div>
          ${(preset.chests || []).map(c => {
            const live = (s.chests || []).find(x => x.index === c.index);
            const present = !!(live && live.present);
            const cap  = present ? (live.capacity || 50) : '—';
            const used = present ? live.slots.length : '—';
            const notBuiltClass = present ? '' : ' chest-config-row-absent';
            const statusBadge = present ? '' : `<span class="chest-status-badge" title="This storage container hasn't been built in your save. The plan will skip it.">NOT BUILT</span>`;
            const showRevert = present && c._preset_name && c._preset_name !== c.name;
            const revertBtn = showRevert
              ? `<button class="btn icon cc-revert" data-revert-idx="${c.index}" title="Use preset name: ${escapeAttr(c._preset_name)}">↻</button>`
              : '';
            return `
            <div class="chest-config-row${notBuiltClass}" data-chest-idx="${c.index}">
              <span class="cc-idx">${c.index}</span>
              <div class="cc-name-cell">
                <input class="cc-name-input" type="text" value="${escapeAttr(c.name)}" maxlength="32" ${present ? '' : 'disabled'} />
                ${revertBtn}
              </div>
              ${renderBucketsCell(c, present)}
              <span class="cc-cap">${used}/${cap}${statusBadge}</span>
            </div>`;
          }).join('')}
        </div>
        <div class="layout-row">
          <label class="layout-toggle">
            <input type="checkbox" data-config-key="consolidate_stacks" ${preset.consolidate_stacks ? 'checked' : ''}>
            Consolidate partial stacks
          </label>
          <label class="layout-row-inline">
            Overflow strategy
            <select data-config-key="overflow_strategy">
              <option value="leave_in_source"        ${preset.overflow_strategy === 'leave_in_source' ? 'selected' : ''}>Leave overflow in source</option>
              <option value="spill_to_overflow_chest"${preset.overflow_strategy === 'spill_to_overflow_chest' ? 'selected' : ''}>Spill to overflow chest</option>
              <option value="fail"                   ${preset.overflow_strategy === 'fail' ? 'selected' : ''}>Fail (warn, do nothing)</option>
            </select>
          </label>
          <label class="layout-row-inline">
            Overflow chest
            <select data-config-key="overflow_chest_index">${overflowOptions.replace(`value="${preset.overflow_chest_index}"`, `value="${preset.overflow_chest_index}" selected`)}</select>
          </label>
        </div>
      </div>
    </section>
  `;
}

function renderReservesSection(preset) {
  const renderList = (key, items) => `
    <div class="reserves-block">
      <header>${key.toUpperCase()} RESERVES</header>
      <table class="reserves-table">
        <tbody>
          ${(items || []).map((it, i) => `
            <tr data-reserve-key="${key}" data-reserve-i="${i}">
              <td>
                <input class="reserve-id" type="text" value="${escapeAttr(it.id)}" placeholder="pick or type ID…"
                       list="reserves-datalist" autocomplete="off" />
              </td>
              <td><input class="reserve-stk" type="number" value="${Number(it.stacks)||1}" min="1" max="20" /></td>
              <td class="reserve-note">${escapeHtml(reserveNoteFor(it.id, it.note))}</td>
              <td><button class="btn icon" data-reserve-del title="Remove">×</button></td>
            </tr>
          `).join('')}
          <tr class="reserves-add-row" data-reserve-key="${key}">
            <td colspan="4"><button class="btn icon" data-reserve-add="${key}">+ ADD ${key.toUpperCase()} RESERVE</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
  // Reserves are stored under operational_reserves keyed by location-type. Show all four
  // (ship / freighter / vehicle / exosuit) so users always have an entry point even if
  // the active preset has none configured for that location.
  const reserves = preset.operational_reserves || {};
  return `
    <section class="layout-section layout-section-wide">
      <header class="layout-section-header">
        OPERATIONAL RESERVES
        <small>— items left in place per ship / freighter / exocraft / exosuit. Pick from the dropdown or type a custom ID.</small>
      </header>
      <div class="layout-section-body">
        <div class="reserves-grid">
          ${renderList('ship',      reserves.ship      || [])}
          ${renderList('freighter', reserves.freighter || [])}
          ${renderList('vehicle',   reserves.vehicle   || [])}
          ${renderList('exosuit',   reserves.exosuit   || [])}
        </div>
      </div>
    </section>
  `;
}

function renderExclusionsSection(preset, s) {
  const excluded = (preset.exclude_ships_by_seed || []).map(seed => {
    const ship = (s.ships || []).find(sh => (sh.seed || '').toLowerCase() === seed.toLowerCase());
    return ship ? `${ship.name || `Ship slot ${ship.index}`} (${ship.shipType || 'unknown type'})` : seed;
  });
  const realShips = (s.ships || []).filter(sh => sh.name || (sh.seed && sh.seed !== '0x0'));
  return `
    <section class="layout-section">
      <header class="layout-section-header">EXCLUDED SHIPS</header>
      <div class="layout-section-body">
        ${excluded.length ? `
          <ul class="exclusion-list">
            ${excluded.map((label, i) => `
              <li>
                <span class="lock-icon">⚿</span>
                <span class="excl-label">${escapeHtml(label)}</span>
                <button class="btn icon" data-excl-remove="${i}" title="Re-include">×</button>
              </li>
            `).join('')}
          </ul>` : `<div class="layout-summary">no ships excluded</div>`}
        <div class="layout-row">
          <select data-excl-add>
            <option value="">— add a ship to exclude —</option>
            ${realShips.map(sh => `<option value="${escapeAttr(sh.seed || '')}">${escapeHtml(sh.name || `Ship slot ${sh.index}`)}${sh.shipType ? ' · ' + sh.shipType : ''}</option>`).join('')}
          </select>
        </div>
      </div>
    </section>
  `;
}

function attachConfigHandlers(bodyEl) {
  // Source toggles → mutate preset.sources
  bodyEl.querySelectorAll('[data-src-key]').forEach(el => {
    el.addEventListener('change', () => {
      const key = el.dataset.srcKey;
      const checked = el.checked;
      if (key === 'chests')   currentConfig.sources.chests   = checked ? 'all' : 'none';
      else if (key === 'ships')   currentConfig.sources.ships   = checked ? 'all' : 'none';
      else if (key === 'vehicles')currentConfig.sources.vehicles= checked ? 'all' : 'none';
      else                        currentConfig.sources[key]    = checked;
      onChangeCb(currentConfig);
      bodyEl.querySelector('.layout-summary').textContent = sourcesSummary(currentConfig.sources, savedStructured);
    });
  });

  // Chest name + buckets (multi-bucket via chips)
  bodyEl.querySelectorAll('.chest-config-row[data-chest-idx]').forEach(row => {
    const idx = Number(row.dataset.chestIdx);
    const cfg = currentConfig.chests.find(c => c.index === idx);
    if (!cfg) return;
    if (!Array.isArray(cfg.buckets)) cfg.buckets = [];

    row.querySelector('.cc-name-input')?.addEventListener('input', e => {
      cfg.name = e.target.value;
      onChangeCb(currentConfig);
    });

    // Remove a bucket chip
    row.querySelectorAll('[data-bucket-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const bid = btn.dataset.bucketRemove;
        cfg.buckets = cfg.buckets.filter(b => b !== bid);
        Log.debug('layout', `SC ${idx}: removed bucket ${bid}`, { remaining: cfg.buckets });
        onChangeCb(currentConfig);
        renderConfigBody(bodyEl, currentConfig);
      });
    });

    // Add a bucket via dropdown
    row.querySelector('[data-bucket-add]')?.addEventListener('change', e => {
      const bid = e.target.value;
      if (!bid) return;
      if (!cfg.buckets.includes(bid)) cfg.buckets.push(bid);
      Log.debug('layout', `SC ${idx}: added bucket ${bid}`, { all: cfg.buckets });
      onChangeCb(currentConfig);
      renderConfigBody(bodyEl, currentConfig);
    });
  });

  // Per-bucket stack-cap dropdowns
  bodyEl.querySelectorAll('[data-cap-bucket]').forEach(sel => {
    sel.addEventListener('change', e => {
      const bucket = sel.dataset.capBucket;
      const raw = e.target.value;
      const cap = raw === '' ? null : Math.max(1, Math.min(999, Number(raw) || 1));
      if (!currentConfig.bucket_stack_caps) currentConfig.bucket_stack_caps = {};
      currentConfig.bucket_stack_caps[bucket] = cap;
      Log.debug('layout', `bucket cap: ${bucket} → ${cap === null ? 'no limit' : cap + ' stacks'}`);
      onChangeCb(currentConfig);
    });
  });

  // Per-row "↻" revert: apply this chest's preset suggestion as its name.
  bodyEl.querySelectorAll('.cc-revert').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.revertIdx);
      const cfg = currentConfig.chests.find(c => c.index === idx);
      if (cfg && cfg._preset_name) {
        cfg.name = cfg._preset_name;
        Log.debug('layout', `Reverted SC ${idx} name to preset: "${cfg._preset_name}"`);
        onChangeCb(currentConfig);
        renderConfigBody(bodyEl, currentConfig);
      }
    });
  });

  // Global "↻ RESET NAMES TO PRESET": replace every chest's name with preset suggestion.
  bodyEl.querySelector('[data-reset-names]')?.addEventListener('click', () => {
    let n = 0;
    for (const c of currentConfig.chests) {
      if (c._preset_name && c._preset_name !== c.name) { c.name = c._preset_name; n++; }
    }
    Log.info('layout', `Reset ${n} container name(s) to preset values`);
    onChangeCb(currentConfig);
    renderConfigBody(bodyEl, currentConfig);
  });

  // Top-level config keys
  bodyEl.querySelectorAll('[data-config-key]').forEach(el => {
    el.addEventListener('change', () => {
      const key = el.dataset.configKey;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (key === 'overflow_chest_index') v = v === '' ? null : Number(v);
      currentConfig[key] = v;
      onChangeCb(currentConfig);
    });
  });

  // Reserves — always defensive about the per-location list existing
  function ensureReserveList(key) {
    if (!currentConfig.operational_reserves) currentConfig.operational_reserves = {};
    if (!Array.isArray(currentConfig.operational_reserves[key])) currentConfig.operational_reserves[key] = [];
    return currentConfig.operational_reserves[key];
  }
  bodyEl.querySelectorAll('[data-reserve-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      ensureReserveList(btn.dataset.reserveAdd).push({ id: '', stacks: 1 });
      renderConfigBody(bodyEl, currentConfig);
    });
  });
  bodyEl.querySelectorAll('[data-reserve-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tr = btn.closest('tr');
      const key = tr.dataset.reserveKey;
      const i   = Number(tr.dataset.reserveI);
      ensureReserveList(key).splice(i, 1);
      renderConfigBody(bodyEl, currentConfig);
    });
  });
  bodyEl.querySelectorAll('tr[data-reserve-key]').forEach(tr => {
    if (!tr.dataset.reserveI) return;
    const key = tr.dataset.reserveKey;
    const i = Number(tr.dataset.reserveI);
    const idInput = tr.querySelector('.reserve-id');
    const noteCell = tr.querySelector('.reserve-note');
    idInput.addEventListener('input', e => {
      const newId = e.target.value.trim().toUpperCase();
      ensureReserveList(key)[i].id = newId;
      // Refresh the note cell live so the user can confirm they picked the right item.
      if (noteCell) noteCell.textContent = reserveNoteFor(newId, null);
      onChangeCb(currentConfig);
    });
    tr.querySelector('.reserve-stk').addEventListener('input', e => {
      ensureReserveList(key)[i].stacks = Math.max(1, Math.min(20, Number(e.target.value) || 1));
      onChangeCb(currentConfig);
    });
  });

  // Exclusion add/remove
  const addSel = bodyEl.querySelector('[data-excl-add]');
  if (addSel) {
    addSel.addEventListener('change', () => {
      const seed = addSel.value;
      if (!seed) return;
      if (!currentConfig.exclude_ships_by_seed.includes(seed)) {
        currentConfig.exclude_ships_by_seed.push(seed);
        onChangeCb(currentConfig);
        renderConfigBody(bodyEl, currentConfig);
      }
    });
  }
  bodyEl.querySelectorAll('[data-excl-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.exclRemove);
      currentConfig.exclude_ships_by_seed.splice(i, 1);
      onChangeCb(currentConfig);
      renderConfigBody(bodyEl, currentConfig);
    });
  });
}

function readConfig() { return currentConfig; }

function saveAsCustom(rootEl) {
  if (!currentConfig) return;
  const label = window.prompt('Name for this custom preset:', `${currentConfig.label} (custom)`);
  if (!label) return;
  const id = `custom_${Date.now()}`;
  const data = clonePreset(currentConfig);
  data.id = id; data.label = label;
  saveCustomPreset(data);
  Log.success('layout', `Saved custom preset "${label}"`, { id });
  // Re-init dropdown so the new preset shows up
  renderLayout(rootEl, savedStructured, { initialPreset: data, onChange: onChangeCb, onGeneratePlan: onGenerateCb });
}

function sourcesSummary(src, s) {
  return [
    src.chests === 'all'    ? `all 10 storage containers` : 'no chests',
    src.freighter_inventory ? 'freighter inv' : null,
    src.freighter_cargo     ? 'freighter cargo' : null,
    src.ships === 'all'     ? `${countRealShips(s)} ships` : 'no ships',
    src.vehicles === 'all'  ? `${countRealVehicles(s)} exocrafts` : 'no exocrafts',
    src.exosuit_general     ? 'exosuit general' : null,
    src.exosuit_cargo       ? 'exosuit cargo' : null,
  ].filter(Boolean).join(' · ');
}

function countRealShips(s) { return (s.ships || []).filter(sh => sh.name || (sh.seed && sh.seed !== '0x0')).length; }
function countRealVehicles(s) { return (s.vehicles || []).filter(v => v.inventory).length; }

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
function escapeAttr(s) { return escapeHtml(s); }
