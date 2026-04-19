// Server-side structured logger (JSONL).
//
// One log file per server start, named session.<ISO-ts>.<pid>.jsonl.
// Each line is a self-contained JSON object — easy to grep, easy to share.
//
// Public:
//   const logger = createLogger({ logsDir })
//   logger.log({ source, level, category, msg, data, context })
//   logger.path                           — absolute path to the current session log
//   logger.relativePath                   — path relative to project root
//   logger.recent(n)                      — last N entries (in-memory ring)
//   logger.close()                        — flush + close the file
//
// `source` is "server" or "browser" so a single file holds both halves.
// Browser entries are pushed via POST /log.

const fs = require('fs');
const path = require('path');

const DEFAULT_RING_SIZE = 2000;

function createLogger({ logsDir, ringSize = DEFAULT_RING_SIZE }) {
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const filename = `session.${stamp}.${process.pid}.jsonl`;
  const fullPath = path.join(logsDir, filename);
  const stream = fs.createWriteStream(fullPath, { flags: 'a' });
  const ring = [];

  function log(entry) {
    // Normalize: ensure ts + source + level + category present.
    const e = {
      ts:       entry.ts || new Date().toISOString(),
      source:   entry.source   || 'server',
      level:    entry.level    || 'info',
      category: entry.category || 'general',
      msg:      entry.msg      || '',
      data:     entry.data || undefined,
      context:  entry.context || undefined,
    };
    const line = JSON.stringify(e) + '\n';
    stream.write(line);
    ring.push(e);
    if (ring.length > ringSize) ring.shift();
    return e;
  }

  function close() { return new Promise(resolve => stream.end(resolve)); }

  // Bootstrap line so a fresh file isn't empty
  log({ category: 'logger', msg: 'session log opened', data: { pid: process.pid, started_at: startedAt.toISOString() } });

  return {
    log,
    path: fullPath,
    relativePath: path.relative(path.dirname(logsDir), fullPath),
    filename,
    recent: (n = 200) => ring.slice(-n),
    close,
  };
}

module.exports = { createLogger };
