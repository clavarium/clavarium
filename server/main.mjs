/* The server. Loopback only: what faces the internet is the edge in front of it.
 *
 * Two ways to run it:
 *
 *   node server/main.mjs --host "sudo -n /usr/local/sbin/clavarium-host" --data /path/to/data \
 *        [--operators you@example.com --public-origin https://clav.example.com]
 *       conversations are VMs, created from the page. --host is how the one
 *       privileged program is reached (deploy/clavarium-host); the data
 *       directory must be the one that program was told (/etc/clavarium/host.conf).
 *       With --operators, an authenticating proxy must stand in front: see gate.mjs
 *
 *   node server/main.mjs --command "your-tool" --cwd /path/to/work
 *       no VM: one tool on this machine, at /?c=<name>. For development.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { attachBridge } from './bridge.mjs';
import { attachCommand } from './tmux.mjs';
import { handleApi } from './api.mjs';
import { Conversations } from './conversations.mjs';
import { Store } from './store.mjs';
import { loadTools } from './tools.mjs';
import { Vms, runner } from './vm.mjs';
import { Resources } from './resources.mjs';
import { makeGate, makeOriginCheck, readOperators } from './gate.mjs';
import { Shortcuts } from './shortcuts.mjs';
import { voiceConfig } from './voice.mjs';
import QRCode from 'qrcode';
import { Devices } from './devices.mjs';
import { handleDoor, deviceConversation } from './door.mjs';
import { Vault } from './vault.mjs';
import { Secrets, RUNNER } from './secrets.mjs';
import { Network } from './network.mjs';
import { SignInMailboxes } from './signin.mjs';
import { Mailboxes, recentMessages } from './mailbox.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILES = {
    '/': ['web/index.html', 'text/html; charset=utf-8'],
    '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
    '/voice.js': ['web/voice.js', 'text/javascript; charset=utf-8'],
    '/icon.svg': ['web/icon.svg', 'image/svg+xml'],
    '/icon-192.png': ['web/icon-192.png', 'image/png'],
    '/icon-512.png': ['web/icon-512.png', 'image/png'],
    '/manifest.webmanifest': ['web/manifest.webmanifest', 'application/manifest+json'],
    '/sw.js': ['web/sw.js', 'text/javascript; charset=utf-8'],
    '/voice-core.js': ['web/voice-core.js', 'text/javascript; charset=utf-8'],
    '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript; charset=utf-8'],
    '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css; charset=utf-8'],
    '/vendor/fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript; charset=utf-8'],
};
/* The device door serves the same files under /c/: that prefix is the only
   one the edge lets through without sign-on. Its page differs; nothing else. */
const DEVICE_FILES = Object.fromEntries(Object.entries(FILES).filter(([path]) => path !== '/').map(([path, file]) => [`/c${path}`, file]));
DEVICE_FILES['/c/'] = ['web/device.html', 'text/html; charset=utf-8'];
DEVICE_FILES['/c/device.js'] = ['web/device.js', 'text/javascript; charset=utf-8'];

/* Nothing loads from anywhere else, and nothing may frame the page. */
const HEADERS = {
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
};

export function option(argv, name, fallback) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

/* A tmux inside a tmux refuses to start: the variable does not travel. */
const withoutTmux = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'TMUX' && key !== 'TMUX_PANE'));

const REFUSED = 'This Clavarium belongs to someone else: your account is not one of its operators.\n';

function serve(port, conversations, resources, { gate = () => 'local', originOk, shortcuts, voice, sharing, door, secrets, network, signin, mailboxes } = {}) {
    const sendFile = async (response, file) => {
        response.writeHead(200, { ...HEADERS, 'content-type': file[1] }).end(await readFile(ROOT + file[0]));
    };
    const server = createServer(async (request, response) => {
        const { pathname } = new URL(request.url ?? '/', 'http://local');
        /* The device door first, and apart: it never consults the gate. */
        if (door && pathname.startsWith('/c/')) {
            if (await handleDoor(request, response, door)) return;
            const file = DEVICE_FILES[pathname];
            if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) { response.writeHead(404, HEADERS).end(); return; }
            await sendFile(response, file);
            return;
        }
        /* Before anything else, static files included: see gate.mjs. */
        if (gate(request.headers) === undefined) {
            response.writeHead(403, { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end(REFUSED);
            return;
        }
        if (conversations && await handleApi(request, response, conversations, HEADERS, resources, originOk, shortcuts, voice, sharing, secrets, network, signin, mailboxes)) return;
        const file = FILES[pathname];
        if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) {
            response.writeHead(404, HEADERS).end();
            return;
        }
        await sendFile(response, file);
    });
    return { server, listening: new Promise((ready) => server.listen(port, '127.0.0.1', () => ready(server))) };
}

/* Development: one tool on this machine, no VM. */
export function start({ port, command, cwd, env = process.env }) {
    const { server, listening } = serve(port);
    attachBridge(server, {
        spawn: (name, cols, rows) => {
            const [program, ...argv] = attachCommand(name, command, cwd);
            return pty.spawn(program, argv, { name: 'xterm-256color', cwd, env: withoutTmux(env), cols, rows });
        },
    });
    return listening;
}

const MAIL_EVERY_MS = 120_000;

/* The product: conversations are VMs. `host` is how the host program is
   reached on this installation, as an argument vector: it is the ONLY thing
   this server runs with more rights than its own. */
export async function startHome({ port, host, dataDir, env = process.env, conversations, resources, operators = [], publicOrigin, vaultKey, tools = loadTools(), stopDelayMs, mailReader }) {
    const gate = makeGate(operators);
    const originOk = makeOriginCheck(publicOrigin);
    const asHost = runner(host);
    const vms = new Vms(asHost, host);
    const all = conversations ?? new Conversations({ store: new Store(`${dataDir}/conversations.json`), vms, tools, ...(stopDelayMs === undefined ? {} : { stopDelayMs }) });
    const folders = resources ?? new Resources({ store: new Store(`${dataDir}/resources.json`), vms, host: asHost, dataDir });
    /* Before anything can start a VM: see resources.mjs. */
    await folders.ensureViews();
    await all.ensureWork?.();
    const shortcuts = new Shortcuts(new Store(`${dataDir}/shortcuts.json`));
    const voice = voiceConfig(env);
    const devices = new Devices(new Store(`${dataDir}/devices.json`));
    const sharing = {
        devices,
        /* Where a pairing address points: the declared public address, or in
           development the address the operator is using right now. */
        origin: (headers) => (publicOrigin ? new URL(publicOrigin).origin : `http://${headers.host}`),
        qr: (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
    };
    const door = { devices, conversations: all, resources: folders, shortcuts, voice, originOk, headers: HEADERS, secure: Boolean(publicOrigin?.startsWith('https:')) };
    const vault = new Vault(vaultKey ?? `${dataDir}/vault.key`);
    const secrets = new Secrets({ store: new Store(`${dataDir}/secrets.json`), vault, vms });
    const signin = new SignInMailboxes({ store: new Store(`${dataDir}/signin.json`), vault, rules: (name) => all.signinRules(name) });
    /* Each opening: the runner and the attached secrets are put in the VM,
       and the tool is started through the runner. */
    const network = new Network({ host: asHost, offline: () => all.offline() });
    /* The rules follow what runs: applied now, and again each time a
       conversation is opened, since a VM that just started has a new tap. */
    await network.apply();
    /* OPENING MUST BE QUICK. Each command sent into a VM costs a noticeable
       part of a second, and delivering secrets takes several: done at every
       opening, it made each page load wait for seconds (felt by the owner).
       So a delivery is remembered: it is done again only when the machine
       has just started, or when what is attached to it has changed. The
       network rules, cheap, are still refreshed every time, alongside. */
    const delivered = new Map();
    all.prepare = async (name, woke) => {
        const wanted = secrets.signature(name);
        const rules = network.apply();
        if (woke || delivered.get(name) !== wanted) {
            delivered.delete(name);
            await secrets.deliver(name);
            delivered.set(name, wanted);
        }
        await rules;
    };
    all.through = [RUNNER];
    /* Mailboxes kept as folders: brought up to date now and then, never
       because a tool asked. */
    /* CLAVARIUM_MAIL_CA: the certificate authority of a mail server of your
       own, as a file, when it is not one every machine already trusts. A
       mailbox is still never read without checking who answers. */
    const mailCa = (env.CLAVARIUM_MAIL_CA ?? '').trim() ? readFileSync(env.CLAVARIUM_MAIL_CA.trim()) : undefined;
    const reader = mailReader ?? ((settings) => recentMessages(settings, { ca: mailCa }));
    const mailboxes = new Mailboxes({ store: new Store(`${dataDir}/mailboxes.json`), vault, resources: folders, reader });
    const mailTimer = setInterval(() => { void mailboxes.syncAll(); }, MAIL_EVERY_MS);
    mailTimer.unref();
    const { server, listening } = serve(port, all, folders, { gate, originOk, shortcuts, voice, sharing, door, secrets, network, signin, mailboxes });
    server.on('close', () => clearInterval(mailTimer));
    const bridge = attachBridge(server, {
        onRejoin: (name) => all.rejoin(name),
        spawn: async (name, cols, rows, say) => {
            const [program, ...argv] = await all.open(name, say);
            return pty.spawn(program, argv, { name: 'xterm-256color', env: withoutTmux(env), cols, rows });
        },
        onLeft: (name) => all.left(name),
        onEnded: (name) => all.ended(name),
        gate, originOk,
        deviceName: (headers) => deviceConversation(devices, headers),
    });
    all.drop = (name) => bridge.drop(name);
    /* The terminal of a running machine is opened before anybody asks: a
       conversation just built, and at start every conversation whose machine
       runs. A page then shows its terminal at once. */
    /* A machine is ready: its folders are shown in it (after a rebuild there
       are some), then its terminal is opened and kept. */
    all.ready = (name) => { void (async () => { await folders.remount(name).catch(() => {}); await bridge.warm(name); })(); };
    void (async () => { for (const name of all.awake()) if (await all.running(name).catch(() => false)) await bridge.warm(name); })();
    return listening;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    const port = Number(option(argv, 'port', '7717'));
    const host = option(argv, 'host', '');
    if (host) {
        const dataDir = option(argv, 'data', `${process.cwd()}/data`);
        /* Behind the edge: who the operators are, and the address people use. */
        const operators = readOperators(option(argv, 'operators', ''));
        const publicOrigin = option(argv, 'public-origin', '') || undefined;
        if (operators.length === 0) console.log('No --operators: development mode, anyone on this machine is the operator.');
        const vaultKey = option(argv, 'vault-key', '') || undefined;
        const server = await startHome({ port, host: host.split(' ').filter(Boolean), dataDir, operators, publicOrigin, vaultKey });
        console.log(`http://127.0.0.1:${server.address().port}/`);
    } else {
        const command = option(argv, 'command', 'bash').split(' ').filter(Boolean);
        const server = await start({ port, command, cwd: option(argv, 'cwd', process.cwd()) });
        console.log(`http://127.0.0.1:${server.address().port}/?c=demo`);
    }
}
