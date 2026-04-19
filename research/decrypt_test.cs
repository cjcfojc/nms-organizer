// Standalone C# transliteration of libNOM's PlatformSteam DecryptMetaStorageEntry
// + EncryptMeta. No NuGet, no Span<T>, .NET Framework 4 compatible. Can be
// compiled with C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
//
// Usage: decrypt_test.exe <mf_save.hg path> <slot> <iterations>

using System;
using System.IO;
using System.Text;

class DecryptTest {
    static readonly uint[] META_ENCRYPTION_KEY = LoadKeyFromAscii("NAESEVADNAYRTNRG");
    const uint META_HEADER = 0xEEEEEEBE;

    static uint[] LoadKeyFromAscii(string s) {
        var bytes = Encoding.ASCII.GetBytes(s);
        var u = new uint[bytes.Length / 4];
        for (int i = 0; i < u.Length; i++) {
            u[i] = (uint)(bytes[i*4] | (bytes[i*4+1] << 8) | (bytes[i*4+2] << 16) | (bytes[i*4+3] << 24));
        }
        return u;
    }

    static uint RotateLeft(uint self, int bits) {
        return (self << bits) | (self >> (32 - bits));
    }

    static uint[] BytesToUints(byte[] b) {
        var u = new uint[b.Length / 4];
        for (int i = 0; i < u.Length; i++) {
            u[i] = (uint)(b[i*4] | (b[i*4+1] << 8) | (b[i*4+2] << 16) | (b[i*4+3] << 24));
        }
        return u;
    }

    static byte[] UintsToBytes(uint[] u) {
        var b = new byte[u.Length * 4];
        for (int i = 0; i < u.Length; i++) {
            b[i*4 + 0] = (byte)(u[i] & 0xFF);
            b[i*4 + 1] = (byte)((u[i] >> 8) & 0xFF);
            b[i*4 + 2] = (byte)((u[i] >> 16) & 0xFF);
            b[i*4 + 3] = (byte)((u[i] >> 24) & 0xFF);
        }
        return b;
    }

    // Verbatim transliteration of libNOM's DecryptMetaStorageEntry.
    static uint[] DecryptMetaStorageEntry(uint storage, int iterations, int lastIndex, uint[] meta) {
        uint[] key = new uint[] {
            (RotateLeft(storage ^ 0x1422CB8C, 13) * 5) + 0xE6546B64,
            META_ENCRYPTION_KEY[1], META_ENCRYPTION_KEY[2], META_ENCRYPTION_KEY[3]
        };
        uint[] result = (uint[])meta.Clone();
        uint hash = 0;
        for (int i = 0; i < iterations; i++) hash += 0x9E3779B9;
        for (int i = 0; i < iterations; i++) {
            uint current = result[0];
            int keyIndex = (int)(hash >> 2 & 3);
            int valueIndex = lastIndex;
            for (int j = lastIndex; j > 0; j--, valueIndex--) {
                result[valueIndex] -= (((current >> 3) ^ (result[valueIndex - 1] << 4)) + ((current * 4) ^ (result[valueIndex - 1] >> 5))) ^ ((result[valueIndex - 1] ^ key[(j & 3) ^ keyIndex]) + (current ^ hash));
                current = result[valueIndex];
            }
            valueIndex = lastIndex;
            result[0] -= (((current >> 3) ^ (result[valueIndex] << 4)) + ((current * 4) ^ (result[valueIndex] >> 5))) ^ ((result[valueIndex] ^ key[keyIndex]) + (current ^ hash));
            hash += 0x61C88647;
        }
        return result;
    }

    // Verbatim transliteration of libNOM's EncryptMeta.
    static uint[] EncryptMeta(uint storage, int iterations, uint[] meta) {
        uint current = 0;
        uint hash = 0;
        uint[] key = new uint[] {
            (RotateLeft(storage ^ 0x1422CB8C, 13) * 5) + 0xE6546B64,
            META_ENCRYPTION_KEY[1], META_ENCRYPTION_KEY[2], META_ENCRYPTION_KEY[3]
        };
        uint[] result = (uint[])meta.Clone();
        int lastIndex = result.Length - 1;
        for (int i = 0; i < iterations; i++) {
            hash += 0x9E3779B9;
            int keyIndex = (int)((hash >> 2) & 3);
            int valueIndex = 0;
            for (int j = 0; j < lastIndex; j++, valueIndex++) {
                result[valueIndex] += (((result[valueIndex + 1] >> 3) ^ (current << 4)) + ((result[valueIndex + 1] * 4) ^ (current >> 5))) ^ ((current ^ key[(j & 3) ^ keyIndex]) + (result[valueIndex + 1] ^ hash));
                current = result[valueIndex];
            }
            result[lastIndex] += (((result[0] >> 3) ^ (current << 4)) + ((result[0] * 4) ^ (current >> 5))) ^ ((current ^ key[(lastIndex & 3) ^ keyIndex]) + (result[0] ^ hash));
            current = result[lastIndex];
        }
        return result;
    }

    static void Main(string[] args) {
        Console.WriteLine("META_ENCRYPTION_KEY[0] = 0x{0:X8}", META_ENCRYPTION_KEY[0]);
        Console.WriteLine("META_ENCRYPTION_KEY[1] = 0x{0:X8}", META_ENCRYPTION_KEY[1]);
        Console.WriteLine("META_ENCRYPTION_KEY[2] = 0x{0:X8}", META_ENCRYPTION_KEY[2]);
        Console.WriteLine("META_ENCRYPTION_KEY[3] = 0x{0:X8}", META_ENCRYPTION_KEY[3]);

        if (args.Length < 1) {
            // No file — run a self-test
            Console.WriteLine("\nSelf-test: encrypt+decrypt round-trip on synthetic 432-byte buffer");
            var plain = new byte[432];
            // Set magic header
            plain[0] = 0xBE; plain[1] = 0xEE; plain[2] = 0xEE; plain[3] = 0xEE;
            // META_FORMAT 0x7D4
            plain[4] = 0xD4; plain[5] = 0x07;
            uint slot = 2;
            int iters = 6;
            var plainU = BytesToUints(plain);
            var enc = EncryptMeta(slot, iters, plainU);
            var dec = DecryptMetaStorageEntry(slot, iters, enc.Length - 1, enc);
            Console.WriteLine("decrypted[0] = 0x{0:X8}  (expect EEEEEEBE)", dec[0]);
            Console.WriteLine("decrypted[1] = 0x{0:X8}  (expect 7D4)", dec[1]);
            Console.WriteLine("encrypted first 32 bytes:");
            var encB = UintsToBytes(enc);
            for (int i = 0; i < 32; i++) Console.Write(encB[i].ToString("X2") + " ");
            Console.WriteLine();
            return;
        }

        string filePath = args[0];
        uint slotArg = args.Length > 1 ? uint.Parse(args[1]) : 2;
        int itersArg = args.Length > 2 ? int.Parse(args[2]) : 6;

        var fileBytes = File.ReadAllBytes(filePath);
        Console.WriteLine("\nLoaded {0} bytes from {1}", fileBytes.Length, filePath);
        Console.WriteLine("First 32 bytes:");
        for (int i = 0; i < 32; i++) Console.Write(fileBytes[i].ToString("X2") + " ");
        Console.WriteLine();

        var fileU = BytesToUints(fileBytes);
        var dec2 = DecryptMetaStorageEntry(slotArg, itersArg, fileU.Length - 1, fileU);
        Console.WriteLine("\nDecrypted with slot={0} iters={1}:", slotArg, itersArg);
        Console.WriteLine("  result[0] = 0x{0:X8}  (expect EEEEEEBE)", dec2[0]);
        Console.WriteLine("  result[1] = 0x{0:X8}  (expect 7D4)", dec2[1]);

        // Brute force slots 0..40
        Console.WriteLine("\nBrute force slots 0..40 with iters {6,8}:");
        int hits = 0;
        for (uint s = 0; s < 40; s++) {
            for (int it = 6; it <= 8; it += 2) {
                var d = DecryptMetaStorageEntry(s, it, fileU.Length - 1, fileU);
                if (d[0] == META_HEADER) {
                    Console.WriteLine("  HIT slot={0} iters={1}", s, it);
                    hits++;
                }
            }
        }
        Console.WriteLine("{0} hits", hits);
    }
}
