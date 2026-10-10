#!/bin/bash
# ---------------------------------------------------------------------------
# THE LEAK GUARD, WHICH IS NOT IN THIS REPOSITORY AND MUST NOT BE.
#
# Its patterns are names: a person, a company, a supplier, a machine. Writing
# them here to check for them would put every one of them in the history --
# the exact thing it exists to prevent. So it lives outside, and this file
# holds only how to find it.
#
# WHERE IT IS LOOKED FOR, in this order:
#
#   1. git config clavarium.guard <path>      an explicit choice wins
#   2. the CLAVARIUM_GUARD environment variable
#   3. ../.clavarium-guard/guard.sh           NEXT TO the repository
#
# The third is a path RELATIVE to the repository, and that is the point of it:
# it names nobody, and it does not depend on anything a restart, a new shell
# or a fresh clone could forget. Put the guard directory beside the clone and
# every commit finds it.
#
# NO GUARD MEANS NO COMMIT. A clone that cannot find it stops here rather than
# committing unchecked -- the one thing worse than a guard that refuses is one
# that shrugs.
# ---------------------------------------------------------------------------
set -u
GUARD="$(git config --get clavarium.guard || true)"
[ -n "${GUARD}" ] || GUARD="${CLAVARIUM_GUARD:-}"
if [ -z "${GUARD}" ]; then
    top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    [ -n "${top}" ] && [ -x "${top}/../.clavarium-guard/guard.sh" ] && GUARD="${top}/../.clavarium-guard/guard.sh"
fi
if [ -z "${GUARD}" ]; then
    echo "The leak guard was not found."
    echo "  Put it next to the repository, as ../.clavarium-guard/guard.sh, or:"
    echo "  git config clavarium.guard <path to the checking script>"
    echo "It lives outside this repository on purpose: its patterns are names."
    exit 1
fi
if [ ! -x "${GUARD}" ]; then
    echo "The declared leak guard is not executable."
    exit 1
fi
exec "${GUARD}" "$@"
