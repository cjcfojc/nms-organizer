// Cross-check: do we have a taxonomy entry for every item ID present in a real save?
// Walk every inventory slot, collect all distinct ^IDs, classify.
const fs = require('fs');

const save = JSON.parse(fs.readFileSync('save.json', 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync('data/taxonomy.json', 'utf8'));
const lookup = {};
for (const r of taxonomy.records) lookup[r.id] = r;

// Obfuscated keys (verified against mapping.json)
const K = {
  slots: ':No',           // Slots
  cls: 'WA4',             // StackSizeGroup wrapper
  clsName: 'rri',         // InventoryStackSizeGroup
  id: 'b2n',              // Id
  type: 'Vn8',            // Type wrapper
  typeVal: 'elv',         // InventoryType
  amount: '1o9',
};

// Find every inventory container (object with WA4.rri + :No array of slot-shaped entries),
// then iterate only those slots. Do NOT recurse into stats/milestones (gUR) or other b2n usages.
function isInventoryContainer(o) {
  return o && typeof o === 'object'
    && Array.isArray(o[K.slots])
    && o[K.cls] && typeof o[K.cls][K.clsName] === 'string';
}

const containers = [];
function walkForContainers(o, path) {
  if (!o || typeof o !== 'object') return;
  if (isInventoryContainer(o)) {
    containers.push({ path, container: o });
    return;
  }
  if (Array.isArray(o)) {
    o.forEach((v, i) => walkForContainers(v, path + '[' + i + ']'));
    return;
  }
  for (const k of Object.keys(o)) walkForContainers(o[k], path + '.' + k);
}
walkForContainers(save, '');
console.log(`inventory containers found: ${containers.length}`);

const seen = {};   // id (without ^) → { count, in_save_type, sample_path }
for (const { path, container } of containers) {
  for (const slot of container[K.slots]) {
    if (!slot || typeof slot !== 'object') continue;
    const rawId = slot[K.id];
    if (typeof rawId !== 'string' || rawId.length === 0) continue;
    const id = rawId.startsWith('^') ? rawId.slice(1) : rawId;
    const type = (slot[K.type] && slot[K.type][K.typeVal]) || '?';
    if (!seen[id]) seen[id] = { count: 0, in_save_type: type, sample_path: path };
    seen[id].count++;
  }
}

const ids = Object.keys(seen).sort();
console.log(`distinct item IDs in save: ${ids.length}`);

const matched = [];
const unmatched = [];
const proceduralLooking = [];
for (const id of ids) {
  if (lookup[id]) {
    matched.push({ id, in_save_type: seen[id].in_save_type, taxonomy: lookup[id] });
  } else if (id.includes('#') || /[\u0080-\uffff]/.test(id)) {
    // procedural items like ^U_X#NNNNN or garbled S-class names
    proceduralLooking.push(id);
  } else {
    unmatched.push(id);
  }
}

console.log(`matched: ${matched.length}`);
console.log(`procedural-looking (with # or non-ASCII): ${proceduralLooking.length}`);
console.log(`UNMATCHED non-procedural: ${unmatched.length}`);
if (unmatched.length) {
  console.log('Unmatched IDs (these will be flagged in UI):');
  for (const id of unmatched) console.log('  ', id, ' (×' + seen[id].count + ')', ' from', seen[id].sample_path.slice(0, 80));
}

// Type-mismatch check: does in_save InventoryType match taxonomy.type?
const mismatches = [];
for (const m of matched) {
  const s = m.in_save_type;
  const t = m.taxonomy.type;
  if (s === 'Substance' && t !== 'Substance') mismatches.push({ id: m.id, in_save: s, taxonomy: t });
  if (s === 'Product' && t !== 'Product') mismatches.push({ id: m.id, in_save: s, taxonomy: t });
}
for (const m of matched) m.taxonomy = { type: m.taxonomy.type, category: m.taxonomy.category, product_category: m.taxonomy.product_category };
if (mismatches.length) {
  console.log('\nType mismatches (in_save vs taxonomy):');
  for (const m of mismatches.slice(0, 20)) console.log('  ', m.id, m.in_save, '!=', m.taxonomy);
  if (mismatches.length > 20) console.log('  ... and', mismatches.length - 20, 'more');
}

// Show a small breakdown by category
console.log('\nMatched item breakdown by category:');
const catCount = {};
for (const m of matched) catCount[m.taxonomy.category || 'null'] = (catCount[m.taxonomy.category || 'null'] || 0) + 1;
for (const c of Object.keys(catCount).sort((a,b)=>catCount[b]-catCount[a])) console.log('  ', c.padEnd(20), catCount[c]);
