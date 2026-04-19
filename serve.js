// Minimal local server for the No Man's Organizer app.
// Reasons we need a real origin (not file://): browser File System Access API,
// ES module imports, and POST endpoints for backups + writes.
//
// Routes:
//   GET  /<file>          → serves files from ./app/ (path-traversal safe)
//   POST /backup          → writes raw save bytes to ./backups/<safe-name>
//                           Headers: X-NMSO-Filename: <suggested name>
//   POST /apply/audit     → writes a JSON apply audit log to ./backups/
//   GET  /nms/folder      → auto-detects %APPDATA%/HelloGames/NMS/ + lists st_* subfolders
//   GET  /nms/slots       → lists save<N>.hg / mf_save<N>.hg pairs in folder, with
//                           SaveSummary + last-write decoded from each manifest
//   GET  /nms/read        → returns the raw bytes of one NMS save file
//   POST /nms/write       → writes bytes to one NMS save file. Existing target is
//                           backed up to ./backups/ before overwrite.
//                           Headers: optional X-NMSO-Replace: 1 to allow overwrite.
//   POST /log             → ingest batched browser log entries into the session log
//   GET  /logs            → list session log files
//   GET  /logs/<file>     → download one session log file
//
// Zero npm deps. Node ≥ 18.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createLogger } = require('./lib/serverLog.js');

const PORT = Number(process.argv[2]) || 8765;
const APP_ROOT = path.resolve(__dirname, 'app');
const BACKUP_ROOT = path.resolve(__dirname, 'backups');
const LOGS_ROOT = path.resolve(__dirname, 'logs');
const CONFIG_FILE = path.resolve(__dirname, 'nmsorganizer.config.json');

function readConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return null; }
}
function writeConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return config;
}

// Auto-detect helpers (mirror extract_icons.js so the wizard and the CLI agree)
function detectSteamLibraries() {
  if (process.platform !== 'win32') return [];
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam', 'steamapps'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Steam', 'steamapps'),
  ].filter(Boolean);
  const libs = new Set();
  for (const root of candidates) {
    const vdf = path.join(root, 'libraryfolders.vdf');
    if (!fs.existsSync(vdf)) continue;
    libs.add(root);
    const text = fs.readFileSync(vdf, 'utf8');
    for (const m of text.matchAll(/"path"\s*"([^"]+)"/g)) {
      libs.add(path.join(m[1].replace(/\\\\/g, '\\'), 'steamapps'));
    }
  }
  return [...libs].map(p => path.join(p, 'common'));
}

function detectNmsInstall() {
  const PAK_REL = 'GAMEDATA/PCBANKS/NMSARC.TexUI.pak';
  for (const common of detectSteamLibraries()) {
    const guess = path.join(common, "No Man's Sky");
    if (fs.existsSync(path.join(guess, PAK_REL))) return guess;
  }
  return null;
}

function detectHgpaktool() {
  const candidates = [path.join(__dirname, 'tools', 'hgpaktool.exe')];
  if (process.platform === 'win32') {
    for (const drive of ['C:', 'D:', 'E:', 'F:', 'G:']) {
      candidates.push(path.join(drive, '\\Amumss', 'MODBUILDER', 'hgpaktool.exe'));
      candidates.push(path.join(drive, '\\AMUMSS', 'MODBUILDER', 'hgpaktool.exe'));
    }
  }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const logger = createLogger({ logsDir: LOGS_ROOT });

// Both stdout AND the session log file get every event. Stdout for the
// developer's terminal; the file is what users share when reporting bugs.
function logBoth(level, category, msg, data) {
  const entry = logger.log({ source: 'server', level, category, msg, data });
  // Mirror to stdout in a compact, grep-friendly format
  const ts = entry.ts.slice(11, 23);
  const dataStr = data ? ' ' + Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ') : '';
  console.log(`${ts} ${level.toUpperCase().padEnd(7)} ${category.padEnd(10)} ${msg}${dataStr}`);
}

// Locate the NMS save root for the current OS. Returns absolute path or null.
// Windows is the only confirmed-tested target; Linux/macOS paths are best-effort.
function detectNmsRoot() {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    if (!appdata) return null;
    const p = path.join(appdata, 'HelloGames', 'NMS');
    return fs.existsSync(p) ? p : null;
  }
  if (process.platform === 'darwin') {
    const p = path.join(os.homedir(), 'Library', 'Application Support', 'HelloGames', 'NMS');
    return fs.existsSync(p) ? p : null;
  }
  // Linux + Steam Proton
  const p = path.join(os.homedir(), '.local', 'share', 'Steam', 'steamapps', 'compatdata',
                      '275850', 'pfx', 'drive_c', 'users', 'steamuser', 'AppData', 'Roaming',
                      'HelloGames', 'NMS');
  return fs.existsSync(p) ? p : null;
}

const NMS_ROOT = detectNmsRoot();

// Filenames the /nms/write endpoint will accept (everything else is rejected).
// Matches save.hg, save2.hg .. save30.hg, mf_save.hg, accountdata.hg, mf_accountdata.hg.
const SAFE_NMS_FILENAME = /^(mf_)?(save\d*|accountdata)\.hg$/;

// Resolve a {folder, filename} request into an absolute path inside NMS_ROOT.
// Returns { ok: true, abs, relStPath } or { ok: false, error }.
function resolveNmsPath(folderName, filename) {
  if (!NMS_ROOT) return { ok: false, error: 'NMS save folder not detected on this OS' };
  if (!folderName || /[\\/]/.test(folderName) || folderName === '.' || folderName === '..') {
    return { ok: false, error: 'invalid folder name' };
  }
  if (!SAFE_NMS_FILENAME.test(filename || '')) {
    return { ok: false, error: `filename "${filename}" not allowed (must match save\\d*\\.hg or mf_*.hg)` };
  }
  const folderAbs = path.resolve(NMS_ROOT, folderName);
  if (!folderAbs.startsWith(NMS_ROOT + path.sep)) {
    return { ok: false, error: 'folder escapes NMS root' };
  }
  if (!fs.existsSync(folderAbs)) return { ok: false, error: `folder does not exist: ${folderAbs}` };
  const fileAbs = path.resolve(folderAbs, filename);
  if (!fileAbs.startsWith(folderAbs + path.sep)) {
    return { ok: false, error: 'filename escapes folder' };
  }
  return { ok: true, abs: fileAbs, relStPath: path.relative(NMS_ROOT, fileAbs) };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
};

// Ensure backups dir exists at startup
if (!fs.existsSync(BACKUP_ROOT)) fs.mkdirSync(BACKUP_ROOT, { recursive: true });

// ── helpers ───────────────────────────────────────────────────────────────────────
function readBody(req, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonResponse(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Extract the trailing integer N from a saveN.hg filename (save.hg → 1, save2.hg → 2, etc).
function fileN(name) {
  if (name === 'save.hg') return 1;
  const m = name.match(/^save(\d+)\.hg$/);
  return m ? Number(m[1]) : 0;
}

// Read a NUL-terminated UTF-8 string from a fixed-width slot in a Uint8Array.
function readUtf8Z(buf, off, slotLen) {
  let end = off;
  while (end < off + slotLen && buf[end] !== 0) end++;
  return new TextDecoder('utf-8').decode(buf.subarray(off, end));
}

// Sanitize a user-supplied filename so we never escape BACKUP_ROOT.
// Strip path separators, control chars, leading dots; keep .hg / common save extensions.
function safeBackupName(rawName, sha8) {
  let n = String(rawName || 'save.hg').replace(/[\\/]/g, '_').replace(/[\x00-\x1f]/g, '_').replace(/^\.+/, '');
  if (!n) n = 'save.hg';
  // Append timestamp + sha to make every backup unique and traceable
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${n}.${ts}.${sha8}.bak`;
}

// ── routes ────────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Apply audit log endpoint — writes a JSON record of an apply operation
  // alongside the .bak files in BACKUP_ROOT. Filename mirrors the safeBackupName
  // pattern so audits sit next to the save they correspond to.
  if (req.method === 'POST' && urlPath === '/apply/audit') {
    try {
      const body = await readBody(req, 4 * 1024 * 1024);
      if (body.length === 0) return jsonResponse(res, 400, { error: 'empty body' });
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch (e) { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const sha8 = crypto.createHash('sha256').update(body).digest('hex').slice(0, 8);
      const baseName = String(req.headers['x-nmso-filename'] || 'save.hg').replace(/[\\/]/g, '_').replace(/[\x00-\x1f]/g, '_').replace(/^\.+/, '') || 'save.hg';
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${baseName}.${ts}.${sha8}.applied.json`;
      const targetPath = path.join(BACKUP_ROOT, filename);
      if (!path.resolve(targetPath).startsWith(BACKUP_ROOT + path.sep)) {
        return jsonResponse(res, 400, { error: 'invalid filename' });
      }
      fs.writeFileSync(targetPath, JSON.stringify(parsed, null, 2));
      logBoth('info', 'audit', `wrote ${filename}`, { bytes: body.length });
      return jsonResponse(res, 200, {
        path: targetPath,
        relative_path: path.relative(__dirname, targetPath),
        bytes: body.length,
      });
    } catch (err) {
      logBoth('error', 'audit', err.message);
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // Backup endpoint
  if (req.method === 'POST' && urlPath === '/backup') {
    try {
      const body = await readBody(req);
      if (body.length === 0) return jsonResponse(res, 400, { error: 'empty body' });
      const sha = crypto.createHash('sha256').update(body).digest('hex');
      const sha8 = sha.slice(0, 8);
      const filename = safeBackupName(req.headers['x-nmso-filename'], sha8);
      const targetPath = path.join(BACKUP_ROOT, filename);
      // Confine to BACKUP_ROOT (path traversal safety even after sanitization)
      if (!path.resolve(targetPath).startsWith(BACKUP_ROOT + path.sep)) {
        return jsonResponse(res, 400, { error: 'invalid filename' });
      }
      fs.writeFileSync(targetPath, body);
      logBoth('info', 'backup', `wrote ${filename}`, { bytes: body.length, sha8 });
      return jsonResponse(res, 200, {
        path: targetPath,
        relative_path: path.relative(__dirname, targetPath),
        bytes: body.length,
        sha256_hex: sha,
      });
    } catch (err) {
      logBoth('error', 'backup', err.message);
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // ── Setup wizard endpoints ──────────────────────────────────────────────────────

  if (req.method === 'GET' && urlPath === '/setup/status') {
    const config = readConfig();
    return jsonResponse(res, 200, {
      configured: !!config && config.setup_completed === true,
      config:     config || {},
      detected: {
        nms_save_root:  NMS_ROOT,
        nms_install:    detectNmsInstall(),
        hgpaktool:      detectHgpaktool(),
        steam_libs:     detectSteamLibraries(),
      },
      icons_extracted: fs.existsSync(path.join(APP_ROOT, 'data/icons.json')),
    });
  }

  if (req.method === 'POST' && urlPath === '/setup/config') {
    try {
      const body = await readBody(req, 64 * 1024);
      const incoming = JSON.parse(body.toString('utf8'));
      const merged = { ...(readConfig() || {}), ...incoming };
      writeConfig(merged);
      logBoth('info', 'setup', 'config saved', { keys: Object.keys(incoming) });
      return jsonResponse(res, 200, merged);
    } catch (err) {
      logBoth('error', 'setup', `config write failed: ${err.message}`);
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // Stream icon extraction live to the browser via SSE (one event per stdout line).
  // The wizard renders a scrolling progress pane sourced from these events.
  if (req.method === 'GET' && urlPath === '/setup/extract-icons-stream') {
    const config = readConfig() || {};
    const args = ['extract_icons.js'];
    if (config.nms_install) args.push('--install',   config.nms_install);
    if (config.hgpaktool)   args.push('--hgpaktool', config.hgpaktool);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('start', { args });
    logBoth('info', 'setup', 'icon extraction started', { args });

    const child = require('child_process').spawn(process.execPath, args, { cwd: __dirname });
    let buf = '';
    const pumpLines = (chunk, kind) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();   // keep partial last line
      for (const line of lines) if (line) send(kind, { line });
    };
    child.stdout.on('data', d => pumpLines(d, 'stdout'));
    child.stderr.on('data', d => pumpLines(d, 'stderr'));
    child.on('exit', code => {
      if (buf) send(code === 0 ? 'stdout' : 'stderr', { line: buf });
      send('done', { code });
      logBoth(code === 0 ? 'info' : 'error', 'setup', `icon extraction exited ${code}`);
      res.end();
    });
    req.on('close', () => { try { child.kill(); } catch {} });
    return;
  }

  // ── Logging endpoints ───────────────────────────────────────────────────────────

  // Receive batched log entries pushed from the browser. Body: { entries: [...] }.
  // Each entry is annotated server-side with source='browser' and persisted to the
  // current session log file alongside server's own entries.
  if (req.method === 'POST' && urlPath === '/log') {
    try {
      const body = await readBody(req, 1 * 1024 * 1024);
      if (body.length === 0) return jsonResponse(res, 200, { received: 0 });
      const parsed = JSON.parse(body.toString('utf8'));
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      for (const e of entries) {
        logger.log({
          ts:       e.ts,
          source:   'browser',
          level:    e.level    || 'info',
          category: e.category || 'browser',
          msg:      String(e.msg || e.message || ''),
          data:     e.data,
        });
      }
      return jsonResponse(res, 200, { received: entries.length });
    } catch (err) {
      logBoth('error', 'log', `failed to ingest browser entries: ${err.message}`);
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // List session log files in LOGS_ROOT, newest first.
  if (req.method === 'GET' && urlPath === '/logs') {
    const files = fs.existsSync(LOGS_ROOT)
      ? fs.readdirSync(LOGS_ROOT).filter(n => /\.jsonl$/.test(n))
      : [];
    const list = files.map(name => {
      const stat = fs.statSync(path.join(LOGS_ROOT, name));
      return { name, bytes: stat.size, mtime: stat.mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
    return jsonResponse(res, 200, { current: logger.filename, files: list });
  }

  // Download a specific session log file. Filename is whitelisted to the JSONL pattern.
  if (req.method === 'GET' && urlPath.startsWith('/logs/')) {
    const name = urlPath.slice('/logs/'.length);
    if (!/^session\.[\w-]+\.\d+\.jsonl$/.test(name)) {
      return jsonResponse(res, 400, { error: 'invalid log filename' });
    }
    const full = path.join(LOGS_ROOT, name);
    if (!fs.existsSync(full)) return jsonResponse(res, 404, { error: 'log not found' });
    const stat = fs.statSync(full);
    res.writeHead(200, {
      'Content-Type':        'application/x-ndjson',
      'Content-Length':      stat.size,
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control':       'no-cache',
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  // ── NMS save folder routes ──────────────────────────────────────────────────────
  // These let the Apply tab write directly into the user's NMS save folder
  // (in addition to the always-available browser download). Filenames are
  // whitelisted; existing files at the target are backed up first.

  if (req.method === 'GET' && urlPath === '/nms/folder') {
    if (!NMS_ROOT) return jsonResponse(res, 200, { detected: false, error: 'no NMS folder found for this OS' });
    let stFolders = [];
    try {
      stFolders = fs.readdirSync(NMS_ROOT)
        .filter(name => /^st_\d+$/.test(name))
        .map(name => {
          const abs = path.join(NMS_ROOT, name);
          const stat = fs.statSync(abs);
          return { name, absolute_path: abs, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch (e) { /* non-fatal */ }
    return jsonResponse(res, 200, { detected: true, root: NMS_ROOT, accounts: stFolders });
  }

  if (req.method === 'GET' && urlPath === '/nms/slots') {
    const url = new URL(req.url, `http://localhost`);
    const folder = url.searchParams.get('folder') || '';
    if (!NMS_ROOT) return jsonResponse(res, 400, { error: 'no NMS folder' });
    if (!folder || /[\\/]/.test(folder)) return jsonResponse(res, 400, { error: 'invalid folder' });
    const folderAbs = path.resolve(NMS_ROOT, folder);
    if (!folderAbs.startsWith(NMS_ROOT + path.sep) || !fs.existsSync(folderAbs)) {
      return jsonResponse(res, 400, { error: 'folder not found' });
    }
    // List all save<N>.hg + matching mf_*. NMS pairs (save.hg, save2.hg) = slot 1,
    // (save3, save4) = slot 2, etc. For each save file we also decrypt its manifest
    // (if present) to surface SaveSummary + LastWrite — that's what makes the OPEN
    // SAVE picker usable without the user remembering which file is which.
    const xxtea = await import('./app/lib/xxtea.js');
    const entries = fs.readdirSync(folderAbs);
    const saves = entries.filter(n => /^save\d*\.hg$/.test(n)).sort((a, b) => fileN(a) - fileN(b));
    const haveN = new Set(saves.map(n => fileN(n)));
    const list = saves.map(name => {
      const abs = path.join(folderAbs, name);
      const stat = fs.statSync(abs);
      const n = fileN(name);
      const slot_index = Math.ceil(n / 2);
      const slot_kind  = (n % 2 === 1) ? 'auto' : 'manual';
      const manifestName = 'mf_' + name;
      const manifestAbs  = path.join(folderAbs, manifestName);
      let summary = null, lastWriteUnix = null, manifestBytes = null;
      if (fs.existsSync(manifestAbs)) {
        try {
          const cipher = new Uint8Array(fs.readFileSync(manifestAbs));
          const slot = xxtea.slotForManifestFilename(manifestName);
          const key = xxtea.deriveManifestKey(slot);
          const iters = xxtea.iterationsForLength(cipher.length);
          const plain = xxtea.xxteaDecrypt(cipher, key, iters);
          const dv = new DataView(plain.buffer);
          if (dv.getUint32(0, true) === xxtea.META_HEADER) {
            summary = readUtf8Z(plain, 0x0D8, 128);
            lastWriteUnix = dv.getUint32(0x164, true);
            manifestBytes = cipher.length;
          }
        } catch (_) { /* unreadable manifest — stay null */ }
      }
      return {
        name,
        n,
        bytes:        stat.size,
        mtime:        stat.mtimeMs,
        manifest:     fs.existsSync(manifestAbs) ? manifestName : null,
        manifest_bytes: manifestBytes,
        slot_index,
        slot_kind,
        summary,
        last_write_unix: lastWriteUnix,
      };
    });
    // Next-free SLOT: NMS pairs files as (save,save2)=slot 1, (save3,save4)=slot 2,
    // (save5,save6)=slot 3, etc. A slot is occupied if EITHER of its file indices
    // exists — writing into a half-occupied slot just fills its manual-save half,
    // which is NOT a new slot from the player's perspective. We want the lowest
    // slot index where BOTH files are absent.
    const occupiedSlots = new Set();
    for (const n of haveN) occupiedSlots.add(Math.ceil(n / 2));
    let nextSlot = 1;
    while (occupiedSlots.has(nextSlot)) nextSlot++;
    const nextN = (nextSlot - 1) * 2 + 1;             // first (auto-save) file of the new pair
    const nextName = nextN === 1 ? 'save.hg' : `save${nextN}.hg`;
    return jsonResponse(res, 200, {
      folder: folderAbs,
      saves: list,
      next_free_n:    nextN,
      next_free_name: nextName,
      next_free_slot: nextSlot,
    });
  }

  if (req.method === 'GET' && urlPath === '/nms/read') {
    const url = new URL(req.url, `http://localhost`);
    const folder   = url.searchParams.get('folder')   || '';
    const filename = url.searchParams.get('filename') || '';
    const resolved = resolveNmsPath(folder, filename);
    if (!resolved.ok) return jsonResponse(res, 400, { error: resolved.error });
    if (!fs.existsSync(resolved.abs)) return jsonResponse(res, 404, { error: 'file not found' });
    const stat = fs.statSync(resolved.abs);
    res.writeHead(200, {
      'Content-Type':   'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control':  'no-cache',
      'X-NMSO-Mtime':   String(stat.mtimeMs),
    });
    fs.createReadStream(resolved.abs).pipe(res);
    return;
  }

  if (req.method === 'POST' && urlPath === '/nms/write') {
    try {
      const url = new URL(req.url, `http://localhost`);
      const folder   = url.searchParams.get('folder')   || '';
      const filename = url.searchParams.get('filename') || '';
      const replace  = req.headers['x-nmso-replace'] === '1';
      const resolved = resolveNmsPath(folder, filename);
      if (!resolved.ok) return jsonResponse(res, 400, { error: resolved.error });

      const body = await readBody(req);
      if (body.length === 0) return jsonResponse(res, 400, { error: 'empty body' });

      // If a file already exists at the target, back it up to ./backups/ first
      // (unless the caller passed X-NMSO-Replace: 0 or omitted it AND we're not
      // explicitly replacing). We DEFAULT to backing-up-then-overwriting so the
      // OVERWRITE ORIGINAL flow Just Works; new-slot writes pass replace=0 to
      // refuse stomping unintentionally.
      const exists = fs.existsSync(resolved.abs);
      if (exists && !replace) {
        return jsonResponse(res, 409, { error: 'target file already exists; pass X-NMSO-Replace: 1 to overwrite', target: resolved.abs });
      }
      let backupPath = null;
      if (exists) {
        const original = fs.readFileSync(resolved.abs);
        const sha8 = crypto.createHash('sha256').update(original).digest('hex').slice(0, 8);
        const backupName = `${path.basename(resolved.abs)}.${new Date().toISOString().replace(/[:.]/g, '-')}.${sha8}.pre-overwrite.bak`;
        const backupAbs  = path.join(BACKUP_ROOT, backupName);
        if (!path.resolve(backupAbs).startsWith(BACKUP_ROOT + path.sep)) {
          return jsonResponse(res, 400, { error: 'backup name unsafe' });
        }
        fs.writeFileSync(backupAbs, original);
        backupPath = backupAbs;
      }

      // Atomic write: write to .tmp + rename
      const tmp = resolved.abs + '.tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, resolved.abs);
      const sha = crypto.createHash('sha256').update(body).digest('hex');
      logBoth('info', 'nms/write', `wrote ${resolved.relStPath}`, {
        bytes:    body.length,
        sha8:     sha.slice(0, 8),
        replaced: exists,
        backup:   exists ? path.basename(backupPath) : null,
      });
      return jsonResponse(res, 200, {
        path: resolved.abs,
        bytes: body.length,
        sha256_hex: sha,
        replaced: exists,
        pre_overwrite_backup: backupPath ? path.relative(__dirname, backupPath) : null,
      });
    } catch (err) {
      logBoth('error', 'nms/write', err.message);
      return jsonResponse(res, 500, { error: err.message });
    }
  }

  // Static file serving
  if (req.method === 'GET' || req.method === 'HEAD') {
    // First-run: when no config exists, GET / serves the setup wizard instead
    // of the main app. The wizard finishes by POST /setup/config and reloads /.
    let staticPath = urlPath === '/' ? '/index.html' : urlPath;
    if (urlPath === '/') {
      const cfg = readConfig();
      if (!cfg || cfg.setup_completed !== true) staticPath = '/wizard.html';
    }
    const resolved = path.resolve(APP_ROOT, '.' + staticPath);
    if (!resolved.startsWith(APP_ROOT + path.sep) && resolved !== APP_ROOT) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }
    fs.stat(resolved, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      const ext = path.extname(resolved).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(resolved).pipe(res);
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`No Man's Organizer dev server`);
  console.log(`  serving:   ${APP_ROOT}`);
  console.log(`  backups:   ${BACKUP_ROOT}`);
  console.log(`  logs:      ${LOGS_ROOT}/${logger.filename}`);
  console.log(`  NMS root:  ${NMS_ROOT || '(not detected)'}`);
  console.log(`  open:      http://localhost:${PORT}`);
  console.log(`  stop:      Ctrl+C`);
  logBoth('info', 'boot', `server listening on 127.0.0.1:${PORT}`, {
    nms_root: NMS_ROOT, backups_root: BACKUP_ROOT, logs_root: LOGS_ROOT,
  });
});

// Flush logs on exit so the JSONL file isn't truncated
function shutdown(signal) {
  logBoth('info', 'boot', `received ${signal} — shutting down`);
  logger.close().then(() => process.exit(0));
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
