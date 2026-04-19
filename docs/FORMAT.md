# Save file format (technical reference)

This is for the curious. You don't need any of this to use the app. Everything here is reverse-engineered from [zencq/libNOM.io](https://github.com/zencq/libNOM.io) (GPL'd, not copied — only format documentation referenced).

## The pair

Every NMS save is two files next to each other:

- `save<N>.hg` — the actual save data, LZ4-chunked JSON (~2 MB on disk, ~7 MB uncompressed).
- `mf_save<N>.hg` — a 432-byte encrypted manifest with the save's metadata + integrity fields.

They must be written as a pair. A save file without its manifest won't load; a manifest without a matching save confuses the game UI.

## Slot numbering

NMS pairs files into slots:

| Files | Slot |
|---|---|
| `save.hg`, `save2.hg` | Slot 1 |
| `save3.hg`, `save4.hg` | Slot 2 |
| `save5.hg`, `save6.hg` | Slot 3 |
| ... | ... |

In each pair, the odd-indexed file is the autosave, the even-indexed is the manual save. NMS loads whichever is newer.

`accountdata.hg` + `mf_accountdata.hg` is a separate pair for account-wide data (discovery journal, etc.).

## save.hg layout

Byte structure:

```
┌─────────────────────────────────┐
│ chunk 0: 16-byte header + LZ4   │
├─────────────────────────────────┤
│ chunk 1: 16-byte header + LZ4   │
├─────────────────────────────────┤
│ ...                             │
└─────────────────────────────────┘
```

Each chunk header:

| Offset | Bytes | Type       | Value |
|--------|-------|------------|-------|
| 0x00   | 4     | uint32 LE  | magic `0xFEEDA1E5` |
| 0x04   | 4     | uint32 LE  | compressed size |
| 0x08   | 4     | uint32 LE  | uncompressed size (max 0x80000 = 524288) |
| 0x0C   | 4     | uint32 LE  | reserved, always 0 |

After the header: `compressed size` bytes of LZ4-block-format data. Decompress each chunk, concatenate, you get the JSON payload.

The JSON itself uses an obfuscated key scheme — keys like `:No`, `@Cs`, `b2n`. See `app/data/mapping.json` for the full deobfuscation table (3,500+ entries, extracted from libMBIN).

## mf_save.hg cipher

Full bytes encrypted with a modified XXTEA (Corrected Block TEA).

- **Cipher:** XXTEA with libNOM's tweaks (not canonical).
- **Rounds:** 6 for modern saves (Waypoint +), 8 for vanilla (pre-Waypoint).
- **Delta constant:** `0x9E3779B9`.
- **Key:** four `uint32` words.
  - Words 1–3 are constants from ASCII `"NAESEVADNAYRTNRG"` reinterpreted as little-endian uint32s:
    - `[1] = 0x44415645` ("EVAD")
    - `[2] = 0x5259414E` ("NAYR")
    - `[3] = 0x47524E54` ("TNRG")
  - Word 0 is derived from the slot index: `((slot ^ 0x1422CB8C).rotl(13) * 5 + 0xE6546B64) mod 2^32`
  - Slot mapping: `mf_accountdata.hg → 1`, `mf_save.hg → 2`, `mf_save2.hg → 3`, `mf_saveN.hg → N+1`.
- **Integrity check:** after decrypt, byte 0x00 must be `0xBE`, bytes 0x01–0x03 must be `0xEE`. I.e. `uint32 LE at offset 0 == 0xEEEEEEBE`. This is the "magic header".

There is no GCM tag, no IV, no AAD. Corrupt data just produces garbage after decrypt; the magic check catches it.

## mf_save.hg plaintext

After decryption, the 432 bytes are a fixed layout. We only touch three fields; everything else is preserved byte-for-byte from the previous manifest (the "echo" strategy — robust to schema drift in future game patches).

| Offset | Bytes | Type        | Field | Used? |
|--------|-------|-------------|-------|-------|
| 0x000  | 4     | uint32 LE   | META_HEADER (`0xEEEEEEBE`) | check |
| 0x004  | 4     | uint32 LE   | META_FORMAT (version tag) | copied |
| 0x008  | 48    | byte[48]    | SpookyHash + SHA-256 slots (zeroed in modern saves) | copied |
| 0x038  | 4     | uint32 LE   | **SizeDecompressed** (uncompressed save JSON bytes) | **written** |
| 0x03C  | 4     | uint32 LE   | **SizeDisk** (save.hg file size on disk) | **written** |
| 0x040  | 8     | —           | unused / reserved | copied |
| 0x048  | ...   | various     | BaseVersion, GameMode, Season, TotalPlayTime (layout drifts per version — we don't touch these) | copied |
| 0x058  | 128   | utf8 + NUL  | SaveName | copied |
| 0x0D8  | 128   | utf8 + NUL  | SaveSummary (the "In the Parlungm system" text) | copied |
| 0x158  | 4     | uint32 LE   | Difficulty preset ID | copied |
| 0x15C  | 8     | byte[8]     | slot identifier | copied |
| 0x164  | 4     | uint32 LE   | **Timestamp** (Unix seconds, UTC) | **written** |
| 0x168  | 4     | uint32 LE   | META_FORMAT (repeated) | copied |
| 0x16C  | ...   | byte[...]   | Tail — includes difficulty preset name string ("Normal"), future fields | copied |

## JSON mutation — why the custom parser

C#'s default JSON serializer emits whole-number floats as `1.0`. JavaScript's `JSON.parse` + `JSON.stringify` round-trips them as `1`. The NMS payload has ~58,000 such floats. Re-serializing through native JS strips every `.0`, breaks libNOM's typed deserializer, and the game refuses to load.

`app/lib/payload.js` solves this: the parser tracks every numeric token's source text. `1.0` becomes a `Float` wrapper instance carrying both the `Number` value and the literal source string. The serializer emits `Float.source` verbatim for untouched values, and formats new `Float(n)` values with explicit `.0` suffixes. Unchanged floats round-trip byte-identical; new floats serialize correctly.

C# and JS also disagree on the 17th significant digit of some doubles. Source-text preservation dodges that too.

## Field keys reference

See `app/lib/keys.js` — a hand-curated subset of the obfuscation map used on hot paths. Full map is in `app/data/mapping.json`.
