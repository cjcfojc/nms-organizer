// Validate every item ID referenced in any preset file against data/taxonomy.json.
// MUST run clean before any preset change is committed. Fails non-zero on any unknown ID.
//
// Catches the failure mode where a preset references an ID that doesn't exist in the game
// (e.g. guessed name vs real internal ID) — silent runtime failures otherwise.
//
// Usage: node verify_presets.js  (defaults to ./app/data/presets/*.json)

const fs = require('fs');
const path = require('path');

const TAX_PATH = path.resolve(__dirname, 'data/taxonomy.json');
const APP_TAX_PATH = path.resolve(__dirname, 'app/data/taxonomy.json');
const PRESETS_DIR = path.resolve(__dirname, 'app/data/presets');

function loadTaxonomy() {
  // Prefer app copy if it exists (what the runtime actually uses); fall back to root copy
  const tax = JSON.parse(fs.readFileSync(fs.existsSync(APP_TAX_PATH) ? APP_TAX_PATH : TAX_PATH, 'utf8'));
  const byId = new Set();
  for (const r of tax.records) byId.add(r.id);
  return { byId, count: tax.records.length };
}

function loadPresetFiles() {
  const indexPath = path.join(PRESETS_DIR, 'index.json');
  const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  return idx.presets.map(p => ({
    meta: p,
    path: path.join(PRESETS_DIR, p.file),
    data: JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, p.file), 'utf8')),
  }));
}

const VALID_BUCKETS = new Set([
  'Raw_Local','Raw_Stellar','Raw_Atmospheric','Raw_Exotic',
  'Components','Curios','Cooking','Trade','Tech_Modules','Salvage_Charts','Contraband',
]);

function verifyPreset(preset, taxIds) {
  const failures = [];

  // Check operational reserves IDs
  const reserves = preset.operational_reserves || {};
  for (const loc of Object.keys(reserves)) {
    const items = reserves[loc] || [];
    items.forEach((entry, i) => {
      if (!entry.id || typeof entry.id !== 'string') {
        failures.push(`reserves.${loc}[${i}]: missing or non-string id`);
        return;
      }
      if (!taxIds.has(entry.id)) {
        failures.push(`reserves.${loc}[${i}]: id "${entry.id}" not in taxonomy`);
      }
      if (!Number.isInteger(entry.stacks) || entry.stacks < 1 || entry.stacks > 20) {
        failures.push(`reserves.${loc}[${i}]: stacks=${entry.stacks} out of 1..20`);
      }
    });
  }

  // Schema version
  if (preset.schema_version !== 2) {
    failures.push(`schema_version=${preset.schema_version} — expected 2 (run migrate_preset_v2.js)`);
  }

  // Check chest bucket assignments (v2: buckets is a non-empty array)
  (preset.chests || []).forEach((c, i) => {
    if (!Number.isInteger(c.index) || c.index < 1 || c.index > 10) {
      failures.push(`chests[${i}]: index=${c.index} out of 1..10`);
    }
    if (typeof c.name !== 'string' || !c.name.trim()) {
      failures.push(`chests[${i}]: empty name`);
    }
    if ('bucket' in c) {
      failures.push(`chests[${i}]: legacy "bucket" field — should be "buckets" array (run migrate_preset_v2.js)`);
    }
    if (!Array.isArray(c.buckets) || c.buckets.length === 0) {
      failures.push(`chests[${i}]: buckets must be a non-empty array`);
    } else {
      for (const b of c.buckets) {
        if (!VALID_BUCKETS.has(b)) failures.push(`chests[${i}]: unknown bucket "${b}"`);
      }
    }
  });

  // Bucket stack caps
  if (preset.bucket_stack_caps && typeof preset.bucket_stack_caps === 'object') {
    for (const [bucket, cap] of Object.entries(preset.bucket_stack_caps)) {
      if (!VALID_BUCKETS.has(bucket)) failures.push(`bucket_stack_caps: unknown bucket "${bucket}"`);
      if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > 999)) {
        failures.push(`bucket_stack_caps.${bucket}: cap must be null or 1..999, got ${cap}`);
      }
    }
  }

  // Cross-check chest indices are unique
  const idxs = (preset.chests || []).map(c => c.index);
  const dupes = idxs.filter((v, i) => idxs.indexOf(v) !== i);
  if (dupes.length) failures.push(`chests: duplicate indices ${[...new Set(dupes)].join(',')}`);

  // Overflow chest must reference a valid index if overflow strategy uses one
  if (preset.overflow_strategy === 'spill_to_overflow_chest') {
    if (!Number.isInteger(preset.overflow_chest_index) || !idxs.includes(preset.overflow_chest_index)) {
      failures.push(`overflow_chest_index=${preset.overflow_chest_index} not in chests[].index when strategy=spill_to_overflow_chest`);
    }
  }

  // Source schema sanity
  const src = preset.sources || {};
  for (const k of ['chests','ships','vehicles']) {
    const v = src[k];
    if (v !== 'all' && v !== 'none' && !Array.isArray(v)) {
      failures.push(`sources.${k}: must be "all" | "none" | array, got ${JSON.stringify(v)}`);
    }
  }
  for (const k of ['freighter_inventory','freighter_cargo','exosuit_general','exosuit_cargo']) {
    if (typeof src[k] !== 'boolean') failures.push(`sources.${k}: must be boolean, got ${JSON.stringify(src[k])}`);
  }

  // Excluded ship seeds must look like hex
  for (const seed of preset.exclude_ships_by_seed || []) {
    if (typeof seed !== 'string' || !/^0x[0-9A-Fa-f]+$/.test(seed)) {
      failures.push(`exclude_ships_by_seed: "${seed}" is not a hex seed`);
    }
  }

  return failures;
}

const { byId, count } = loadTaxonomy();
console.log(`Loaded taxonomy: ${count} item IDs`);

const presets = loadPresetFiles();
console.log(`Loaded ${presets.length} preset(s) to verify\n`);

let totalFails = 0;
for (const { meta, path: p, data } of presets) {
  const fails = verifyPreset(data, byId);
  if (fails.length === 0) {
    console.log(`  ✓ ${meta.id.padEnd(20)} (${meta.label})`);
  } else {
    totalFails += fails.length;
    console.log(`  ✗ ${meta.id.padEnd(20)} (${meta.label})  — ${fails.length} failure(s):`);
    for (const f of fails) console.log(`      • ${f}`);
  }
}

console.log();
if (totalFails === 0) {
  console.log('All presets verified clean.');
  process.exit(0);
} else {
  console.log(`FAILED: ${totalFails} verification error(s) across ${presets.length} preset(s).`);
  process.exit(1);
}
