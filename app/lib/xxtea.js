// XXTEA cipher (libNOM.io variant) used by No Man's Sky to encrypt the
// `mf_*.hg` save manifest files. Pure JavaScript, browser-compatible, no
// native deps. ESM module.
//
// This is NOT generic XXTEA. libNOM.io introduces three deviations from the
// canonical Wikipedia XXTEA spec:
//
//   1. The number of rounds is fixed (6 for the 360/384/432-byte modern
//      formats, 8 for the legacy 104-byte vanilla format) instead of the
//      standard `6 + 52/n`.
//   2. The "previous-element" register (called `current` in libNOM, `z` in
//      canonical XXTEA) is initialized to **0** at the start of encrypt
//      instead of `v[n-1]`. This makes the cipher subtly NOT self-inverse
//      unless `v[n-1] == 0`. libNOM gets away with it because the manifest
//      tail (last 68 bytes of a 432-byte buffer) is always zero-padded.
//   3. The key schedule replaces `key[0]` with a slot-derived word so that
//      the same plaintext encrypts differently per save slot.
//
// Reference: https://github.com/zencq/libNOM.io
//   PlatformSteam/PlatformSteam_Read.cs::DecryptMetaStorageEntry
//   PlatformSteam/PlatformSteam_Write.cs::EncryptMeta
//   PlatformSteam/PlatformSteam.cs::META_ENCRYPTION_KEY  (== ASCII "NAESEVADNAYRTNRG")
//
// IMPORTANT GOTCHA the published spec gets wrong:
// The four base key words derived from the ASCII string "NAESEVADNAYRTNRG"
// (16 bytes) reinterpreted as four little-endian uint32s are:
//
//   META_ENCRYPTION_KEY[0] = 0x5345414E   ("NAES")  -- replaced per-call by the
//                                                     slot-derived word, not used
//   META_ENCRYPTION_KEY[1] = 0x44415645   ("EVAD")
//   META_ENCRYPTION_KEY[2] = 0x5259414E   ("NAYR")  <-- NOT 0x52594E41 (spec typo!)
//   META_ENCRYPTION_KEY[3] = 0x47524E54   ("TNRG")
//
// `research/manifest_spec.md` §3.1 transposes the middle two bytes of [2] as
// `0x52594E41`. That is wrong; the correct LE reinterpretation of bytes
// `4E 41 59 52` is `0x5259414E`. Using the spec's value produces garbage and
// is the bug this module fixes.

const TEA_DELTA = 0x9E3779B9;          // The TEA "magic constant" sqrt(5)/2 << 32.
const NEG_DELTA = 0x61C88647;          // (uint32)(-TEA_DELTA), used by decrypt.
const KEY_TAIL  = [
  0x44415645,                          // "EVAD"  - ASCII bytes 4..7  of "NAESEVADNAYRTNRG"
  0x5259414E,                          // "NAYR"  - ASCII bytes 8..11 (NOT 0x52594E41)
  0x47524E54,                          // "TNRG"  - ASCII bytes 12..15
];

// 32-bit unsigned coercion. JS bitwise operators internally use Int32 so we
// finalize every result with `>>> 0` to stay in the unsigned range.
const u32 = (x) => x >>> 0;

// 32-bit left rotate (libNOM uses BitOperations.RotateLeft semantics).
function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

// Build the 4-word working key for a given save slot. The slot-derived word 0
// is what makes the same plaintext encrypt differently per slot.
//
//   slot 1 = mf_accountdata.hg            (StoragePersistentSlotEnum.AccountData)
//   slot 2 = mf_save.hg     (autosave 1)  (StoragePersistentSlotEnum.PlayerState1)
//   slot 3 = mf_save2.hg    (manual 1)    (StoragePersistentSlotEnum.PlayerState2)
//   ...
//   slot N = mf_save<N-1>.hg              (StoragePersistentSlotEnum.PlayerStateN-1)
//
// The constants 0x1422CB8C, 13, 5, 0xE6546B64 are baked into NMS — don't change them.
export function deriveManifestKey(slot) {
  // (slot ^ 0x1422CB8C).RotateLeft(13) * 5 + 0xE6546B64
  const xored = u32(slot ^ 0x1422CB8C);
  const rotated = rotl(xored, 13);
  const multiplied = u32(Math.imul(rotated, 5));     // safe 32-bit signed*signed mul
  const k0 = u32(multiplied + 0xE6546B64);
  return new Uint32Array([k0, KEY_TAIL[0], KEY_TAIL[1], KEY_TAIL[2]]);
}

// Read a Uint8Array as N little-endian uint32s into a Uint32Array.
function bytesToWords(bytes) {
  if (bytes.length % 4) {
    throw new Error(`xxtea: buffer length ${bytes.length} is not a multiple of 4`);
  }
  const N = bytes.length / 4;
  const words = new Uint32Array(N);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < N; i++) words[i] = dv.getUint32(i * 4, true);
  return words;
}

// Inverse of bytesToWords.
function wordsToBytes(words) {
  const bytes = new Uint8Array(words.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i], true);
  return bytes;
}

// Encrypt a buffer (Uint8Array of length divisible by 4) with the given 4-word
// key for `iterations` rounds. Returns a fresh Uint8Array of identical length.
//
// Mirrors libNOM PlatformSteam_Write.cs::EncryptMeta — see file header for the
// list of deviations from canonical XXTEA.
export function xxteaEncrypt(plaintext, key, iterations) {
  const result = bytesToWords(plaintext);
  const lastIndex = result.length - 1;

  // libNOM initializes `current` to 0 (NOT to result[lastIndex] as canonical
  // XXTEA does). For a manifest, this works only because result[lastIndex] is
  // always zero (the 432-byte tail is zero-padded). Don't change this.
  let current = 0;
  let hash = 0;

  for (let i = 0; i < iterations; i++) {
    hash = u32(hash + TEA_DELTA);
    const keyIndex = (hash >>> 2) & 3;

    // Forward pass: process j = 0 .. lastIndex - 1.
    for (let j = 0; j < lastIndex; j++) {
      const next = result[j + 1];
      // (((next>>3) ^ (current<<4)) + ((next*4) ^ (current>>5)))
      //  ^ ((current ^ key[(j&3)^keyIndex]) + (next ^ hash))
      // Bitwise ops in JS truncate to Int32 then return signed; the `+` may
      // overflow into 53-bit Number; we coerce to u32 at every assignment.
      const term = (
        (((next >>> 3) ^ (current << 4)) + ((next * 4) ^ (current >>> 5))) ^
        ((current ^ key[(j & 3) ^ keyIndex]) + (next ^ hash))
      ) >>> 0;
      result[j] = u32(result[j] + term);
      current = result[j];
    }

    // Wrap-around: process j = lastIndex using result[0] as the "next".
    const head = result[0];
    const term = (
      (((head >>> 3) ^ (current << 4)) + ((head * 4) ^ (current >>> 5))) ^
      ((current ^ key[(lastIndex & 3) ^ keyIndex]) + (head ^ hash))
    ) >>> 0;
    result[lastIndex] = u32(result[lastIndex] + term);
    current = result[lastIndex];
  }

  return wordsToBytes(result);
}

// Decrypt a buffer. Inverse of xxteaEncrypt.
//
// Mirrors libNOM PlatformSteam_Read.cs::DecryptMetaStorageEntry. The wrapper
// in libNOM brute-forces over StoragePersistentSlotEnum to find the slot whose
// decrypted output starts with META_HEADER (= 0xEEEEEEBE), but for our use we
// know the slot from the filename (see slotForFilename in verify_manifests.mjs).
export function xxteaDecrypt(ciphertext, key, iterations) {
  const result = bytesToWords(ciphertext);
  const lastIndex = result.length - 1;

  // hash is pre-computed to delta * iterations; libNOM does this with a loop
  // for clarity, but the math is the same.
  let hash = u32(Math.imul(TEA_DELTA, iterations));

  for (let i = 0; i < iterations; i++) {
    let current = result[0];
    const keyIndex = (hash >>> 2) & 3;

    // Backward pass: undo encrypt's wrap step first (j = lastIndex), then
    // peel back j = lastIndex - 1 .. 1.
    for (let j = lastIndex; j > 0; j--) {
      const prev = result[j - 1];
      const term = (
        (((current >>> 3) ^ (prev << 4)) + ((current * 4) ^ (prev >>> 5))) ^
        ((prev ^ key[(j & 3) ^ keyIndex]) + (current ^ hash))
      ) >>> 0;
      result[j] = u32(result[j] - term);
      current = result[j];
    }

    // Wrap: undo encrypt's first inner step (j = 0). Uses result[lastIndex]
    // (just-decrypted) as the "z" register; this only matches encrypt when the
    // original plaintext result[lastIndex] was 0 (true for manifests).
    const tail = result[lastIndex];
    const term = (
      (((current >>> 3) ^ (tail << 4)) + ((current * 4) ^ (tail >>> 5))) ^
      ((tail ^ key[keyIndex]) + (current ^ hash))
    ) >>> 0;
    result[0] = u32(result[0] - term);

    hash = u32(hash + NEG_DELTA);
  }

  return wordsToBytes(result);
}

// Magic value at offset 0x00 of every decrypted manifest. If decrypt produces
// any other value at offset 0, the slot/key was wrong — not a valid manifest.
export const META_HEADER = 0xEEEEEEBE;

// Pick the right number of XXTEA rounds for a given manifest length. Modern
// (Waypoint+) manifests use 6 rounds; the legacy 104-byte vanilla format used 8.
export function iterationsForLength(byteLength) {
  return byteLength === 104 ? 8 : 6;
}

// Map an mf_* filename to the StoragePersistentSlotEnum integer used as the
// slot input to deriveManifestKey. Returns null if the filename isn't a manifest.
//
//   mf_accountdata.hg → 1
//   mf_save.hg        → 2   (PlayerState1, autosave slot 1)
//   mf_save2.hg       → 3   (PlayerState2, manual slot 1)
//   mf_save3.hg       → 4   (PlayerState3, autosave slot 2)
//   mf_saveN.hg       → N + 1   (PlayerState_N)
export function slotForManifestFilename(filename) {
  // Strip any directory part — keep just the basename, lowercase.
  const base = filename.replace(/^.*[/\\]/, '').toLowerCase();
  if (base === 'mf_accountdata.hg') return 1;
  if (base === 'mf_save.hg') return 2;
  const m = base.match(/^mf_save(\d+)\.hg$/);
  if (m) return Number(m[1]) + 1;
  return null;
}
