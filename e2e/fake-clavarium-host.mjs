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
/* What the server has left, and what takes the room: plenty, unless a test
   says otherwise (FAKE_SERVER_ROOM, FAKE_SERVER_USAGE: the lines the real
   verbs print). The machines that run here are given a little memory each. */
if (area === 'server' && verb === 'room') {
    const running = existsSync(join(DIR, 'vms')) ? readdirSync(join(DIR, 'vms')).filter((vm) => { try { return readFileSync(join(DIR, 'vms', vm, 'state'), 'utf8').trim() === 'Running'; } catch { return false; } }) : [];
    /* The CPU time of the server and of each machine, growing with the clock: the curves have something to draw. */
    const ticks = Math.floor(Date.now() / 10) * 4;
    const cpu = [`cpu ${ticks} ${Math.floor(ticks * 0.6)} 4`, ...running.map((vm) => `machinecpu ${vm} ${Math.floor(ticks / 20)}`)];
    console.log(process.env.FAKE_SERVER_ROOM ?? ['place machines 2049 102400 61440', 'place data 2049 102400 61440', 'place folders 2049 102400 61440', 'memory 16384 12288', ...running.map((vm) => `machine ${vm} 900`), ...cpu].join('\n'));
    process.exit(0);
}
if (area === 'server' && verb === 'usage') {
    const made = existsSync(join(DIR, 'vms')) ? readdirSync(join(DIR, 'vms')).filter((vm) => vm.startsWith('clv-')) : [];
    console.log(process.env.FAKE_SERVER_USAGE ?? ['used data 120', 'used folders 2300', 'used work 1800', 'used removed 0', 'used tools 3', ...made.map((vm) => `used machine ${vm} 1500`), 'used shelf 0', 'used others 0', 'used images 650'].join('\n'));
    process.exit(0);
}
/* THE DISKS: a system disk, an empty one, one with a file system not mounted, one mounted
   under /mnt where the machines may go; what was prepared or mounted is kept in FAKE_VM_DIR/disks. */
if (area === 'disks' || (area === 'machines' && ['places', 'old', 'moving'].includes(verb))) {
    const G = 1024 ** 3;
    const state = join(DIR, 'disks.json');
    const done = existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {};
    const keep = () => writeFileSync(state, JSON.stringify(done));
    const dev = (name, type, size, extra = {}) => ({ name, path: `/dev/${name}`, type, size, fstype: null, label: null, uuid: null, mountpoint: null, model: null, ro: false, rm: false, pkname: null, tran: null, ...extra });
    const list = () => [
        dev('fd0', 'disk', 4096, { rm: true }),
        dev('sda', 'disk', 100 * G, { model: 'QEMU HARDDISK', children: [dev('sda1', 'part', 99 * G, { fstype: 'ext4', mountpoint: '/' }), dev('sda15', 'part', 100 * 1024 ** 2, { fstype: 'vfat', mountpoint: '/boot/efi' })] }),
        done.sdb ? dev('sdb', 'disk', 500 * G, { model: 'WD Blue', children: [dev('sdb1', 'part', 500 * G, { fstype: 'ext4', label: 'clavarium', mountpoint: '/mnt/sdb' })] }) : dev('sdb', 'disk', 500 * G, { model: 'WD Blue' }),
        dev('sdc', 'disk', 1000 * G, { children: [dev('sdc1', 'part', 1000 * G, { fstype: 'ext4', label: 'photos', mountpoint: done.sdc1 ? '/mnt/sdc1' : null })] }),
        dev('sdd', 'disk', 2000 * G, { model: 'Seagate Archive drive with a long name', children: [dev('sdd1', 'part', 2000 * G, { fstype: 'ext4', mountpoint: '/mnt/data' })] }),
    ];
    if (verb === 'list') { console.log(JSON.stringify({ blockdevices: list() })); process.exit(0); }
    /* The system's volume made small at installation: room set aside until it is grown. */
    if (verb === 'room') { console.log(`lvroom / /dev/mapper/vg-root vg ${done.grown ? 0 : 1740000} ext4`); process.exit(0); }
    if (verb === 'grow') { if (argv[0] !== '/') { console.error('REFUSED: not that one'); process.exit(78); } done.grown = true; keep(); console.log('grown / 1840000'); process.exit(0); }
    if (verb === 'places') {
        console.log(['now /var/snap/multipass/common 2049 102400 61440', 'place /mnt/data 3000 2048000 1900000', ...(done.sdb ? ['place /mnt/sdb 3001 512000 500000'] : []), ...(done.sdc1 ? ['place /mnt/sdc1 3002 1024000 400'] : [])].join('\n'));
        process.exit(0);
    }
    if (verb === 'old' || verb === 'moving') { if (verb === 'moving') console.log('state inactive'); process.exit(0); }
    if (verb === 'prepare') { if (argv[0] !== '/dev/sdb' || argv[1] !== 'sdb') { console.error('REFUSED: not that one'); process.exit(78); } done.sdb = true; keep(); console.log('prepared /dev/sdb1, mounted /mnt/sdb'); process.exit(0); }
    if (verb === 'mount') { if (argv[0] !== '/dev/sdc1') { console.error('REFUSED: not that one'); process.exit(78); } done.sdc1 = true; keep(); console.log('mounted /mnt/sdc1'); process.exit(0); }
}
/* LOGS: a few lines per source, one holding a secret the page must not show; a restart only noted. */
if (area === 'server' && verb === 'logs') {
    console.log([`2026-10-21T03:20:00+0000 host ${argv[0]}[1]: started (${argv[1]})`, '2026-10-21T03:21:00+0000 host x[1]: login password=hunter2hunter2', '2026-10-21T03:22:00+0000 host kernel: Out of memory: Killed process 4242 (qemu-system-x86)'].join('\n'));
    process.exit(0);
}
if (area === 'server' && verb === 'restart') { writeFileSync(join(DIR, 'restart-asked'), new Date().toISOString()); process.exit(0); }
/* WI-FI: a server on "Home", a few networks in sight; FAKE_VM_DIR/wifi.json keeps what was
   joined or forgotten. A switch ends a second after it was asked: joined when the password is
   "right-password" (or the network is open), back on the network before otherwise. */
if (area === 'wifi') {
    const at = join(DIR, 'wifi.json');
    const w = existsSync(at) ? JSON.parse(readFileSync(at, 'utf8')) : { using: 'Home', saved: ['Home', 'Office'], last: null };
    const keep = () => writeFileSync(at, JSON.stringify(w));
    const fail = (message, code) => { console.error(`REFUSED: ${message}`); process.exit(code); };
    const seen = [['Home', 70, 'wpa'], ['Café "Guest"', 55, 'wpa'], ['Corp', 80, 'enterprise'], ['Open Lounge', 40, 'open']];
    const now = Math.floor(Date.now() / 1000);
    /* Its network set up outside (netplan, systemd-networkd): handed over a second after it was asked. */
    if (w.hand?.state === 'switching' && Date.now() - w.hand.ms > 1000) { w.hand = { state: 'handed', at: now }; w.outside = false; keep(); }
    if (verb === 'handover') {
        if (!w.outside) fail("this server's network is not one netplan renders with systemd-networkd: nothing to hand over", 78);
        w.hand = { state: 'switching', at: now, ms: Date.now() }; keep();
        console.log('handing'); process.exit(0);
    }
    /* Its connections: a cable and the Wi-Fi, each with its address (written apart: not an address of anywhere). */
    const address = (last) => ['192', '168', '1', String(last)].join('.');
    const links = [`link cable eth0 ${address(20)}`, `link wifi wlan0 ${w.using ? address(21) : 'none'}`];
    if (verb === 'status') console.log(links.join('\n'));
    if (verb === 'status' && (w.outside || w.hand)) {
        const h = w.hand ? [`hand ${w.hand.state} ${w.hand.at}`] : [];
        if (w.outside) { console.log([...h, ...(w.hand?.state === 'switching' ? [] : ['handover possible']), 'nmcli no', 'wifiwhy no-nmcli'].join('\n')); process.exit(0); }
        console.log(h.join('\n'));
    }
    if (w.last?.state === 'joining' && Date.now() - w.last.ms > 1000) {
        w.last.state = w.last.ok ? 'joined' : 'went-back'; w.last.at = now;
        if (w.last.ok) { w.using = w.last.ssid; w.saved.push(w.last.ssid); } else w.last.why = 'password';
        keep();
    }
    if (verb === 'status') {
        const l = w.last;
        console.log(['nmcli yes', 'device wlan0', ...(w.using ? [`using ${seen.find((n) => n[0] === w.using)?.[1] ?? 60} ${w.using}`] : []), ...w.saved.map((x) => `saved ${x}`),
            ...(l ? [`last ${l.state} ${l.at}`, `lastssid ${l.ssid}`, `lastback ${l.back ?? ''}`, ...(l.why ? [`lastwhy ${l.why}`] : [])] : [])].join('\n'));
        process.exit(0);
    }
    if (verb === 'scan') { console.log(seen.map(([ssid, signal, sec]) => `network ${signal} ${sec} ${ssid === w.using ? 'now' : 'other'} ${ssid}`).join('\n')); process.exit(0); }
    if (verb === 'join') {
        const [ssid, password] = readFileSync(0, 'utf8').split('\n');
        const n = seen.find((x) => x[0] === ssid);
        if (!n) fail(`${ssid} is not in sight of this server: look for the networks again`, 78);
        if (n[2] === 'enterprise') fail(`${ssid} asks for a user and a certificate (802.1X), which are not given from here`, 78);
        w.last = { state: 'joining', at: now, ms: Date.now(), ssid, back: w.using, ok: n[2] === 'open' || password === 'right-password' };
        keep();
        console.log(`joining ${ssid}\nfallback ${w.using ?? ''}`);
        process.exit(0);
    }
    if (verb === 'forget') {
        if (argv[0] === w.using) fail(`${argv[0]} is the network in use: join another one first`, 78);
        if (!w.saved.includes(argv[0])) fail(`no saved network is named ${argv[0]}`, 78);
        w.saved = w.saved.filter((x) => x !== argv[0]); keep();
        console.log(`forgotten ${argv[0]}`);
        process.exit(0);
    }
}
/* UPDATES: the updater played on two files (the ones the server reads, as the
   real updater writes them): FAKE_VM_DIR/update/state.json and update.conf.
   What the registry has out: update/registry; a version that will not come up: update/broken. */
if (area === 'update') {
    const at = join(DIR, 'update');
    mkdirSync(at, { recursive: true });
    const read = (f, d) => { try { return readFileSync(join(at, f), 'utf8').trim(); } catch { return d; } };
    const state = JSON.parse(read('state.json', '{}'));
    const save = () => writeFileSync(join(at, 'state.json'), JSON.stringify(state));
    const now = new Date().toISOString();
    const done = (entry) => { state.history = [{ at: now, ...entry }, ...(state.history ?? [])]; state.running = null; };
    if (verb === 'check') { const out = read('registry', ''); state.checkedAt = now; state.available = out && out !== state.version ? out : null; save(); process.exit(0); }
    if (verb === 'set') {
        const conf = Object.fromEntries(read('update.conf', '').split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')));
        conf[{ mode: 'MODE', channel: 'CHANNEL', window: 'WINDOW' }[argv[0]]] = argv[1];
        writeFileSync(join(at, 'update.conf'), `${Object.entries(conf).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
        process.exit(0);
    }
    if (verb === 'apply') {
        const from = state.version;
        if (read('broken', '') === argv[0]) done({ action: 'update', from, to: argv[0], result: 'rolled-back', why: 'it did not answer' });
        else { done({ action: 'update', from, to: argv[0], result: 'done' }); state.version = argv[0]; state.releases = [{ id: argv[0], version: argv[0], current: true }, { id: from, version: from, current: false }]; }
        /* As the updater: what is out stays out after a version put back. */
        if (state.version === argv[0]) state.available = null;
        save(); process.exit(0);
    }
    if (verb === 'rollback') {
        const from = state.version;
        done({ action: 'back', from, to: argv[0], result: 'done' }); state.version = argv[0];
        state.releases = [{ id: argv[0], version: argv[0], current: true }, { id: from, version: from, current: false }];
        save(); process.exit(0);
    }
    process.exit(64);
}
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
/* The views never break here: nothing to take off. */
} else if (area === 'mounts' && verb === 'repair') { process.exit(0);
} else if (area !== 'vm') { console.error(`REFUSED: unknown verb: ${area} ${verb}`); process.exit(78); }
/* Everything below plays a VM. */
if (area === 'vm') {
    const home = (vm) => join(DIR, 'vms', vm);
    const root = (vm) => join(home(vm), 'root');
    const stateOf = (vm) => (existsSync(join(home(vm), 'state')) ? readFileSync(join(home(vm), 'state'), 'utf8') : undefined);
    const setState = (vm, s) => writeFileSync(join(home(vm), 'state'), s);
    const fail = (message, code = 2) => { console.error(message); process.exit(code); };
    /* The VM manager answers here: asked if it does (vmwatch.mjs), and restarted when asked. */
    if (verb === 'ping' || verb === 'revive') process.exit(0);
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
    if (verb === 'states') {
        const vms = existsSync(join(DIR, 'vms')) ? readdirSync(join(DIR, 'vms')).filter((vm) => stateOf(vm)) : [];
        console.log(JSON.stringify({ list: vms.map((name) => ({ name, state: stateOf(name), ipv4: [] })) }));
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
        /* A start or a stop that takes a while, when a test says so: the page's
           wait is then seen. Meanwhile the machine is said to be starting or
           stopping, as the VM manager says it. */
        if (verb === 'start') { setState(vm, 'Starting'); spawnSync('sleep', [process.env.FAKE_VM_START_SECONDS ?? '0']); }
        if (verb === 'stop') { setState(vm, 'Stopping'); spawnSync('sleep', [process.env.FAKE_VM_STOP_SECONDS ?? '0']); }
        /* A machine just started does not answer at once while its system
           comes up: for this long, when a test says so. */
        if (verb === 'start') writeFileSync(join(home(vm), 'answers-at'), String(Date.now() + Number(process.env.FAKE_VM_BOOT_SECONDS ?? '0') * 1000));
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
        if (existsSync(join(home(vm), 'answers-at')) && Date.now() < Number(readFileSync(join(home(vm), 'answers-at'), 'utf8'))) fail('exec failed: the machine does not answer yet', 255);
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
            const lines = [`memory ${memory * 1024} ${(h.availableMb ?? Math.round(memory * 0.6)) * 1024}`, `oom ${h.oom ?? 0}`, ...(h.oomMachine !== undefined || h.oomLimit !== undefined ? [`oomkinds ${h.oomMachine ?? 0} ${h.oomLimit ?? 0}`] : []), `disk / ${h.diskLeftMb ?? 5000} 8000`];
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
        /* The machine's tools (Parley, Docket, Binder): the ones installed in it. */
        if (program === 'parley' || program === 'docket' || program === 'binder') {
            const bin = inVm(vm, `/usr/local/bin/${program}`);
            if (!existsSync(bin)) { console.error(`${program}: command not found`); process.exit(127); }
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
