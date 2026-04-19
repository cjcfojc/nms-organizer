// mf_save.hg generator using the "echo" strategy.
//
// WHY echo: the manifest plaintext layout has fields whose semantics drift
// across NMS versions (libNOM's spec lags upstream). When we save back, the
// ONLY values that change are:
//   1. SizeDecompressed @ 0x038 — uncompressed save JSON byte length
//   2. SizeDisk         @ 0x03C — save.hg file size on disk after LZ4
//   3. Timestamp        @ 0x164 — Unix seconds, write time
// Everything else (BaseVersion, GameMode, Season, TotalPlayTime, SaveName,
// SaveSummary, Difficulty, the slot identifier at 0x15C, the difficulty
// preset name string at 0x16C, and any future fields HelloGames adds) is
// copied byte-for-byte from the previous manifest.
//
// This makes the regenerator robust to game patches that change the layout
// — we never assume what's at offsets we don't write.

import { xxteaEncrypt, xxteaDecrypt, deriveManifestKey, iterationsForLength, META_HEADER } from './xxtea.js';

// Plaintext field offsets (Worlds Part II 432-byte format). Stable across
// NMS versions per libNOM history; only these three are written.
const OFF_SIZE_DECOMPRESSED = 0x038;
const OFF_SIZE_DISK         = 0x03C;
const OFF_TIMESTAMP         = 0x164;

// Take an existing mf_save.hg ciphertext and produce a new ciphertext with
// SizeDecompressed/SizeDisk/Timestamp updated for a freshly-written save.hg.
//
//   originalCipher          — Uint8Array, the existing mf_*.hg bytes (432 typically)
//   srcSlot                 — slot the original cipher was encrypted with
//   dstSlot                 — slot the new cipher should be encrypted with
//                             (== srcSlot for OVERWRITE; different for WRITE NEW SLOT)
//   newSaveSizeDecompressed — uint32, byte length of the new uncompressed save JSON
//   newSaveSizeDisk         — uint32, byte length of the new save.hg on disk
//   timestampSec            — optional, default Math.floor(Date.now() / 1000)
//
// Returns: Uint8Array of the new mf_save.hg ciphertext (same length as input).
export function regenerateManifest(originalCipher, srcSlot, dstSlot, newSaveSizeDecompressed, newSaveSizeDisk, timestampSec) {
  if (!(originalCipher instanceof Uint8Array)) throw new Error('manifest: originalCipher must be Uint8Array');
  if (!Number.isInteger(srcSlot) || srcSlot < 0) throw new Error('manifest: srcSlot must be a non-negative integer');
  if (!Number.isInteger(dstSlot) || dstSlot < 0) throw new Error('manifest: dstSlot must be a non-negative integer');
  if (!Number.isInteger(newSaveSizeDecompressed) || newSaveSizeDecompressed < 0) throw new Error('manifest: newSaveSizeDecompressed must be uint32');
  if (!Number.isInteger(newSaveSizeDisk)         || newSaveSizeDisk         < 0) throw new Error('manifest: newSaveSizeDisk must be uint32');

  const iters  = iterationsForLength(originalCipher.length);
  const srcKey = deriveManifestKey(srcSlot);
  const dstKey = deriveManifestKey(dstSlot);

  const plain = xxteaDecrypt(originalCipher, srcKey, iters);
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);

  // Magic check: if absent, srcSlot was wrong and re-encrypting would silently
  // produce garbage NMS rejects. Bail loudly.
  const magic = dv.getUint32(0, true);
  if (magic !== META_HEADER) {
    throw new Error(`manifest: decrypt magic mismatch (srcSlot=${srcSlot}, got 0x${magic.toString(16).toUpperCase()}). Wrong source slot?`);
  }

  dv.setUint32(OFF_SIZE_DECOMPRESSED, newSaveSizeDecompressed, true);
  dv.setUint32(OFF_SIZE_DISK,         newSaveSizeDisk,         true);
  dv.setUint32(OFF_TIMESTAMP,         (timestampSec ?? Math.floor(Date.now() / 1000)) >>> 0, true);

  return xxteaEncrypt(plain, dstKey, iters);
}
