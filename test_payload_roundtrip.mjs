// Round-trip the real save payload through parsePayload + serializePayload.
// SUCCESS CRITERION: serialized output is byte-identical to the parsed input
// (after stripping trailing nulls / whitespace from the input that aren't
// part of the JSON document).
//
// Save discovery:
//   CLI:  node test_payload_roundtrip.mjs /path/to/save.hg
//   ENV:  NMS_TEST_SAVE=/path/to/save.hg
//   Local: drop a save.hg into ./test_save/<any-subfolder>/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { parsePayload, serializePayload, Float } = await import('./app/lib/payload.js');
const { decodeSaveBytes }                       = await import('./app/lib/codec.js');

function findSave() {
  if (process.argv[2] && fs.existsSync(process.argv[2])) return process.argv[2];
  if (process.env.NMS_TEST_SAVE && fs.existsSync(process.env.NMS_TEST_SAVE)) return process.env.NMS_TEST_SAVE;
  const root = path.join(__dirname, 'test_save');
  if (fs.existsSync(root)) {
    for (const sub of fs.readdirSync(root)) {
      const p = path.join(root, sub, 'save.hg');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const SAVE = findSave();
if (!SAVE) {
  console.error(`No save.hg found. CLI arg, NMS_TEST_SAVE env, or ./test_save/<sub>/save.hg.`);
  process.exit(1);
}
console.log(`reading ${SAVE}`);
const bytes = new Uint8Array(fs.readFileSync(SAVE));
console.log(`  ${bytes.length.toLocaleString()} bytes raw save`);

const payload = decodeSaveBytes(bytes);
console.log(`  ${payload.length.toLocaleString()} bytes payload (LZ4-decompressed)`);

let text = new TextDecoder('utf-8').decode(payload);
// Strip trailing nulls / whitespace that NMS's writer pads with — those are
// not part of the JSON document.
const stripped = text.replace(/\u0000+$/g, '').replace(/\s+$/g, '');
console.log(`  ${stripped.length.toLocaleString()} bytes payload after stripping trailing pad`);
console.log(`  pad bytes stripped: ${text.length - stripped.length}`);

console.log('\nparsing...');
const t0 = performance.now();
const obj = parsePayload(stripped);
console.log(`  parsed in ${(performance.now() - t0).toFixed(0)}ms`);

console.log('serializing...');
const t1 = performance.now();
const out = serializePayload(obj);
console.log(`  serialized in ${(performance.now() - t1).toFixed(0)}ms`);
console.log(`  output: ${out.length.toLocaleString()} bytes`);

if (out === stripped) {
  console.log('\n✓✓ BYTE-IDENTICAL ROUND-TRIP — payload.js is correct on this save.');
  process.exit(0);
}

// Find first difference
console.log('\n✗ MISMATCH — investigating first difference...');
const diffLen = Math.min(stripped.length, out.length);
let firstDiff = -1;
for (let i = 0; i < diffLen; i++) {
  if (stripped[i] !== out[i]) { firstDiff = i; break; }
}
if (firstDiff < 0) {
  console.log(`  no char-level diff in first ${diffLen} chars; lengths differ: orig=${stripped.length} out=${out.length}`);
  console.log(`  trailing of orig: ${JSON.stringify(stripped.slice(diffLen, diffLen + 80))}`);
  console.log(`  trailing of out : ${JSON.stringify(out.slice(diffLen, diffLen + 80))}`);
} else {
  const ctxStart = Math.max(0, firstDiff - 60);
  const ctxEnd   = Math.min(stripped.length, firstDiff + 60);
  console.log(`  first diff at offset ${firstDiff.toLocaleString()}:`);
  console.log(`    orig: ${JSON.stringify(stripped.slice(ctxStart, ctxEnd))}`);
  console.log(`    out : ${JSON.stringify(out.slice(ctxStart, ctxEnd))}`);
  console.log(`    char at diff: orig=${JSON.stringify(stripped[firstDiff])} (0x${stripped.charCodeAt(firstDiff).toString(16)}) vs out=${JSON.stringify(out[firstDiff])} (0x${out.charCodeAt(firstDiff).toString(16)})`);
}

// Count where in the file the diff is (% through)
if (firstDiff >= 0) {
  console.log(`  diff is at ${(100 * firstDiff / stripped.length).toFixed(2)}% through the payload`);
}

process.exit(1);
