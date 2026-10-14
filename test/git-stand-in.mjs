/* What the git tests share: a real git, a stand-in for the host program's
   sandboxed read (it runs the real reader script, without the sandbox: see
   e2e/fake-git-read.mjs), and a runner that uses it. Not a test file. */
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GitRunner } from '../server/gitrunner.mjs';

const FAKE_READ = fileURLToPath(new URL('../e2e/fake-git-read.mjs', import.meta.url));

export const ENV = { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Tool', GIT_AUTHOR_EMAIL: 'tool@example.com', GIT_COMMITTER_NAME: 'Tool', GIT_COMMITTER_EMAIL: 'tool@example.com' };
export const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/* `host git read <name>`, played: `folderOf(name)` is where the folder is.
   `reads` (optional) counts them; `code` forces an exit code. */
export function standInRead(folderOf, { reads, code, env = {} } = {}) {
    return (name) => {
        reads?.push(name);
        return spawn(process.execPath, [FAKE_READ, folderOf(name), name], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, ...(code !== undefined ? { FAKE_GIT_READ_CODE: String(code) } : {}) } });
    };
}

/* A runner for tests: reads played, no reserve of free space (a test
   machine may have little), and every git it runs recorded in `calls`. */
export function testRunner(dataDir, folderOf, options = {}) {
    return new GitRunner({ dataDir, reserveBytes: 0, spawnRead: standInRead(folderOf, options), ...options.runner });
}

/* `host git read`, played by a process that writes exactly `bytes` (a
   Buffer, written to a file first: it may be large) and exits with `code`.
   `endless`: it writes `bytes` again and again, until killed. */
export function bytesRead(dir, bytes, { code = 0, endless = false, reads } = {}) {
    let n = 0;
    return (name) => {
        reads?.push(name);
        const file = `${dir}/bytes-${process.pid}-${n += 1}`;
        writeFileSync(file, bytes);
        const script = endless
            ? `const b = require('fs').readFileSync(${JSON.stringify(file)}); const go = () => { if (process.stdout.write(b)) setImmediate(go); else process.stdout.once('drain', go); }; go();`
            : `process.stdout.write(require('fs').readFileSync(${JSON.stringify(file)}), () => process.exit(${code}));`;
        return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    };
}
/* A repository's branches as `git bundle create` writes them: { header, pack }. */
export function bundleOf(repo) {
    const whole = execFileSync('git', ['bundle', 'create', '-', '--branches'], { cwd: repo, env: ENV, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 512 * 1024 * 1024 });
    const at = whole.indexOf('\n\nPACK');
    return { header: whole.subarray(0, at + 2).toString('latin1'), pack: whole.subarray(at + 2) };
}
export const committed = (repo, file, text, subject) => { writeFileSync(`${repo}/${file}`, text); git(repo, 'add', file); git(repo, 'commit', '--quiet', '-m', subject); return git(repo, 'rev-parse', 'HEAD'); };
