// Verify manifest.js: regenerate a manifest with new size fields, then decrypt
// it again and confirm:
//   - Magic is still 0xEEEEEEBE
//   - SizeDecompressed / SizeDisk / Timestamp are the new values
//   - Every OTHER byte of the plaintext matches the original verbatim
//
// Save folder discovery (priority): NMS_DIR env var → CLI arg → auto-detect.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { regenerateManifest } from './app/lib/manifest.js';
import { xxteaDecrypt, deriveManifestKey, iterationsForLength, META_HEADER, slotForManifestFilename } from './app/lib/xxtea.js';

function findNmsDir() {
  if (process.env.NMS_DIR && fs.existsSync(process.env.NMS_DIR)) return process.env.NMS_DIR;
  if (process.argv[2] && fs.existsSync(process.argv[2])) return process.argv[2];
  // Auto-detect: scan default NMS root for the first st_<steamid> subfolder
  const root = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'HelloGames', 'NMS')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'HelloGames', 'NMS')
      : path.join(os.homedir(), '.local/share/Steam/steamapps/compatdata/275850/pfx/drive_c/users/steamuser/AppData/Roaming/HelloGames/NMS');
  if (!fs.existsSync(root)) return null;
  const sub = fs.readdirSync(root).find(n => /^st_\d+$/.test(n));
  return sub ? path.join(root, sub) : null;
}

const NMS_DIR = findNmsDir();
if (!NMS_DIR) {
  console.error(`No NMS save folder found. Provide via:
  ENV: NMS_DIR=/path/to/st_<steamid> node test_manifest.mjs
  CLI: node test_manifest.mjs /path/to/st_<steamid>`);
  process.exit(1);
}
console.log(`testing manifests in: ${NMS_DIR}\n`);

const FILES = ['mf_save.hg', 'mf_save2.hg', 'mf_save3.hg', 'mf_save4.hg', 'mf_save5.hg', 'mf_save6.hg', 'mf_accountdata.hg'];

const OFF_SD = 0x038, OFF_SK = 0x03C, OFF_TS = 0x164;

let allPass = true;

for (const name of FILES) {
  const fp = `${NMS_DIR}/${name}`;
  if (!fs.existsSync(fp)) continue;

  const orig = new Uint8Array(fs.readFileSync(fp));
  const slot = slotForManifestFilename(name);
  const key  = deriveManifestKey(slot);
  const iters = iterationsForLength(orig.length);

  console.log(`\n=== ${name} (slot=${slot}, ${orig.length} bytes) ===`);

  // Decrypt original to capture baseline plaintext
  const origPlain = xxteaDecrypt(orig, key, iters);
  const origDv = new DataView(origPlain.buffer);
  const origSD = origDv.getUint32(OFF_SD, true);
  const origSK = origDv.getUint32(OFF_SK, true);
  const origTS = origDv.getUint32(OFF_TS, true);
  console.log(`  original SizeDecompressed=${origSD.toLocaleString()}  SizeDisk=${origSK.toLocaleString()}  ts=${origTS}`);

  // Pretend we wrote a save with different sizes
  const newSD = origSD + 17;          // arbitrary delta
  const newSK = origSK + 23;
  const newTS = origTS + 100;

  const newCipher = regenerateManifest(orig, slot, slot, newSD, newSK, newTS);
  if (newCipher.length !== orig.length) {
    console.log(`  ✗ length differs: ${newCipher.length} vs ${orig.length}`);
    allPass = false;
    continue;
  }

  // Decrypt the new manifest with the same key
  const newPlain = xxteaDecrypt(newCipher, key, iters);
  const newDv = new DataView(newPlain.buffer);

  if (newDv.getUint32(0, true) !== META_HEADER) {
    console.log(`  ✗ new manifest magic mismatch: 0x${newDv.getUint32(0, true).toString(16).toUpperCase()}`);
    allPass = false;
    continue;
  }

  const gotSD = newDv.getUint32(OFF_SD, true);
  const gotSK = newDv.getUint32(OFF_SK, true);
  const gotTS = newDv.getUint32(OFF_TS, true);
  if (gotSD !== newSD || gotSK !== newSK || gotTS !== newTS) {
    console.log(`  ✗ field mismatch — wanted SD=${newSD},SK=${newSK},TS=${newTS}; got SD=${gotSD},SK=${gotSK},TS=${gotTS}`);
    allPass = false;
    continue;
  }
  console.log(`  ✓ updated fields verified after re-decrypt`);

  // Every other byte should be identical to the original plaintext
  let drift = 0;
  for (let i = 0; i < origPlain.length; i++) {
    if (i >= OFF_SD && i < OFF_SD + 4) continue;     // SizeDecompressed
    if (i >= OFF_SK && i < OFF_SK + 4) continue;     // SizeDisk
    if (i >= OFF_TS && i < OFF_TS + 4) continue;     // Timestamp
    if (origPlain[i] !== newPlain[i]) {
      if (drift < 5) console.log(`  ✗ byte drift @ 0x${i.toString(16)}: 0x${origPlain[i].toString(16)} → 0x${newPlain[i].toString(16)}`);
      drift++;
    }
  }
  if (drift > 0) {
    console.log(`  ✗ ${drift} unintended byte changes outside the 12 written bytes`);
    allPass = false;
  } else {
    console.log(`  ✓ ${origPlain.length - 12} non-target bytes preserved verbatim`);
  }

  // Round-trip echo with same values should be byte-identical to input
  const echoCipher = regenerateManifest(orig, slot, slot, origSD, origSK, origTS);
  let echoDrift = -1;
  for (let i = 0; i < orig.length; i++) {
    if (orig[i] !== echoCipher[i]) { echoDrift = i; break; }
  }
  if (echoDrift < 0) {
    console.log(`  ✓ identity echo: regenerate with same values → byte-identical output`);
  } else {
    console.log(`  ✗ identity echo drift @ 0x${echoDrift.toString(16)}: ${orig[echoDrift]} vs ${echoCipher[echoDrift]}`);
    allPass = false;
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(allPass ? '✓✓ ALL MANIFEST TESTS PASSED' : '✗ SOME TESTS FAILED');
process.exit(allPass ? 0 : 1);
