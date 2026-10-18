/* THE SMOKE TEST OF A RELEASE, run by the updater before it is switched to
 * (deploy/updater.mjs), with the Node.js it will run on. It touches no data
 * and starts nothing: every module loads, the files the page asks for are
 * there, the terminal module (compiled on this machine) opens a terminal,
 * and Parley's archive for the machines is the one npm recorded.
 *
 *   node server/smoke.mjs      exit 0 and "smoke: ok <version>", or 1 and why
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';

const fail = (why) => { console.error(`smoke: ${why}`); process.exit(1); };
try {
    const { FILES } = await import('./main.mjs');
    for (const [path, [file]] of Object.entries(FILES)) for (const f of [file].flat()) if (!existsSync(f.startsWith('/') ? f : new URL(`../${f}`, import.meta.url))) fail(`${path}: ${f} is missing`);
    const { parleySource } = await import('./toolbox.mjs');
    if (parleySource().length !== 1) fail("Parley's archive for the machines is missing, or not the one npm recorded");
    const pty = createRequire(import.meta.url)('node-pty');
    await new Promise((done, broken) => {
        const term = pty.spawn('/bin/sh', ['-c', 'exit 0'], { cols: 80, rows: 24, env: { PATH: '/usr/bin:/bin' } });
        const late = setTimeout(() => broken(new Error('the terminal module opened no terminal')), 10_000);
        term.onExit(() => { clearTimeout(late); done(); });
    });
    console.log(`smoke: ok ${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}`);
    process.exit(0);
} catch (error) { fail(error.message); }
