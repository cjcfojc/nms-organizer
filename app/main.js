// Bootstrap for No Man's Organizer.
//
// Wires the UI together: file picker → decode → walk → render audit/layout/preview/apply
// tabs. State is held in module-level `state` so the apply pipeline can re-validate
// against the same loaded save without re-reading the file.

import { loadSave } from './lib/save.js';
import { loadTaxonomy, getStats as taxonomyStats, getKnownIds } from './lib/classify.js';
import { renderAudit, renderItemDetail } from './lib/audit.js';
import { renderLayout } from './lib/layout.js';
import { displayName } from './lib/classify.js';
import { generatePlan } from './lib/plan.js';
import { renderPreview } from './lib/preview.js';
import { renderApplyTab } from './lib/applyUI.js';
import { pickSaveFromNmsFolder } from './lib/savePicker.js';

const state = {
  fileHandle: null,    // FileSystemFileHandle for save.hg (in-place writeback when granted)
  manifestHandle: null,// FileSystemFileHandle for mf_save.hg (in-place writeback)
  loaded: null,        // loadSave() result + {bytes, fileName, manifestBytes, manifestName, backupPath}
  plan: null,          // most recent generated plan
  structured: null,    // structured save snapshot, separate ref so apply.js can resolve paths
};

document.addEventListener('DOMContentLoaded', async () => {
  const terminalRoot = document.querySelector('.terminal');
  Log.attach(terminalRoot);

  initBranding();
  initTabs();
  initDensityToggle();
  initActions();
  initLockedSourceTree();
  renderItemDetail(document.querySelector('.detail .pane-body'), null);

  Log.info('boot', "No Man's Organizer starting");
  Log.debug('boot', 'Viewport', { w: window.innerWidth, h: window.innerHeight });
  Log.info('codec', 'Browser LZ4 codec ready (lib/codec.js)');

  // Pre-load taxonomy so it's ready by the time the user picks a save.
  try {
    const t0 = performance.now();
    await loadTaxonomy();
    const dt = (performance.now() - t0).toFixed(1);
    const s = taxonomyStats();
    Log.success('taxonomy', `Loaded taxonomy in ${dt}ms`, {
      records: s.total_records,
      libmbin: s.libmbin_version,
    });
    // Expose a Set of known IDs for runtime preset validation
    window.__taxonomyIds = getKnownIds();
    // Sync the topbar pill to the actual loaded count
    const taxPill = document.querySelector('.status-pill .value');
    document.querySelectorAll('.status-pill').forEach(pill => {
      const label = pill.querySelector('.label');
      const val = pill.querySelector('.value');
      if (label && val && label.textContent === 'TAXONOMY') {
        val.textContent = `${s.total_records.toLocaleString()} ids`;
      }
    });
  } catch (err) {
    Log.error('taxonomy', `Failed to load taxonomy: ${err.message}`);
  }

  Log.success('boot', 'Ready · click OPEN SAVE in the top bar');
});

// ── Branding ──────────────────────────────────────────────────────────
function initBranding() {
  const pairs = [
    { banner: 'assets/welcome_banner_1.png', header: 'assets/header_1.png', mood: 'blue/space' },
    { banner: 'assets/welcome_banner_2.png', header: 'assets/header_1.png', mood: 'blue/space' },
    { banner: 'assets/welcome_banner_3.png', header: 'assets/header_2.png', mood: 'purple/sunset' },
    { banner: 'assets/welcome_banner_4.png', header: 'assets/header_2.png', mood: 'purple/sunset' },
  ];
  const pick = pairs[Math.floor(Math.random() * pairs.length)];
  const bannerEl = document.querySelector('[data-welcome-banner]');
  const brandEl = document.querySelector('[data-brand-mark]');
  if (bannerEl) bannerEl.src = pick.banner;
  if (brandEl) {
    brandEl.src = pick.header;
    brandEl.addEventListener('error', () => {
      brandEl.dataset.broken = '1';
      Log.warn('ui', 'Brand mark image failed to load — using text fallback', { src: brandEl.src });
    });
  }
  Log.debug('boot', `Banner cycle: ${pick.banner.split('/').pop()} (${pick.mood})`);
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const target = document.querySelector(`[data-pane="${tab.dataset.tab}"]`);
      if (target) target.classList.add('active');
      Log.debug('ui', `Switched to tab: ${tab.dataset.tab}`);
    });
  });
}

function initDensityToggle() {
  const btn = document.querySelector('[data-density-toggle]');
  if (!btn) return;
  const cycle = ['normal', 'compact', 'comfortable'];
  btn.addEventListener('click', () => {
    const cur = document.documentElement.dataset.density || 'normal';
    const next = cycle[(cycle.indexOf(cur) + 1) % cycle.length];
    document.documentElement.dataset.density = next;
    btn.textContent = `DENSITY: ${next.toUpperCase()}`;
    Log.info('ui', `UI density set to ${next}`);
  });
}

function initLockedSourceTree() {
  document.querySelectorAll('.tree-item.locked').forEach(item => {
    item.addEventListener('click', e => e.preventDefault());
  });
}

function initActions() {
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const action = btn.dataset.action;
      try {
        if (action === 'open-save')  return await openSave();
        if (action === 'apply-plan') return openApplyTab();
        Log.warn('ui', `Action "${action}" not wired yet`);
      } catch (err) {
        Log.error('ui', `Action "${action}" failed: ${err.message}`, { stack: err.stack && err.stack.split('\n')[1] });
      }
    });
  });
}

// ── OPEN SAVE flow ────────────────────────────────────────────────────
// Two acquisition paths, one ingest path:
//   1. List-from-NMS-folder (preferred) — server enumerates the user's actual
//      slots and decrypts each manifest's SaveSummary so the picker shows
//      friendly text. One click loads both save<N>.hg + mf_save<N>.hg.
//   2. OS file picker (fallback) — for systems where NMS isn't auto-detected
//      or for loading from arbitrary locations (backups, shared saves).
//
// Both paths produce the same { saveBytes, saveName, manifestBytes?, manifestName? }
// tuple that ingestSave() consumes.

async function openSave() {
  let acquired;
  try {
    acquired = await pickSaveFromNmsFolder();
  } catch (err) {
    Log.error('codec', `NMS folder picker failed: ${err.message} — falling back to file picker`);
    acquired = { source: 'fallback' };
  }

  if (acquired.source === 'cancel') { Log.debug('ui', 'Save picker dismissed'); return; }

  if (acquired.source === 'list') {
    Log.info('codec', `Loaded from NMS folder: ${acquired.save.name}`, {
      slot:    acquired.save.slot_index,
      summary: acquired.save.summary,
      bytes:   acquired.saveBytes.length,
    });
    return ingestSave({
      saveBytes:     acquired.saveBytes,
      saveName:      acquired.save.name,
      manifestBytes: acquired.manifestBytes,
      manifestName:  acquired.save.manifest,
      lastModified:  acquired.save.mtime,
    });
  }

  // source === 'fallback' — show the OS file picker
  const picked = await pickViaOsPicker();
  if (!picked) { Log.debug('ui', 'File picker dismissed'); return; }

  if (!picked.manifestFile) {
    Log.warn('codec', `No matching mf_${picked.file.name} in your selection — apply will refuse to run without it. Re-open with both files selected to enable manifest regeneration.`);
  }

  return ingestSave({
    saveBytes:     new Uint8Array(await picked.file.arrayBuffer()),
    saveName:      picked.file.name,
    manifestBytes: picked.manifestFile ? new Uint8Array(await picked.manifestFile.arrayBuffer()) : null,
    manifestName:  picked.manifestFile ? picked.manifestFile.name : null,
    lastModified:  picked.file.lastModified,
  });
}

// Pick save + manifest via the OS file dialog. Returns null if user cancels.
async function pickViaOsPicker() {
  if ('showOpenFilePicker' in window) {
    Log.debug('codec', 'Using native file picker (FSA API)');
    try {
      const handles = await window.showOpenFilePicker({
        types: [{ description: 'NMS save + manifest', accept: { 'application/octet-stream': ['.hg'] } }],
        multiple: true,
        excludeAcceptAllOption: false,
      });
      const files = await Promise.all(handles.map(h => h.getFile()));
      const { file, manifestFile } = pickSaveAndManifest(files);
      if (!file) { Log.error('codec', 'no save.hg in selection'); return null; }
      // Track BOTH file handles so OVERWRITE ORIGINAL could write back in place
      // (currently unused — the /nms/write path uses the local server).
      state.fileHandle     = handles.find(h => h.name === file.name) || null;
      state.manifestHandle = manifestFile ? (handles.find(h => h.name === manifestFile.name) || null) : null;
      return { file, manifestFile };
    } catch (err) {
      if (err.name === 'AbortError') return null;
      throw err;
    }
  }
  Log.debug('codec', 'Using input fallback picker (FSA unavailable)');
  const files = await pickViaInput();
  if (!files || !files.length) return null;
  const { file, manifestFile } = pickSaveAndManifest(files);
  if (!file) { Log.error('codec', 'no save.hg in selection'); return null; }
  return { file, manifestFile };
}

// Common ingest path: takes raw bytes, runs auto-backup, decode, walk, render.
// Both the list-picker and the file-picker route through here.
async function ingestSave({ saveBytes, saveName, manifestBytes, manifestName, lastModified }) {
  setPillLoaded(saveName);

  // Auto-backup the loaded save bytes BEFORE any further processing. The
  // apply pipeline refuses to run without a backupPath on the loaded state.
  let backupPath = null;
  try {
    const t0 = performance.now();
    const r = await fetch('/backup', {
      method:  'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-NMSO-Filename': saveName },
      body:    saveBytes,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const meta = await r.json();
    Log.success('backup', `Auto-backed up to ${meta.relative_path} in ${(performance.now() - t0).toFixed(1)}ms`, { bytes: meta.bytes, sha: meta.sha256_hex.slice(0, 16) });
    setPillBackup(meta.relative_path, meta.path);
    backupPath = meta.relative_path;
  } catch (err) {
    Log.error('backup', `Auto-backup FAILED: ${err.message}`, { hint: 'Save will still load, but you have no automatic backup. Make a manual copy now.' });
    setPillBackupFailed();
  }

  Log.debug('codec', 'Decoding LZ4 chunks…');
  const t0 = performance.now();
  const result = await loadSave(saveBytes);
  Log.success('codec', `Decoded in ${(performance.now() - t0).toFixed(1)}ms`, {
    bytes_in: result.bytes_size,
    payload:  result.payload_size,
    sha:      result.sha256.slice(0, 16),
  });

  // Augment the loaded result with what downstream tabs (Apply) need.
  result.bytes         = saveBytes;
  result.fileName      = saveName;
  result.lastModified  = lastModified;
  result.backupPath    = backupPath;
  result.manifestBytes = manifestBytes;
  result.manifestName  = manifestName;
  state.loaded     = result;
  state.structured = result.structured;
  if (manifestBytes) Log.success('codec', `Manifest paired: ${manifestName} (${manifestBytes.length} B)`);

  const s = result.structured;
  const chestCount = s.chests.filter(c => c.present).length;
  const shipCount = s.ships.length;
  Log.info('walk', 'Inventory walk complete', {
    chests: chestCount,
    ships: shipCount,
    freighter: !!s.freighter.inventory,
    exosuit: !!s.exosuit.inventory,
    weapon: !!s.weapon,
    total_containers: s.allContainers.length,
  });

  // Initial render — no layout config yet, no exclusions applied
  populateSourcesTree(s, null);
  renderAuditTab(s);
  renderLayoutTab(s);
  enableActionsAfterLoad();
}

function renderLayoutTab(structured) {
  const layoutPane = document.querySelector('[data-pane="layout"]');
  if (!layoutPane) return;
  layoutPane.innerHTML = '';
  renderLayout(layoutPane, structured, {
    onChange(cfg) {
      // Mirror the config's exclusions / sources back to the left sources tree.
      populateSourcesTree(structured, cfg);
      Log.debug('layout', `Config changed`, {
        preset: cfg.id,
        excluded_ships: (cfg.exclude_ships_by_seed || []).length,
      });
    },
    onGeneratePlan(cfg) {
      try {
        const t0 = performance.now();
        const plan = generatePlan(structured, cfg);
        const dt = (performance.now() - t0).toFixed(1);
        state.plan = plan;
        const lvl = plan.summary.invariant_ok ? 'success' : 'error';
        Log[lvl]('plan', `Plan generated in ${dt}ms`, {
          dest_chests: plan.summary.destinations_used,
          stacks_placed: plan.summary.stacks_placed,
          overflow: plan.summary.overflow_entries,
          skipped: plan.summary.skipped_entries,
          amount_in: plan.summary.total_amount_in,
          amount_out: plan.summary.total_amount_out,
          invariant_ok: plan.summary.invariant_ok,
        });
        for (const w of plan.summary.warnings) Log.warn('plan', w);
        renderPreviewTab(plan);   // preview.js attaches plan.validation
        gateApplyButton(plan);
        const previewTab = document.querySelector('[data-tab="preview"]');
        if (previewTab) previewTab.click();
      } catch (err) {
        Log.error('plan', `Plan generation failed: ${err.message}`, { stack: err.stack && err.stack.split('\n')[1] });
      }
    },
  }).catch(err => {
    Log.error('layout', `Failed to render Layout tab: ${err.message}`);
  });
}

function renderPreviewTab(plan) {
  const pane = document.querySelector('[data-pane="preview"]');
  if (!pane) return;
  renderPreview(pane, plan);
  // Apply tab mirrors the latest plan, so re-render it whenever a new plan lands.
  renderApplyTabNow();
}

function renderApplyTabNow() {
  const pane = document.querySelector('[data-pane="apply"]');
  if (!pane) return;
  renderApplyTab(pane, state, (lvl, cat, msg, data) => Log[lvl](cat, msg, data));
}

function openApplyTab() {
  renderApplyTabNow();
  const tab = document.querySelector('[data-tab="apply"]');
  if (tab) tab.click();
}

function renderAuditTab(structured) {
  const auditPane = document.querySelector('[data-pane="audit"]');
  if (!auditPane) return;
  auditPane.innerHTML = '';   // remove welcome banner
  const detailEl = document.querySelector('.detail .pane-body');

  renderAudit(auditPane, structured, {
    onSelectSlot(sel) {
      renderItemDetail(detailEl, sel);
      Log.debug('ui', `Selected ${sel.slot.id} @ ${sel.container.path}`,
        { bucket: sel.classification.classification, amount: sel.slot.amount });
      // Update the "SLOT" status pill in the topbar with the friendly name
      const slotPill = document.querySelector('[data-status-slot]');
      if (slotPill) slotPill.textContent = displayName(sel.slot.id, sel.classification) || sel.slot.id;
    },
  });
  Log.success('ui', 'Audit grid rendered');
}

function setStatus(key, value) {
  const el = document.querySelector(`[data-status-${key}]`);
  if (el) el.textContent = value;
}

// Status pill helpers — they apply the .ok class for the green-glow active state.
function setPillLoaded(filename) {
  const pill  = document.querySelector('[data-pill-loaded]');
  const value = document.querySelector('[data-status-loaded]');
  if (pill)  pill.classList.add('ok');
  if (value) value.textContent = `${filename}  ✓`;
}
function setPillBackup(relativePath, fullPath) {
  const pill  = document.querySelector('[data-pill-backup]');
  const value = document.querySelector('[data-status-backup]');
  if (pill)  { pill.classList.add('ok'); pill.classList.remove('error'); pill.title = fullPath || relativePath; }
  if (value) value.textContent = `${truncatePath(relativePath, 32)}  ✓`;
}
function setPillBackupFailed() {
  const pill  = document.querySelector('[data-pill-backup]');
  const value = document.querySelector('[data-status-backup]');
  if (pill)  { pill.classList.add('error'); pill.classList.remove('ok'); }
  if (value) value.textContent = 'FAILED';
}
function truncatePath(p, maxLen) {
  if (!p) return '';
  if (p.length <= maxLen) return p;
  // Keep the leading "backups\" prefix and the tail — middle gets …
  const head = p.slice(0, 9);   // "backups\"
  const tailLen = maxLen - head.length - 1;
  const tail = p.slice(-tailLen);
  return `${head}…${tail}`;
}

function enableActionsAfterLoad() {
  // Backup + Apply still gated to later phases; just remove "disabled" hint on welcome
  document.querySelector('[data-action="backup-now"]').disabled = false;
}

// Apply button is enabled only when a plan exists AND its validation passed.
// Tooltip explains the current state. Wire this any time a plan is (re)generated.
function gateApplyButton(plan) {
  const btn = document.querySelector('[data-action="apply-plan"]');
  if (!btn) return;
  if (plan && plan.validation && plan.validation.ok) {
    btn.disabled = false;
    btn.title = `Apply this plan: ${plan.summary.stacks_placed} stacks across ${plan.summary.destinations_used} containers`;
    Log.success('apply', `APPLY PLAN unlocked — validation passed (${plan.validation.summary.pass}/${plan.validation.summary.total} checks)`);
  } else {
    btn.disabled = true;
    if (!plan) {
      btn.title = 'Generate a plan first (Layout tab → ▶ GENERATE PLAN)';
    } else {
      const fails = plan.validation ? plan.validation.errors.length : 0;
      btn.title = `Plan blocked: ${fails} validation check(s) failed. See Preview tab.`;
      Log.warn('apply', `APPLY PLAN remains disabled — ${fails} validation failure(s)`);
    }
  }
}

// ── Sources tree population ───────────────────────────────────────────
// `config` is the current layout config (may be null if no preset loaded yet).
// When provided, drives ship lock state from config.exclude_ships_by_seed.
function populateSourcesTree(s, config) {
  const tree = document.querySelector('.sources-tree');
  if (!tree) return;
  const excludedSeeds = new Set(((config && config.exclude_ships_by_seed) || []).map(x => x.toLowerCase()));

  // Storage containers — the game calls them "Storage Containers" + "BLD_STORAGE_NAME"
  // is the in-game default for unnamed slots, so we substitute "Storage Container N".
  const builtChests = s.chests.filter(c => c.present).length;
  const chestGroup = treeGroup('STORAGE CONTAINERS', `${builtChests}/10`);
  for (const ch of s.chests) {
    const isUnnamed = !ch.present || !ch.name || !ch.name.trim() || ch.name === 'BLD_STORAGE_NAME';
    const label = isUnnamed ? `Storage Container ${ch.index}` : ch.name;
    const meta = ch.present ? `${ch.slots.length}/${ch.capacity || 50}` : 'not built';
    const item = treeItem(label, meta, !ch.present);
    item.dataset.kind = 'chest';
    item.dataset.idx = ch.index;
    chestGroup.body.appendChild(item);
  }

  // Freighter (Tech omitted — installed gear, not loose items)
  const fInvCount = (s.freighter.inventory ? 1 : 0) + (s.freighter.cargo ? 1 : 0);
  const fGroup = treeGroup('FREIGHTER', `${fInvCount}/2`);
  if (s.freighter.inventory) fGroup.body.appendChild(addClick(treeItem('Inventory', `${s.freighter.inventory.slots.length}/${s.freighter.inventory.capacity || '?'}`)));
  if (s.freighter.cargo)     fGroup.body.appendChild(addClick(treeItem('Cargo',     `${s.freighter.cargo.slots.length}/${s.freighter.cargo.capacity || '?'}`)));

  // Ships — @Cs is a 12-slot array (game-reserved capacity); filter to ones the player actually owns.
  // A real ship has a non-empty name OR a non-zero seed (claimed Sentinel Interceptors may have no name).
  const realShips = s.ships.filter(sh => {
    const hasName = sh.name && sh.name.trim().length > 0;
    const hasSeed = sh.seed && sh.seed !== '0x0';
    return hasName || hasSeed;
  });
  const sGroup = treeGroup('SHIPS', `${realShips.length}`);
  for (const ship of realShips) {
    const baseName = ship.name && ship.name.trim() ? ship.name : `Ship slot ${ship.index} (unclaimed)`;
    const label = ship.shipType ? `${baseName} · ${ship.shipType}` : baseName;
    const isExcluded = excludedSeeds.has((ship.seed || '').toLowerCase());
    const inventoryCount = (ship.inventory ? ship.inventory.slots.length : 0)
                         + (ship.cargo ? ship.cargo.slots.length : 0);
    const meta = `${inventoryCount} items` + (isExcluded ? ' · EXCLUDED' : '');
    const item = treeItem(label, meta, isExcluded);
    item.dataset.kind = 'ship';
    item.dataset.idx = ship.index;
    item.title = `seed: ${ship.seed || '—'}\ntype: ${ship.shipType || 'unknown'}` + (isExcluded ? '\n(excluded by current layout config)' : '');
    if (!isExcluded) addClick(item);
    sGroup.body.appendChild(item);
  }
  if (s.ships.length > realShips.length) {
    Log.debug('walk', `Filtered out ${s.ships.length - realShips.length} unused ship slots from sources tree`);
  }

  // Exocrafts (vehicles) — Inventory only; no cargo for vehicles
  const realVehicles = (s.vehicles || []).filter(v => v.inventory);
  let vGroup = null;
  if (realVehicles.length) {
    vGroup = treeGroup('EXOCRAFTS', `${realVehicles.length}`);
    for (const v of realVehicles) {
      const label = v.name && v.name.trim() ? v.name : `Exocraft ${v.index + 1}`;
      const meta = `${v.inventory.slots.length} items`;
      const item = treeItem(label, meta);
      item.dataset.kind = 'exocraft';
      item.dataset.idx = v.index;
      addClick(item);
      vGroup.body.appendChild(item);
    }
  }

  // Exosuit (POLICY-locked by default; HARD-locked tech omitted entirely)
  const eGroup = treeGroup('EXOSUIT', 'LOCKED');
  if (s.exosuit.inventory) eGroup.body.appendChild(treeItem('General', `${s.exosuit.inventory.slots.length} items`, true));
  if (s.exosuit.cargo)     eGroup.body.appendChild(treeItem('Cargo',   `${s.exosuit.cargo.slots.length} items`, true));

  // Replace existing tree contents
  tree.innerHTML = '';
  tree.append(chestGroup.root, fGroup.root, sGroup.root);
  if (vGroup) tree.append(vGroup.root);
  tree.append(eGroup.root);

  Log.info('ui', 'Sources tree populated from save data');
}

function countOnOf3(group) {
  let n = 0;
  if (group.inventory) n++;
  if (group.cargo) n++;
  if (group.tech) n++;
  return `${n}/3`;
}

function treeGroup(title, count) {
  const root = document.createElement('div'); root.className = 'tree-group';
  const header = document.createElement('div'); header.className = 'tree-group-header';
  header.innerHTML = `<span>${escapeHtml(title)}</span><span class="count">${escapeHtml(count)}</span>`;
  const body = document.createElement('div'); body.className = 'tree-group-body';
  root.append(header, body);
  return { root, body };
}

function treeItem(name, meta, locked = false) {
  const item = document.createElement('div');
  item.className = 'tree-item' + (locked ? ' locked' : '');
  const check = document.createElement('span');
  check.className = 'check' + (locked ? ' locked' : '');
  const nameEl = document.createElement('span');
  nameEl.className = 'name'; nameEl.textContent = name;
  const metaEl = document.createElement('span');
  metaEl.className = 'meta'; metaEl.textContent = meta;
  item.append(check, nameEl, metaEl);
  if (locked) {
    const lock = document.createElement('span');
    lock.className = 'lock-icon'; lock.textContent = '⚿';
    item.append(lock);
  }
  return item;
}

function addClick(item) {
  item.addEventListener('click', () => {
    const check = item.querySelector('.check');
    check.classList.toggle('checked');
    Log.debug('ui', `Source toggled: ${item.querySelector('.name').textContent}`,
      { checked: check.classList.contains('checked') });
  });
  return item;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[ch]));
}

// Universal fallback: programmatically click an <input type="file" multiple>.
// Resolves with the selected File[] (or null if user cancels).
function pickViaInput() {
  return new Promise(resolve => {
    let input = document.querySelector('#fallback-file-input');
    if (!input) {
      input = document.createElement('input');
      input.type = 'file';
      input.id = 'fallback-file-input';
      input.accept = '.hg,application/octet-stream';
      input.multiple = true;
      input.style.display = 'none';
      document.body.appendChild(input);
    }
    let resolved = false;
    const onChange = () => {
      resolved = true;
      const arr = input.files ? Array.from(input.files) : [];
      input.value = '';
      resolve(arr.length ? arr : null);
    };
    input.addEventListener('change', onChange, { once: true });
    window.addEventListener('focus', () => {
      setTimeout(() => { if (!resolved) resolve(null); }, 300);
    }, { once: true });
    input.click();
  });
}

// Sort a list of picked File objects into the save file and its manifest sibling.
// A "manifest" is anything whose name starts with "mf_" and has its sibling save's
// name after that prefix. Save file: any .hg that isn't a manifest. If we get
// multiple candidates we prefer the matched pair; otherwise warn.
function pickSaveAndManifest(files) {
  const saves = [], manifests = [];
  for (const f of files) {
    if (f.name.toLowerCase().startsWith('mf_')) manifests.push(f);
    else saves.push(f);
  }
  if (saves.length === 0) return { file: null, manifestFile: null };
  // Prefer the first save and its matching manifest
  for (const s of saves) {
    const wanted = ('mf_' + s.name).toLowerCase();
    const m = manifests.find(mf => mf.name.toLowerCase() === wanted);
    if (m) return { file: s, manifestFile: m };
  }
  // No match — return first save without a manifest
  return { file: saves[0], manifestFile: null };
}
