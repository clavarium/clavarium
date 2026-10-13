#!/bin/bash
# Copies Clavarium Parley, a project of its own, into server/parley, unchanged.
#   tools/sync-parley.sh /path/to/clavarium-parley
set -euo pipefail
from="${1:?the folder of clavarium-parley}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$from/server/parley-mcp.mjs" ] || { echo "sync-parley: not a clavarium-parley folder: $from" >&2; exit 64; }
[ -z "$(git -C "$from" status --porcelain)" ] || { echo "sync-parley: that folder has changes that are not committed" >&2; exit 78; }
install -d "$here/server/parley/server" "$here/server/parley/host" "$here/server/parley/ui"
cp "$from/server/parley-mcp.mjs" "$here/server/parley/server/"
cp "$from/host/parley-host.mjs" "$here/server/parley/host/"
cp "$from/ui/parley-ui.js" "$from/ui/parley-ui.css" "$here/server/parley/ui/"
cp "$from/LICENSE" "$here/server/parley/LICENSE"
git -C "$from" rev-parse --short HEAD > "$here/server/parley/VERSION"
echo "parley: $(cat "$here/server/parley/VERSION")"
