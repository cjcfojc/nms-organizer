// Preset loader + manager.
// Built-in presets are JSON files in /data/presets/. User-defined presets live in localStorage.
// Returns a uniform list of {id, label, description, builtin, data}.

const LS_KEY = 'nmso.user_presets';
const INDEX_URL = 'data/presets/index.json';
const PRESET_URL = id => `data/presets/${id}.json`;

const cache = new Map();   // preset id → preset data

export async function loadPresetIndex() {
  const r = await fetch(INDEX_URL);
  if (!r.ok) throw new Error(`presets index fetch failed: ${r.status}`);
  const idx = await r.json();
  return idx.presets;
}

export async function loadPreset(id) {
  if (cache.has(id)) return cache.get(id);
  // Custom preset?
  const custom = getCustomPresets().find(p => p.id === id);
  if (custom) { const norm = normalizeToV2(custom); cache.set(id, norm); return norm; }
  // Built-in
  const r = await fetch(PRESET_URL(id));
  if (!r.ok) throw new Error(`preset "${id}" fetch failed: ${r.status}`);
  const data = await r.json();
  const norm = normalizeToV2(data);
  cache.set(id, norm);
  return norm;
}

// Normalize old (v1) presets to v2 schema in-memory. v1: chests[].bucket = "X".
// v2: chests[].buckets = ["X", ...] + top-level bucket_stack_caps. Idempotent.
function normalizeToV2(p) {
  if (!p || typeof p !== 'object') return p;
  if (Array.isArray(p.chests)) {
    for (const c of p.chests) {
      if (typeof c.bucket === 'string' && !Array.isArray(c.buckets)) {
        c.buckets = [c.bucket];
        delete c.bucket;
      }
      if (!Array.isArray(c.buckets)) c.buckets = [];
    }
  }
  if (!p.bucket_stack_caps || typeof p.bucket_stack_caps !== 'object') {
    p.bucket_stack_caps = {};
  }
  // Ensure all known buckets have an entry (null = no limit)
  for (const b of BUCKETS) {
    if (!(b.id in p.bucket_stack_caps)) p.bucket_stack_caps[b.id] = null;
  }
  if (p.schema_version !== 2) p.schema_version = 2;
  return p;
}

export function getCustomPresets() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to read custom presets:', err);
    return [];
  }
}

export function saveCustomPreset(preset) {
  if (!preset || !preset.id) throw new Error('preset must have an id');
  const all = getCustomPresets().filter(p => p.id !== preset.id);
  all.push(preset);
  localStorage.setItem(LS_KEY, JSON.stringify(all));
  cache.delete(preset.id);
}

export function deleteCustomPreset(id) {
  const all = getCustomPresets().filter(p => p.id !== id);
  localStorage.setItem(LS_KEY, JSON.stringify(all));
  cache.delete(id);
}

// Available buckets (must match classify.js classification names)
export const BUCKETS = [
  { id: 'Raw_Local',       label: 'Raw — Common' },
  { id: 'Raw_Stellar',     label: 'Raw — Stellar' },
  { id: 'Raw_Atmospheric', label: 'Raw — Atmospheric' },
  { id: 'Raw_Exotic',      label: 'Raw — Exotic' },
  { id: 'Components',      label: 'Components' },
  { id: 'Curios',          label: 'Curios' },
  { id: 'Cooking',         label: 'Cooking' },
  { id: 'Trade',           label: 'Trade' },
  { id: 'Tech_Modules',    label: 'Tech Modules' },
  { id: 'Salvage_Charts',  label: 'Salvage & Charts' },
  { id: 'Contraband',      label: 'Contraband' },
];
const VALID_BUCKETS = new Set(BUCKETS.map(b => b.id));

// Validate a preset against a Set of known item IDs (built from taxonomy at load time).
// Returns { ok: bool, errors: string[] }. Caller should surface errors to the terminal.
export function validatePreset(preset, knownIds) {
  const errors = [];
  if (!preset || typeof preset !== 'object') {
    errors.push('preset is not an object');
    return { ok: false, errors };
  }
  // Operational reserves — every id must exist in taxonomy
  const res = preset.operational_reserves || {};
  for (const loc of Object.keys(res)) {
    const items = res[loc] || [];
    items.forEach((entry, i) => {
      if (!entry || typeof entry.id !== 'string' || !entry.id) {
        errors.push(`reserves.${loc}[${i}]: missing id`);
        return;
      }
      if (!knownIds.has(entry.id)) {
        errors.push(`reserves.${loc}[${i}]: id "${entry.id}" not in taxonomy`);
      }
    });
  }
  // Chests — v2 schema: buckets is a non-empty array of valid bucket ids
  (preset.chests || []).forEach((c, i) => {
    if (!Number.isInteger(c.index) || c.index < 1 || c.index > 10) errors.push(`chests[${i}]: bad index ${c.index}`);
    if (!Array.isArray(c.buckets) || c.buckets.length === 0) {
      errors.push(`chests[${i}]: buckets must be a non-empty array`);
    } else {
      for (const b of c.buckets) {
        if (!VALID_BUCKETS.has(b)) errors.push(`chests[${i}]: unknown bucket "${b}"`);
      }
    }
  });

  // Bucket stack caps — must be null or positive integer per known bucket
  if (preset.bucket_stack_caps && typeof preset.bucket_stack_caps === 'object') {
    for (const [bucket, cap] of Object.entries(preset.bucket_stack_caps)) {
      if (!VALID_BUCKETS.has(bucket)) errors.push(`bucket_stack_caps: unknown bucket "${bucket}"`);
      if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 999)) {
        errors.push(`bucket_stack_caps.${bucket}: cap must be null or 1..999, got ${cap}`);
      }
    }
  }
  // Overflow chest reference must resolve
  if (preset.overflow_strategy === 'spill_to_overflow_chest') {
    const idxs = (preset.chests || []).map(c => c.index);
    if (!idxs.includes(preset.overflow_chest_index)) {
      errors.push(`overflow_chest_index=${preset.overflow_chest_index} not present in chests`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// Deep-clone a preset so callers can mutate without affecting the cache
export function clonePreset(preset) {
  return JSON.parse(JSON.stringify(preset));
}
