#!/bin/bash
# ---------------------------------------------------------------------------
# THE LEAK GUARD, WHICH IS NOT IN THIS REPOSITORY AND MUST NOT BE.
#
# Its patterns are names: a person, a company, a supplier, a machine. Writing
# them here to check for them would put every one of them in the history --
# the exact thing it exists to prevent. So it lives outside, and this file
# holds only how to find it:
#
#     git config clavarium.guard /the/path/to/the-script
#
# NOT A DEFAULT PATH, EITHER. A path is a name too: it carries a user, a
# directory, sometimes a client.
#
# NO GUARD MEANS NO COMMIT. A clone that has not been told where it is stops
# here rather than committing unchecked -- the one thing worse than a guard
# that refuses is one that shrugs.
# ---------------------------------------------------------------------------
set -u
GUARD="$(git config --get clavarium.guard || true)"
[ -n "${GUARD}" ] || GUARD="${CLAVARIUM_GUARD:-}"
if [ -z "${GUARD}" ]; then
    echo "The leak guard is not declared."
    echo "  git config clavarium.guard <path to the checking script>"
    echo "It lives outside this repository on purpose: its patterns are names."
    exit 1
fi
if [ ! -x "${GUARD}" ]; then
    echo "The declared leak guard is not executable."
    exit 1
fi
exec "${GUARD}"
