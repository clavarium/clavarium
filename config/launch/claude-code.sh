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
# ITS FIRST QUESTIONS ANSWERED BEFORE THEY ARE ASKED (02-11): the welcome (theme, tips) taken as seen, and its
# work folder trusted -- in its own file, as it records them itself; nothing to answer in the terminal.
node "$(dirname "$0")/json-set.mjs" .claude.json '{"hasCompletedOnboarding": true, "projects": {"/work": {"hasTrustDialogAccepted": true}}}' \
    || echo "launch: Claude Code may ask its first questions in the terminal" >&2
# ITS TOOLS (MCP), EACH THROUGH THE RELAY (02-11): a tool updated on the machine is taken up between two of
# its requests -- whatever the tool, the session never restarted, nothing for the agent to do. Declared
# once, by Claude Code itself (its other servers kept); an older declaration without the relay is replaced.
# Looked for in its settings first, since asking Claude Code takes seconds. Nothing stops the start.
relay="$(dirname "$0")/mcp-relay.mjs"
tool() {   # NAME FOLDER COMMAND ARGS...
    name="$1"; folder="$2"; shift 2
    if grep -q "\"$folder\"" "$HOME/.claude.json" 2>/dev/null && grep -q "mcp-relay.mjs" "$HOME/.claude.json" 2>/dev/null \
        && node -e 'const d=require(process.argv[1]);const s=d.mcpServers?.[process.argv[2]];const a=JSON.stringify(s?.args??[]);process.exit(a.includes("mcp-relay.mjs")&&a.includes(JSON.stringify(process.argv[3]))?0:1)' "$HOME/.claude.json" "$name" "$1" 2>/dev/null; then return 0; fi
    claude mcp remove --scope user "$name" >/dev/null 2>&1
    claude mcp add --scope user "$name" -- node "$relay" "$@" >/dev/null 2>&1 \
        || echo "launch: $name was not given to Claude Code as tools: the command $name still works" >&2
}
# Parley, the chat of the conversation, when it has one: the version installed on the machine (parley-mcp),
# else the copy beside the chat.
chat="${PARLEY_DIR:-/work/.parley}"
if [ -f "$chat/server.mjs" ]; then
    if command -v parley-mcp >/dev/null 2>&1; then tool parley "$chat" parley-mcp --dir "$chat"; else tool parley "$chat" node "$chat/server.mjs" --dir "$chat"; fi
fi
# Its docket, with its chat: what woke it, to say done or failed; the reminders it sets itself.
docket="/work/.docket"
if [ -f "$chat/server.mjs" ] && command -v docket-mcp >/dev/null 2>&1; then tool docket "$docket" docket-mcp --dir "$docket"; fi
# Its tether: the accesses it was given (a mailbox, a calendar, a folder, a machine over SSH).
tether="/work/.tether"
if command -v tether-mcp >/dev/null 2>&1; then tool tether "$tether" tether-mcp --dir "$tether"; fi
# ITS PULSE: Claude Code's own hooks say to the chat that it acts, and when its turn ends, so that
# the person sees "Working..." while it works without a word (parley pulse; nothing posted).
if [ -f "$chat/server.mjs" ]; then
    node "$(dirname "$0")/claude-pulse.mjs" "$chat" \
        || echo "launch: the chat will not say when Claude Code works without a word" >&2
fi
# WHAT ITS SCREEN ASKS (02-11), read by the generic screen-watch -- Claude Code's own words, here and only
# here: not signed in, its sign-in started by itself, its link sent to the person's chat, the code they paste
# there typed back (02-11, tried on a real Claude Code); an update installed told to the agent, which restarts
# when it suits it (never in the middle of its work). A tool that changes its words: only these lines change.
node "$(dirname "$0")/screen-watch.mjs" \
    'type:Not logged in · Run /login=/login' \
    'keys:Select login method:=Enter' \
    'link:https://(claude\.ai|claude\.com|console\.anthropic\.com)/\S*oauth\S*' \
    'code:Paste code here' \
    'notice:(update|updated|installed)[^\n]{0,80}restart=Your tool was updated: when nothing runs, touch /work/.parley/restart-asked to take it up.' \
    </dev/null >/dev/null 2>&1 &
exec "$@"
