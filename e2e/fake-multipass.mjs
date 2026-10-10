#!/usr/bin/env node
/* A STAND-IN FOR THE VM MANAGER, for end-to-end tests on a machine with no
   VM. It speaks the few verbs the server uses and plays each "VM" as a
   directory: what would run inside the VM runs here, with its paths moved
   under that directory, and with a tmux server of its own per VM.
 *
 * It exists so that the REAL server, the REAL page and REAL terminals can be
 * exercised together. It is not a sandbox and protects nothing.
 *
 * State lives under FAKE_VM_DIR:  vms/<name>/{state, root/...}
 */
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync, chmodSync, lstatSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DIR = process.env.FAKE_VM_DIR;
if (!DIR) { console.error('FAKE_VM_DIR is not set'); process.exit(64); }
const argv = process.argv.slice(2);
const verb = argv[0];
/* For the tests that count what is sent into a machine. */
if (process.env.FAKE_VM_LOG) appendFileSync(process.env.FAKE_VM_LOG, `${verb} ${argv.slice(1, 6).join(' ')}\n`);
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
    const vm = argv[argv.indexOf('--name') + 1];
    if (stateOf(vm)) fail(`launch failed: instance "${vm}" already exists`);
    mkdirSync(join(root(vm), 'resources'), { recursive: true });
    setState(vm, 'Running');
    /* Building takes a moment in real life; a little of it is kept, so that
       the page's "building" state is really seen by the tests. */
    spawnSync('sleep', [process.env.FAKE_VM_LAUNCH_SECONDS ?? '1']);
    process.exit(0);
}
if (verb === 'info') {
    const s = stateOf(argv[1]);
    if (!s) fail(`info failed: instance "${argv[1]}" does not exist`);
    console.log(JSON.stringify({ info: { [argv[1]]: { state: s } } }));
    process.exit(0);
}
if (verb === 'start' || verb === 'stop' || verb === 'suspend') {
    const vm = argv[1];
    if (!stateOf(vm)) fail(`instance "${vm}" does not exist`);
    /* A stopped machine has lost its processes; a suspended one has not. */
    if (verb === 'stop') killTmux(vm);
    setState(vm, verb === 'start' ? 'Running' : verb === 'stop' ? 'Stopped' : 'Suspended');
    process.exit(0);
}
if (verb === 'delete') {
    const vm = argv.at(-1);
    killTmux(vm);
    rmSync(home(vm), { recursive: true, force: true });
    process.exit(0);
}
if (verb === 'mount') {
    const [source, target] = argv.slice(-2);
    const [vm, path] = target.split(':');
    const link = inVm(vm, path);
    if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) fail(`mount failed: "${path}" is already mounted in '${vm}'`);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(source, link);
    process.exit(0);
}
if (verb === 'umount') {
    const [vm, path] = argv[1].split(':');
    rmSync(inVm(vm, path), { force: true });
    process.exit(0);
}
if (verb === 'exec') {
    const vm = argv[1];
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
