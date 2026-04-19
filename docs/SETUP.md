# Setup

The detailed first-run walkthrough. The setup wizard handles all of this automatically; this page exists for when you want to know what's actually happening or need to fix something manually.

## Prerequisites

- **Node.js** — any LTS release. [Download](https://nodejs.org/).
- **A modern browser** — Chrome, Edge, Brave, or Firefox. The app uses standard web APIs (no plugin required).
- **A No Man's Sky save** to work on. Steam version, latest release.
- **(Optional) hgpaktool.exe** — for icon extraction. See below.

## Wizard steps

When you launch the app for the first time and your browser hits `http://localhost:8765`, the server notices there's no `nmsorganizer.config.json` yet and serves the wizard instead of the main app.

### 1 — Welcome
Reminds you that this only supports the latest NMS release and to keep manual backups. Nothing to confirm.

### 2 — Save folder
The server scans `%APPDATA%\HelloGames\NMS` (Windows), or the platform equivalent on macOS / Linux. Should detect `st_<your steam id>/` automatically. If it doesn't, your NMS isn't installed where the wizard expects, or you're on a platform we don't auto-detect — the app will still run but `OPEN SAVE` will fall back to the OS file picker.

### 3 — NMS install
Used by icon extraction only. The server scans `libraryfolders.vdf` from your Steam install to enumerate all your Steam libraries, then looks for `No Man's Sky/GAMEDATA/PCBANKS/NMSARC.TexUI.pak` in each. If it's there, you're done. If not (e.g. NMS installed in a non-Steam location), paste the path manually and click `VERIFY`.

### 4 — hgpaktool
HelloGames packs game assets into `.pak` archives. `hgpaktool.exe` is the tool that reads them. We can't bundle it because it's GPLv3 and this repo is MIT.

The wizard checks common AMUMSS install paths first. If you have AMUMSS, it'll find it.

If you don't, download from [zencq/HGPak releases](https://github.com/zencq/HGPak/releases) and either:
- Drop the binary at `tools/hgpaktool.exe` in this repo, or
- Click `Set manually` in the wizard, paste the path, click `VERIFY`.

You can skip this step entirely. The app works fine without icons — you'll see colored category badges instead of game art.

### 5 — Icons
If hgpaktool is set up, this step extracts ~1,627 icon DDS files from `NMSARC.TexUI.pak` and converts them to PNG via `tools/texconv.exe` (Microsoft DirectXTex, MIT). Takes 1–2 minutes. The output (~125MB) lands in `app/assets/icons/`.

Live progress streams from the server via Server-Sent Events; you'll see every file as it's converted.

If you skip, you can run extraction later with `node extract_icons.js` from the command line.

### 6 — Done
Your config (`nmsorganizer.config.json`) is saved. Click `LAUNCH APP`. From here on, the server skips the wizard and goes straight to the app.

## Linux specifics

The auto-detection helpers in `serve.js` were written against Windows conventions. On Linux they degrade gracefully — `detectSteamLibraries()` and `detectHgpaktool()` return empty / null on non-Windows, and the wizard's NMS Install + hgpaktool steps fall through to the manual-input path.

What this means in practice:

- **Step 2 (Save folder)** auto-detects fine. The Steam Proton path is hardcoded as a fallback in `detectNmsRoot()`.
- **Step 3 (NMS install)** won't auto-detect. Paste your install path. Typical: `~/.local/share/Steam/steamapps/common/No Man's Sky` or `~/.steam/steam/steamapps/common/No Man's Sky` (if the symlink is set up).
- **Step 4 (hgpaktool)** won't auto-detect. AMUMSS is Windows software. Either run it through Wine and paste the path to the `.exe`, or download a standalone Wine-runnable build, or skip the icons step.
- **Step 5 (Icon extraction)** assumes `tools/texconv.exe` works. On Linux you'd need to run it via Wine too. Easiest path: skip icons.

If you want full Linux support added — Linux Steam library scan, Linux-native DDS converter (`texturetool` or similar) instead of texconv — open an issue. The hooks are in `serve.js::detectSteamLibraries()` and `extract_icons.js`.

## Re-running setup

Delete (or rename) `nmsorganizer.config.json` and refresh the browser tab. The wizard will reappear.

## Manual config

`nmsorganizer.config.json` is plain JSON. You can edit it by hand:

```json
{
  "nms_install":     "C:/SteamLibrary/steamapps/common/No Man's Sky",
  "hgpaktool":       "C:/Amumss/MODBUILDER/hgpaktool.exe",
  "setup_completed": true,
  "setup_completed_at": "2026-04-19T22:30:00.000Z"
}
```

Restart the server to pick up changes.
