#!/usr/bin/env node
/* A stand-in for the privileged host commands, for end-to-end tests: the
   read-only view is a marked link, the network rules are written to a file.
   It enforces nothing: what it lets the tests check is that the server ASKS
   for the right thing, at the right moment. */
import { existsSync, writeFileSync, symlinkSync, rmSync, rmdirSync, appendFileSync } from 'node:fs';

const DIR = process.env.FAKE_VM_DIR;
const [program, ...args] = process.argv.slice(2);
const marker = (view) => `${view}.mounted`;
if (program === 'mountpoint') process.exit(existsSync(marker(args.at(-1))) ? 0 : 1);
if (program === 'bindfs') {
    const [source, view] = args.slice(-2);
    rmdirSync(view); symlinkSync(source, view); writeFileSync(marker(view), '');
    process.exit(0);
}
if (program === 'umount') { rmSync(args[0], { force: true }); rmSync(marker(args[0]), { force: true }); process.exit(0); }
if (program === 'nft') { writeFileSync(`${DIR}/network-rules`, args[0]); appendFileSync(`${DIR}/network-log`, `${Date.now()}\n`); process.exit(0); }
/* pgrep, ip: no VM runs here, so there is nothing to list. */
process.exit(program === 'pgrep' ? 1 : 0);
