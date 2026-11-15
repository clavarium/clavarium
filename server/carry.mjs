/* A WHOLE CONVERSATION CARRIED ELSEWHERE (14-11, its owner's ask): beyond its tool's memory, the whole of its home,
   its work folder and the list of what it was given -- one .tar.gz the person downloads, and puts back into a
   conversation of the same tool, here or on another server. The parts made here, on this server's side; the
   machine's part (its home) is in conversations.mjs (exportWhole, importState).

   The archive, in this order:
     clavarium-conversation.json   its manifest (version 2, `whole`): its tool, its title, its sizes, its accesses
     home/...                      its home, without what is rebuilt or thrown away (HOME_LEFT_OUT)
     work/...                      its work folder, read here (it is kept on this server) */
import { spawn } from 'node:child_process';
import { createReadStream, readdirSync, renameSync, rmSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createGzip, createGunzip } from 'node:zlib';

/* WHAT A HOME IS CARRIED WITHOUT -- the one list: caches, packages fetched again, the bin, snaps, and what an
   import left half done. Each word as tar takes it: `./x` only at the top of the home, a bare name anywhere. The
   tool's own `state.skip` is added to it (its cache, as its entry in config/tools.json says). */
export const HOME_LEFT_OUT = ['./.cache', './.npm', 'node_modules', './.local/share/Trash', './snap', './.clavarium-import.*'];
export const homeExcludes = (skip = []) => [...HOME_LEFT_OUT, ...skip.map((a) => `./${a}`)];

/* Where the parts wait in its work folder: never shown as its work, never carried in it. */
export const CARRY = '.clavarium-carry';

/* A tar made with one block per record (-b 1) ends with exactly two empty blocks: taken off, another tar can follow. */
const END = 1024;

/* THE ONE ARCHIVE, streamed: its machine's part (the manifest and home/, a tar already written in its work folder)
   without its end, then its work folder read here as work/, all compressed on the way -- nothing held in memory.
   `done` is called once it ended, well or not (its part then thrown away by the caller). -> { stream, kill } */
export function wholeStream(homeTar, workDir, done = () => {}) {
    const size = statSync(homeTar).size;
    const tail = Buffer.alloc(END);
    const fd = openSync(homeTar, 'r');
    try { readSync(fd, tail, 0, END, Math.max(0, size - END)); } finally { closeSync(fd); }
    if (size < END || tail.some((b) => b !== 0)) { done(); throw new Error('its home was not read whole'); }
    const gzip = createGzip();
    const out = new PassThrough();
    gzip.pipe(out);
    let child = null; let ended = false;
    const end = (error) => { if (ended) return; ended = true; done(); if (error) out.destroy(error); };
    const home = createReadStream(homeTar, { start: 0, end: size - END - 1 });
    home.on('error', end);
    home.on('end', () => {
        /* Its work: every file, its carried parts left out; named work/... (a link's target left as it is). */
        child = spawn('tar', ['-cf', '-', '-b', '1', '-C', workDir, `--exclude=./${CARRY}`, '--transform', 's,^\\.,work,S', '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.pipe(gzip);
        child.on('error', end);
        child.on('close', (code) => end(code === 0 || code === 1 ? undefined : new Error(`its work folder was not read (exit ${code})`)));
    });
    home.pipe(gzip, { end: false });
    return { stream: out, kill: () => { home.destroy(); try { child?.kill(); } catch { /* ended */ } end(); } };
}

/* The manifest of an export, read from its first entry only (it is always first): its JSON, or null; throws when
   the file is not compressed as an export is. */
export async function readManifest(file) {
    const gunzip = createGunzip();
    const input = createReadStream(file);
    input.pipe(gunzip);
    let got = Buffer.alloc(0);
    try {
        for await (const chunk of gunzip) {
            got = Buffer.concat([got, chunk]);
            if (got.length < 512) continue;
            const name = got.subarray(0, 100).toString().replace(/\0.*$/s, '');
            if (name !== 'clavarium-conversation.json' && name !== './clavarium-conversation.json') return null;
            const length = parseInt(got.subarray(124, 136).toString().replace(/\0.*$/s, '').trim(), 8);
            if (!(length >= 0) || length > 1_000_000) return null;
            if (got.length < 512 + length) continue;
            try { return JSON.parse(got.subarray(512, 512 + length).toString()); } catch { return null; }
        }
        return null;
    } finally { input.destroy(); gunzip.destroy(); }
}

/* A work folder holds nothing of its own (its carried parts aside). */
export const workEmpty = (dir) => readdirSync(dir).every((e) => e === CARRY);

/* Unpacked here, into `into` (an empty folder): tar refuses names that climb out (..) and leading slashes. */
export function unpackHere(file, into) {
    mkdirSync(into, { recursive: true });
    return new Promise((ok, fail) => {
        const child = spawn('tar', ['-xzf', file, '-C', into, '--no-same-owner'], { stdio: ['ignore', 'ignore', 'pipe'] });
        let said = '';
        child.stderr.on('data', (d) => { said = (said + d).slice(-500); });
        child.on('error', fail);
        child.on('close', (code) => (code === 0 ? ok() : fail(new Error(said.trim().split('\n').pop() || `exit ${code}`))));
    });
}

/* ITS WORK PUT BACK, here: what it holds now thrown away only when asked (`replace`), then each entry of the
   export's work/ moved in (the same disk: a rename). */
export function restoreWork(from, workDir, replace) {
    if (replace) for (const e of readdirSync(workDir)) if (e !== CARRY) rmSync(join(workDir, e), { recursive: true, force: true });
    let entries = [];
    try { entries = readdirSync(from); } catch { return; }
    for (const e of entries) if (e !== CARRY) renameSync(join(from, e), join(workDir, e));
}

/* WHAT IT WAS GIVEN, for a whole export, each by its id: a folder, a repository or a mailbox by its asset
   (folder:x, git:x, mailbox:x), a secret by its NAME ONLY (never its value), its Tether targets and its lists by
   theirs, with their levels; and whether its chat is on, its guide's lines. The same as a copy gives (copyRights). */
export function accessesOf({ folders, secrets, tethers, binders, talk, guide }, name) {
    return {
        resources: folders.of(name).map((r) => ({ id: folders.assetOf(folders.get(r.name) ?? { name: r.name }), access: r.access })),
        secrets: secrets.of(name).map(String),
        tethers: tethers?.grantsOf(name) ?? [],
        binders: binders?.grantsOf(name) ?? [],
        talk: talk.isOn(name) === true,
        guide: guide.lines(name),
    };
}

/* ITS IMPORT: each given again where the same id exists here, with the same level, through the calls a copy uses;
   the rest said back, to link by hand. -> { linked: [id], missing: [id] } */
export async function relinkAccesses({ folders, secrets, tethers, binders, talk, guide, gitKeeper }, name, given = {}) {
    const linked = []; const missing = [];
    const list = (v) => (Array.isArray(v) ? v : []);
    for (const r of list(given.resources)) {
        const id = String(r?.id ?? ''); const at = id.indexOf(':');
        const resource = at > 0 ? folders.get(id.slice(at + 1)) : undefined;
        if (!resource || folders.assetOf(resource) !== id || (r.access !== 'read' && r.access !== 'write')) { missing.push(id); continue; }
        try {
            if (r.access === 'write') gitKeeper?.beforeWriter(resource.name, name, true);
            await folders.attach(name, resource.name, r.access); linked.push(id);
        } catch { missing.push(id); }
    }
    for (const s of list(given.secrets)) {
        try { secrets.attach(name, String(s), true); linked.push(`secret:${s}`); } catch { missing.push(`secret:${s}`); }
    }
    for (const [kind, keeper, grants] of [['tether', tethers, list(given.tethers)], ['binder', binders, list(given.binders)]]) {
        const absent = keeper ? keeper.regrant(name, grants) : grants.map((g) => g?.id);
        for (const g of grants) (absent.includes(g?.id) ? missing : linked).push(`${kind}:${g?.id}`);
    }
    if (given.talk === true) await talk.set(name, true).catch(() => {});
    if (list(given.guide).length) await guide.setLines(name, given.guide).catch(() => {});
    return { linked, missing };
}
