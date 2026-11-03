#!/bin/sh
# THE LAUNCHER OF CODEX (OpenAI), run by Clavarium in its machine at each start (config/tools.json,
# "launch"), from the read-only /tools. Arguments: the rights chosen by the owner (full, ask), then the
# command to run, as Clavarium made it. All that is Codex's own is here, and only here (02-11).
mode="$1"; shift
case "$mode" in full|ask) ;; *) echo "launch: the first argument is full or ask" >&2; exit 64 ;; esac
[ $# -gt 0 ] || { echo "launch: no command to run" >&2; exit 64; }
here="$(dirname "$0")"; relay="$here/mcp-relay.mjs"
chat="${PARLEY_DIR:-/work/.parley}"; docket="/work/.docket"; tether="/work/.tether"
# ITS SETTINGS (~/.codex/config.toml), in a block of their own, the rest kept: its work folder trusted (no
# question at its first start), and its tools (MCP) each through the relay -- a tool updated on the
# machine taken up between two requests, never a restart.
block='[projects."/work"]
trust_level = "trusted"'
if [ -f "$chat/server.mjs" ] && command -v parley-mcp >/dev/null 2>&1; then block="$block
[mcp_servers.parley]
command = \"node\"
args = [\"$relay\", \"parley-mcp\", \"--dir\", \"$chat\"]"; fi
if [ -f "$chat/server.mjs" ] && command -v docket-mcp >/dev/null 2>&1; then block="$block
[mcp_servers.docket]
command = \"node\"
args = [\"$relay\", \"docket-mcp\", \"--dir\", \"$docket\"]"; fi
if command -v tether-mcp >/dev/null 2>&1; then block="$block
[mcp_servers.tether]
command = \"node\"
args = [\"$relay\", \"tether-mcp\", \"--dir\", \"$tether\"]"; fi
node "$here/toml-block.mjs" .codex/config.toml tools "$block" \
    || echo "launch: Codex may ask its first questions, and has not its tools (MCP)" >&2
# WHAT ITS SCREEN ASKS, read by the generic screen-watch -- Codex's own words: its sign-in link (and the
# code beside it) sent to the person's chat; an update told to the agent, which restarts when it suits it.
node "$here/screen-watch.mjs" \
    'link:https://auth\.openai\.com/\S+' \
    'link:https://chatgpt\.com/\S*auth\S*' \
    'notice:update available[^\n]{0,120}=Your tool has an update: when nothing runs, touch /work/.parley/restart-asked to take it up.' \
    </dev/null >/dev/null 2>&1 &
exec "$@"
