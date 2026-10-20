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
exec "$@"
