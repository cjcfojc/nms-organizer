#!/usr/bin/env bash
# ─── No Man's Organizer launcher (macOS / Linux) ───────────────────────
#
# Starts the local server (node serve.js) in this terminal and opens your
# default browser to http://localhost:8765. Press Ctrl+C to stop the server.

set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  cat <<EOF

Node.js is required but was not found on PATH.
Install it from https://nodejs.org/  (any LTS release works).

EOF
  exit 1
fi

# Open the browser after a brief delay so the server is listening when it lands.
(
  sleep 1
  if   command -v open    >/dev/null 2>&1; then open    http://localhost:8765
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:8765
  fi
) &

echo "Starting No Man's Organizer (Ctrl+C to stop)…"
node serve.js
