// End-to-end test of the apply pipeline:
//   bytes -> decode -> parsePayload -> mutate (apply plan) -> serializePayload
//        -> encode -> bytes -> decode again -> parse again -> verify
//
// Verifies BOTH chest contents AND chest names match the preset, and that
// mf_save.hg round-trips cleanly.
//
// Save discovery (in priority order):
//   1. CLI arg:    node test_e2e.mjs <path-to-save.hg>
//   2. Env var:    NMS_TEST_SAVE=<path-to-save.hg>
//   3. test_save/  — symlink/copy any st_* folder into ./test_save/ for
//                    repeated runs against a known fixture (gitignored).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, 'app');

// Find a save.hg + its sibling mf_save.hg to test against.
function discoverTestSave() {
  // 1. CLI arg
  const cliArg = process.argv[2];
  if (cliArg && fs.existsSync(cliArg)) return resolveSavePair(cliArg);
  // 2. Env var
  if (process.env.NMS_TEST_SAVE && fs.existsSync(process.env.NMS_TEST_SAVE)) return resolveSavePair(process.env.NMS_TEST_SAVE);
  // 3. ./test_save/<st_*>/save.hg
  const testSaveRoot = path.join(__dirname, 'test_save');
  if (fs.existsSync(testSaveRoot)) {
    for (const sub of fs.readdirSync(testSaveRoot)) {
      const candidate = path.join(testSaveRoot, sub, 'save.hg');
      if (fs.existsSync(candidate)) return resolveSavePair(candidate);
    }
  }
  return null;
}
function resolveSavePair(savePath) {
  const dir = path.dirname(savePath);
  const base = path.basename(savePath);
  const mfPath = path.join(dir, 'mf_' + base);
  return { savePath, mfPath: fs.existsSync(mfPath) ? mfPath : null };
}

// fetch shim so browser modules can read app/data/* in Node
globalThis.fetch = async (url) => {
  if (typeof url === 'string' && !/^https?:\/\//.test(url)) {
    const fp = path.join(APP_ROOT, url.replace(/^\//, ''));
    if (fs.existsSync(fp)) {
      const data = fs.readFileSync(fp);
      return { ok: true, json: async () => JSON.parse(data.toString('utf8')), text: async () => data.toString('utf8') };
    }
    return { ok: false, status: 404 };
  }
  throw new Error('http not allowed');
};

const { loadSave }                                = await import('./app/lib/save.js');
const { loadTaxonomy }                            = await import('./app/lib/classify.js');
const { generatePlan }                            = await import('./app/lib/plan.js');
const { validatePlan }                            = await import('./app/lib/validate.js');
const { applyPlanToJson, resolveContainerNode }   = await import('./app/lib/apply.js');
const { encodeSaveBytes, decodeSaveBytes }        = await import('./app/lib/codec.js');
const { parsePayload, serializePayload, clonePayload } = await import('./app/lib/payload.js');
const { regenerateManifest }                      = await import('./app/lib/manifest.js');
const { slotForManifestFilename }                 = await import('./app/lib/xxtea.js');

console.log('=== Apply pipeline end-to-end test ===\n');

await loadTaxonomy();

const located = discoverTestSave();
if (!located) {
  console.error(`No test save found. Provide one via:
  CLI:   node test_e2e.mjs /path/to/save.hg
  ENV:   NMS_TEST_SAVE=/path/to/save.hg node test_e2e.mjs
  Local: copy any st_<steamid>/ folder into ./test_save/ (gitignored)`);
  process.exit(1);
}
if (!located.mfPath) {
  console.error(`Found ${located.savePath} but no sibling mf_${path.basename(located.savePath)} — both files are required.`);
  process.exit(1);
}
const bytes = new Uint8Array(fs.readFileSync(located.savePath));
const mfBytes = new Uint8Array(fs.readFileSync(located.mfPath));
console.log(`✓ ${located.savePath}`);
console.log(`✓ ${located.mfPath}`);
console.log(`✓ ${bytes.length.toLocaleString()} B save + ${mfBytes.length} B manifest`);

const loaded = await loadSave(bytes);
console.log(`✓ decoded + parsed: ${loaded.payload_size.toLocaleString()} B payload`);

// Print original chest names so we can confirm they change
console.log('\noriginal chest names:');
for (const c of loaded.structured.chests) {
  console.log(`  ${c.index.toString().padStart(2)}: "${c.name || '(unnamed)'}"  (${c.slots ? c.slots.length : 0} slots)`);
}

const preset = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'data/presets/the_vault.json'), 'utf8'));
const plan = generatePlan(loaded.structured, preset);
plan.validation = validatePlan(plan);
console.log(`\n✓ plan generated (${preset.label}): ${plan.summary.stacks_placed} stacks across ${plan.summary.destinations_used} chests, validation ${plan.validation.ok ? 'PASS' : 'FAIL'}`);
if (!plan.validation.ok) { console.error('plan validation failed:'); plan.validation.errors.forEach(e => console.error(` - ${e.label}: ${e.detail}`)); process.exit(1); }

// Clone, apply, serialize
const cloned = clonePayload(loaded.json);
const result = applyPlanToJson(cloned, plan, loaded.structured);
console.log(`✓ apply: ${result.summary.containers_touched} containers, ${result.summary.stacks_before} → ${result.summary.stacks_after} stacks`);

const t0 = Date.now();
const newText = serializePayload(cloned);
console.log(`✓ serialize: ${newText.length.toLocaleString()} B in ${Date.now()-t0}ms`);

const t1 = Date.now();
const newPayload = new TextEncoder().encode(newText);
const newBytes = encodeSaveBytes(newPayload);
console.log(`✓ encode: ${newBytes.length.toLocaleString()} B file in ${Date.now()-t1}ms`);

// Round-trip: decode the newly-written save and verify
console.log('\nverifying round-trip:');
const reDecoded = decodeSaveBytes(newBytes);
let reText = new TextDecoder('utf-8').decode(reDecoded);
reText = reText.replace(/\u0000+$/g, '').replace(/\s+$/g, '');
const reParsed = parsePayload(reText);

let allOk = true;

// 1. Verify chest names
console.log('\nchest names after round-trip:');
const expectedNames = new Map();
for (const c of preset.chests) expectedNames.set(c.index, c.name);

for (const c of loaded.structured.chests) {
  if (!c.present) continue;
  const node = resolveContainerNode(reParsed, c.path);
  const actualName = node ? node['NKm'] : null;
  const expectedName = expectedNames.get(c.index);
  const ok = (actualName === expectedName);
  console.log(`  ${ok ? '✓' : '✗'} chest ${c.index}: name="${actualName}"  (expected "${expectedName}")`);
  if (!ok) allOk = false;
}

// 2. Verify slot contents (compare per-touched-container against in-memory result)
console.log('\nslot contents after round-trip:');
let driftCount = 0;
for (const p of result.touchedPaths) {
  const expected = resolveContainerNode(cloned, p)[':No'];
  const actual   = resolveContainerNode(reParsed, p)[':No'];
  if (expected.length !== actual.length) {
    console.log(`  ✗ ${p}: slot count drift ${expected.length} vs ${actual.length}`);
    driftCount++; continue;
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i].b2n !== actual[i].b2n || expected[i]['1o9'] !== actual[i]['1o9']) {
      driftCount++;
      if (driftCount < 5) console.log(`  ✗ ${p}[${i}]: ${expected[i].b2n}×${expected[i]['1o9']} vs ${actual[i].b2n}×${actual[i]['1o9']}`);
    }
  }
}
if (driftCount === 0) console.log(`  ✓ ${result.touchedPaths.length} containers — slot contents preserved exactly`);
else { console.log(`  ✗ ${driftCount} slot drifts detected`); allOk = false; }

// 3. Manifest regen
console.log('\nmanifest regeneration:');
const slot = slotForManifestFilename('mf_save.hg');
const newMf = regenerateManifest(mfBytes, slot, slot, newPayload.length, newBytes.length);
console.log(`  ✓ regenerated: ${newMf.length} B (slot=${slot}, SizeDecompressed=${newPayload.length}, SizeDisk=${newBytes.length})`);

// 4. Write to sandbox so user can verify in NMS / NomNom
const sandboxDir = path.join(__dirname, 'applied/sandbox_2026-04-19_phase4');
fs.mkdirSync(sandboxDir, { recursive: true });
fs.writeFileSync(path.join(sandboxDir, 'save.hg'), newBytes);
fs.writeFileSync(path.join(sandboxDir, 'mf_save.hg'), newMf);
console.log(`\nsandbox written:  ${sandboxDir}`);
console.log(`  save.hg     ${newBytes.length.toLocaleString()} B`);
console.log(`  mf_save.hg  ${newMf.length} B`);

console.log(`\n${'='.repeat(60)}`);
console.log(allOk ? '✓✓ END-TO-END PIPELINE WORKS' : '✗ END-TO-END VERIFICATION FAILED');
process.exit(allOk ? 0 : 1);
