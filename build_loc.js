// Parse NMS_LOC*_ENGLISH.MXML files into data/loc.json (key → english display string).
// Uses targeted regex (one entry has 17 language fields; we want only _id + English).
//
// Sources (extracted from NMSARC.MetadataEtc.pak):
//   extracted/EXTRA/LOC/language/nms_loc{1,4,5,6,7,8,9}_english.MXML
//
// Output: data/loc.json shape:
//   { schema_version: 1, source_libmbin_version: "...", entries: { KEY: "English text", ... } }

const fs = require('fs');
const path = require('path');

const SRC_DIR = 'extracted/EXTRA/LOC/language';
const FILES = ['nms_loc1_english.MXML','nms_loc4_english.MXML','nms_loc5_english.MXML',
               'nms_loc6_english.MXML','nms_loc7_english.MXML','nms_loc8_english.MXML','nms_loc9_english.MXML'];
const OUT = 'data/loc.json';

// Match each TkLocalisationEntry block by its opening tag and the immediately-following English property.
// Pattern: <Property name="Table" value="TkLocalisationEntry" _id="KEY">  ...  <Property name="English" value="VALUE" />
const RX = /<Property\s+name="Table"\s+value="TkLocalisationEntry"\s+_id="([^"]+)">[\s\S]{0,400}?<Property\s+name="English"\s+value="([^"]*)"/g;

// Decode common XML entities + strip a few NMS inline-icon tags that aren't useful in plain text.
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
function stripInlineIcons(s) {
  // NMS uses tags like <IMG>SLASH<>, <PICTURE>...<>, <SIZE=...>...</SIZE>, <COLOR=...>...</>
  return s
    .replace(/<IMG>[^<]*<>/g, '')
    .replace(/<PICTURE>[^<]*<>/g, '')
    .replace(/<SIZE=[^>]*>/g, '')
    .replace(/<\/SIZE>/g, '')
    .replace(/<COLOR=[^>]*>/g, '')
    .replace(/<\/COLOR>/g, '')
    .replace(/<\/?>/g, '')
    .trim();
}

const entries = {};
const collisions = [];
let totalScanned = 0;
let libmbin = null;

for (const file of FILES) {
  const fullPath = path.join(SRC_DIR, file);
  if (!fs.existsSync(fullPath)) { console.warn(`SKIP missing ${fullPath}`); continue; }
  const text = fs.readFileSync(fullPath, 'utf8');
  if (!libmbin) {
    const m = text.match(/MBINCompiler version \(([^)]+)\)/);
    if (m) libmbin = m[1];
  }
  let count = 0;
  for (const m of text.matchAll(RX)) {
    const id = m[1];
    const value = stripInlineIcons(decodeEntities(m[2]));
    if (!value) continue;
    if (entries[id] && entries[id] !== value) collisions.push({ id, prev: entries[id], next: value, file });
    entries[id] = value;
    count++;
  }
  totalScanned += count;
  console.log(`${file}: ${count} entries scanned`);
}

console.log(`\nTotal entries: ${Object.keys(entries).length} unique (${totalScanned} scanned, ${collisions.length} collisions resolved last-wins)`);

const out = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source_libmbin_version: libmbin,
  source_files: FILES,
  entry_count: Object.keys(entries).length,
  entries,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`wrote ${OUT}`);

// Spot-check against keys we know from taxonomy
console.log('\nSpot checks (sample taxonomy name_keys):');
for (const k of ['UI_AIR1_NAME','UI_LAND1_NAME','UI_SAND1_NAME','UI_SUNGOLD_NAME','UI_GREEN2_NAME','UI_HEXITE_NAME','UI_TOXIC1_NAME','UI_RED2_NAME','U_SCANNERX_NAME','U_SHIELDBOOSTX_NAME','UI_GAS_3_NAME','CASING_NAME','NANOTUBES_NAME']) {
  console.log(`  ${k.padEnd(28)} → ${entries[k] || '(not found)'}`);
}
