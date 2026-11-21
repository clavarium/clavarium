#!/bin/sh
# A TOOL OF THE CONVERSATION, THROUGH THE SHARED HOST (11-11, card #350): what the agent starts for each of its
# tools (MCP) -- the same arguments as mcp-relay.mjs, COMMAND ARGS... -- but instead of a Node program of its
# own, a few lines of sh and netcat: the session goes to tools-host.mjs, one program for all the tools of this
# user. Anything missing (netcat, the host not starting): the relay of before, as if nothing changed.
here="$(dirname "$0")"
fallback() { exec node "$here/mcp-relay.mjs" "$@"; }
command -v nc >/dev/null 2>&1 || fallback "$@"
dir="${XDG_RUNTIME_DIR:-/tmp}/clavarium-tools-$(id -u)"
# Its folder: this user's alone (700), or the relay of before.
mkdir -p "$dir" 2>/dev/null && [ -O "$dir" ] && chmod 700 "$dir" 2>/dev/null || fallback "$@"
sock="$dir/host.sock"
up() { [ -S "$sock" ] && nc -zU "$sock" 2>/dev/null; }
if ! up; then
    (
        flock 9   # the host itself never holds the lock (9>&- below): two tools starting at once both get in
        if ! up; then
            # its own session (setsid): an agent ending its tools never ends the host the others use
            ns=""; command -v setsid >/dev/null 2>&1 && ns=setsid
            $ns nohup node "$here/tools-host.mjs" "$dir" >>"$dir/host.log" 2>&1 </dev/null 9>&- &
            i=0; while [ $i -lt 30 ] && ! up; do sleep 0.1; i=$((i + 1)); done
        fi
    ) 9>"$dir/lock"
fi
up || fallback "$@"
# Its first line: which tool, with which arguments (JSON); then the session, both ways.
json() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
head="{\"command\":\"$(json "$1")\",\"args\":["; shift
sep=""; for a in "$@"; do head="$head$sep\"$(json "$a")\""; sep=","; done
head="$head]}"
{ printf '%s\n' "$head"; exec cat; } | exec nc -NU "$sock"
