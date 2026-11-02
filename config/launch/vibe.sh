#!/bin/sh
# THE LAUNCHER OF VIBE (Mistral), run by Clavarium in its machine at each start (config/tools.json,
# "launch"), from the read-only /tools. Arguments: the rights chosen by the owner (full, ask), then the
# command to run, as Clavarium made it. All that is Vibe's own is here, and only here (02-11).
mode="$1"; shift
case "$mode" in full|ask) ;; *) echo "launch: the first argument is full or ask" >&2; exit 64 ;; esac
[ $# -gt 0 ] || { echo "launch: no command to run" >&2; exit 64; }
here="$(dirname "$0")"; relay="$here/mcp-relay.mjs"
chat="${PARLEY_DIR:-/work/.parley}"; docket="/work/.docket"; tether="/work/.tether"
# ITS KEY: a secret named MISTRAL_API_KEY given to the conversation is in its environment; Vibe reads it
# there, and asks nothing. Without it, Vibe asks for it in its terminal at its first start.
# ITS TOOLS (MCP) in its settings (~/.vibe/config.toml), a block of their own, each through the relay.
block=''
if [ -f "$chat/server.mjs" ] && command -v parley-mcp >/dev/null 2>&1; then block="$block
[[mcp_servers]]
name = \"parley\"
transport = \"stdio\"
command = \"node\"
args = [\"$relay\", \"parley-mcp\", \"--dir\", \"$chat\"]"; fi
if [ -f "$chat/server.mjs" ] && command -v docket-mcp >/dev/null 2>&1; then block="$block
[[mcp_servers]]
name = \"docket\"
transport = \"stdio\"
command = \"node\"
args = [\"$relay\", \"docket-mcp\", \"--dir\", \"$docket\"]"; fi
if command -v tether-mcp >/dev/null 2>&1; then block="$block
[[mcp_servers]]
name = \"tether\"
transport = \"stdio\"
command = \"node\"
args = [\"$relay\", \"tether-mcp\", \"--dir\", \"$tether\"]"; fi
node "$here/toml-block.mjs" .vibe/config.toml tools "$block" \
    || echo "launch: Vibe has not its tools (MCP)" >&2
# WHAT ITS SCREEN ASKS, read by the generic screen-watch -- Vibe's own words: an update told to the
# agent, which restarts when it suits it.
node "$here/screen-watch.mjs" \
    'notice:(new version|update) (is )?available[^\n]{0,120}=Your tool has an update: when nothing runs, touch /work/.parley/restart-asked to take it up.' \
    </dev/null >/dev/null 2>&1 &
exec "$@"
