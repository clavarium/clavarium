#!/usr/bin/env node
/* A STAND-IN FOR `clavarium-host git read <name>`, for tests on a machine
 * with no root: `fake-git-read.mjs <folder> <name>`.
 *
 * It runs the REAL reader (deploy/git-read) in the folder, with the
 * environment the sandbox gives it, and exits with the codes the host
 * program would give (0, 65, 66, 67, 82). It is NOT a sandbox: the git it
 * runs reads the folder's config as the sandboxed one would, but with this
 * account's rights. What the sandbox stops is tried for real, as root, in
 * the trial written at the end of blueprint/git-runner-core.md.
 *
 * FAKE_GIT_READ_CODE, when set, is the exit code to give instead (with no
 * output): for the tests of what each code means.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const READER = fileURLToPath(new URL('../deploy/git-read', import.meta.url));
const [folder, name] = process.argv.slice(2);
if (process.env.FAKE_GIT_READ_CODE) process.exit(Number(process.env.FAKE_GIT_READ_CODE));
const child = spawn('sh', [READER, name], {
    cwd: folder, stdio: ['ignore', 'inherit', 'inherit'],
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CEILING_DIRECTORIES: dirname(folder), GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
});
child.on('error', () => process.exit(79));
child.on('close', (code, signal) => {
    if (signal) process.exit(82);
    process.exit(code === 0 ? 0 : code === 128 ? 65 : code === 3 ? 67 : 66);
});
