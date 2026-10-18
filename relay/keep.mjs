#!/usr/bin/env node
/* The relay's maintenance program is not built yet: this version only keeps
 * the name. It runs nothing else, installs nothing and reaches no network. */
process.stderr.write('clavarium-relay is not built yet: it will be the maintenance program of a Clavarium relay.\nhttps://github.com/clavarium/clavarium\n');
process.exitCode = 1;
