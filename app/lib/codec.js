// Browser-compatible LZ4 block codec + NMS save chunk wrapper.
//
// Public API:
//   decodeSaveBytes(buf) → Uint8Array  — Uncompressed save JSON payload
//   encodeSaveBytes(payload) → Uint8Array — LZ4-chunked save.hg-format bytes
//   sha256Hex(buf) → Promise<string>    — Hex digest (uses Web Crypto)
//
// Format reference: libNOM.io/Global/Constants.cs + LZ4 block specification.
// Uses Uint8Array exclusively — no Node Buffer dependency, runs in any browser.

// NMS chunk header — 16 bytes total, little-endian:
//   uint32 magic (0xFEEDA1E5)
//   uint32 compressedSize
//   uint32 uncompressedSize
//   uint32 reserved (always 0)
const MAGIC      = 0xFEEDA1E5;
const HEADER_LEN = 16;
const CHUNK_MAX  = 0x80000;     // 524288: max uncompressed bytes per chunk (libNOM SAVE_STREAMING_CHUNK_LENGTH_MAX)

// LZ4 block format constants
const MIN_MATCH    = 4;
const LAST_LITERALS= 5;
const MIN_BLOCK    = 13;
const MFLIMIT_TAIL = 12;
const MAX_OFFSET   = 65535;
const HASH_BITS    = 16;
const HASH_SIZE    = 1 << HASH_BITS;
const HASH_MASK    = HASH_SIZE - 1;

// Read/write unsigned 32-bit LE without DataView allocation overhead.
function readU32LE(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
function writeU32LE(buf, off, val) {
  buf[off]     =  val         & 0xff;
  buf[off + 1] = (val >>> 8)  & 0xff;
  buf[off + 2] = (val >>> 16) & 0xff;
  buf[off + 3] = (val >>> 24) & 0xff;
}

// LZ4-style 4-byte hash for the encoder's match-finder.
function hash4(buf, p) {
  const v = readU32LE(buf, p);
  return (Math.imul(v, 2654435761) >>> (32 - HASH_BITS)) & HASH_MASK;
}

// ── LZ4 block codec ──────────────────────────────────────────────────────────

function lz4DecompressBlock(src, uncompSize) {
  const out = new Uint8Array(uncompSize);
  let sp = 0, dp = 0;
  const srcLen = src.length;
  while (sp < srcLen) {
    const token = src[sp++];
    let litLen = token >>> 4;
    if (litLen === 15) {
      let b;
      do { b = src[sp++]; litLen += b; } while (b === 255);
    }
    if (litLen) {
      out.set(src.subarray(sp, sp + litLen), dp);
      sp += litLen; dp += litLen;
    }
    if (sp >= srcLen) break;   // last sequence: literals only, no match follows
    const offset = src[sp] | (src[sp + 1] << 8);
    sp += 2;
    if (offset === 0) throw new Error('LZ4 decode: offset 0 invalid');
    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let b;
      do { b = src[sp++]; matchLen += b; } while (b === 255);
    }
    matchLen += MIN_MATCH;
    const start = dp - offset;
    if (start < 0) throw new Error('LZ4 decode: match before start');
    // Byte-by-byte copy is required for overlapping runs (offset < matchLen).
    for (let i = 0; i < matchLen; i++) out[dp + i] = out[start + i];
    dp += matchLen;
  }
  if (dp !== uncompSize) throw new Error(`LZ4 decode: size mismatch got ${dp} want ${uncompSize}`);
  return out;
}

function lz4CompressBlock(src) {
  const len = src.length;
  // Worst-case output: every byte a literal + token bytes + length-extension bytes.
  const out = new Uint8Array(len + Math.ceil(len / 255) + 16);
  let op = 0;

  if (len < MIN_BLOCK) return writeFinalLiterals(src, 0, len, out, op);

  const ht = new Int32Array(HASH_SIZE).fill(-1);
  let ip = 0, anchor = 0;
  const mflimit   = len - MFLIMIT_TAIL;
  const matchlimit = len - LAST_LITERALS;

  ht[hash4(src, 0)] = 0;
  ip = 1;

  while (ip < mflimit) {
    const h = hash4(src, ip);
    const ref = ht[h];
    ht[h] = ip;

    if (ref < 0 || (ip - ref) > MAX_OFFSET || readU32LE(src, ref) !== readU32LE(src, ip)) {
      ip++;
      continue;
    }

    let mp = ip + MIN_MATCH, rp = ref + MIN_MATCH;
    while (mp < matchlimit && src[mp] === src[rp]) { mp++; rp++; }
    const matchLen = mp - ip;
    const offset   = ip - ref;
    const litLen   = ip - anchor;

    const tokenPos = op++;
    let token = 0;

    if (litLen >= 15) {
      token = 0xF0;
      let r = litLen - 15;
      while (r >= 255) { out[op++] = 255; r -= 255; }
      out[op++] = r;
    } else {
      token = litLen << 4;
    }
    if (litLen) { out.set(src.subarray(anchor, anchor + litLen), op); op += litLen; }

    out[op++] =  offset        & 0xff;
    out[op++] = (offset >>> 8) & 0xff;

    const ml = matchLen - MIN_MATCH;
    if (ml >= 15) {
      token |= 0x0F;
      let r = ml - 15;
      while (r >= 255) { out[op++] = 255; r -= 255; }
      out[op++] = r;
    } else {
      token |= ml;
    }
    out[tokenPos] = token;

    ip += matchLen;
    anchor = ip;
    if (ip - 2 >= 0 && ip - 2 + 4 <= len) ht[hash4(src, ip - 2)] = ip - 2;
  }

  return writeFinalLiterals(src, anchor, len, out, op);
}

function writeFinalLiterals(src, anchor, len, out, op) {
  const litLen = len - anchor;
  const tokenPos = op++;
  let token;
  if (litLen >= 15) {
    token = 0xF0;
    let r = litLen - 15;
    while (r >= 255) { out[op++] = 255; r -= 255; }
    out[op++] = r;
  } else {
    token = litLen << 4;
  }
  if (litLen) { out.set(src.subarray(anchor, anchor + litLen), op); op += litLen; }
  out[tokenPos] = token;
  return out.subarray(0, op);
}

// ── NMS chunk wrapper ────────────────────────────────────────────────────────

// Decode a save.hg file's bytes into the uncompressed JSON payload.
//
// Modern saves are a stream of LZ4-compressed chunks, each prefixed with a
// 16-byte header. Pre-Frontiers saves and accountdata.hg may be stored
// uncompressed (no chunks, no magic) — we pass those through verbatim.
//
// Tolerates trailing zero padding after the final chunk (NMS sometimes pads).
export function decodeSaveBytes(buf) {
  // Legacy / accountdata: not chunked, return as-is.
  if (buf.length < 4 || readU32LE(buf, 0) !== MAGIC) return new Uint8Array(buf);

  const parts = [];
  let total = 0;
  let off = 0;
  while (off < buf.length) {
    if (off + HEADER_LEN > buf.length) break;
    const m = readU32LE(buf, off);
    if (m !== MAGIC) {
      // Trailing zero padding is tolerated — anything else is corruption.
      let allZero = true;
      for (let i = off; i < buf.length; i++) if (buf[i] !== 0) { allZero = false; break; }
      if (allZero) break;
      throw new Error(`bad chunk magic at offset ${off}: 0x${m.toString(16)}`);
    }
    const cs = readU32LE(buf, off + 4);
    const us = readU32LE(buf, off + 8);
    off += HEADER_LEN;
    if (off + cs > buf.length) throw new Error(`chunk truncated at ${off}: want ${cs} bytes`);
    parts.push(lz4DecompressBlock(buf.subarray(off, off + cs), us));
    total += us;
    off += cs;
  }

  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

// Encode an uncompressed JSON payload back into save.hg-format bytes.
// Splits the payload into CHUNK_MAX-byte slices, LZ4-compresses each, prefixes
// with the 16-byte header. Output is byte-equivalent to what NMS itself writes
// modulo LZ4 implementation differences (the same payload re-compressed by
// NMS may differ in compressed bytes, but the decompressed payload matches).
export function encodeSaveBytes(payload) {
  const pieces = [];
  for (let pos = 0; pos < payload.length; pos += CHUNK_MAX) {
    const slice = payload.subarray(pos, Math.min(pos + CHUNK_MAX, payload.length));
    const compressed = lz4CompressBlock(slice);
    const header = new Uint8Array(HEADER_LEN);
    writeU32LE(header, 0, MAGIC);
    writeU32LE(header, 4, compressed.length);
    writeU32LE(header, 8, slice.length);
    // header bytes 12..15 (reserved): left as zero.
    pieces.push(header, compressed);
  }
  let totalLen = 0;
  for (const p of pieces) totalLen += p.length;
  const out = new Uint8Array(totalLen);
  let p = 0;
  for (const piece of pieces) { out.set(piece, p); p += piece.length; }
  return out;
}

// SHA-256 hex digest of a byte array (uses Web Crypto subtle.digest).
export async function sha256Hex(buf) {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
