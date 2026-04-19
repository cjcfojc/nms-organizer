#!/usr/bin/env bash
# ─── No Man's Organizer launcher (macOS) ───────────────────────────────
#
# Double-click this file to start the local server and open your browser.
# `.command` is the macOS extension that opens in Terminal on double-click;
# the script logic is identical to start-linux.sh.
#
# First-time use: macOS Gatekeeper may block double-click. Right-click the
# file → Open → confirm. Once trusted, future double-clicks work directly.

set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  cat <<EOF

Node.js is required but was not found on PATH.
Install it from https://nodejs.org/  (any LTS release works).

EOF
  read -n 1 -s -r -p "Press any key to close…"
  exit 1
fi

(
  sleep 1
  open http://localhost:8765
) &

echo "Starting No Man's Organizer (Ctrl+C to stop)…"
node serve.js
