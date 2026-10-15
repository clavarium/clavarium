/* THE CATALOGUE OF WHAT A CONVERSATION CAN RUN. Adding a tool is an entry in
   config/tools.json, not code: a label, the command that starts it (and,
   when it has one, the command that starts it on its last session), and the
   steps that install it in a fresh VM.
 *
 * Every step is an argument vector. No step is a shell line: a recipe that
 * needs a pipe is a recipe that downloads and runs what it has not checked.
 *
 * "node" is the one named step, because several tools need it: the runtime is
 * downloaded over HTTPS only, its checksum is compared BEFORE it is unpacked,
 * and the checksum comes from this repository, never from the network. */
import { readFileSync } from 'node:fs';
import { VM_USER } from './vm.mjs';

export const NODE_VERSION = 'v24.20.0';
export const NODE_SHA256 = '2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2';
const ARCHIVE = `node-${NODE_VERSION}-linux-x64.tar.xz`;
const TMP = `/tmp/${ARCHIVE}`;
const APT = ['sudo', '-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get'];

/* A step is { argv, input? }: `input` goes to standard input. */
export const NODE_STEPS = [
    { argv: [...APT, 'update', '-q'] },
    { argv: [...APT, 'install', '-y', '-q', '--no-install-recommends', 'curl', 'xz-utils', 'ca-certificates'] },
    { argv: ['curl', '--proto', '=https', '--tlsv1.2', '-fsSL', '--max-time', '600', '-o', TMP, `https://nodejs.org/dist/${NODE_VERSION}/${ARCHIVE}`] },
    { argv: ['sha256sum', '-c', '-'], input: `${NODE_SHA256}  ${TMP}\n` },
    { argv: ['sudo', '-n', 'tar', '-xJf', TMP, '-C', '/usr/local', '--strip-components=1', '--no-same-owner'] },
    { argv: ['rm', '-f', TMP] },
];

/* "npm-writable": what npm installs globally becomes the machine user's, so
   that a tool that updates itself (Claude Code does, with npm, as that user)
   can: otherwise it says "Auto-update failed" for ever. The user is root in
   its machine through sudo anyway: nothing is given away. Put AFTER the
   tool's own `npm install -g`, which runs as root. Machines built before
   this was in the recipe get it once, at an opening (conversations.mjs). */
export const NPM_WRITABLE = [
    { argv: ['sudo', '-n', 'mkdir', '-p', '/usr/local/lib/node_modules'] },
    { argv: ['sudo', '-n', 'chown', '-R', `${VM_USER}:${VM_USER}`, '/usr/local/lib/node_modules'] },
    /* The directory only: the links to the tools in it can then be replaced. */
    { argv: ['sudo', '-n', 'chown', `${VM_USER}:${VM_USER}`, '/usr/local/bin'] },
];

const isArgv = (x) => Array.isArray(x) && x.length > 0 && x.every((a) => typeof a === 'string' && a !== '');
const ID = /^[a-z][a-z0-9-]{0,30}$/;

export function readTools(text) {
    const raw = JSON.parse(text);
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('the tool catalogue is empty');
    const seen = new Set();
    return raw.map((t) => {
        if (!ID.test(t?.id ?? '') || seen.has(t.id)) throw new Error(`tool id missing, malformed or repeated: ${String(t?.id)}`);
        seen.add(t.id);
        if (typeof t.label !== 'string' || t.label === '' || t.label.length > 40) throw new Error(`${t.id}: label`);
        if (!isArgv(t.command) || t.command.includes(';')) throw new Error(`${t.id}: command must be an argument vector`);
        if (!Number.isInteger(t.memoryMb) || t.memoryMb < 512 || t.memoryMb > 65536) throw new Error(`${t.id}: memoryMb`);
        if (!Array.isArray(t.install)) throw new Error(`${t.id}: install must be a list of steps`);
        const steps = t.install.flatMap((s) => {
            if (s === 'node') return NODE_STEPS;
            if (s === 'npm-writable') return NPM_WRITABLE;
            /* A step that writes a small file gives its content apart, to go
               on standard input: { "argv": [...], "input": "..." }. Steps run
               in the home of the machine's user, so a path can be relative. */
            if (s && typeof s === 'object' && !Array.isArray(s)) {
                if (!isArgv(s.argv) || typeof s.input !== 'string' || s.input.length > 4096) throw new Error(`${t.id}: a step with input needs "argv" and a short "input"`);
                return [{ argv: s.argv, input: s.input }];
            }
            if (!isArgv(s)) throw new Error(`${t.id}: an install step must be "node", "npm-writable", an argument vector, or { argv, input }`);
            return [{ argv: s }];
        });
        /* Optional: whose mail is a sign-in mail for this tool, and where its
           links may lead. See signin.mjs. */
        let signin;
        if (t.signin !== undefined) {
            const domains = (list) => Array.isArray(list) && list.length > 0 && list.every((d) => typeof d === 'string' && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d));
            if (!domains(t.signin.senders) || !domains(t.signin.links)) throw new Error(`${t.id}: signin needs "senders" and "links", lists of domain names`);
            signin = Object.freeze({ senders: Object.freeze([...t.signin.senders]), links: Object.freeze([...t.signin.links]) });
        }
        /* Optional: the command that starts it taking up its last session
           ("claude --continue"); used instead of `command` once it has run on
           its disk, unless the owner chose to start it fresh. */
        if (t.resume !== undefined && (!isArgv(t.resume) || t.resume.includes(';'))) throw new Error(`${t.id}: resume must be an argument vector`);
        /* Repairs an existing machine is given once (see FIXES in conversations.mjs). */
        const fixups = t.install.includes('npm-writable') ? NPM_WRITABLE : [];
        return Object.freeze({ id: t.id, label: t.label, command: Object.freeze([...t.command]), ...(t.resume ? { resume: Object.freeze([...t.resume]) } : {}), memoryMb: t.memoryMb, steps: Object.freeze(steps), fixups: Object.freeze(fixups), signin });
    });
}

export function loadTools(path = new URL('../config/tools.json', import.meta.url)) {
    return readTools(readFileSync(path, 'utf8'));
}
