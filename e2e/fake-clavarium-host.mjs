#!/usr/bin/env node
/* A STAND-IN FOR THE HOST PROGRAM (deploy/clavarium-host), for end-to-end
   tests on a machine with no VM and no root. It speaks the same verbs, and
   plays each "VM" as a directory: what would run inside the VM runs here,
   with its paths moved under that directory, and with a tmux server of its
   own per VM. A read-only view is a marked link; network rules go to a file.
 *
 * It exists so that the REAL server, the REAL page and REAL terminals can be
 * exercised together. It is not a sandbox and protects nothing: what the
 * real program refuses is tested on the real program (test/host-program).
 *
 * State lives under FAKE_VM_DIR:  vms/<name>/{state, root/...}, data/...
 */
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, renameSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync, chmodSync, lstatSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DIR = process.env.FAKE_VM_DIR;
if (!DIR) { console.error('FAKE_VM_DIR is not set'); process.exit(64); }
const [area, verb, ...argv] = process.argv.slice(2);
/* For the tests that count what is sent into a machine. */
if (process.env.FAKE_VM_LOG && area === 'vm') appendFileSync(process.env.FAKE_VM_LOG, `${verb} ${argv.slice(0, 5).join(' ')}\n`);
const DATA = join(DIR, 'data');
const folderOf = (name) => join(DATA, 'resources', name);
const viewOf = (name) => join(DATA, 'views', name);
const marker = (name) => `${viewOf(name)}.mounted`;

if (area === 'folder' && verb === 'make') { mkdirSync(folderOf(argv[0]), { recursive: true }); process.exit(0); }
if (area === 'folder' && verb === 'aside') {
    mkdirSync(join(DATA, 'removed'), { recursive: true });
    renameSync(folderOf(argv[0]), join(DATA, 'removed', `${argv[0]}-${Date.now()}`));
    process.exit(0);
}
/* A kept work folder. In a real VM it is mounted at /work, and "/work/.." is
   the VM's root. Here a "mount" is a link, and ".." of a link's target is the
   target's own parent: so the folder really lives in a directory of its own
   that also holds a link to that VM's /resources, and tests can go from the
   work folder to "../resources" as a tool would. */
const workHome = (name) => join(DIR, 'kept-work', name);
if (area === 'work' && verb === 'make') {
    const [name] = argv;
    if (!existsSync(join(workHome(name), 'work'))) {
        mkdirSync(join(workHome(name), 'work'), { recursive: true });
        symlinkSync(join(DIR, 'vms', `clv-${name}`, 'root', 'resources'), join(workHome(name), 'resources'));
        mkdirSync(join(DATA, 'work'), { recursive: true });
        symlinkSync(join(workHome(name), 'work'), join(DATA, 'work', name));
    }
    process.exit(0);
}
if (area === 'work' && verb === 'aside') {
    const [name] = argv;
    if (existsSync(workHome(name))) {
        mkdirSync(join(DATA, 'removed'), { recursive: true });
        renameSync(join(workHome(name), 'work'), join(DATA, 'removed', `${name}-work-${Date.now()}`));
        rmSync(workHome(name), { recursive: true, force: true }); rmSync(join(DATA, 'work', name), { force: true });
    }
    process.exit(0);
}
if (area === 'view' && verb === 'make') {
    const [name] = argv;
    if (existsSync(marker(name))) process.exit(0);
    mkdirSync(dirname(viewOf(name)), { recursive: true });
    rmSync(viewOf(name), { recursive: true, force: true });
    symlinkSync(folderOf(name), viewOf(name)); writeFileSync(marker(name), '');
    process.exit(0);
}
if (area === 'view' && verb === 'close') { rmSync(viewOf(argv[0]), { force: true }); rmSync(marker(argv[0]), { force: true }); process.exit(0); }
if (area === 'net') {
    if (verb === 'apply') { writeFileSync(`${DIR}/network-rules`, argv[0]); appendFileSync(`${DIR}/network-log`, `${Date.now()}\n`); process.exit(0); }
    /* taps, bridge: no VM runs here, so there is nothing to list. */
    process.exit(verb === 'taps' ? 1 : 0);
}
if (area !== 'vm') { console.error(`REFUSED: unknown verb: ${area} ${verb}`); process.exit(78); }
const home = (vm) => join(DIR, 'vms', vm);
const root = (vm) => join(home(vm), 'root');
const stateOf = (vm) => (existsSync(join(home(vm), 'state')) ? readFileSync(join(home(vm), 'state'), 'utf8') : undefined);
const setState = (vm, s) => writeFileSync(join(home(vm), 'state'), s);
const fail = (message, code = 2) => { console.error(message); process.exit(code); };
/* A path of the VM, as a path here. */
const inVm = (vm, path) => (path.startsWith('/') ? join(root(vm), path) : path);
const socket = (vm) => `e2e-${vm}`.slice(0, 40);
const killTmux = (vm) => spawnSync('tmux', ['-L', socket(vm), 'kill-server'], { stdio: 'ignore' });

if (verb === 'launch') {
    const vm = argv[0];
    if (stateOf(vm)) fail(`launch failed: instance "${vm}" already exists`);
    mkdirSync(join(root(vm), 'resources'), { recursive: true });
    setState(vm, 'Running');
    /* Building takes a moment in real life; a little of it is kept, so that
       the page's "building" state is really seen by the tests. */
    spawnSync('sleep', [process.env.FAKE_VM_LAUNCH_SECONDS ?? '1']);
    process.exit(0);
}
if (verb === 'info') {
    const s = stateOf(argv[0]);
    if (!s) fail(`info failed: instance "${argv[0]}" does not exist`);
    console.log(JSON.stringify({ info: { [argv[0]]: { state: s } } }));
    process.exit(0);
}
if (verb === 'start' || verb === 'stop' || verb === 'suspend') {
    const vm = argv[0];
    if (!stateOf(vm)) fail(`instance "${vm}" does not exist`);
    /* A stopped machine has lost its processes; a suspended one has not. */
    if (verb === 'stop') killTmux(vm);
    setState(vm, verb === 'start' ? 'Running' : verb === 'stop' ? 'Stopped' : 'Suspended');
    process.exit(0);
}
if (verb === 'delete') {
    const vm = argv[0];
    killTmux(vm);
    rmSync(home(vm), { recursive: true, force: true });
    process.exit(0);
}
if (verb === 'mount') {
    const [vm, kind, name] = argv;
    /* As the real program: a read attachment meets the view, or nothing. */
    if (kind === 'view' && !existsSync(marker(name))) { console.error(`REFUSED: the read-only view of ${name} is not in place`); process.exit(78); }
    const source = kind === 'work' ? join(workHome(name), 'work') : kind === 'view' ? viewOf(name) : folderOf(name);
    const path = kind === 'work' ? '/work' : `/resources/${name}`;
    const link = inVm(vm, path);
    if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) fail(`mount failed: "${path}" is already mounted in '${vm}'`);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(source, link);
    process.exit(0);
}
if (verb === 'umount') {
    rmSync(inVm(argv[0], `/resources/${argv[1]}`), { force: true });
    process.exit(0);
}
if (verb === 'exec') {
    const vm = argv[0];
    if (stateOf(vm) !== 'Running') fail(`exec failed: instance "${vm}" is not running`);
    let command = argv.slice(argv.indexOf('--') + 1);
    if (command[0] === 'sudo') command = command.slice(command[1] === '-n' ? 2 : 1);
    const [program, ...rest] = command;
    const stdin = () => readFileSync(0);
    if (program === 'snap' || program === 'chown') process.exit(0);
    if (program === 'mkdir') { mkdirSync(inVm(vm, rest.at(-1)), { recursive: true }); process.exit(0); }
    if (program === 'install') {
        const target = inVm(vm, rest.at(-1));
        if (rest.includes('-d')) { mkdirSync(target, { recursive: true }); process.exit(0); }
        mkdirSync(dirname(target), { recursive: true });
        /* The runner names /run/secrets: here that is a directory of this VM. */
        writeFileSync(target, stdin().toString('utf8').replaceAll('/run/secrets', inVm(vm, '/run/secrets')));
        chmodSync(target, Number.parseInt(rest[rest.indexOf('-m') + 1], 8));
        process.exit(0);
    }
    if (program === 'find') {
        const dir = inVm(vm, rest[0]);
        for (const name of existsSync(dir) ? readdirSync(dir) : []) rmSync(join(dir, name), { recursive: true, force: true });
        process.exit(0);
    }
    if (program === 'tmux') {
        /* Each VM has its own tmux server, as each real VM does. */
        const args = rest.map((a, i) => (rest[i - 1] === '-L' ? socket(vm) : rest[i - 1] === '-c' || a.startsWith('/usr/local/bin/') ? inVm(vm, a) : a));
        const child = spawn('tmux', args, { stdio: 'inherit', env: { ...process.env, TMUX: '', FAKE_VM_ROOT: root(vm) } });
        child.on('exit', (code) => process.exit(code ?? 1));
    } else {
        const child = spawn(program, rest.map((a) => (a.startsWith('/resources/') || a.startsWith('/work') || a.startsWith('/run/') ? inVm(vm, a) : a)), { stdio: 'inherit', cwd: root(vm) });
        child.on('error', () => process.exit(127));
        child.on('exit', (code) => process.exit(code ?? 1));
    }
} else if (!['launch', 'info', 'start', 'stop', 'suspend', 'delete', 'mount', 'umount'].includes(verb)) {
    fail(`unknown verb: ${verb}`, 64);
}
