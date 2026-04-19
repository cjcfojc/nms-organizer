// Game-icon extractor.
//
// Reads icon_path from data/taxonomy.json, extracts the matching DDS files
// from NMSARC.TexUI.pak (HelloGames' HGPAK format) via hgpaktool, then
// converts each DDS (BC7_UNORM in this pak) to PNG via Microsoft DirectXTex's
// texconv. Writes:
//   app/assets/icons/<relative-dir>/<file>.png   one PNG per distinct icon
//   app/data/icons.json                          { item_id: "icons/.../foo.png" }
//
// Idempotent: skips DDS extraction and PNG conversion when targets already exist.
// Read-only against game files; never modifies the pak.
//
// Path discovery (in priority order):
//   1. CLI flags:        --install <NMS root>   --hgpaktool <path>
//   2. Config file:      nmsorganizer.config.json (written by the setup wizard)
//   3. Environment vars: NMS_INSTALL, HGPAKTOOL
//   4. Auto-detect:      Steam library scan (Windows) + AMUMSS install scan
//
// On Linux/macOS only the manual paths are honored — there's no Proton-compat
// shortcut in this script (the PCBANKS path is the same once you point at it).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── Constants ────────────────────────────────────────────────────────────────

const REPO_ROOT     = __dirname;
const TAXONOMY      = path.resolve(REPO_ROOT, 'app/data/taxonomy.json');
const TEXCONV       = path.resolve(REPO_ROOT, 'tools/texconv.exe');
const EXTRACT_DIR   = path.resolve(REPO_ROOT, 'extracted/ICONS');
const PNG_OUT_ROOT  = path.resolve(REPO_ROOT, 'app/assets/icons');
const MANIFEST_OUT  = path.resolve(REPO_ROOT, 'app/data/icons.json');
const SPEC_JSON     = path.resolve(REPO_ROOT, 'extracted/icons_spec.json');
const CONFIG_FILE   = path.resolve(REPO_ROOT, 'nmsorganizer.config.json');

const PAK_RELATIVE  = 'GAMEDATA/PCBANKS/NMSARC.TexUI.pak';
const MANIFEST_PREFIX = 'icons';

// ── Path discovery ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--install'   && argv[i+1]) { out.install   = argv[++i]; }
    else if (a === '--hgpaktool' && argv[i+1]) { out.hgpaktool = argv[++i]; }
    else if (a === '--help' || a === '-h')      { out.help = true; }
  }
  return out;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

// Walk a Steam library file (libraryfolders.vdf) to enumerate library roots.
// Returns absolute paths to each "<library>/steamapps/common".
function scanSteamLibraries() {
  if (process.platform !== 'win32') return [];
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam', 'steamapps'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Steam', 'steamapps'),
  ].filter(Boolean);

  const libraries = new Set();
  for (const root of candidates) {
    const vdf = path.join(root, 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libraries.add(root);
    const text = fs.readFileSync(vdf, 'utf8');
    // Crude VDF parse — pull every "path" "<value>" pair.
    for (const m of text.matchAll(/"path"\s*"([^"]+)"/g)) {
      libraries.add(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps'));
    }
  }
  return [...libraries].map(p => path.join(p, 'common'));
}

function findNmsInstall(explicit) {
  if (explicit && fs.existsSync(path.join(explicit, PAK_RELATIVE))) return explicit;
  for (const common of scanSteamLibraries()) {
    const guess = path.join(common, "No Man's Sky");
    if (fs.existsSync(path.join(guess, PAK_RELATIVE))) return guess;
  }
  return null;
}

function findHgpaktool(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  // Common AMUMSS install roots
  if (process.platform === 'win32') {
    for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:']) {
      candidates.push(path.join(drive, '\\Amumss', 'MODBUILDER', 'hgpaktool.exe'));
      candidates.push(path.join(drive, '\\AMUMSS', 'MODBUILDER', 'hgpaktool.exe'));
    }
  }
  candidates.push(path.join(REPO_ROOT, 'tools', 'hgpaktool.exe'));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);
if (args.help) {
  console.log(`Usage: node extract_icons.js [--install <NMS root>] [--hgpaktool <path>]

Extracts UI icons from your local NMS install for the in-app item display.
Auto-detects Steam install + AMUMSS hgpaktool when possible.

  --install      override NMS install root (folder containing GAMEDATA/PCBANKS/)
  --hgpaktool    override path to hgpaktool.exe (from AMUMSS or zencq/HGPak)

Paths can also be set persistently in ${path.basename(CONFIG_FILE)} or
via the NMS_INSTALL / HGPAKTOOL environment variables.`);
  process.exit(0);
}

const config = loadConfig();
const nmsInstall = findNmsInstall(args.install || config.nms_install || process.env.NMS_INSTALL);
const hgpaktool  = findHgpaktool(args.hgpaktool || config.hgpaktool || process.env.HGPAKTOOL);

if (!nmsInstall) {
  console.error(`Could not locate NMS install. Tried CLI flag, ${path.basename(CONFIG_FILE)}, NMS_INSTALL env, Steam library scan.

Provide it manually:
  node extract_icons.js --install "C:/SteamLibrary/steamapps/common/No Man's Sky"
`);
  process.exit(1);
}
if (!hgpaktool) {
  console.error(`Could not locate hgpaktool.exe. Required to read HelloGames' HGPAK archives.

Get it from one of:
  - AMUMSS bundle:           https://github.com/HolterPhylo/AMUMSS  (MODBUILDER/hgpaktool.exe)
  - Standalone zencq/HGPak:  https://github.com/zencq/HGPak/releases

Then either:
  - Drop the binary at ${path.join(REPO_ROOT, 'tools', 'hgpaktool.exe')}
  - Or pass the path: node extract_icons.js --hgpaktool "/path/to/hgpaktool.exe"
`);
  process.exit(1);
}
const PAK_PATH = path.join(nmsInstall, PAK_RELATIVE);
if (!fs.existsSync(PAK_PATH))  { console.error(`MISSING TexUI pak inside ${nmsInstall}: ${PAK_PATH}`); process.exit(1); }
if (!fs.existsSync(TEXCONV))   { console.error(`MISSING texconv: ${TEXCONV}\nThis ships with the repo at tools/texconv.exe — your checkout may be incomplete.`); process.exit(1); }
if (!fs.existsSync(TAXONOMY))  { console.error(`MISSING taxonomy: ${TAXONOMY}`); process.exit(1); }

console.log(`NMS install: ${nmsInstall}`);
console.log(`hgpaktool:   ${hgpaktool}`);
console.log(`taxonomy:    ${TAXONOMY}`);

// ── 1. collect distinct icon paths from taxonomy ────────────────────────────

const tax = JSON.parse(fs.readFileSync(TAXONOMY, 'utf8'));
const idToIconPath = new Map();   // item_id → lowercase relative path inside pak
const distinctIcons = new Set();
for (const r of tax.records) {
  if (!r.icon_path) continue;
  const p = r.icon_path.toLowerCase();
  idToIconPath.set(r.id, p);
  distinctIcons.add(p);
}
console.log(`taxonomy: ${tax.records.length} records, ${idToIconPath.size} with icons, ${distinctIcons.size} distinct icon files`);

// ── 2. write hgpaktool extraction spec ──────────────────────────────────────

const spec = { [PAK_PATH]: [...distinctIcons] };
fs.mkdirSync(path.dirname(SPEC_JSON), { recursive: true });
fs.writeFileSync(SPEC_JSON, JSON.stringify(spec, null, 2));
console.log(`wrote spec: ${SPEC_JSON} (${distinctIcons.size} files requested)`);

// ── 3. run hgpaktool to extract DDS ─────────────────────────────────────────

const ddsTargetPath = (innerPath) => path.join(EXTRACT_DIR, ...innerPath.split('/'));
const missingDds = [...distinctIcons].filter(p => !fs.existsSync(ddsTargetPath(p)));

if (missingDds.length === 0) {
  console.log(`all ${distinctIcons.size} DDS already extracted - skipping hgpaktool step`);
} else {
  console.log(`extracting ${missingDds.length} DDS via hgpaktool ...`);
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  const t0 = Date.now();
  const res = spawnSync(hgpaktool, ['-U', '-O', EXTRACT_DIR, SPEC_JSON], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (res.status !== 0) { console.error(`hgpaktool exited ${res.status}`); process.exit(1); }
  console.log(`hgpaktool finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const stillMissing = [...distinctIcons].filter(p => !fs.existsSync(ddsTargetPath(p)));
if (stillMissing.length) {
  console.error(`ERROR: ${stillMissing.length} DDS still missing after extract. First 5:`);
  for (const m of stillMissing.slice(0, 5)) console.error('  ' + m);
  process.exit(1);
}

// ── 4. convert DDS → PNG via texconv ────────────────────────────────────────

// Strip the "textures/ui/frontend/icons/" prefix so the on-disk tree is shorter.
const pngRelative = (innerPath) => {
  const prefix = 'textures/ui/frontend/icons/';
  const p = innerPath.startsWith(prefix) ? innerPath.slice(prefix.length) : innerPath;
  return p.replace(/\.dds$/i, '.png');
};
const pngTargetPath = (innerPath) => path.join(PNG_OUT_ROOT, ...pngRelative(innerPath).split('/'));

const toConvert = [...distinctIcons].filter(p => !fs.existsSync(pngTargetPath(p)));
console.log(`PNG conversion: ${distinctIcons.size - toConvert.length} cached, ${toConvert.length} to convert`);

if (toConvert.length) {
  // Group by output directory; texconv takes a single -o per call. Cap each
  // batch at 200 files so the command line stays under Windows' limit.
  const groups = new Map();
  for (const inner of toConvert) {
    const outDir = path.dirname(pngTargetPath(inner));
    if (!groups.has(outDir)) groups.set(outDir, []);
    groups.get(outDir).push(ddsTargetPath(inner));
  }
  let done = 0;
  for (const [outDir, files] of groups) {
    fs.mkdirSync(outDir, { recursive: true });
    for (let i = 0; i < files.length; i += 200) {
      const batch = files.slice(i, i + 200);
      const res = spawnSync(TEXCONV, ['-nologo', '-ft', 'png', '-o', outDir, '-y', ...batch], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      if (res.status !== 0) {
        console.error(`texconv failed (status ${res.status}) for batch in ${outDir}`);
        process.stderr.write(res.stdout || '');
        process.exit(1);
      }
      done += batch.length;
      process.stdout.write(`\r  converted ${done}/${toConvert.length}     `);
    }
  }
  process.stdout.write('\n');
}

// ── 5. write manifest ───────────────────────────────────────────────────────

const ddsWithoutPng = [...distinctIcons].filter(p => !fs.existsSync(pngTargetPath(p)));
if (ddsWithoutPng.length) {
  console.error(`ERROR: ${ddsWithoutPng.length} DDS have no PNG output. First 5:`);
  for (const m of ddsWithoutPng.slice(0, 5)) console.error('  ' + m);
  process.exit(1);
}

const manifest = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source_pak: 'NMSARC.TexUI.pak',
  source_libmbin_version: tax.source_libmbin_version,
  total_items_with_icons: idToIconPath.size,
  total_distinct_icons: distinctIcons.size,
  // path_prefix tells the UI loader what to prepend before each manifest value
  // (we keep values relative so the manifest is portable across deploy paths).
  path_prefix: MANIFEST_PREFIX,
  icons: {},
};
for (const [id, ddsPath] of idToIconPath) manifest.icons[id] = pngRelative(ddsPath);
fs.mkdirSync(path.dirname(MANIFEST_OUT), { recursive: true });
fs.writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2));

console.log(`\nwrote manifest: ${MANIFEST_OUT}`);
console.log(`  ${idToIconPath.size} item -> icon mappings`);
console.log(`  ${distinctIcons.size} distinct PNG files in ${PNG_OUT_ROOT}`);
