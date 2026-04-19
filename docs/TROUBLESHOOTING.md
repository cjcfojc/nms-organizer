# Troubleshooting

## "Save loaded but the chests look the same in-game"

Your slot might have an autosave + manual save pair where one is older than what we wrote. NMS loads whichever of the two is newer. If you wrote `save5.hg` (slot 3 autosave) but `save6.hg` (slot 3 manual) is older, then the next time NMS autosaves it'll overwrite our changes.

Two fixes:
- After loading the modified save in NMS, immediately make a manual save in-game so both files of that slot reflect our changes.
- Or use **OVERWRITE ORIGINAL** which replaces the loaded file in place — same slot, same kind (auto/manual).

## "NomNom says incompatible"

Means the manifest checksum on disk doesn't match the save bytes. Should never happen with this app — we always emit save + manifest together as a pair. If you see this:

1. Check your NMS save folder — is there an orphan `save.hg` without a matching `mf_save.hg` (or vice versa)?
2. Check the apply audit log under `backups/` for the most recent run. It records both files' SHA-256 — confirm both made it to disk.
3. If both files are present and intact, share the latest `logs/session.*.jsonl` — there was a race condition or write failure we should know about.

## "Setup wizard can't find my NMS install"

Steam library scan reads `libraryfolders.vdf`. If you installed Steam to a non-default location or NMS isn't in any registered Steam library, the auto-scan won't find it.

Open the wizard's NMS Install step → click `Set manually` → paste the absolute path to the folder containing `GAMEDATA/PCBANKS/`. Click `VERIFY`.

The path looks like:
- Windows: `D:\SteamLibrary\steamapps\common\No Man's Sky`
- macOS: `~/Library/Application Support/Steam/steamapps/common/No Man's Sky`
- Linux (Proton): `~/.local/share/Steam/steamapps/common/No Man's Sky`

## "hgpaktool not found"

You need a copy of `hgpaktool.exe`. Two sources:

- AMUMSS bundle (most NMS modders have this): `C:\Amumss\MODBUILDER\hgpaktool.exe` (or other drive). The wizard auto-scans `C:` through `G:` for `Amumss` / `AMUMSS` folders.
- Standalone download: [zencq/HGPak releases](https://github.com/zencq/HGPak/releases). Drop at `tools/hgpaktool.exe` in this repo and the wizard picks it up next refresh.

Or skip the icons step entirely — app works fine with category badges.

## "Icons aren't showing in the audit grid"

Run `node extract_icons.js` from the command line to extract them. The wizard's icon step does the same thing.

If extraction succeeds but icons still don't show, check `app/data/icons.json` exists and has a non-empty `icons` field. Hard-refresh the browser (`Ctrl+Shift+R`) to reload the manifest.

## "I made a mistake — how do I revert?"

Every save you load is auto-backed-up to `backups/<name>.<timestamp>.<sha8>.bak` BEFORE any modification. The OVERWRITE flow makes an additional `<name>.<timestamp>.<sha8>.pre-overwrite.bak`.

To restore:
1. Find the right `.bak` file (timestamps in the filename).
2. Copy it to your NMS save folder, renaming to the original `save.hg` (or `save<N>.hg`).
3. You'll also need the matching manifest. The auto-backup is save bytes only, NOT the manifest. If you have NomNom installed, it can rebuild the manifest from save bytes. Otherwise, your in-NMS-folder manifest from the same time period should still match.

If the manifest is also gone or corrupt, NMS will refuse to load that slot. Use a different slot or restore from a Steam Cloud backup.

## "How do I share a bug report?"

Attach two things:

1. **The latest session log:** `logs/session.<latest-timestamp>.<pid>.jsonl`. This has every server action AND every browser event from your session, timestamped, structured. Both halves of the conversation in one file.

2. **The save that triggered the issue.** If sharing your save publicly is a privacy concern (your save reveals your in-game location, friend list, etc.), at minimum tell us:
   - The summary line from `mf_save.hg` (visible in the slot picker — e.g. "In the Parlungm system")
   - The total play time
   - The save version (NMS shows this in the load menu's bottom-left corner)

Open an issue on GitHub with both attached. Don't worry about formatting — just paste.

## "The browser shows a blank page"

Either the server isn't running or your browser doesn't trust `http://localhost`.

- Make sure the launcher window is still open. If you closed it, double-click `start.bat` (Windows) or run `./start.sh` (Mac/Linux) again.
- Check the launcher's terminal output for errors.
- Try `http://127.0.0.1:8765` instead of `http://localhost:8765`.
- If your browser auto-redirects HTTP to HTTPS, the redirect breaks because the server only speaks HTTP. Disable HTTPS-only mode for `localhost`.
