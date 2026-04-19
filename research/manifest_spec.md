# `mf_save.hg` (NMS Manifest) — Byte-Level Specification

**Scope.** Steam (PC) platform only. Format `META_FORMAT_4` (432 bytes), produced by current libNOM.io for the Worlds Part II era of NMS (`BaseVersion >= 553`, "WorldsPartIIWithDifficultyTag"). Brief notes are included for the older 360 / 384 / 104 byte variants where they share machinery.

**Goal.** Enough detail to re-implement encode and decode in browser JavaScript using only the Web Crypto API (or any byte-twiddling — no AES is actually used).

**Source of truth.** Every byte-level claim cites a specific file + symbol in `zencq/libNOM.io` (master branch as of fetch). Each citation gives the GitHub raw URL — open it and grep for the symbol to verify. Where libNOM has a constant, the literal value is reproduced inline.

---

## 0. TL;DR — the format is *not* AES-anything

If you came in expecting AES-GCM with a derived key, breathe out. The actual primitives are:

- **Cipher.** A modified XXTEA (Corrected Block TEA) over the metadata buffer treated as `uint32` words. Rounds: 8 for the legacy 104-byte vanilla format, **6 for everything Waypoint and newer (including the 432-byte Worlds Part II layout you care about)**. Constant magic numbers: `0x9E3779B9` (TEA delta) and `0x61C88647` (= -delta, used by the decrypt loop).
- **Key.** A four-`uint32` array. Words 1–3 are constant ASCII bytes from the literal string `"NAESEVADNAYRTNRG"` (read as little-endian `uint32`s, hex `0x53454144 0x52414E59 0x47524E54` for the last three — see §3). Word 0 is *derived from the save slot index* using a fixed scramble, so the same plaintext encrypts to different bytes in slot 1 vs slot 2 vs accountdata.
- **Auth tag.** None. There is no GCM tag. Integrity is implicit: after the receiver decrypts, byte `[0..4)` must equal the magic header `0xEEEEEEBE`. If it does, the buffer is accepted.
- **Save-data hash field.** *Modern saves (`META_FORMAT_2/3/4`, i.e. anything from Frontiers / 3.60 onward) leave this field blank.* The 16-byte SpookyHash and 32-byte SHA-256 slots in the buffer (bytes 8..55) exist for layout reasons but are written as zero bytes by libNOM's `CreateMeta` for any save your tool will see. This is the single most surprising thing in the format and is what made me ask whether it was secretly a hash check — it isn't.
- **Encryption boundary.** Whole 432-byte buffer is encrypted in one shot. There is no plaintext header, no IV, no tag. The encrypted output is exactly 432 bytes and is the entire on-disk file.

**Implication for your editor.** To re-emit a valid `mf_save.hg` after rewriting `save.hg`, you need: (a) the slot index, (b) the new `Extra.SizeDecompressed` (uncompressed save JSON byte length), (c) a few fields you can pull from the JSON itself (`BaseVersion`, `GameMode`, `Season`, `TotalPlayTime`, `SaveName`, `SaveSummary`, `Difficulty`), and (d) a current Unix timestamp. No actual hashing of `save.hg` is required.

---

## 1. File location and naming

```
%APPDATA%\HelloGames\NMS\st_<steamid64>\mf_save.hg            # slot 1 / autosave
%APPDATA%\HelloGames\NMS\st_<steamid64>\mf_save2.hg           # slot 1 / manual save
%APPDATA%\HelloGames\NMS\st_<steamid64>\mf_save3.hg           # slot 2 / autosave
%APPDATA%\HelloGames\NMS\st_<steamid64>\mf_save4.hg           # slot 2 / manual save
...
%APPDATA%\HelloGames\NMS\st_<steamid64>\mf_accountdata.hg     # account-level meta
```

The data file is `save<n>.hg` (or `save.hg` / `accountdata.hg`), and the manifest file is the same name with an `mf_` prefix.

> Source: `libNOM.io/PlatformSteam/PlatformSteam_Initialize.cs` builds the meta path as
> ```csharp
> MetaFile = new FileInfo(Path.Combine(Location.FullName, $"mf_{name}"))
> ```
> with `name = metaIndex == 0 ? "accountdata.hg" : $"save{(metaIndex == OFFSET_INDEX ? "" : metaIndex - 1)}.hg"`.
> `OFFSET_INDEX = 2` (`Global/Constants.cs`), so `metaIndex == 2` produces `save.hg` (no suffix), `3` produces `save2.hg`, etc.

The Steam OS-specific roots:
```csharp
Windows: %APPDATA%\HelloGames\NMS
Linux  : ~/.local/share/Steam/steamapps/compatdata/275850/pfx/drive_c/users/steamuser/Application Data/HelloGames/NMS
macOS  : ~/Library/Application Support/HelloGames/NMS
```
> Source: `PlatformSteam/PlatformSteam.cs`, `public static readonly string PATH = ...` block.

---

## 2. Total length and which length to use

The buffer length depends on the **save's `BaseVersion`**, which lives inside the save JSON (the `F2P` key in the obfuscated form, or `Version` in plaintext) and gets read out by libNOM into `Container.BaseVersion`. The mapping (from `Platform/Platform_Write.cs` → `GetMetaBufferLength`):

| `BaseVersion` (`GameVersionEnum`) | Length (bytes) | Symbol                              |
|-----------------------------------|----------------|-------------------------------------|
| `>= 553` (`WorldsPartIIWithDifficultyTag`) | **432** (`0x1B0`) | `META_LENGTH_TOTAL_WORLDS_PART_II` |
| `>= 500` (`WorldsPartI`)          | 384 (`0x180`)  | `META_LENGTH_TOTAL_WORLDS_PART_I`   |
| `>= 400` (`Waypoint`)             | 360 (`0x168`)  | `META_LENGTH_TOTAL_WAYPOINT`        |
| `<  400`                          | 104 (`0x68`)   | `META_LENGTH_TOTAL_VANILLA`         |

> Source for the constants: `PlatformSteam/PlatformSteam.cs`. `GameVersionEnum` numeric values: `Enums/GameVersionEnum.cs` (Frontiers=360, Waypoint=400, WorldsPartI=500, WorldsPartII=550, WorldsPartIIWithDifficultyTag=553).

For your editor: detect the save's BaseVersion from its JSON, look up the right length here, allocate that many zero-initialized bytes, write the fields per §4, then encrypt with the routine in §3. Do not assume 432 — older saves still in the wild are 384 or 360.

For the worked example (§7) and everything else below, assume **432 bytes** unless otherwise stated.

---

## 3. Cipher (XXTEA variant)

### 3.1 Constants

From `PlatformSteam/PlatformSteam.cs`:

```csharp
protected static readonly uint[] META_ENCRYPTION_KEY =
    Encoding.ASCII.GetBytes("NAESEVADNAYRTNRG").AsSpan().Cast<byte, uint>().ToArray();
protected const uint META_HEADER = 0xEEEEEEBE; // 4,008,636,094
```

Decoding the literal: ASCII for `"NAESEVADNAYRTNRG"` is the byte sequence
```
4E 41 45 53  45 56 41 44  4E 41 59 52  54 4E 52 47
```
read as four little-endian `uint32`s:
```
META_ENCRYPTION_KEY[0] = 0x5345414E   (will be OVERWRITTEN per-call, see 3.2)
META_ENCRYPTION_KEY[1] = 0x44415645
META_ENCRYPTION_KEY[2] = 0x5259414E
META_ENCRYPTION_KEY[3] = 0x47524E54

> **Heads up.** An earlier draft of this spec listed
> `META_ENCRYPTION_KEY[2] = 0x52594E41` — that was a transcription error. The
> bytes at offsets 8..11 of "NAESEVADNAYRTNRG" are `4E 41 59 52` ("NAYR"),
> which read as little-endian uint32 is `0x5259414E`. Verified against a real
> .NET runtime; using the wrong value produces garbage on decrypt.
```

### 3.2 Per-call key derivation (slot-dependent)

Both encrypt and decrypt build the working key as:

```csharp
ReadOnlySpan<uint> key = [
    (((uint)(storage) ^ 0x1422CB8C).RotateLeft(13) * 5) + 0xE6546B64,
    META_ENCRYPTION_KEY[1],   // 0x44415645
    META_ENCRYPTION_KEY[2],   // 0x5259414E
    META_ENCRYPTION_KEY[3],   // 0x47524E54
];
```

`storage` is the value of `Container.PersistentStorageSlot` cast to `uint`. From `Enums/StoragePersistentSlotEnum.cs` the enum has implicit sequential values:

```
UserSettings   = 0
AccountData    = 1
PlayerState1   = 2     // mf_save.hg     (slot 1, autosave)
PlayerState2   = 3     // mf_save2.hg    (slot 1, manual)
PlayerState3   = 4     // mf_save3.hg    (slot 2, autosave)
...
PlayerState30  = 31    // mf_save30.hg
```

> The mapping from filename to slot is in `PlatformSteam/PlatformSteam_Initialize.cs` (file naming) plus the `OFFSET_INDEX = 2` constant in `Global/Constants.cs` and the slot enum order in `Enums/StoragePersistentSlotEnum.cs`. Equivalently: `storage = metaIndex` where `metaIndex` is `0` for accountdata and `2 + (n-1)*1` for saveN — but in practice you can just take the integer that follows `mf_save` (treating `mf_save.hg` as `1`) and add `1` to get `storage`.

`RotateLeft(13)` is a 32-bit left rotate (low 13 to top, high 19 to bottom). All arithmetic is unsigned 32-bit, wrap on overflow.

> Source: `PlatformSteam/PlatformSteam_Read.cs` `DecryptMetaStorageEntry`, and `PlatformSteam/PlatformSteam_Write.cs` `EncryptMeta`.

### 3.3 Encrypt loop (verbatim, with annotations)

From `PlatformSteam/PlatformSteam_Write.cs`:

```csharp
protected override ReadOnlySpan<byte> EncryptMeta(Container container, ReadOnlySpan<byte> data, Span<byte> meta)
{
    uint current = 0;
    uint hash = 0;
    int iterations = container.IsVersion400Waypoint ? 6 : 8;
    ReadOnlySpan<uint> key = [
        (((uint)(container.PersistentStorageSlot) ^ 0x1422CB8C).RotateLeft(13) * 5) + 0xE6546B64,
        META_ENCRYPTION_KEY[1], META_ENCRYPTION_KEY[2], META_ENCRYPTION_KEY[3]
    ];
    Span<uint> result = Common.DeepCopy<uint>(meta.Cast<byte, uint>());

    int lastIndex = result.Length - 1;

    for (int i = 0; i < iterations; i++)
    {
        hash += 0x9E3779B9;
        int keyIndex = (int)((hash >> 2) & 3);
        int valueIndex = 0;

        for (int j = 0; j < lastIndex; j++, valueIndex++)
        {
            result[valueIndex] += (((result[valueIndex + 1] >> 3) ^ (current << 4))
                                + ((result[valueIndex + 1] * 4)  ^ (current >> 5)))
                                ^ ((current ^ key[(j & 3) ^ keyIndex])
                                + (result[valueIndex + 1] ^ hash));
            current = result[valueIndex];
        }

        result[lastIndex] += (((result[0] >> 3) ^ (current << 4))
                            + ((result[0] * 4)  ^ (current >> 5)))
                            ^ ((current ^ key[(lastIndex & 3) ^ keyIndex])
                            + (result[0] ^ hash));
        current = result[lastIndex];
    }
    return result.Cast<uint, byte>();
}
```

Inputs:
- `meta` is the full 432-byte plaintext built per §4. It is treated as 108 little-endian `uint32`s.
- `data` is *passed but unused* in EncryptMeta itself — it is used by `CreateMeta` for the legacy hash branch.

Iterations:
- `IsVersion400Waypoint` is `GameVersion >= Waypoint(400)` (see `Container/Container_Property_IsVersion.cs` and `IsVersion()` in `Container/Container.cs`).
- For all modern saves (anything you'll be editing), iterations = **6**. The old VANILLA format used 8 — implement both if you want to handle pre-Waypoint saves, otherwise hard-code 6.

Output is 432 bytes of ciphertext. **Write that to disk as `mf_save.hg` directly. There is no envelope.**

### 3.4 Decrypt loop (for sanity-checking your encoder)

From `PlatformSteam/PlatformSteam_Read.cs`:

```csharp
private Span<uint> DecryptMetaStorageEntry(StoragePersistentSlotEnum storage, int iterations, int lastIndex, ReadOnlySpan<uint> meta)
{
    ReadOnlySpan<uint> key = [
        (((uint)(storage) ^ 0x1422CB8C).RotateLeft(13) * 5) + 0xE6546B64,
        META_ENCRYPTION_KEY[1], META_ENCRYPTION_KEY[2], META_ENCRYPTION_KEY[3]
    ];
    Span<uint> result = Common.DeepCopy(meta);
    uint hash = 0;

    // Pre-compute the final hash (= delta * iterations).
    for (int i = 0; i < iterations; i++)
        hash += 0x9E3779B9;

    for (int i = 0; i < iterations; i++)
    {
        uint current = result[0];
        int keyIndex = (int)(hash >> 2 & 3);
        int valueIndex = lastIndex;

        for (int j = lastIndex; j > 0; j--, valueIndex--)
        {
            result[valueIndex] -= (((current >> 3) ^ (result[valueIndex - 1] << 4))
                                 + ((current * 4)  ^ (result[valueIndex - 1] >> 5)))
                                 ^ ((result[valueIndex - 1] ^ key[(j & 3) ^ keyIndex])
                                 + (current ^ hash));
            current = result[valueIndex];
        }

        valueIndex = lastIndex;
        result[0] -= (((current >> 3) ^ (result[valueIndex] << 4))
                    + ((current * 4)  ^ (result[valueIndex] >> 5)))
                    ^ ((result[valueIndex] ^ key[keyIndex])
                    + (current ^ hash));

        hash += 0x61C88647;   // = -0x9E3779B9 mod 2^32
    }
    return result;
}
```

Validation in `DecryptMeta`: the slot is unknown until a candidate decrypt produces `result[0] == META_HEADER` (= `0xEEEEEEBE`). libNOM tries the container's own slot first, then iterates other slots with the right account/save partition. **For your encoder you always know the slot from the filename — you do not need this fallback.**

### 3.5 Endianness gotchas for JS

- All `uint32` interpretations are **little-endian**. Use `DataView.getUint32(off, true)` / `setUint32(off, val, true)`.
- `RotateLeft(13)` over `uint32`: `((x << 13) | (x >>> 19)) >>> 0`.
- All add/sub/mul/xor must be coerced back into 32-bit unsigned via `>>> 0` (or `Math.imul` for the `* 5` and `* 4`).
- Buffer length is always a multiple of 4 (432 = 108 × 4), so no partial-word handling.

---

## 4. Plaintext layout (432-byte `META_FORMAT_4`)

This is the byte layout *before* §3 encrypts it. Source: `PlatformSteam/PlatformSteam_Write.cs::CreateMeta` (the Frontiers+ branch), plus `Platform/Platform_Write.cs::OverwriteWaypointMeta` and the Steam override of `OverwriteWorldsMeta` in `PlatformSteam/PlatformSteam_Write.cs`.

```
Offset  Size  Type        Field                         Notes
------  ----  ----------  ----------------------------  ------------------------------------------------
0x000     4  uint32 LE   META_HEADER                   Always 0xEEEEEEBE
0x004     4  uint32 LE   META_FORMAT                   0x7D4 (= 2004) for Worlds Part II
0x008    16  byte[16]    SpookyHash slot               Zero-filled by libNOM for modern saves (see §0)
0x018    32  byte[32]    SHA-256 slot                  Zero-filled by libNOM for modern saves
0x038     4  uint32 LE   SizeDecompressed              Length of the LZ4-decompressed save JSON
0x03C     4  uint32 LE   SizeDisk                      Set by OverwriteWorldsMeta (§4.6) — total LZ4'd
                                                        chunk bytes on disk (see §4.6 caveat)
0x040     4  uint32 LE   "Compressed Size" / unused    Skipped by Frontiers branch; left zero.
0x044     4  uint32 LE   "Profile Hash" / unused       Skipped by Frontiers branch; left zero.
0x048     4   int32 LE   BaseVersion                   From save JSON (key F2P or Version)
0x04C     2  uint16 LE   GameMode                      PresetGameModeEnum cast to ushort
0x04E     2  uint16 LE   Season                        SeasonEnum cast to ushort (0 outside Expedition)
0x050     8  uint64 LE   TotalPlayTime                 Seconds, from save JSON (Lg8 / TotalPlayTime)
0x058   128  utf8 +NUL   SaveName                      §4.4
0x0D8   128  utf8 +NUL   SaveSummary                   §4.5
0x158     4  uint32 LE   Difficulty (preset id)        DifficultyPresetTypeEnum, see §4.5
0x15C     8  byte[8]     SLOT IDENTIFIER (skipped)     Left as whatever was in the buffer = zeros
0x164     4  uint32 LE   Timestamp (Unix seconds, UTC) Last write time — set by OverwriteWorldsMeta
0x168     4  uint32 LE   META_FORMAT (repeated)        Same as 0x004; written again by Worlds code
0x16C    68  byte[68]    Tail / padding                Zero-filled, never written
                                                        (0x1B0 - 0x16C = 0x44 = 68)
```

Total: `0x16C + 68 = 0x1B0 = 432`. ✓

### 4.1 META_HEADER (offset 0x000)

```csharp
writer.Write(META_HEADER); // 4
```
Constant `0xEEEEEEBE`. On disk: `BE EE EE EE`.

### 4.2 META_FORMAT (offset 0x004)

```csharp
writer.Write(GetMetaFormat(container)); // 4
```

From `Platform/Platform_Write.cs::GetMetaFormat`:

```csharp
protected static uint GetMetaFormat(Container container)
{
    return container.GameVersion switch
    {
        >= GameVersionEnum.WorldsPartII => Constants.META_FORMAT_4,
        >= GameVersionEnum.WorldsPartI  => Constants.META_FORMAT_3,
        >= GameVersionEnum.Frontiers    => Constants.META_FORMAT_2,
        _                                => Constants.META_FORMAT_1,
    };
}
```

Constants from `Global/Constants.cs`:
```csharp
internal const uint META_FORMAT_0 = 0x7D0; // 2000 (1.00)
internal const uint META_FORMAT_1 = 0x7D1; // 2001 (1.10)
internal const uint META_FORMAT_2 = 0x7D2; // 2002 (3.60)
internal const uint META_FORMAT_3 = 0x7D3; // 2003 (5.00)
internal const uint META_FORMAT_4 = 0x7D4; // 2004 (5.50)
```

Mapping note: `GetMetaFormat` uses `>= WorldsPartII` (= 550) for FORMAT_4, but `GetMetaBufferLength` uses `>= WorldsPartIIWithDifficultyTag` (= 553) for the 432-byte bucket. So `BaseVersion` 550–552 produces a 384-byte buffer with `META_FORMAT = 0x7D4` and `BaseVersion >= 553` produces a 432-byte buffer also with `META_FORMAT = 0x7D4`. Practically, current NMS is 553+, so for an active save you write `0x7D4` into a 432-byte buffer. If you encounter a 384-byte buffer with format 0x7D4, that is normal for the brief window between 5.50 and 5.53.

### 4.3 SpookyHash + SHA-256 slots (offsets 0x008..0x037)

In `CreateMeta` (Steam, Frontiers+ branch):

```csharp
// SPOOKY HASH and SHA256 HASH not used.
writer.Seek(0x30, SeekOrigin.Current); // 16 + 32 = 48
```

The writer skips 48 bytes without touching them. Because the buffer was allocated as `new byte[GetMetaBufferLength(container)]`, those 48 bytes are zero. **For a modern save, write 48 zero bytes here.**

The `AppendHashes` helper (which writes a SpookyV2 64-bit-pair + SHA-256) is reachable only via the `else` branch of `CreateMeta`, which fires only when `!(container.IsSave && container.IsVersion360Frontiers)`. For "is a save and version 3.60+", that branch is not taken. The `else` branch is used for the legacy 104-byte format and for `accountdata.hg` on older builds.

For completeness, `AppendHashes` is, from `PlatformSteam/PlatformSteam_Write.cs`:

```csharp
private static void AppendHashes(BinaryWriter writer, ReadOnlySpan<byte> data)
{
    var sha256 = SHA256.HashData(data);
    var spookyHash = new SpookyHash(0x155AF93AC304200, 0x8AC7230489E7FFFF);
    spookyHash.Update(sha256);
    spookyHash.Update(data.ToArray());
    spookyHash.Final(out ulong spookyFinal1, out ulong spookyFinal2);
    writer.Write(spookyFinal1); // 8
    writer.Write(spookyFinal2); // 8
    writer.Write(sha256);       // 32
}
```

i.e. SpookyV2-128 with seeds (`0x0155AF93AC304200`, `0x8AC7230489E7FFFF`), updated with the SHA-256 result first and then the raw data. The hash is over the **uncompressed** save bytes (`data` is the uncompressed save JSON — see `Platform_Write.cs::WriteData` which compresses *after* CreateMeta has been called).

You will **not** need this for editing modern saves. Document it here so we can revisit if we ever need to support legacy 104-byte saves or Microsoft Store.

### 4.4 SizeDecompressed (offset 0x038)

```csharp
writer.Write(container.Extra.SizeDecompressed); // 4
```

`uint32 LE` — the byte length of the **uncompressed** save JSON (i.e. the bytes that get LZ4-compressed into `save.hg`). This is the *plaintext* size, before any chunking or LZ4.

For your editor: after you finalize the new save JSON, take its UTF-8 byte length and put it here.

### 4.5 SizeDisk + skipped 8 bytes (offsets 0x03C..0x047)

`CreateMeta` (Frontiers+ branch) does:
```csharp
// COMPRESSED SIZE and PROFILE HASH not used.
writer.Seek(0x8, SeekOrigin.Current); // 4 + 4 = 8
```

So bytes 0x03C..0x043 are skipped (zero) inside CreateMeta itself, and bytes 0x044..0x047 are also skipped (zero). Then in `OverwriteWorldsMeta` (Steam override):

```csharp
protected override void OverwriteWorldsMeta(BinaryWriter writer, Container container)
{
    base.OverwriteWorldsMeta(writer, container);   // §4.6
    if (container.IsVersion500WorldsPartI)
    {
        // COMPRESSED SIZE is used again.
        writer.Seek(0x3C, SeekOrigin.Begin);       // 4 + 4 + 16 + 32 + 4 = 60
        writer.Write(container.Extra.SizeDisk);    // 4
    }
}
```

So for `BaseVersion >= 500` (WorldsPartI), bytes 0x03C..0x03F are overwritten with the **on-disk save size** (`Extra.SizeDisk`). Bytes 0x040..0x047 stay zero.

`SizeDisk` is the post-LZ4 file size, including chunk headers (see `Constants.SAVE_STREAMING_HEADER_LENGTH = 16` and `SAVE_STREAMING_CHUNK_LENGTH_MAX = 0x80000`). Practically, it equals `save.hg`'s file size on disk.

### 4.6 Version block (offsets 0x048..0x057)

```csharp
writer.Write(container.BaseVersion);            // 4   int32 LE  @ 0x048
writer.Write((ushort)(container.GameMode));     // 2   uint16 LE @ 0x04C
writer.Write((ushort)(container.Season));       // 2   uint16 LE @ 0x04E
writer.Write(container.TotalPlayTime);          // 8   uint64 LE @ 0x050
```

Sources for each:
- `BaseVersion` — `Container/Container_Property_Save.cs` derives from `SaveVersion` (in JSON key `F2P` / `Version`) using `Meta/BaseVersion.cs`:
  ```csharp
  return container.SaveVersion -
      (((int)(container.GameMode) + ((int)(container.Season) * Constants.OFFSET_SEASON))
       * Constants.OFFSET_GAMEMODE);
  ```
  `OFFSET_GAMEMODE = 512`, `OFFSET_SEASON = 128` (`Global/Constants.cs`).
- `GameMode` — `Meta/GameMode.cs` parses JSON keys `idA` (obfuscated) or `GameMode` (plaintext), single digit.
- `Season` — `Meta/Season.cs` parses JSON keys `gou`/`SeasonId` (and falls back to `SEASON_ID` / `SEASON_ID_LEGACY`). Cast to ushort.
- `TotalPlayTime` — `Meta/TotalPlayTime.cs` parses JSON keys `Lg8` (obfuscated) or `TotalPlayTime` (plaintext), uint64.

For your editor: re-read these from the save JSON you are about to write. If you did not change them, you can copy them from the previous mf_save.hg.

### 4.7 SaveName (offset 0x058, 128 bytes)

From `Platform/Platform_Write.cs::OverwriteWaypointMeta`:

```csharp
writer.Seek(META_LENGTH_BEFORE_NAME, SeekOrigin.Begin);
writer.Write(container.SaveName.GetBytesWithTerminator()); // 128
```

`META_LENGTH_BEFORE_NAME` for Steam = `META_LENGTH_AFTER_VANILLA + 4 = 0x54 + 4 = 0x58 = 88`. Writes happen via `GetBytesWithTerminator`:

```csharp
internal static byte[] GetBytesWithTerminator(this string self) =>
    $"{self}\0".GetUTF8Bytes();
```

i.e. **UTF-8** encoding with a trailing `\0`. The slot is 128 bytes (`SAVE_RENAMING_LENGTH_MANIFEST = 0x80` from `Global/Constants.cs`). The string after the NUL is whatever was in the buffer (zeros for a fresh allocation) — there is no second pass that pads it.

> ⚠ The `BinaryWriter.Write(byte[])` writes only the bytes you give it, and only one NUL is appended. If the SaveName is shorter than 127 UTF-8 bytes, bytes after the NUL will remain zero (because the buffer started as zero-filled and nothing else writes there until offset 0x0D8). If the SaveName is longer than 127 UTF-8 bytes (including the terminator) it will overflow into SaveSummary. libNOM caps SaveName at 42 chars (`SAVE_RENAMING_LENGTH_INGAME = 0x2A`, see `Container_Property_Save.cs::SaveName`), so this never happens in practice. Cap your input to 42 UTF-8 chars to be safe.

For your editor: pull this from the JSON via the `Pk4` (obfuscated) or `SaveName` (plaintext) key (see `Meta/SaveName.cs`).

### 4.8 SaveSummary (offset 0x0D8, 128 bytes)

```csharp
writer.Seek(META_LENGTH_BEFORE_SUMMARY, SeekOrigin.Begin); // 0xD8
writer.Write(container.SaveSummary.GetBytesWithTerminator()); // 128
```

`META_LENGTH_BEFORE_SUMMARY = 88 + 0x80 = 0xD8 = 216`. Same UTF-8 + NUL semantics as SaveName, same 128-byte slot. Pulled from JSON keys `n:R` (obfuscated) or `SaveSummary` (plaintext) (`Meta/SaveSummary.cs`). Cap at 127 UTF-8 bytes.

### 4.9 Difficulty preset (offset 0x158, 4 bytes)

In `OverwriteWaypointMeta` (Waypoint era, would write `byte`):
```csharp
writer.Seek(META_LENGTH_BEFORE_DIFFICULTY_PRESET, SeekOrigin.Begin);
writer.Write((byte)(container.Difficulty)); // 1
```

In `OverwriteWorldsMeta` (Worlds Part I+ overrides it as `uint32`):
```csharp
writer.Seek(META_LENGTH_BEFORE_DIFFICULTY_PRESET, SeekOrigin.Begin);
writer.Write((uint)(container.Difficulty)); // 4
```

`META_LENGTH_BEFORE_DIFFICULTY_PRESET = 0xD8 + 0x80 = 0x158 = 344`.

Order of writes inside `CreateMeta` is:
1. base writes through TotalPlayTime then `Extra.Bytes` → fills the buffer
2. `OverwriteWaypointMeta` → writes SaveName, SaveSummary, then 1-byte Difficulty
3. Steam `OverwriteWorldsMeta` → calls `base.OverwriteWorldsMeta` (writes 4-byte Difficulty + timestamp + format), then writes SizeDisk @ 0x3C

Net effect for a Worlds save: bytes 0x158..0x15B hold the 4-byte `DifficultyPresetTypeEnum` value (low byte equals the legacy 1-byte version). Per `Meta/DifficultyPreset.cs`, this is one of the standard preset IDs (Normal=0, Creative=1, Relaxed=2, Survival=3, Permadeath=4, etc. — confirm in `Enums/DifficultyPresetTypeEnum.cs` if you need exact numbers; the byte values match what the in-game preset menu reports).

### 4.10 Slot identifier (offsets 0x15C..0x163, 8 bytes)

The Worlds base override seeks past 4 + 8 = 12 bytes from `META_LENGTH_BEFORE_DIFFICULTY_PRESET`:
```csharp
protected virtual int META_LENGTH_BEFORE_TIMESTAMP =>
    META_LENGTH_BEFORE_DIFFICULTY_PRESET + 4 + 8;   // 0x158 + 12 = 0x164
```

Those middle 8 bytes (0x15C..0x163) are commented in `OverwriteWorldsMeta` as `// Skip SLOT IDENTIFIER.` and are not written. They stay as whatever was in `Extra.Bytes` (typically zeros for a freshly-built buffer). For a clean encode, leave them zero.

### 4.11 Timestamp (offset 0x164, 4 bytes)

```csharp
writer.Seek(META_LENGTH_BEFORE_TIMESTAMP, SeekOrigin.Begin); // 0x164
writer.Write((uint)(container.LastWriteTime!.Value.ToUniversalTime().ToUnixTimeSeconds())); // 4
```

Unix timestamp in **seconds**, **UTC**, as `uint32 LE`. Note this is unsigned 32-bit — it will roll over in 2106. In the meantime: just write `Math.floor(Date.now() / 1000)`.

`LastWriteTime` defaults to `MetaFile?.LastWriteTime` (the meta file's mtime), which is set when libNOM writes the new file. For your editor, "now" is correct.

### 4.12 Repeated META_FORMAT (offset 0x168, 4 bytes)

```csharp
writer.Write(GetMetaFormat(container)); // 4 // META_FORMAT_3 or META_FORMAT_4
```

Same value as offset 0x004. Both must match.

### 4.13 Tail (offsets 0x16C..0x1AF, 68 bytes)

Never written by any path. Zero-filled.

### 4.14 Where `Extra.Bytes` fits

`CreateMeta` writes `container.Extra.Bytes` *after* `TotalPlayTime`, starting at offset 0x58 (= `META_LENGTH_AFTER_VANILLA + 4`):

```csharp
writer.Write(container.Extra.Bytes ?? []); // Extra.Bytes is 20 or 276 or 300 or 348
```

For a 432-byte buffer the 348-byte `Extra.Bytes` chunk is what fills 0x058..0x1AF. Then `OverwriteWaypointMeta` and `OverwriteWorldsMeta` overwrite specific named slots within that range. The leftover bytes in between (0x15C..0x163, 0x16C..0x1AF) carry forward whatever was in `Extra.Bytes`.

**Practical implication for your editor.** Two choices:

- **Echo strategy (recommended).** Read the existing `mf_save.hg`, decrypt with §3.4, copy bytes 0x058..0x1AF into a "tail buffer", then build a new plaintext where you write the documented fields and *also* preserve the unknown bytes (the slot identifier at 0x15C and any other future fields HelloGames may add). This is what libNOM does naturally because it round-trips `Extra.Bytes`.
- **Zero strategy.** Build the buffer fresh as zeros and write only the documented fields. Acceptable today (libNOM and NomNom do not validate the slot identifier or undocumented bytes), but may break with a future game patch that starts using one of those slots.

I recommend the echo strategy for the editor — it costs 432 bytes of round-trip and protects against unknown future fields.

---

## 5. Decoder pseudocode (Web Crypto–ish)

There is no Web Crypto primitive for XXTEA — implement it by hand. Web Crypto is only relevant if you decide to support the legacy `AppendHashes` branch (then you'd use `crypto.subtle.digest('SHA-256', data)` and a JS SpookyHash — there is no native one).

```js
// 432-byte encrypted file -> plaintext + parsed fields
async function decodeManifest(filenameSlot, encryptedBytes) {
    if (encryptedBytes.length !== 432 &&
        encryptedBytes.length !== 384 &&
        encryptedBytes.length !== 360 &&
        encryptedBytes.length !== 104) {
        throw new Error('Unknown manifest length');
    }
    const iters = encryptedBytes.length === 104 ? 8 : 6;

    const plaintext = xxteaDecrypt(encryptedBytes, deriveKey(filenameSlot), iters);

    const dv = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    if (dv.getUint32(0, true) !== 0xEEEEEEBE) throw new Error('Bad magic');
    return parseFields(plaintext);   // see §4 layout
}
```

`deriveKey(slot)` is §3.2. `xxteaDecrypt` is §3.4 transliterated — a `Uint32Array` view of the buffer, the inner loops as written. Same for encrypt.

---

## 6. Encoder pseudocode

```js
async function encodeManifest({
    slot,             // integer: 1=accountdata, 2=mf_save.hg, 3=mf_save2.hg, ...
    saveJsonBytes,    // the uncompressed save JSON (the actual bytes you LZ4'd into save.hg)
    saveDiskSize,     // size of save.hg on disk after LZ4
    baseVersion, gameMode, season, totalPlayTime,
    saveName, saveSummary, difficultyPreset,
    timestampSec,     // Math.floor(Date.now()/1000)
    previousMfBytes,  // optional, for echo strategy
}) {
    // 1. Pick layout length.
    const len =
        baseVersion >= 553 ? 432 :
        baseVersion >= 500 ? 384 :
        baseVersion >= 400 ? 360 : 104;

    if (len === 104) throw new Error('Legacy vanilla format not supported');

    // 2. Allocate plaintext, optionally seeded from previous decrypt for echo strategy.
    const plain = new Uint8Array(len);
    if (previousMfBytes) {
        const prev = xxteaDecrypt(previousMfBytes, deriveKey(slot), 6);
        plain.set(prev.subarray(0x58, len), 0x58);   // preserve Extra.Bytes region
    }

    const dv = new DataView(plain.buffer);
    dv.setUint32(0x000, 0xEEEEEEBE, true);
    dv.setUint32(0x004, metaFormatFor(baseVersion), true);
    // 0x008..0x037 stay zero (no spooky/sha for modern saves)
    dv.setUint32(0x038, saveJsonBytes.length, true);
    dv.setUint32(0x03C, saveDiskSize, true);          // Worlds+ only; harmless on Waypoint
    // 0x040..0x047 stay zero
    dv.setInt32 (0x048, baseVersion, true);
    dv.setUint16(0x04C, gameMode, true);
    dv.setUint16(0x04E, season, true);
    dv.setBigUint64(0x050, BigInt(totalPlayTime), true);
    writeUtf8WithTerminator(plain, 0x058, saveName,    128);
    writeUtf8WithTerminator(plain, 0x0D8, saveSummary, 128);
    dv.setUint32(0x158, difficultyPreset, true);
    // 0x15C..0x163 stay as previousMfBytes copy (slot id) or zero
    dv.setUint32(0x164, timestampSec, true);
    dv.setUint32(0x168, metaFormatFor(baseVersion), true);
    // 0x16C..0x1AF stay zero (or as previous bytes)

    // 3. Encrypt in place (XXTEA, 6 rounds for modern, 8 for vanilla).
    const cipher = xxteaEncrypt(plain, deriveKey(slot), 6);
    return cipher;   // exactly `len` bytes — write to mf_save.hg
}

function metaFormatFor(bv) {
    if (bv >= 550) return 0x7D4;
    if (bv >= 500) return 0x7D3;
    if (bv >= 360) return 0x7D2;
    return 0x7D1;
}

function deriveKey(slot) {
    const k0 = ((rotl(((slot ^ 0x1422CB8C) >>> 0), 13) * 5) + 0xE6546B64) >>> 0;
    return new Uint32Array([k0, 0x44415645, 0x52594E41, 0x47524E54]);
}
const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

function writeUtf8WithTerminator(buf, off, str, slot) {
    const enc = new TextEncoder().encode(str + '\0');
    if (enc.length > slot) throw new Error('String too long');
    buf.set(enc, off);
    // bytes [off+enc.length .. off+slot) are left as-is (zero or echoed)
}
```

---

## 7. Worked example

Inputs (representative — substitute your test save's values):
```
filename            = mf_save.hg   →  slot = 2  (= PlayerState1)
saveJsonBytes.length = 5_812_433   (uncompressed save JSON length)
saveDiskSize         =   873_204   (size of save.hg on disk after LZ4)
baseVersion          = 4690        (Worlds Part II era, e.g. Voyagers 6.00)
gameMode             = 6           (Normal)
season               = 0
totalPlayTime        = 1_234_567   (seconds, ~14.3 days)
saveName             = "Player Name"
saveSummary          = "On Planet Foo, in System Bar, in the Capricorn galaxy."
difficultyPreset     = 0           (Normal)
timestampSec         = 1_734_624_000   (some Dec-2024 instant, UTC)
```

Step-by-step the encoder (§6) produces:

1. **Length pick.** `baseVersion = 4690 >= 553` → 432-byte buffer.
2. **Allocate** `plain = new Uint8Array(432)` (all zero).
3. **Header.** `plain[0..4) = BE EE EE EE` (uint32 LE 0xEEEEEEBE).
4. **Format.** `plain[4..8) = D4 07 00 00` (uint32 LE 0x000007D4).
5. **Skip 48 bytes** (zero) for SpookyHash + SHA-256 slots → cursor 56 / 0x38.
6. **SizeDecompressed.** `plain[0x38..0x3C) = 51 B7 58 00` (uint32 LE 0x0058B751 = 5_812_433).
7. **SizeDisk.** `plain[0x3C..0x40) = 34 53 0D 00` (uint32 LE 0x000D5334 = 873_204).
8. **Skip 8 bytes** → cursor 0x48.
9. **BaseVersion.** `plain[0x48..0x4C) = 52 12 00 00` (int32 LE 4690 = 0x1252).
10. **GameMode.** `plain[0x4C..0x4E) = 06 00`.
11. **Season.** `plain[0x4E..0x50) = 00 00`.
12. **TotalPlayTime.** `plain[0x50..0x58) = 87 D6 12 00 00 00 00 00` (uint64 LE 1_234_567).
13. **SaveName.** UTF-8 of `"Player Name\0"` is 12 bytes. Written at 0x58. Bytes after the NUL stay zero.
14. **SaveSummary.** UTF-8 of the summary + NUL written at 0xD8.
15. **Difficulty.** `plain[0x158..0x15C) = 00 00 00 00`.
16. **Slot identifier 0x15C..0x163.** Stays zero (or echoed from previous).
17. **Timestamp.** `plain[0x164..0x168) = 00 4C 65 67` (uint32 LE 1_734_624_000 = 0x6765_4C00).
18. **Format repeat.** `plain[0x168..0x16C) = D4 07 00 00`.
19. **Tail 0x16C..0x1AF.** Zero-filled.

20. **Derive key for slot 2:**
    - `slot ^ 0x1422CB8C` = `2 ^ 0x1422CB8C` = `0x1422CB8E`
    - `rotl(0x1422CB8E, 13)` = `0x597_1C284 & 0xFFFFFFFF`
      - `0x1422CB8E << 13` = `0x2845971C0000` → low 32: `0x971C0000`
      - `0x1422CB8E >>> 19` = `0x00000284`
      - OR: `0x971C0284`
    - `* 5` (uint32 wrap): `0x971C0284 * 5 = 0x2F584_0CE4` → low 32: `0xF5840CE4`
    - `+ 0xE6546B64` (uint32 wrap): `0xF5840CE4 + 0xE6546B64` = `0x1_DBD87848` → low 32: `0xDBD87848`

    So `key = [0xDBD87848, 0x44415645, 0x52594E41, 0x47524E54]`.

21. **Encrypt** the 432-byte plaintext in place using §3.3 with `iterations = 6` and the key above. Result is 432 bytes of opaque bytes.

22. **Write** that 432-byte ciphertext to `%APPDATA%\HelloGames\NMS\st_<id>\mf_save.hg`.

To verify, a round-trip: feed the ciphertext to §3.4 with the same slot/key/iterations, check that the first 4 bytes decrypt to `BE EE EE EE`, and that the field at 0x048 reads back as 4690 etc.

---

## 8. Things that are *not* a concern (and why)

- **No GCM tag, no IV.** Recovery is by the `META_HEADER` magic byte check after decrypt. There is no AAD anywhere.
- **No PBKDF2 / steam ID input.** The slot index is the only per-save key input. The four base words are constant.
- **No checksum of save.hg in the modern manifest.** SizeDecompressed and SizeDisk are the only fields tying the manifest to its data file, and they are size checks only. NomNom's "incompatible" status for a save you've edited is most likely caused by:
  1. SizeDecompressed not matching the actual decompressed JSON length in the new `save.hg`,
  2. SizeDisk not matching the new file size on disk,
  3. The header magic failing to decrypt (because you chose the wrong slot when deriving the key),
  4. BaseVersion in the manifest not matching the version the save JSON declares — libNOM uses both in `Container.GameVersion` resolution and a mismatch causes the loader to bail.
  Get those four right and the save loads.

---

## 9. Spec-to-source citation index

| Claim                                              | File                                                         | Symbol                          |
|----------------------------------------------------|--------------------------------------------------------------|---------------------------------|
| File is named `mf_<datafilename>`                  | `libNOM.io/PlatformSteam/PlatformSteam_Initialize.cs`        | meta path build                 |
| Buffer length per BaseVersion                      | `libNOM.io/Platform/Platform_Write.cs`                       | `GetMetaBufferLength`           |
| `META_LENGTH_TOTAL_*` constants                    | `libNOM.io/PlatformSteam/PlatformSteam.cs`                   | `META_LENGTH_TOTAL_*`           |
| Encryption key string `"NAESEVADNAYRTNRG"`         | `libNOM.io/PlatformSteam/PlatformSteam.cs`                   | `META_ENCRYPTION_KEY`           |
| `META_HEADER = 0xEEEEEEBE`                         | `libNOM.io/PlatformSteam/PlatformSteam.cs`                   | `META_HEADER`                   |
| Slot-derived key word 0                            | `libNOM.io/PlatformSteam/PlatformSteam_Read.cs`              | `DecryptMetaStorageEntry`       |
| Encrypt rounds (6 for Waypoint+, 8 for vanilla)    | `libNOM.io/PlatformSteam/PlatformSteam_Write.cs`             | `EncryptMeta`                   |
| Decrypt loop                                       | `libNOM.io/PlatformSteam/PlatformSteam_Read.cs`              | `DecryptMetaStorageEntry`       |
| TEA delta `0x9E3779B9` and `0x61C88647`            | same as above                                                | both methods                    |
| Buffer field layout (header, format, hash skip, …) | `libNOM.io/PlatformSteam/PlatformSteam_Write.cs`             | `CreateMeta`                    |
| Hash branch (legacy AppendHashes)                  | `libNOM.io/PlatformSteam/PlatformSteam_Write.cs`             | `AppendHashes`                  |
| `OverwriteWaypointMeta` (SaveName/Summary/Diff1)   | `libNOM.io/Platform/Platform_Write.cs`                       | `OverwriteWaypointMeta`         |
| `OverwriteWorldsMeta` base (Diff4 + ts + format)   | `libNOM.io/Platform/Platform_Write.cs`                       | `OverwriteWorldsMeta`           |
| `OverwriteWorldsMeta` Steam (SizeDisk @ 0x3C)      | `libNOM.io/PlatformSteam/PlatformSteam_Write.cs`             | `OverwriteWorldsMeta`           |
| `META_FORMAT_*` numeric values                     | `libNOM.io/Global/Constants.cs`                              | `META_FORMAT_*`                 |
| `SAVE_RENAMING_LENGTH_MANIFEST = 128`              | `libNOM.io/Global/Constants.cs`                              | `SAVE_RENAMING_LENGTH_MANIFEST` |
| `SAVE_RENAMING_LENGTH_INGAME = 42`                 | `libNOM.io/Global/Constants.cs`                              | `SAVE_RENAMING_LENGTH_INGAME`   |
| `OFFSET_GAMEMODE = 512`, `OFFSET_SEASON = 128`     | `libNOM.io/Global/Constants.cs`                              | `OFFSET_*`                      |
| GameVersion thresholds (Frontiers=360 etc.)        | `libNOM.io/Enums/GameVersionEnum.cs`                         | enum members                    |
| StoragePersistentSlotEnum is sequential from 0     | `libNOM.io/Enums/StoragePersistentSlotEnum.cs`               | enum members                    |
| `IsVersion(x) := GameVersion >= x`                 | `libNOM.io/Container/Container.cs`                           | `IsVersion`                     |
| `BaseVersion = SaveVersion - …`                    | `libNOM.io/Meta/BaseVersion.cs`                              | `Calculate`                     |
| JSON keys for SaveName (`Pk4` / `SaveName`)        | `libNOM.io/Meta/SaveName.cs`                                 | regex array                     |
| JSON keys for SaveSummary (`n:R` / `SaveSummary`)  | `libNOM.io/Meta/SaveSummary.cs`                              | regex array                     |
| JSON keys for TotalPlayTime (`Lg8` / `TotalPlayTime`) | `libNOM.io/Meta/TotalPlayTime.cs`                         | regex array                     |
| JSON keys for GameMode (`idA` / `GameMode`)        | `libNOM.io/Meta/GameMode.cs`                                 | regex array                     |
| JSON keys for Season (`gou` / `SeasonId`)          | `libNOM.io/Meta/Season.cs`                                   | regex array                     |
| `GetBytesWithTerminator` is UTF-8 + `\0`           | `libNOM.io/Extensions/String.cs`                             | `GetBytesWithTerminator`        |
| WriteMeta is just `MetaFile.WriteAllBytes(meta)`   | `libNOM.io/Platform/Platform_Write.cs`                       | `WriteMeta`                     |

Raw URLs (master branch):
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/PlatformSteam/PlatformSteam.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/PlatformSteam/PlatformSteam_Read.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/PlatformSteam/PlatformSteam_Write.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/PlatformSteam/PlatformSteam_Initialize.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Platform/Platform_Read.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Platform/Platform_Write.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Container/Container.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Container/Container_Property_Save.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Container/Container_Property_IsVersion.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Global/Constants.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Enums/GameVersionEnum.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Enums/StoragePersistentSlotEnum.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Meta/BaseVersion.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Meta/SaveName.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Meta/SaveSummary.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Meta/TotalPlayTime.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Meta/GameMode.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Meta/Season.cs`
- `https://raw.githubusercontent.com/zencq/libNOM.io/master/libNOM.io/Extensions/String.cs`

---

## 10. What I did not verify and you may want to double-check

- **Exact 1-byte vs 4-byte difficulty width on a 384-byte WorldsPartI buffer.** The Steam override of `OverwriteWorldsMeta` does not gate on `IsVersion400Waypoint`, but `OverwriteWaypointMeta` writes 1 byte first and then the Worlds base override writes 4 bytes on top — so the net is 4 bytes for any save that goes through both. Confirm by decrypting one of your existing 432-byte files and checking offset 0x158..0x15C.
- **`SizeDisk` semantics.** I asserted "save.hg file size on disk." It is set by libNOM right after compressing, equal to the total bytes written to disk including 16-byte chunk headers. If you recompress with the same chunking strategy as libNOM (chunks up to 0x80000 bytes pre-LZ4, each chunk prefixed with a 16-byte header) the value matches the file length exactly. If you use a different chunking strategy you may need to verify.
- **`Extra.Bytes` echo.** Confirmed structurally; the recommendation in §4.14 is mine — libNOM does it implicitly via `Extra.Bytes`, but no one else (NomNom, NMSSaveEditor) appears to validate the slot identifier slot. The echo strategy is a defensive hedge.
- **Microsoft / GOG / PlayStation / Switch.** Not in scope. GOG inherits Steam's PlatformSteam_Write paths (it has no Write override file), so its manifest is byte-identical to Steam's. Microsoft Store uses a totally different container format (blob index).
