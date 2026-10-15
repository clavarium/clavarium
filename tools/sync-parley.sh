#!/bin/bash
# Copies Clavarium Parley, a project of its own, into server/parley, unchanged,
# with the archive an agent installs it from (npm pack: put in /tools of every
# machine, see server/toolbox.mjs).
#   tools/sync-parley.sh /path/to/clavarium-parley
set -euo pipefail
from="${1:?the folder of clavarium-parley}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$from/server/parley-mcp.mjs" ] || { echo "sync-parley: not a clavarium-parley folder: $from" >&2; exit 64; }
[ -z "$(git -C "$from" status --porcelain)" ] || { echo "sync-parley: that folder has changes that are not committed" >&2; exit 78; }
install -d "$here/server/parley/server" "$here/server/parley/host" "$here/server/parley/ui/texts" "$here/server/parley/bin"
cp "$from/server/parley-mcp.mjs" "$here/server/parley/server/"
cp "$from/bin/parley.mjs" "$here/server/parley/bin/"
cp "$from/host/parley-host.mjs" "$here/server/parley/host/"
cp "$from/ui/parley-ui.js" "$from/ui/parley-ui.css" "$here/server/parley/ui/"
rm -f "$here/server/parley/ui/texts/"*.json
cp "$from/ui/texts/"*.json "$here/server/parley/ui/texts/"
cp "$from/LICENSE" "$here/server/parley/LICENSE"
rm -f "$here/server/parley/"*.tgz
(cd "$from" && npm pack --silent --pack-destination "$here/server/parley" >/dev/null)
git -C "$from" rev-parse --short HEAD > "$here/server/parley/VERSION"
echo "parley: $(cat "$here/server/parley/VERSION") $(cd "$here/server/parley" && ls ./*.tgz)"
