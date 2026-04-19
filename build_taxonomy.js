// Build data/taxonomy.json from NMS GC*Table.MXML files.
// Output schema (one record per item):
//   {
//     id: "OXYGEN",                 // bare item id (no leading ^)
//     type: "Substance" | "Product" | "Technology" | "ProceduralTechnology",
//     name_key: "UI_AIR1_NAME",     // localization key (display name not resolved here)
//     category: "Fuel",             // SubstanceCategory (legacy, present on both subs and prods)
//     product_category: "Component", // Type.ProductCategory (products only)
//     trade_category: "Commodity",  // None|Commodity|Energy|...
//     wiki_category: "Crafting",    // Crafting|Curio|Trade|Cooking|Tech|NotEnabled
//     legality: "Legal" | "Illegal",
//     rarity: "Common" | "Uncommon" | "Rare",
//     base_value: 34,
//     stack_multiplier: 1,
//     consumable: false,
//     cooking_ingredient: false,
//     is_techbox: false,
//     source_file: "nms_reality_gcsubstancetable.MXML"   // citation
//   }
//
// Sources cited per record so future maintainers can verify against the MBIN.

const fs = require('fs');
const path = require('path');
const { loadTable } = require('./parse_mxml');

const MXML_DIR = 'extracted/EXTRACTED/metadata/reality/tables';
const OUT = 'data/taxonomy.json';

// Primary item-data tables. Each item gets a full classified record.
const sources = [
  { file: 'nms_reality_gcsubstancetable.MXML', type: 'Substance' },
  { file: 'nms_reality_gcproducttable.MXML', type: 'Product' },
  { file: 'nms_reality_gctechnologytable.MXML', type: 'Technology' },
  { file: 'nms_reality_gcproceduraltechnologytable.MXML', type: 'ProceduralTechnology' },
];

const records = [];
const stats = { total: 0, by_type: {}, by_category: {}, by_product_category: {}, illegal: 0, cooking: 0 };

for (const { file, type } of sources) {
  const fullPath = path.join(MXML_DIR, file);
  if (!fs.existsSync(fullPath)) {
    console.warn(`SKIP missing: ${fullPath}`);
    continue;
  }
  const items = loadTable(fullPath);
  console.log(`${file}: ${items.length} ${type}s`);
  stats.by_type[type] = items.length;

  for (const it of items) {
    const id = it._id || it.ID;
    if (!id) continue;
    // Icon path comes from the nested Icon.Filename field (TkTextureResource wrapper).
    // Stored uppercase / forward-slash for consistency with how the pak indexes them.
    let iconPath = null;
    if (it.Icon) {
      const fname = (typeof it.Icon === 'string') ? it.Icon : (it.Icon.Filename || null);
      if (fname && typeof fname === 'string') iconPath = fname.toUpperCase().replace(/\\/g, '/');
    }

    const rec = {
      id,
      type,
      name_key: it.Name || null,
      category: it.Category || null,
      product_category: it.Type || null,           // for Products this is ProductCategory
      trade_category: it.TradeCategory || null,
      wiki_category: it.WikiCategory || null,
      legality: it.Legality || 'Legal',
      rarity: it.Rarity || null,
      base_value: it.BaseValue ? Number(it.BaseValue) : null,
      stack_multiplier: it.StackMultiplier ? Number(it.StackMultiplier) : null,
      consumable: it.Consumable === 'true',
      cooking_ingredient: it.CookingIngredient === 'true',
      is_techbox: it.IsTechbox === 'true',
      icon_path: iconPath,                          // e.g. "TEXTURES/UI/FRONTEND/ICONS/U4SUBSTANCES/SUBSTANCE.FUEL.1.DDS"
      source_file: file,
    };
    records.push(rec);
    stats.total++;
    if (rec.category) stats.by_category[rec.category] = (stats.by_category[rec.category] || 0) + 1;
    if (rec.product_category) stats.by_product_category[rec.product_category] = (stats.by_product_category[rec.product_category] || 0) + 1;
    if (rec.legality === 'Illegal') stats.illegal++;
    if (rec.cooking_ingredient) stats.cooking++;
  }
}

// Supplemental: legacy item conversion table (old IDs that auto-convert to new IDs in-game).
// Useful if a player's save has legacy IDs — we know the conversion target.
const legacyMap = {};
const legacyPath = path.join(MXML_DIR, 'legacyitemtable.MXML');
if (fs.existsSync(legacyPath)) {
  const items = loadTable(legacyPath);
  for (const it of items) {
    const id = it._id || it.ID;
    if (!id) continue;
    legacyMap[id] = {
      convert_to: it.ConvertID,
      convert_ratio: it.ConvertRatio ? Number(it.ConvertRatio) : 1,
    };
  }
  console.log(`legacyitemtable.MXML: ${Object.keys(legacyMap).length} legacy mappings`);
}

// Supplemental: well-known orphan IDs referenced in rewardtable as MultiItemRewardType=Product
// but whose GcProductData definitions weren't in NMSARC.Precache.pak. Likely stored in
// defaultreality.mbin or a DLC pak. For the organizer they're flagged Uncategorized — we
// expose their existence so the UI can label them "known orphan" rather than "unknown".
const rewardOrphanPath = path.join(MXML_DIR, 'rewardtable.MXML');
const rewardOrphans = new Set();
if (fs.existsSync(rewardOrphanPath)) {
  const text = fs.readFileSync(rewardOrphanPath, 'utf8');
  // Matches: <Property name="Items" value="GcMultiSpecificItemEntry" _id="X"> ... <Property name="MultiItemRewardType" value="Product" /> ... <Property name="Id" value="X" />
  // Cheap regex: find ids whose entry contains MultiItemRewardType=Product within ~250 chars after
  const re = /_id="([A-Z0-9_]+)"[^]{0,300}?MultiItemRewardType"\s+value="Product"/g;
  let m;
  while ((m = re.exec(text)) !== null) rewardOrphans.add(m[1]);
}
const haveIds = new Set(records.map(r => r.id));
let orphanCount = 0;
for (const id of rewardOrphans) {
  if (!haveIds.has(id)) {
    records.push({
      id,
      type: 'Product',
      name_key: null,
      category: null,
      product_category: null,
      trade_category: null,
      wiki_category: null,
      legality: 'Legal',
      rarity: null,
      base_value: null,
      stack_multiplier: null,
      consumable: false,
      cooking_ingredient: false,
      is_techbox: false,
      source_file: 'rewardtable.MXML (orphan ref)',
      orphan: true,                        // signals "known to exist as Product, no detailed data"
    });
    orphanCount++;
    stats.total++;
  }
}
console.log(`rewardtable.MXML: ${orphanCount} orphan Product IDs added (no detailed data)`);

// Build a fast lookup: id → record (case-sensitive, no '^' prefix)
const lookup = {};
for (const r of records) lookup[r.id] = r;

// Detect duplicate ids (substance and product can collide — flag if so)
const idCounts = {};
for (const r of records) idCounts[r.id] = (idCounts[r.id] || 0) + 1;
const dupes = Object.entries(idCounts).filter(([, n]) => n > 1);

const taxonomy = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source_libmbin_version: '6.33.0.2',
  source_files: [...sources.map(s => s.file), 'legacyitemtable.MXML', 'rewardtable.MXML'],
  stats,
  duplicate_ids: dupes.map(([id, n]) => ({ id, count: n })),
  legacy_map: legacyMap,
  records,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(taxonomy, null, 2));
console.log(`\nwrote ${records.length} records to ${OUT}`);
console.log(`stats:`, JSON.stringify(stats, null, 2));
if (dupes.length) console.log(`duplicate IDs (collision between tables):`, dupes.slice(0, 10));
