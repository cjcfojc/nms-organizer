// Verify that app/lib/xxtea.js correctly decrypts every mf_*.hg manifest in
// the NMS save folder, and that decrypt + re-encrypt is byte identical.
// Prints META_HEADER, META_FORMAT, SizeDecompressed, SizeDisk, SaveSummary,
// Timestamp for each file.
//
// Save folder discovery (priority): NMS_DIR env var → CLI arg → auto-detect.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  xxteaEncrypt, xxteaDecrypt, deriveManifestKey,
  slotForManifestFilename, iterationsForLength,
  META_HEADER,
} from './app/lib/xxtea.js';

function findNmsDir() {
  if (process.env.NMS_DIR && fs.existsSync(process.env.NMS_DIR)) return process.env.NMS_DIR;
  if (process.argv[2] && fs.existsSync(process.argv[2])) return process.argv[2];
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
  console.error(`No NMS save folder found. NMS_DIR env, CLI arg, or auto-detect.`);
  process.exit(1);
}
console.log(`scanning: ${NMS_DIR}\n`);

const CANDIDATES = [
  'mf_save.hg',
  'mf_save2.hg',
  'mf_save3.hg',
  'mf_save4.hg',
  'mf_save5.hg',
  'mf_save6.hg',
  'mf_accountdata.hg',
];

// Read a NUL-terminated UTF-8 string from a fixed-width slot in `buf`.
function readUtf8Z(buf, off, slotLen) {
  let end = off;
  while (end < off + slotLen && buf[end] !== 0) end++;
  return new TextDecoder('utf-8').decode(buf.slice(off, end));
}

// Print decoded fields per manifest_spec.md §4.
function describe(plain, label) {
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const fmt4 = (off) => '0x' + dv.getUint32(off, true).toString(16).toUpperCase().padStart(8, '0');
  const fmt2 = (off) => '0x' + dv.getUint16(off, true).toString(16).toUpperCase().padStart(4, '0');
  console.log(`\n  --- ${label} (${plain.length} bytes plaintext) ---`);
  console.log(`  0x000  META_HEADER       = ${fmt4(0x000)}`);
  console.log(`  0x004  META_FORMAT       = ${fmt4(0x004)}`);
  console.log(`  0x038  SizeDecompressed  = ${dv.getUint32(0x038, true).toLocaleString()} bytes`);
  console.log(`  0x03C  SizeDisk          = ${dv.getUint32(0x03C, true).toLocaleString()} bytes`);
  console.log(`  0x048  BaseVersion       = ${dv.getInt32(0x048, true)}`);
  console.log(`  0x04C  GameMode          = ${dv.getUint16(0x04C, true)}`);
  console.log(`  0x04E  Season            = ${dv.getUint16(0x04E, true)}`);
  console.log(`  0x050  TotalPlayTime     = ${dv.getBigUint64(0x050, true).toString()} sec`);
  console.log(`  0x058  SaveName          = "${readUtf8Z(plain, 0x058, 128)}"`);
  console.log(`  0x0D8  SaveSummary       = "${readUtf8Z(plain, 0x0D8, 128)}"`);
  console.log(`  0x158  Difficulty        = ${dv.getUint32(0x158, true)}`);
  const ts = dv.getUint32(0x164, true);
  const tsIso = ts ? new Date(ts * 1000).toISOString() : '(none)';
  console.log(`  0x164  Timestamp         = ${ts}  (${tsIso})`);
  console.log(`  0x168  META_FORMAT (rep) = ${fmt4(0x168)}`);
}

let allOk = true;
let checkedAny = false;

for (const name of CANDIDATES) {
  const full = path.join(NMS_DIR, name);
  if (!fs.existsSync(full)) continue;
  checkedAny = true;

  const cipher = new Uint8Array(fs.readFileSync(full));
  const slot = slotForManifestFilename(name);
  const iters = iterationsForLength(cipher.length);
  const key = deriveManifestKey(slot);

  console.log(`\n=== ${name} (${cipher.length} bytes, slot=${slot}, iters=${iters}, key[0]=0x${key[0].toString(16).toUpperCase().padStart(8, '0')}) ===`);

  let plain;
  try { plain = xxteaDecrypt(cipher, key, iters); }
  catch (e) { console.log(`  ! decrypt threw: ${e.message}`); allOk = false; continue; }

  const dv = new DataView(plain.buffer);
  const magic = dv.getUint32(0, true);
  if (magic !== META_HEADER) {
    console.log(`  ! MAGIC MISMATCH: got 0x${magic.toString(16).toUpperCase().padStart(8, '0')}, expected 0x${META_HEADER.toString(16).toUpperCase()}`);
    allOk = false;
    continue;
  }
  console.log(`  ok magic verified after decrypt (slot=${slot})`);

  describe(plain, name);

  // Round-trip: re-encrypt and confirm byte-identical to original cipher.
  const reCipher = xxteaEncrypt(plain, key, iters);
  let firstDiff = -1;
  for (let i = 0; i < cipher.length; i++) {
    if (cipher[i] !== reCipher[i]) { firstDiff = i; break; }
  }
  if (firstDiff < 0) {
    console.log(`\n  ok BYTE-IDENTICAL ROUND TRIP — cipher matches libNOM exactly`);
  } else {
    console.log(`\n  ! round-trip mismatch at byte ${firstDiff}: orig=0x${cipher[firstDiff].toString(16)} got=0x${reCipher[firstDiff].toString(16)}`);
    allOk = false;
  }
}

if (!checkedAny) {
  console.log(`No mf_*.hg files found in ${NMS_DIR}`);
  process.exit(1);
}

console.log(`\n${'='.repeat(60)}`);
console.log(allOk ? 'ALL MANIFESTS DECRYPTED + ROUND-TRIPPED SUCCESSFULLY' : 'SOME MANIFESTS FAILED — see errors above');
process.exit(allOk ? 0 : 2);
