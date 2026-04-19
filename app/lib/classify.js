// Browser-side item classifier.
// Loads data/taxonomy.json + data/loc.json + data/icons.json once via fetch,
// then classify() / displayName() / iconUrl() are synchronous.

let taxonomy = null;       // parsed taxonomy.json
let byId = null;           // id → record lookup
let locEntries = null;     // localization key → English string
let iconManifest = null;   // parsed icons.json (may be null if not yet generated)
let loadPromise = null;

export function loadTaxonomy() {
  if (loadPromise) return loadPromise;
  // icons.json is optional — extract_icons.js may not have been run yet.
  const fetchRequired = (url) => fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); });
  const fetchOptional = (url) => fetch(url).then(r => r.ok ? r.json() : null).catch(() => null);

  loadPromise = Promise.all([
    fetchRequired('data/taxonomy.json'),
    fetchRequired('data/loc.json'),
    fetchOptional('data/icons.json'),
  ]).then(([taxData, locData, iconsData]) => {
    taxonomy = taxData;
    byId = {};
    for (const r of taxData.records) byId[r.id] = r;
    locEntries = locData.entries;
    iconManifest = iconsData;
  });
  return loadPromise;
}

// Resolve an item id to a fully-qualified PNG URL, or null when no icon exists.
// Procedural items (^MEAL_BREAD#12345) try the base id so the template icon shows.
// Legacy ids fall back to their post-conversion id.
export function iconUrl(rawId) {
  if (!iconManifest || !iconManifest.icons) return null;
  const id = normalizeId(rawId);
  if (!id) return null;

  let rel = iconManifest.icons[id];
  if (!rel && id.includes('#'))                rel = iconManifest.icons[id.split('#')[0]];
  if (!rel && taxonomy?.legacy_map?.[id])      rel = iconManifest.icons[taxonomy.legacy_map[id].convert_to];

  if (!rel) return null;
  const prefix = iconManifest.path_prefix || 'icons';
  return `assets/${prefix}/${rel}`;
}

// All taxonomy item IDs as a Set — used by preset validation to flag any
// reference to an item the loaded taxonomy doesn't recognize.
export function getKnownIds() {
  if (!byId) return new Set();
  return new Set(Object.keys(byId));
}

export function getStats() {
  if (!taxonomy) return null;
  return {
    total_records: taxonomy.records.length,
    by_type: taxonomy.stats.by_type,
    libmbin_version: taxonomy.source_libmbin_version,
    loc_entries: locEntries ? Object.keys(locEntries).length : 0,
  };
}

// Look up a localization key → English text (titlecased for display).
// Returns null if no translation found.
export function locText(key) {
  if (!key || !locEntries) return null;
  const v = locEntries[key];
  if (!v) return null;
  // NMS strings are usually all-caps; titlecase for nicer display
  return titleCase(v);
}

function titleCase(s) {
  return s.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Get a friendly display name for an item id, falling back through:
//   1. taxonomy.name_key → loc.json English  (fully resolved name)
//   2. procedural pattern → generic label    (e.g. "Procedural Module")
//   3. raw id without ^ prefix
export function displayName(rawId, classification) {
  const id = normalizeId(rawId);
  if (!id) return '';
  const rec = byId && byId[id];
  if (rec && rec.name_key) {
    const t = locText(rec.name_key);
    if (t) return t;
  }
  // Procedural items: show a category hint based on their id pattern
  if (classification && classification.procedural) {
    if (classification.procedural === 'ProceduralWithSeed')      return 'Procedural Item';
    if (classification.procedural === 'ProceduralUpgradeGarbled') return 'Procedural Module';
    if (classification.procedural === 'UpgradeModuleX')          return inferProcLabel(id) + ' ⓧ';
    if (classification.procedural === 'UpgradeModule')           return inferProcLabel(id);
  }
  return id;
}

function inferProcLabel(id) {
  // Strip U_ prefix and trailing tier digit; map common stems to friendly names.
  let stem = id.replace(/^U_/, '').replace(/[1-4X]$/, '');
  // Common stems → readable
  const STEMS = {
    SCANNER: 'Scanner Module', SHIELDBOOST: 'Shield Module', JETBOOST: 'Jetpack Module',
    CANNON: 'Boltcaster Module', BOLT: 'Boltcaster Module', GRENADE: 'Grenade Module',
    LAUNCH: 'Launch Module', SHIPLAS: 'Ship Laser Module', SHIPSHOT: 'Photon Cannon Module',
    SHIPMINI: 'Mining Beam Module', SHIPBLOB: 'Positron Module', SHIPHIT: 'Infraknife Module',
    EXOLAS: 'Exocraft Mining Module', EXOGUN: 'Exocraft Cannon Module', EXO_ENG: 'Exocraft Engine Module',
    MECHGUN: 'Minotaur Cannon', MECH_ENG: 'Minotaur Engine',
    ENERGY: 'Life Support Module', RAD: 'Hazard Module', UNW: 'Hazard Module',
    SMG: 'Pulse Spitter Module', RAIL: 'Scatter Blaster Module',
  };
  return STEMS[stem] || `${stem} Module`;
}

// Strip the leading ^ NMS uses on save-file item IDs
export function normalizeId(rawId) {
  if (typeof rawId !== 'string') return null;
  return rawId.startsWith('^') ? rawId.slice(1) : rawId;
}

// Procedural ID pattern detection — these are generated, not in static tables.
function detectProcedural(id) {
  if (id.includes('#'))                        return 'ProceduralWithSeed';     // ^MEAL_X#12345
  if (/[\u0080-\uffff]/.test(id))              return 'ProceduralUpgradeGarbled'; // S/X-class with garbled name
  if (/^U_[A-Z_]+X$/.test(id))                 return 'UpgradeModuleX';         // X-class
  if (/^U_[A-Z_]+[1-4]$/.test(id))             return 'UpgradeModule';          // C/B/A/S tiers
  return null;
}

// Map authoritative table fields → high-level classification bucket.
// Each rule cites the source field that drove the decision (returned in `reason`).
function classifyKnown(rec) {
  if (rec.type === 'Substance') {
    const map = {
      Fuel:      'Raw_Local',
      Earth:     'Raw_Local',
      Metal:     'Raw_Stellar',
      Catalyst:  'Raw_Atmospheric',
      Stellar:   'Raw_Stellar',
      Exotic:    'Raw_Exotic',
      Flora:     'Raw_Exotic',
      Special:   'Raw_Exotic',
    };
    return { classification: map[rec.category] || 'Raw_Exotic', reason: `SubstanceCategory=${rec.category}` };
  }

  if (rec.type === 'Product') {
    if (rec.legality === 'Illegal') return { classification: 'Contraband', reason: 'Legality=Illegal' };
    if (rec.is_techbox)             return { classification: 'Tech_Modules', reason: 'IsTechbox=true' };
    const pc = rec.product_category;
    if (pc === 'Component')         return { classification: 'Components', reason: 'ProductCategory=Component' };
    if (pc === 'Tradeable') {
      if (rec.trade_category && rec.trade_category !== 'None')
        return { classification: 'Trade', reason: `TradeCategory=${rec.trade_category}` };
      return { classification: 'Components', reason: 'ProductCategory=Tradeable + TradeCategory=None (alloy/refined)' };
    }
    if (pc === 'Curiosity') {
      // The game's WikiCategory field distinguishes genuine collectibles from charts/tokens.
      // Verified: items where WikiCategory="Tech" are NAV_DATA, ACCESS1/2, FRIG_TOKEN, BP_SALVAGE,
      // ALIEN_TECHBOX, etc. — functionally distinct from Storm Crystal / Vent Gem (WikiCategory="Curio").
      if (rec.wiki_category === 'Tech') return { classification: 'Salvage_Charts', reason: 'ProductCategory=Curiosity + WikiCategory=Tech' };
      return { classification: 'Curios', reason: 'ProductCategory=Curiosity' };
    }
    if (pc === 'Consumable') {
      if (rec.cooking_ingredient)   return { classification: 'Cooking', reason: 'ProductCategory=Consumable + CookingIngredient=true' };
      return { classification: 'Tech_Modules', reason: 'ProductCategory=Consumable + non-cooking (upgrade/charge/charts)' };
    }
    if (pc === 'BuildingPart')      return { classification: 'Building', reason: 'ProductCategory=BuildingPart' };
    if (pc === 'CustomisationPart') return { classification: 'Cosmetics', reason: 'ProductCategory=CustomisationPart' };
    if (pc === 'Fish')              return { classification: 'Cooking', reason: 'ProductCategory=Fish' };
    if (pc === 'CreatureEgg')       return { classification: 'Curios', reason: 'ProductCategory=CreatureEgg' };
    if (pc === 'Emote')             return { classification: 'Cosmetics', reason: 'ProductCategory=Emote' };
    if (pc === 'ExhibitBone')       return { classification: 'Curios', reason: 'ProductCategory=ExhibitBone' };
    return { classification: 'Uncategorized', reason: `Product with unmapped ProductCategory=${pc}` };
  }

  if (rec.type === 'Technology' || rec.type === 'ProceduralTechnology') {
    return { classification: 'InstalledTech', reason: 'type=Technology — never auto-organize' };
  }

  return { classification: 'Uncategorized', reason: `unrecognized record type=${rec.type}` };
}

export function classify(rawId, inSaveType) {
  const id = normalizeId(rawId);
  if (!id) return { known: false, classification: 'Uncategorized', reason: 'empty id' };
  if (!byId) throw new Error('taxonomy not loaded — call loadTaxonomy() first');

  const rec = byId[id];
  if (rec) {
    if (rec.orphan) {
      return {
        known: true, orphan: true, id, type: rec.type,
        classification: 'Uncategorized',
        reason: 'orphan reference (rewardtable mentions as Product but no detailed table data)',
      };
    }
    const c = classifyKnown(rec);
    return {
      known: true, id, type: rec.type, name_key: rec.name_key,
      category: rec.category, product_category: rec.product_category,
      trade_category: rec.trade_category, wiki_category: rec.wiki_category,
      legality: rec.legality, rarity: rec.rarity, base_value: rec.base_value,
      stack_multiplier: rec.stack_multiplier, source_file: rec.source_file,
      ...c,
    };
  }

  const proc = detectProcedural(id);
  if (proc) {
    return {
      known: true, procedural: proc, id, type: inSaveType || 'Product',
      classification: 'Tech_Modules',
      reason: `procedural pattern: ${proc}`,
    };
  }

  const legacy = taxonomy.legacy_map && taxonomy.legacy_map[id];
  if (legacy) {
    const targetRec = byId[legacy.convert_to];
    if (targetRec) {
      const c = classifyKnown(targetRec);
      return { known: true, id, legacy: true, converts_to: legacy.convert_to, type: targetRec.type, ...c };
    }
  }

  return { known: false, id, in_save_type: inSaveType, classification: 'Uncategorized', reason: 'no match in any extracted table or pattern' };
}
