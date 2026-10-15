# Parley, as it is used here

These files are Clavarium Parley, a project of its own, copied here unchanged
so that this one installs from a single folder. The commit they come from is
in `VERSION`. They are not edited here: a change is made there, then copied.

    tools/sync-parley.sh /path/to/clavarium-parley

The archive `clavarium-parley-<version>.tgz` is what `npm pack` makes of it:
put in /tools of every machine (server/toolbox.mjs), it is what an agent
installs with `npm install -g`.
