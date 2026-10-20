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
const INSTRUCTIONS = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,7}$/;

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
        /* Optional: FULL RIGHTS IN ITS OWN MACHINE. `full`: what is added to
           the command that starts it (the first start, a resume, a fresh
           start: every start goes through one place, conversations.mjs) for
           it to act without asking -- the default; `ask`: what is added
           instead when the owner chose "Ask before acting" (often nothing).
           The machine is its own and disposable: its user is root there by
           sudo already; what it may reach outside is what was attached. */
        let rights;
        if (t.rights !== undefined) {
            const extra = (list) => Array.isArray(list) && list.every((a) => typeof a === 'string' && a !== '' && a !== ';');
            if (!t.rights || typeof t.rights !== 'object' || !extra(t.rights.full) || t.rights.full.length === 0 || (t.rights.ask !== undefined && !extra(t.rights.ask))) throw new Error(`${t.id}: rights needs "full", a list of arguments, and may have "ask"`);
            rights = Object.freeze({ full: Object.freeze([...t.rights.full]), ask: Object.freeze([...(t.rights.ask ?? [])]) });
        }
        /* Optional: the tool's own instruction file, in the home of the
           machine's user (".claude/CLAUDE.md"): a marked block in it points
           the tool to its guide (see guide.mjs). A plain relative path. */
        if (t.instructions !== undefined && !INSTRUCTIONS.test(t.instructions)) throw new Error(`${t.id}: instructions is a relative path in the home, without ".."`);
        /* Optional: ITS LAUNCHER, a script of config/launch shown at /tools/launch: run at each start,
           given the rights chosen (full, ask) then the command; it sets what the tool needs,
           then runs it. Clavarium knows nothing more of the tool. */
        if (t.launch !== undefined && !/^[a-z][a-z0-9-]{0,40}\.sh$/.test(t.launch)) throw new Error(`${t.id}: launch is the name of a script of config/launch, such as "${t.id}.sh"`);
        /* Repairs an existing machine is given once (see FIXES in conversations.mjs). */
        const fixups = t.install.includes('npm-writable') ? NPM_WRITABLE : [];
        return Object.freeze({ id: t.id, label: t.label, ...(t.instructions ? { instructions: t.instructions } : {}), command: Object.freeze([...t.command]), ...(t.launch ? { launch: t.launch } : {}), ...(t.resume ? { resume: Object.freeze([...t.resume]) } : {}), memoryMb: t.memoryMb, ...(rights ? { rights } : {}), steps: Object.freeze(steps), fixups: Object.freeze(fixups), signin });
    });
}

export function loadTools(path = new URL('../config/tools.json', import.meta.url)) {
    return readTools(readFileSync(path, 'utf8'));
}

/* TAKING UP ITS LAST SESSION, OR A NEW ONE: a tool told to resume where it has
   no session of its own (never spoken to, its session files gone) may just say
   so and stop ("No conversation found"), leaving a dead terminal. If the resume
   fails within RESUME_GRACE_S, the tool starts fresh, in the same terminal. A
   tool that ran and is quit stays quit. One argument vector, for tmux. */
export const RESUME_GRACE_S = 20;
const shq = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
export function resumeOrFresh(resume, fresh) {
    const script = `t=$(date +%s); ${resume.map(shq).join(' ')}; c=$?; `
        + `if [ "$c" -ne 0 ] && [ $(( $(date +%s) - t )) -lt ${RESUME_GRACE_S} ]; then echo; echo 'No session to take up here: a new one starts.'; exec ${fresh.map(shq).join(' ')}; fi; exit "$c"`;
    return ['sh', '-c', script];
}
