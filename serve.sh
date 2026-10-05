#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-4173}"
echo "Net Pulse → http://localhost:${PORT}/  (and http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}/ on LAN)"
if command -v npx >/dev/null 2>&1; then
  exec npx --yes serve -l "$PORT" .
fi
exec python3 -m http.server "$PORT"
