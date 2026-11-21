#!/usr/bin/env node
/* THE TETHER BROWSER EXTENSION, BUILT FOR THE STORES: the Chrome zip (Chrome Web Store, or "Load unpacked" from it
 * unzipped) and the Firefox zip with its sources zip (addons.mozilla.org asks for the sources of a bundled add-on).
 * Built from Tether's own extension/ folder with its own scripts (wxt zip), in a git checkout of clavarium-tether:
 * the npm package does not carry the extension.
 *
 *   npm run extension -- --tether DIR [--out DIR]
 *
 * DIR: a checkout of clavarium-tether (or $TETHER_DIR). The zips are copied to --out (default: extension/ beside this
 * checkout's package.json, kept out of git). Nothing is published: the stores need their owner's accounts. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const tether = resolve(opt('--tether') ?? process.env.TETHER_DIR ?? '');
const out = resolve(opt('--out') ?? join(HERE, '..', 'extension'));
const ext = join(tether, 'extension');
if (!opt('--tether') && !process.env.TETHER_DIR) { process.stderr.write('Say where clavarium-tether is checked out: --tether DIR (or TETHER_DIR).\n'); process.exit(64); }
if (!existsSync(join(ext, 'wxt.config.ts'))) { process.stderr.write(`No Tether extension in ${ext}.\n`); process.exit(66); }

const run = (cmd, argv) => {
    process.stdout.write(`> ${cmd} ${argv.join(' ')}\n`);
    const r = spawnSync(cmd, argv, { cwd: ext, stdio: 'inherit', env: { ...process.env, WXT_TELEMETRY: 'false' } });
    if (r.status !== 0) { process.stderr.write(`${cmd} ${argv.join(' ')} failed (${r.status ?? r.signal}).\n`); process.exit(1); }
};
rmSync(join(ext, '.output'), { recursive: true, force: true });
run('npm', ['ci', '--no-audit', '--no-fund']);
run('npm', ['run', 'zip']);
run('npm', ['run', 'zip:firefox']);
mkdirSync(out, { recursive: true });
const zips = readdirSync(join(ext, '.output')).filter((f) => f.endsWith('.zip'));
for (const f of zips) copyFileSync(join(ext, '.output', f), join(out, f));
process.stdout.write(`${zips.length} zip(s) in ${out}:\n${zips.map((f) => `  ${f}`).join('\n')}\n`);
