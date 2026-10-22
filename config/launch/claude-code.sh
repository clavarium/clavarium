#!/bin/sh
# THE LAUNCHER OF CLAUDE CODE, run by Clavarium in its machine at each start
# (config/tools.json, "launch"), from the read-only /tools: the agent cannot
# change it. Arguments: the rights chosen by the owner (full: acts without
# asking; ask: asks first), then the command to run, as Clavarium made it.
#
# Claude Code trusts skipDangerousModePermissionPrompt only in its settings
# FILE: on its command line it is ignored, and so is
# --dangerously-skip-permissions ("Bypass permissions was requested at launch
# and ignored"). So the file says it, for the rights of this start.
mode="$1"; shift
case "$mode" in
    full) keys='{"skipDangerousModePermissionPrompt": true}' ;;
    ask) keys='{"skipDangerousModePermissionPrompt": null}' ;;
    *) echo "launch: the first argument is full or ask" >&2; exit 64 ;;
esac
[ $# -gt 0 ] || { echo "launch: no command to run" >&2; exit 64; }
node "$(dirname "$0")/json-set.mjs" .claude/settings.json "$keys" \
    || echo "launch: the settings of Claude Code were not changed: it may ask before acting" >&2
# PARLEY AS ITS OWN TOOLS (MCP): the chat of the conversation, when it has one (its folder holds
# Parley's server), given to Claude Code as tools always in its list -- the same as the command
# "parley", which stays. Declared once, by Claude Code itself (its other servers kept); looked for
# in its settings first, since asking Claude Code takes seconds. Nothing stops the start.
chat="${PARLEY_DIR:-/work/.parley}"
if [ -f "$chat/server.mjs" ] && ! grep -q "\"$chat/server.mjs\"" "$HOME/.claude.json" 2>/dev/null; then
    claude mcp add --scope user parley -- node "$chat/server.mjs" --dir "$chat" >/dev/null 2>&1 \
        || echo "launch: Parley was not given to Claude Code as tools: the command parley still works" >&2
fi
# ITS DOCKET AS ITS OWN TOOLS (MCP), with its chat: what woke it, to say done or failed; the
# reminders it sets itself. The same as the command "docket", installed in every machine.
docket="/work/.docket"
if [ -f "$chat/server.mjs" ] && command -v docket-mcp >/dev/null 2>&1 && ! grep -q "\"$docket\"" "$HOME/.claude.json" 2>/dev/null; then
    claude mcp add --scope user docket -- docket-mcp --dir "$docket" >/dev/null 2>&1 \
        || echo "launch: Docket was not given to Claude Code as tools: the command docket still works" >&2
fi
# ITS PULSE: Claude Code's own hooks say to the chat that it acts, and when its turn ends, so that
# the person sees "Working..." while it works without a word (parley pulse; nothing posted).
if [ -f "$chat/server.mjs" ]; then
    node "$(dirname "$0")/claude-pulse.mjs" "$chat" \
        || echo "launch: the chat will not say when Claude Code works without a word" >&2
fi
exec "$@"
