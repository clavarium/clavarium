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
import { mkdirSync, rmdirSync, renameSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, readdirSync, chmodSync, lstatSync, appendFileSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DIR = process.env.FAKE_VM_DIR;
if (!DIR) { console.error('FAKE_VM_DIR is not set'); process.exit(64); }
const [area, verb, ...argv] = process.argv.slice(2);
/* For the tests that count what is sent into a machine. */
if (process.env.FAKE_VM_LOG && (area === 'vm' || area === 'shelf')) appendFileSync(process.env.FAKE_VM_LOG, `${area === 'shelf' ? 'shelf ' : ''}${verb} ${argv.slice(0, 5).join(' ')}\n`);
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
/* Room left: plenty, unless a test says otherwise. */
if (area === 'work' && verb === 'room') { console.log(process.env.FAKE_WORK_ROOM ?? 'disk 9000 host 20000'); process.exit(0); }
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
/* The tools folder: the server's files, and their "read-only view", a link as views are here. */
const toolsView = join(DATA, 'toolbox', 'view');
if (area === 'tools' && verb === 'make') {
    mkdirSync(join(DATA, 'toolbox', 'files'), { recursive: true });
    if (!lstatSync(toolsView, { throwIfNoEntry: false })) symlinkSync(join(DATA, 'toolbox', 'files'), toolsView);
    process.exit(0);
}
if (area === 'view' && verb === 'close') { rmSync(viewOf(argv[0]), { force: true }); rmSync(marker(argv[0]), { force: true }); process.exit(0); }
if (area === 'net') {
    if (verb === 'apply') { writeFileSync(`${DIR}/network-rules`, argv[0]); appendFileSync(`${DIR}/network-log`, `${Date.now()}\n`); process.exit(0); }
    /* taps, bridge: no VM runs here, so there is nothing to list. */
    process.exit(verb === 'taps' ? 1 : 0);
}
/* THE READY-MADE MACHINE: a "VM" directory like the others, prepared and
   then stopped. Its preparation steps are NOT run: here they would install
   packages on the machine running the tests. They are only logged. */
if (area === 'shelf') {
    const shelfHome = (name) => join(DIR, 'vms', name);
    const [name] = argv;
    if (verb === 'room') { console.log(process.env.FAKE_SHELF_ROOM ?? 'free 50000'); process.exit(0); }
    if (verb === 'list') { for (const n of existsSync(join(DIR, 'vms')) ? readdirSync(join(DIR, 'vms')) : []) if (n.startsWith('clvshelf-')) console.log(n); process.exit(0); }
    if (!/^clvshelf-\d{8}-\d{6}$/.test(name ?? '')) { console.error(`REFUSED: not one of our ready-made machines: ${name}`); process.exit(78); }
    if (verb === 'launch') {
        if (existsSync(shelfHome(name))) { console.error(`launch failed: instance "${name}" already exists`); process.exit(2); }
        mkdirSync(join(shelfHome(name), 'root', 'resources'), { recursive: true });
        writeFileSync(join(shelfHome(name), 'state'), 'Running');
        process.exit(0);
    }
    if (!existsSync(join(shelfHome(name), 'state'))) { console.error(`instance "${name}" does not exist`); process.exit(2); }
    if (verb === 'exec') { appendFileSync(join(shelfHome(name), 'prepared'), `${argv.slice(2).join(' ')}\n`); process.exit(0); }
    if (verb === 'seal') { writeFileSync(join(shelfHome(name), 'state'), 'Stopped'); process.exit(0); }
    if (verb === 'info') { console.log(JSON.stringify({ info: { [name]: { state: readFileSync(join(shelfHome(name), 'state'), 'utf8') } } })); process.exit(0); }
    if (verb === 'size') { console.log('size 4200'); process.exit(0); }
    if (verb === 'delete') { rmSync(shelfHome(name), { recursive: true, force: true }); process.exit(0); }
    console.error(`REFUSED: unknown verb: shelf ${verb}`); process.exit(78);
}
/* THE GIT READER: the real reader script, run in the folder, with the host's
   exit codes (see fake-git-read.mjs). A reference is refused, as for real. */
if (area === 'git') {
    const [name] = argv;
    if (!/^[a-z]([a-z0-9-]{0,30}[a-z0-9])?$/.test(name ?? '') || argv.length !== 1) { console.error('REFUSED: not a folder name'); process.exit(78); }
    if (verb === 'stop') process.exit(0);
    if (verb !== 'read') { console.error(`REFUSED: unknown verb: git ${verb}`); process.exit(78); }
    if (name.endsWith('-origin')) { console.error('REFUSED: the reference of a repository is never read this way'); process.exit(78); }
    if (!existsSync(folderOf(name)) || lstatSync(folderOf(name)).isSymbolicLink()) { console.error(`REFUSED: no such folder: ${name}`); process.exit(78); }
    const child = spawn(process.execPath, [join(dirname(new URL(import.meta.url).pathname), 'fake-git-read.mjs'), folderOf(name), name], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('close', (code) => process.exit(code ?? 82));
} else if (area !== 'vm') { console.error(`REFUSED: unknown verb: ${area} ${verb}`); process.exit(78); }
/* Everything below plays a VM. */
if (area === 'vm') {
    const home = (vm) => join(DIR, 'vms', vm);
    const root = (vm) => join(home(vm), 'root');
    const stateOf = (vm) => (existsSync(join(home(vm), 'state')) ? readFileSync(join(home(vm), 'state'), 'utf8') : undefined);
    const setState = (vm, s) => writeFileSync(join(home(vm), 'state'), s);
    const fail = (message, code = 2) => { console.error(message); process.exit(code); };
    /* A path of the VM, as a path here. */
    /* ("dir/." and "dir/" mean something to cp: the ending is kept.) */
    const inVm = (vm, path) => (path.startsWith('/') ? join(root(vm), path) + (path.endsWith('/.') ? '/.' : path.endsWith('/') && path !== '/' ? '/' : '') : path);
    /* Named after the bench that runs it (FAKE_TMUX_PREFIX), so that two runs on one computer stay apart. */
    const socket = (vm) => `${process.env.FAKE_TMUX_PREFIX ?? 'e2e-'}${vm}`.slice(0, 40);
    const killTmux = (vm) => spawnSync('tmux', ['-L', socket(vm), 'kill-server'], { stdio: 'ignore' });

    /* What the VM manager says the machine has: memory in MB, disk in GB. */
    const sizeFile = (vm) => join(home(vm), 'size.json');
    const sizeOf = (vm) => (existsSync(sizeFile(vm)) ? JSON.parse(readFileSync(sizeFile(vm), 'utf8')) : { memory: 1024, disk: 8 });
    const setSize = (vm, change) => writeFileSync(sizeFile(vm), JSON.stringify({ ...sizeOf(vm), ...change }));
    /* What a test makes the machine report about itself (see health.mjs):
       { oom, availableMb, diskLeftMb, dead: [paths whose link died], silent: true }. */
    const healthOf = (vm) => (existsSync(join(home(vm), 'health.json')) ? JSON.parse(readFileSync(join(home(vm), 'health.json'), 'utf8')) : {});
    /* A link that died is healed by unmounting it, as a real one is. */
    const heal = (vm, path) => { const h = healthOf(vm); if (h.dead?.includes(path)) writeFileSync(join(home(vm), 'health.json'), JSON.stringify({ ...h, dead: h.dead.filter((x) => x !== path) })); };
    if (verb === 'launch') {
        const vm = argv[0];
        if (stateOf(vm)) fail(`launch failed: instance "${vm}" already exists`);
        mkdirSync(join(root(vm), 'resources'), { recursive: true });
        setState(vm, 'Running');
        setSize(vm, { memory: Number(argv[1]), disk: 8 });
        /* Building takes a moment in real life; a little of it is kept, so that
           the page's "building" state is really seen by the tests. */
        spawnSync('sleep', [process.env.FAKE_VM_LAUNCH_SECONDS ?? '1']);
        process.exit(0);
    }
    /* A copy of a stopped ready-made machine, stopped too. */
    if (verb === 'clone') {
        const [from, vm] = argv;
        if (stateOf(from) !== 'Stopped') fail(`clone failed: "${from}" is not stopped`);
        if (stateOf(vm)) fail(`clone failed: instance "${vm}" already exists`);
        cpSync(root(from), root(vm), { recursive: true });
        setState(vm, 'Stopped');
        setSize(vm, { memory: Number(argv[2]), disk: 8 });
        spawnSync('sleep', [process.env.FAKE_VM_STEP_SECONDS ?? '0']);
        process.exit(0);
    }
    if (verb === 'info') {
        const s = stateOf(argv[0]);
        if (!s) fail(`info failed: instance "${argv[0]}" does not exist`);
        console.log(JSON.stringify({ info: { [argv[0]]: { state: s } } }));
        process.exit(0);
    }
    if (verb === 'size') {
        const { memory, disk } = sizeOf(argv[0]);
        console.log(`memory ${memory}M\ndisk ${disk}.0GiB`);
        process.exit(0);
    }
    if (verb === 'set') {
        const [vm, key, value] = argv;
        if (stateOf(vm) !== 'Stopped') fail(`set failed: instance "${vm}" must be stopped`);
        if (key === 'disk' && Number(value) < sizeOf(vm).disk) fail('set failed: disk can only grow');
        setSize(vm, { [key]: Number(value) });
        process.exit(0);
    }
    /* A clean stop that hangs, when a test says so: the force is then needed. */
    if (verb === 'stop' && existsSync(join(home(argv[0]), 'stuck'))) { spawnSync('sleep', ['2']); fail('stop failed: timed out'); }
    if (verb === 'kill') {
        const vm = argv[0];
        if (!stateOf(vm)) fail(`instance "${vm}" does not exist`);
        killTmux(vm); setState(vm, 'Stopped'); rmSync(join(home(vm), 'stuck'), { force: true });
        appendFileSync(join(home(vm), 'killed'), 'x');
        process.exit(0);
    }
    if (verb === 'start' || verb === 'stop' || verb === 'suspend') {
        const vm = argv[0];
        if (!stateOf(vm)) fail(`instance "${vm}" does not exist`);
        /* A start that takes a while, when a test says so: the page's wait is then seen. */
        if (verb === 'start') spawnSync('sleep', [process.env.FAKE_VM_START_SECONDS ?? '0']);
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
        /* (A real mount covers an empty directory; here it must not be in the way.) */
        if (kind === 'work') { try { rmdirSync(inVm(vm, '/work')); } catch { /* not there, or not empty: said below */ } }
        /* As the real program: a read attachment meets the view, or nothing. */
        if (kind === 'view' && !existsSync(marker(name))) { console.error(`REFUSED: the read-only view of ${name} is not in place`); process.exit(78); }
        if (kind === 'tools' && !existsSync(toolsView)) { console.error('REFUSED: the read-only view of the tools is not in place'); process.exit(78); }
        const source = kind === 'work' ? join(workHome(name), 'work') : kind === 'view' ? viewOf(name) : kind === 'tools' ? toolsView : folderOf(name);
        const path = kind === 'work' ? '/work' : kind === 'tools' ? '/tools' : `/resources/${name}`;
        const link = inVm(vm, path);
        if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) fail(`mount failed: "${path}" is already mounted in '${vm}'`);
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(source, link);
        process.exit(0);
    }
    if (verb === 'untools') { rmSync(inVm(argv[0], '/tools'), { force: true }); heal(argv[0], '/tools'); process.exit(0); }
    if (verb === 'unwork') { rmSync(inVm(argv[0], '/work'), { force: true }); mkdirSync(inVm(argv[0], '/work')); heal(argv[0], '/work'); process.exit(0); }
    if (verb === 'umount') {
        rmSync(inVm(argv[0], `/resources/${argv[1]}`), { force: true });
        heal(argv[0], `/resources/${argv[1]}`);
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
        /* The health probe (server/health.mjs): played from what is here, and what the test said. */
        if (program === 'sh' && rest[0] === '-c' && rest[2] === 'clavarium-health') {
            const h = healthOf(vm);
            /* A machine that does not answer: the channel into it fails. */
            if (h.silent) { console.error('exec failed: ssh connection timed out'); process.exit(2); }
            const { memory } = sizeOf(vm);
            const lines = [`memory ${memory * 1024} ${(h.availableMb ?? Math.round(memory * 0.6)) * 1024}`, `oom ${h.oom ?? 0}`, `disk / ${h.diskLeftMb ?? 5000} 8000`];
            for (const path of rest.slice(3)) {
                const link = inVm(vm, path);
                const there = lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() && existsSync(link);
                lines.push(`mount ${there && !h.dead?.includes(path) ? 'ok' : 'missing'} ${path}`);
            }
            console.log(lines.join('\n'));
            process.exit(0);
        }
        /* A copy's first start, and the look that its tool is there: each given
           a moment, so that a test sees every step of the build go by. */
        if (program === 'cloud-init' || program === 'which') {
            spawnSync('sleep', [process.env.FAKE_VM_STEP_SECONDS ?? '0']);
            if (program === 'cloud-init') process.exit(0);
        }
        /* PARLEY INSTALLED BY THE SERVER (toolbox.mjs): installed for real,
           offline, but into the machine's /usr/local here (its root is a
           directory), never into this computer's. Only that install, from
           where the machine sees /tools; each one written down for the tests
           that count them. `parley` is then the one of the machine. */
        if (program === 'npm') {
            const archive = rest.at(-1);
            if (rest[0] !== 'install' || !rest.includes('-g') || !rest.includes('--offline') || !archive.startsWith('/tools/') || !existsSync(inVm(vm, archive))) fail(`npm: refused here: ${rest.join(' ')}`);
            const r = spawnSync('npm', ['install', '-g', '--offline', '--no-audit', '--no-fund', '--prefix', inVm(vm, '/usr/local'), inVm(vm, archive)], { encoding: 'utf8' });
            if (r.status !== 0) fail(r.stderr || 'npm failed', r.status ?? 1);
            appendFileSync(join(home(vm), 'npm-installs'), `${archive}\n`);
            process.exit(0);
        }
        if (program === 'parley') {
            const bin = inVm(vm, '/usr/local/bin/parley');
            if (!existsSync(bin)) { console.error('parley: command not found'); process.exit(127); }
            const r = spawnSync(bin, rest, { encoding: 'utf8', cwd: root(vm) });
            process.stdout.write(r.stdout ?? ''); process.stderr.write(r.stderr ?? '');
            process.exit(r.status ?? 1);
        }
        if (program === 'mkdir') { mkdirSync(inVm(vm, rest.at(-1)), { recursive: true }); process.exit(0); }
        if (program === 'install') {
            const target = inVm(vm, rest.at(-1));
            if (rest.includes('-d')) { mkdirSync(target, { recursive: true }); process.exit(0); }
            mkdirSync(dirname(target), { recursive: true });
            /* As install does: a file put in place, whatever mode the one before had (a guide is 0444). */
            rmSync(target, { force: true });
            /* The runner names /run/secrets: here that is a directory of this VM. */
            writeFileSync(target, stdin().toString('utf8').replaceAll('/run/secrets', inVm(vm, '/run/secrets')));
            chmodSync(target, Number.parseInt(rest[rest.indexOf('-m') + 1], 8));
            process.exit(0);
        }
        if (program === 'find' && rest.includes('-delete')) {
            const dir = inVm(vm, rest[0]);
            for (const name of existsSync(dir) ? readdirSync(dir) : []) rmSync(join(dir, name), { recursive: true, force: true });
            process.exit(0);
        }
        /* A TERMINAL THAT DOES NOT COME, when a test says so (a file "hang-attach"
           in the machine's directory): the channel opens, and nothing ever comes
           through it. Once, unless "hang-always" is there too. */
        if (program === 'tmux' && rest.includes('new-session') && existsSync(join(home(vm), 'hang-attach'))) {
            if (!existsSync(join(home(vm), 'hang-always'))) rmSync(join(home(vm), 'hang-attach'), { force: true });
            setInterval(() => {}, 60_000);
        } else if (program === 'tmux') {
            /* Each VM has its own tmux server, as each real VM does. */
            const args = rest.map((a, i) => (rest[i - 1] === '-L' ? socket(vm) : rest[i - 1] === '-c' || a.startsWith('/usr/local/bin/') ? inVm(vm, a) : a));
            const child = spawn('tmux', args, { stdio: 'inherit', env: { ...process.env, TMUX: '', FAKE_VM_ROOT: root(vm) } });
            child.on('exit', (code) => process.exit(code ?? 1));
        } else {
            const child = spawn(program, rest.map((a) => (a.startsWith('/resources/') || a.startsWith('/work') || a.startsWith('/run/') || a.startsWith('/tools') ? inVm(vm, a) : a)), { stdio: 'inherit', cwd: root(vm) });
            child.on('error', () => process.exit(127));
            child.on('exit', (code) => process.exit(code ?? 1));
        }
    } else if (!['launch', 'clone', 'info', 'start', 'stop', 'suspend', 'delete', 'mount', 'umount', 'unwork', 'untools', 'size', 'set', 'kill'].includes(verb)) {
        fail(`unknown verb: ${verb}`, 64);
    }
}
