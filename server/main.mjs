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
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { attachBridge } from './bridge.mjs';
import { attachCommand } from './tmux.mjs';
import { handleApi } from './api.mjs';
import { Conversations, DRAWN_MS } from './conversations.mjs';
import { Store, JsonFile } from './store.mjs';
import { Instance } from './instance.mjs';
import { loadTools } from './tools.mjs';
import { Vms, runner } from './vm.mjs';
import { Resources } from './resources.mjs';
import { makeGate, makeOriginCheck, readOperators } from './gate.mjs';
import { Shortcuts } from './shortcuts.mjs';
import { Dictation } from './voice.mjs';
import QRCode from 'qrcode';
import { Devices } from './devices.mjs';
import { handleDoor, deviceTerminal } from './door.mjs';
import { Vault } from './vault.mjs';
import { Secrets, RUNNER } from './secrets.mjs';
import { scan, secretRef } from './secret-scan.mjs';
import { Network } from './network.mjs';
import { Answerer, answererConfig } from './answerer.mjs';
import { Dockets } from './dockets.mjs';
import { PULSE_MS } from 'clavarium-parley/ui';
import { Wakeups, TypingWatch, CALL_PATH } from './wakeups.mjs';
import { Alerts } from './alerts.mjs';
import { Talk } from './talk.mjs';
import { Toolbox } from './toolbox.mjs';
import { Guide, commonText } from './guide.mjs';
import { SignInMailboxes } from './signin.mjs';
import { Mailboxes, recentMessages } from './mailbox.mjs';
import { Grants } from './grants.mjs';
import { Groups } from './groups.mjs';
import { GitReview } from './gitpush.mjs';
import { GitAccess } from './gitaccess.mjs';
import { GitChecks } from './gitchecks.mjs';
import { GitKeeper } from './gitkeeper.mjs';
import { GitRunner } from './gitrunner.mjs';
import { Shelf } from './shelf.mjs';
import { Health } from './health.mjs';
import { Setup } from './setup.mjs';
import { Capacity } from './capacity.mjs';
import { packageFile, PARLEY } from './parley.mjs';
import { Updates } from './updates.mjs';
import { Certificate } from './certificate.mjs';
import { Operators } from './operators.mjs';
import { HealthReact } from './healthreact.mjs';
import { HealthDocket } from './healthdocket.mjs';
import { MachinesMove } from './machinesmove.mjs';
import { Wifi } from './wifi.mjs';
import { MeshCentral } from './meshcentral.mjs';
import { Binders } from './binders.mjs';
import { Tethers } from './tethers.mjs';
import { Accounts } from './accounts.mjs';
import { ServerLogs } from './serverlogs.mjs';
import { History, STEP_MS as HISTORY_STEP_MS } from './history.mjs';
import { Events } from './events.mjs';
import { Bundles } from './bundle.mjs';
import { migrateData } from './dataformat.mjs';
import { VmWatch } from './vmwatch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAINTENANCE = 'deploy/maintenance.html';
export const FILES = {
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
    '/icons.js': ['web/icons.js', 'text/javascript; charset=utf-8'],
    '/links.js': ['web/links.js', 'text/javascript; charset=utf-8'],
    '/gitgraph.js': ['web/gitgraph.js', 'text/javascript; charset=utf-8'],
    /* The page shown while an update stops this server (app.js goes to it); the front serves the same file while it is down. */
    '/maintenance.html': [MAINTENANCE, 'text/html; charset=utf-8'],
    /* The review's diff, drawn by diff2html (vendored, pinned: web/vendor/diff2html/LICENSE). */
    '/vendor/diff2html.js': ['web/vendor/diff2html/diff2html-ui-slim.min.js', 'text/javascript; charset=utf-8'],
    '/vendor/diff2html.css': ['web/vendor/diff2html/diff2html.min.css', 'text/css; charset=utf-8'],
    '/vendor/xterm.js': [packageFile('@xterm/xterm', 'lib/xterm.js'), 'text/javascript; charset=utf-8'],
    '/vendor/xterm.css': [packageFile('@xterm/xterm', 'css/xterm.css'), 'text/css; charset=utf-8'],
    '/vendor/fit.js': [packageFile('@xterm/addon-fit', 'lib/addon-fit.js'), 'text/javascript; charset=utf-8'],
    /* A PDF is drawn by the page itself, on a canvas: asked for only when one is previewed. */
    '/vendor/parley-ui.js': [packageFile(PARLEY, 'ui/parley-ui.js'), 'text/javascript; charset=utf-8'],
    '/vendor/parley-ui.css': [packageFile(PARLEY, 'ui/parley-ui.css'), 'text/css; charset=utf-8'],
    /* Its icons (Lucide, copied in Parley): the chat's, and this page's own. */
    '/vendor/parley-icons.js': [packageFile(PARLEY, 'ui/parley-icons.js'), 'text/javascript; charset=utf-8'],
    /* Binder's screen: it draws the lists, this page gives it a place (Lists). */
    '/vendor/binder-ui.js': [packageFile('clavarium-binder', 'ui/binder-ui.js'), 'text/javascript; charset=utf-8'],
    '/vendor/binder-ui.css': [packageFile('clavarium-binder', 'ui/binder-ui.css'), 'text/css; charset=utf-8'],
    '/vendor/binder-en.json': [packageFile('clavarium-binder', 'ui/texts/en.json'), 'application/json; charset=utf-8'],
    '/vendor/binder-fr.json': [packageFile('clavarium-binder', 'ui/texts/fr.json'), 'application/json; charset=utf-8'],
    '/vendor/pdf.mjs': [packageFile('pdfjs-dist', 'build/pdf.min.mjs'), 'text/javascript; charset=utf-8'],
    '/vendor/pdf.worker.mjs': [packageFile('pdfjs-dist', 'build/pdf.worker.min.mjs'), 'text/javascript; charset=utf-8'],
    /* Drawings in the chat (```mermaid), at the version package.json fixes: asked for only when one is shown. */
    '/vendor/mermaid.js': [packageFile('mermaid', 'dist/mermaid.min.js'), 'text/javascript; charset=utf-8'],
    /* Code coloured in the chat: Prism and the languages it is given, one file; asked for only when code is shown. */
    '/vendor/prism.js': [['web/prism-manual.js', ...['core', 'clike', 'markup', 'css', 'javascript', 'typescript', 'json', 'python', 'bash', 'markup-templating', 'php', 'sql', 'yaml', 'diff', 'markdown', 'ini', 'apacheconf']
        .map((l) => packageFile('prismjs', `components/prism-${l}.min.js`))], 'text/javascript; charset=utf-8'],
};
/* Formulas in the chat are drawn by Parley with its own copy of KaTeX, loaded on the first formula
   (the page tells it where: /vendor/katex/katex.mjs): served as Parley ships it, fonts included. */
try {
    const katex = packageFile(PARLEY, 'ui/vendor/katex');
    FILES['/vendor/katex/katex.mjs'] = [`${katex}/katex.mjs`, 'text/javascript; charset=utf-8'];
    FILES['/vendor/katex/katex.min.css'] = [`${katex}/katex.min.css`, 'text/css; charset=utf-8'];
    for (const font of readdirSync(`${katex}/fonts`)) if (/^[\w.-]+\.woff2$/.test(font)) FILES[`/vendor/katex/fonts/${font}`] = [`${katex}/fonts/${font}`, 'font/woff2'];
} catch { /* a Parley without it: formulas shown as their text */ }
/* The device door serves the same files under /c/: that prefix is the only
   one the edge lets through without sign-on. Its page differs; nothing else. */
const DEVICE_FILES = Object.fromEntries(Object.entries(FILES).filter(([path]) => path !== '/').map(([path, file]) => [`/c${path}`, file]));
DEVICE_FILES['/c/'] = ['web/device.html', 'text/html; charset=utf-8'];
DEVICE_FILES['/c/device.js'] = ['web/device.js', 'text/javascript; charset=utf-8'];

/* Nothing loads from anywhere else, and nothing may frame the page. */
const HEADERS = {
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
};
/* The maintenance page is ONE file, its script in it: the front (Caddy) serves it alone while this
   server is down. Here its script is allowed by its hash, and nothing else inline. */
export const MAINTENANCE_HEADERS = (() => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(readFileSync(ROOT + MAINTENANCE, 'utf8'))?.[1] ?? '';
    const hash = createHash('sha256').update(script).digest('base64');
    return { ...HEADERS, 'content-security-policy': HEADERS['content-security-policy'].replace("default-src 'self';", `default-src 'self'; script-src 'sha256-${hash}';`) };
})();

export function option(argv, name, fallback) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

/* A tmux inside a tmux refuses to start: the variable does not travel. */
const withoutTmux = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'TMUX' && key !== 'TMUX_PANE'));

const REFUSED = 'This Clavarium belongs to someone else: your account is not one of its operators.\n';

function serve(port, conversations, resources, { gate = () => 'local', originOk, shortcuts, voice, sharing, door, secrets, network, signin, mailboxes, gitReview, platform, answerer, wakeups, alerts, talk, gitAccess, gitKeeper, shelf, health, setup, guide, repair, capacity, updates, instance = new Instance(), certificate, team, reacting, machinesMove, serverLogs, history, events, bundles, wifi, binders, meshcentral, tethers, accounts, groups } = {}) {
    /* Its manifest carries the name of this Clavarium, or the one a device chose (instance.mjs). */
    const sendManifest = (response, url) => response.writeHead(200, { ...HEADERS, 'content-type': 'application/manifest+json' }).end(instance.manifest(new URL(url ?? '/', 'http://local').searchParams.get('name') ?? undefined));
    const sendFile = async (response, file) => {
        /* Several files are one, in their order. */
        const body = Array.isArray(file[0]) ? Buffer.concat((await Promise.all(file[0].map((f) => readFile(f.startsWith('/') ? f : ROOT + f)))).flatMap((b) => [b, Buffer.from('\n;\n')])) : await readFile(file[0].startsWith('/') ? file[0] : ROOT + file[0]);
        response.writeHead(200, { ...(file[0] === MAINTENANCE ? MAINTENANCE_HEADERS : HEADERS), 'content-type': file[1] }).end(body);
    };
    const server = createServer(async (request, response) => {
        const { pathname } = new URL(request.url ?? '/', 'http://local');
        /* An update about to stop this server (updates.mjs, notice): said on every answer, so that
           every page hears it at its next question, whatever it asks. */
        try { const notice = updates?.notice(); if (notice) response.setHeader('x-clavarium-update', notice); } catch { /* never in the way of an answer */ }
        /* The version that answers, to the page's own questions: a page loaded before an update starts again (app.js). */
        if (platform?.version && (pathname.startsWith('/api/') || pathname.startsWith('/c/api/'))) response.setHeader('x-clavarium-version', platform.version);
        /* The device door first, and apart: it never consults the gate. */
        /* An address that wakes a tool, called from outside by what its owner
           runs elsewhere: the address is the right. Nothing else is looked at,
           and nothing is said back but what happened. See wakeups.mjs. */
        if (wakeups && pathname.startsWith(CALL_PATH)) {
            const say = (status, body) => response.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
            if (request.method !== 'POST') { say(405, { error: 'Call this address with POST.' }); return; }
            let text = ''; let over = false;
            for await (const piece of request) { text += piece; if (text.length > 4096) { over = true; break; } }
            if (over) { say(413, { error: 'Too long.' }); return; }
            const happened = await wakeups.call(pathname.slice(CALL_PATH.length), text);
            if (happened === undefined) { say(404, { error: 'Not found.' }); return; }
            say(happened === 'typed' ? 202 : happened === 'capped' ? 429 : 409, { woken: happened === 'typed', why: happened });
            return;
        }
        if (door && pathname.startsWith('/c/')) {
            if (await handleDoor(request, response, door)) return;
            if (pathname === '/c/manifest.webmanifest' && request.method === 'GET') { sendManifest(response, request.url); return; }
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
        if (conversations && await handleApi(request, response, conversations, HEADERS, resources, originOk, shortcuts, voice, sharing, secrets, network, signin, mailboxes, gitReview, platform, answerer, wakeups, alerts, talk, gitAccess, gitKeeper, shelf, health, setup, repair, guide, capacity, updates, instance, certificate, team, reacting, machinesMove, serverLogs, history, events, bundles, wifi, binders, meshcentral, tethers, accounts, groups)) return;
        if (pathname === '/manifest.webmanifest' && request.method === 'GET') { sendManifest(response, request.url); return; }
        const file = FILES[pathname];
        if (!file || (request.method !== 'GET' && request.method !== 'HEAD')) {
            response.writeHead(404, HEADERS).end();
            return;
        }
        await sendFile(response, file);
    });
    /* Its port taken (an old server that did not die on its stop): said plainly, and the start fails. */
    const listening = new Promise((ready, fail) => {
        server.once('error', (error) => { if (error.code === 'EADDRINUSE') console.error(`start: port ${port} is in use by another process (an old server that did not stop?): see ss -ltnp 'sport = :${port}'`); fail(error); });
        server.listen(port, '127.0.0.1', () => ready(server));
    });
    return { server, listening };
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
/* An opening waits this long at most for Parley to be installed in its machine (toolbox.mjs). */
const PARLEY_WAIT_MS = 20_000;

/* The product: conversations are VMs. `host` is how the host program is
   reached on this installation, as an argument vector: it is the ONLY thing
   this server runs with more rights than its own. */
export async function startHome({ port, host, dataDir, mntDir = dataDir, gitReserveBytes, env = process.env, conversations, resources, operators = [], publicOrigin, vaultKey, tools = loadTools(), stopDelayMs, mailReader, gitLocalRemotes = false, gitSsh, answerFetcher, answerEveryMs, wakeEveryMs, alertSend, talkEveryMs, gitEveryMs, shelfEveryMs, shelfFirstMs, healthEveryMs, healthSettleMs, setupPollMs, rereadAfterMs, serverRoomMs, updateState, updateConf, appName, startWaitMs = 20_000, vmWatchEveryMs, historyEveryMs = HISTORY_STEP_MS }) {
    /* The data, in the format this code reads, before anything reads it (dataformat.mjs). */
    const migrated = migrateData(dataDir);
    if (migrated.ran.length) console.log(`data: format ${migrated.from} -> ${migrated.to}`);
    /* Who may sign in, kept up to date from the page (operators.mjs); none: this machine only. */
    const team = operators.length ? new Operators({ host: runner(host), store: new Store(`${dataDir}/operators.json`), initial: operators }) : null;
    const gate = makeGate(team ? () => team.allowed() : []);
    const originOk = makeOriginCheck(publicOrigin);
    const instance = new Instance({ file: new JsonFile(`${dataDir}/instance.json`, {}), origin: publicOrigin, given: appName });
    let repairTerminal = async () => { throw new Error('not ready'); };
    const asHost = runner(host);
    const vms = new Vms(asHost, host);
    const all = conversations ?? new Conversations({ store: new Store(`${dataDir}/conversations.json`), layout: new JsonFile(`${dataDir}/layout.json`, {}), vms, tools, ...(stopDelayMs === undefined ? {} : { stopDelayMs }) });
    /* Who may do what with what: ONE table, shared by everything below. */
    const grants = new Grants(new Store(`${dataDir}/grants.json`));
    /* Folder-style boxes the owner drops assets into, to tidy the views and hand a whole box at once (groups.mjs). */
    const groups = new Groups({ store: new Store(`${dataDir}/groups.json`) });
    /* What happened, in one dated list (events.mjs): the owner's actions, and what the server did by itself. */
    const events = new Events({ file: `${dataDir}/events.log` });
    const vault = new Vault(vaultKey ?? `${dataDir}/vault.key`);
    /* How private repositories are reached: keys and tokens kept and used here only (gitaccess.mjs).
       `gitSsh`: a stand-in for the ssh program, for tests. */
    const gitAccess = new GitAccess({ vault, dataDir, ...(gitSsh ? { ssh: gitSsh } : {}) });
    /* The tools every machine sees at /tools, read-only: see toolbox.mjs. */
    /* With /tools/CLAVARIUM.md in it: where a tool is, the same for all (guide.mjs). */
    const toolbox = new Toolbox({ host: asHost, vms, mntDir, notes: () => commonText(), launched: new Store(`${dataDir}/launched.json`),
        launches: (name) => Boolean(tools.find((t) => t.id === all.list().find((c) => c.name === name)?.tool)?.launch) });
    const folders = resources ?? new Resources({ store: new Store(`${dataDir}/resources.json`), vms, host: asHost, dataDir, mntDir, grants, access: gitAccess, toolbox });
    /* The ready-made machine new conversations are copied from, kept fresh
       in the background: see shelf.mjs. Tidied up at start, without making
       the start wait on the VM manager. */
    const shelf = new Shelf({ store: new Store(`${dataDir}/shelf.json`), run: asHost, tools });
    void shelf.recover();
    /* CLAVARIUM_SHELF=off: never rebuilt by itself (the button still works).
       For a server whose disk cannot hold two images of a few GB each, such
       as one that is itself a virtual machine on a small disk. */
    const stopShelf = shelf.start(env.CLAVARIUM_SHELF === 'off' ? 0 : shelfEveryMs, shelfFirstMs);
    if (all.shelf) all.shelf = shelf;
    /* What the host must have before a machine starts (its views, /tools, the work disks, the
       network rules, further down). Waited for at start, but never long: this server listens
       and serves its pages even when the host program or the VM manager does not answer;
       a machine that starts waits for it (all.prepare). */
    const hostSteps = (async () => {
        /* A view left broken (its program gone: killed, crashed) is taken off first, or none can
           be made there again before a reboot: see clavarium-host, "mounts repair". */
        const repaired = await asHost(['mounts', 'repair'], { timeoutMs: 60_000 });
        if (repaired.code || repaired.stderr.trim()) console.error(`mounts: ${repaired.stderr.trim() || `exit ${repaired.code}`}`);
        /* Before anything can start a VM: see resources.mjs. */
        await folders.ensureViews().catch((error) => console.error(`views: ${error.message}`));
        /* Not in place is said, not fatal: no machine is then given /tools. */
        await toolbox.prepare().catch((error) => console.error(error.message));
        await Promise.resolve(all.ensureWork?.()).catch((error) => console.error(`work folders: ${error.message}`));
    })();
    const bounded = (promise, ms, what) => {
        let timer;
        const late = new Promise((r) => { timer = setTimeout(() => { console.error(`start: ${what} still going after ${ms / 1000} s: the server starts without waiting for it`); r(); }, ms); timer.unref?.(); });
        return Promise.race([promise, late]).finally(() => clearTimeout(timer));
    };
    await bounded(hostSteps, startWaitMs, 'the host program');
    const shortcuts = new Shortcuts(new Store(`${dataDir}/shortcuts.json`));
    /* The engine of dictation: chosen in Settings, else the environment's (voice.mjs). */
    const voice = new Dictation({ file: new JsonFile(`${dataDir}/dictation.json`, {}), env, secret: (name) => secrets.reveal(name), expired: (name) => secrets.isExpired(name) });
    /* Read here already: a device paired before a conversation was shared in
       two parts keeps the chat it reached then (see devices.mjs). */
    const talkStore = new Store(`${dataDir}/talk.json`);
    const devices = new Devices(new Store(`${dataDir}/devices.json`), undefined, grants, { chatWas: (name) => talkStore.get(name)?.on === true });
    const sharing = {
        devices,
        /* Where a pairing address points: the declared public address, or in
           development the address the operator is using right now. */
        origin: (headers) => (publicOrigin ? new URL(publicOrigin).origin : `http://${headers.host}`),
        qr: (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
    };
    const door = { devices, conversations: all, resources: folders, shortcuts, voice, originOk, headers: HEADERS, secure: Boolean(publicOrigin?.startsWith('https:')), repair: (name) => repairTerminal(name) };
    const secrets = new Secrets({ store: new Store(`${dataDir}/secrets.json`), vault, vms, grants });
    /* A secret renamed: what names it follows (the key of dictation). `voice` is made below. */
    secrets.renamed = (from, to) => voice.secretRenamed(from, to);
    /* Expired: kept, no longer delivered; said once in What happened. */
    secrets.expired = (name, users) => { events.add({ kind: 'asset', text: `Secret ${name} expired: no longer given${users.length ? ` to ${users.join(', ')}` : ''}` }); };
    secrets.check();
    const expiryTimer = setInterval(() => secrets.check(), 10 * 60_000); expiryTimer.unref();
    const signin = new SignInMailboxes({ store: new Store(`${dataDir}/signin.json`), vault, rules: (name) => all.signinRules(name) });
    /* Each opening: the runner and the attached secrets are put in the VM,
       and the tool is started through the runner. */
    const network = new Network({ host: asHost, offline: () => all.offline() });
    /* The rules follow what runs: applied now, and again each time a
       conversation is opened, since a VM that just started has a new tap. */
    const hostReady = (async () => { await hostSteps; await network.apply().catch((error) => console.error(`network rules: ${error.message}`)); })();
    await bounded(hostReady, startWaitMs, 'the network rules');
    /* OPENING MUST BE QUICK. Each command sent into a VM costs a noticeable
       part of a second, and delivering secrets takes several: done at every
       opening, it made each page load wait for seconds (felt by the owner).
       So a delivery is remembered: it is done again only when the machine
       has just started, or when what is attached to it has changed. The
       network rules, cheap, are still refreshed every time, alongside. */
    const delivered = new Map();
    /* Where its tool is, said to it in a few lines (guide.mjs): written into
       its machine at a start and when a setting changes. `talk` and
       `wakeups` are made below; only asked once the server runs. */
    const guide = new Guide({ store: new Store(`${dataDir}/guide.json`), vms, conversations: all, resources: folders, secrets, toolbox, tools,
        chat: (name) => Boolean(talk?.brief(name)), say: (name, line) => wakeups.say(name, line), reread: () => talk?.rereadCommand() ?? null });
    /* Why Parley is not in a machine, said once in the log, not at each opening. */
    const parleySaid = new Map();
    all.prepare = async (name, woke) => {
        await hostReady;
        secrets.check();
        const wanted = secrets.signature(name);
        const rules = network.apply();
        if (woke || delivered.get(name) !== wanted) {
            delivered.delete(name);
            await secrets.deliver(name);
            delivered.set(name, wanted);
        }
        /* Before the tool starts: it reads its instruction file then. */
        await guide.prepared(name, woke);
        /* Parley, installed by this server in every machine (toolbox.mjs):
           known there, nothing is asked; otherwise looked at, and installed
           if missing or not as the index has it. Waited for, but never long:
           the tool still starts, and it is tried again at the next opening. */
        await Promise.race([toolbox.installIn(name).then((why) => { if (why && parleySaid.get(name) !== why) console.error(`${name}: Parley not installed: ${why}`); parleySaid.set(name, why); }), new Promise((r) => { setTimeout(r, PARLEY_WAIT_MS).unref?.(); })]);
        await rules;
    };
    /* The launcher of its tool, in /tools, before it starts: repaired when missing. */
    all.launcherReady = async (name, file) => { const why = await toolbox.launcherIn(name, file); if (!why) toolbox.started(name); return why; };
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
    /* What would go out of a repository, shown before it is sent: see gitpush.mjs. */
    /* Every git of this server, and the one way an agent's commits come in: see gitrunner.mjs. */
    const gitRunner = new GitRunner({ dataDir, host, ...(gitReserveBytes === undefined ? {} : { reserveBytes: gitReserveBytes }) });
    const gitReview = new GitReview({ store: new Store(`${dataDir}/git.json`), vault, resources: folders, dataDir, localRemotes: gitLocalRemotes, access: gitAccess, runner: gitRunner });
    /* What the Settings screen says of this installation: set when it was installed, shown, not changed from the page. */
    /* Several models answer a tool's simple questions in the owner's place, where the owner asked: see answerer.mjs. */
    /* The owner's devices are told when something waits for them: see alerts.mjs. */
    const alerts = new Alerts({ store: new Store(`${dataDir}/alerts.json`), keyFile: `${dataDir}/alerts-keys.json`, subject: publicOrigin, ...(alertSend ? { send: alertSend } : {}) });
    const answerer = new Answerer({ store: new Store(`${dataDir}/answerer.json`), vms, config: answererConfig(env), conversations: all, dataDir, ...(answerFetcher ? { fetcher: answerFetcher } : {}),
        onNeeds: (name, why) => { void alerts.tell({ title: `${instance.name()}: ${name} waits for you`, body: why, url: `/?c=${name}` }); } });
    const answerTimer = answerer.start(answerEveryMs);
    /* A tool is told to get to work when something arrives, or by the clock: see wakeups.mjs. */
    let bridge;
    /* A wake-up typed is said in its chat (talk, made below: called only once a wake-up fires). */
    /* Where its chat is on, what wakes a tool is an event it acknowledges: see dockets.mjs. */
    const dockets = new Dockets({ store: new Store(`${dataDir}/dockets.json`), resources: folders,
        say: (name, line) => wakeups.say(name, line),
        event: (name, line) => talk.event(name, line),
        alert: (message) => { void alerts.tell({ ...message, title: `${instance.name()}: ${message.title}` }); },
        /* Not in a turn: its pulse ended, or is old (Parley's own measure). */
        idle: (name) => { const p = talk.pulse(name); return !(p?.busy === true && Date.now() - Date.parse(p.at) < PULSE_MS); },
        awake: () => all.awake(), chatOn: (name) => talk.isOn(name) });
    const typingWatch = new TypingWatch();
    const wakeups = new Wakeups({ store: new Store(`${dataDir}/wakeups.json`), vms, conversations: all, resources: folders, warm: (name) => bridge?.warm(name), docket: dockets, typing: (name) => typingWatch.busy(name),
        fired: (name, { text }) => talk.event(name, { kind: 'wakeup', text, topic: 'Wake-up' }) });
    const wakeTimer = wakeups.start(wakeEveryMs);
    const docketTimer = dockets.start(wakeEveryMs);
    /* Lists kept with the tools, held here: see binders.mjs. */
    const binders = new Binders({ dataDir, resources: folders, conversations: () => all.list().map((c) => c.name), dockets, team,
        alert: (message) => alerts.tell({ ...message, title: `${instance.name()}: ${message.title}` }) });
    const stopBinders = binders.start();
    /* The accesses an agent was given -- a machine over SSH, an online folder, a
       mailbox, a calendar, an address book -- held here with their secrets read from
       the vault by name, never in a machine: see tethers.mjs. */
    const tethers = new Tethers({ dataDir, resources: folders, conversations: () => all.list().map((c) => c.name), secrets });
    const stopTethers = tethers.start();
    /* Connecting a mailbox, calendar or address book by token: the consent happens
       in the owner's browser, the refresh token is kept host-only (never in a
       machine) and a Tether target is made for it: see accounts.mjs. */
    const accounts = new Accounts({ secrets, targets: { put: (spec) => tethers.store().putTarget(spec), all: () => tethers.store().targets() }, probe: (target, password) => tethers.probe(target, password) });
    /* A calendar target made before it needed the account address (Google CalDAV
       puts it in the URL) carries none. The same account's mailbox or address book
       has it -- they share the one refresh token -- so fill it in from a sibling,
       once, with no reconnection asked of anyone. */
    (() => {
        const store = tethers.store();
        for (const t of store.targets()) {
            if (t.kind !== 'calendar' || t.config?.user || !t.secrets?.refresh) continue;
            const sib = store.targets().find((o) => o.secrets?.refresh === t.secrets.refresh && o.config?.user);
            if (sib) store.putTarget({ ...t, config: { ...t.config, user: sib.config.user } });
        }
    })();
    /* A repository's origin kept up to date, checks run in the machine, and
       automatic sending to the branches the owner listed: see gitkeeper.mjs. */
    /* What could not be read is told to the agents that write in the repository, where they can act. */
    /* `only`: the conversation whose automatic sending it is about: its agent alone can act on it. */
    /* `full`: what the line sums up (all a remote said), put in each one's chat folder for it to read. */
    const tellAgent = async (repository, line, only, full) => {
        const writers = Object.entries(folders.list().find((x) => x.name === repository)?.attachments ?? {}).filter(([, access]) => access === 'write').map(([conversation]) => conversation).filter((c) => only === undefined || c === only);
        /* Told: at least one of them had the line typed (see GitKeeper #toAgent). */
        let heard = false;
        for (const conversation of writers) {
            let path = null;
            if (full) { try { path = talk.keepText(conversation, 'git-remote-refused.txt', full); } catch { path = null; } }
            if (await wakeups.say(conversation, path ? `${line.replace(/\.$/, '')}; all it said: ${path}.` : line) === true) heard = true;
        }
        return heard;
    };
    /* What happened to a repository is said in the chat of the conversations it is attached to (talk.mjs). */
    const gitKeeper = new GitKeeper({ store: new Store(`${dataDir}/git-keep.json`), last: new Store(`${dataDir}/git-checks.json`), review: gitReview, resources: folders, alerts, tellAgent,
        thread: (conversation, event) => talk.event(conversation, event),
        checks: new GitChecks({ vms, conversations: all, resources: folders }) });
    const gitTimer = gitKeeper.start(gitEveryMs);
    /* A conversation with a tool on a screen that is not its terminal: see talk.mjs. */
    const talk = new Talk({ store: talkStore, words: new Store(`${dataDir}/talk-words.json`), keptDir: `${dataDir}/talk-kept`, vms, conversations: all, resources: folders, toolbox, warm: (name) => bridge?.warm(name), ...(talkEveryMs ? { listenEveryMs: talkEveryMs } : {}),
        ...(rereadAfterMs === undefined ? {} : { rereadAfterMs }),
        /* A line typed down the terminal already open when there is one, and
           what is already known of a machine used instead of asking (talk.mjs). */
        terminal: { open: (name) => bridge?.open(name) ?? false, type: (name, line, ms) => bridge?.type(name, line, ms) ?? false, droppedAt: (name) => bridge?.droppedAt(name) },
        health: { of: (name) => health?.of(name) ?? null },
        /* A secret pasted in a message is lifted out before the message is kept:
           it goes to the short-lived vault and the message keeps only a marker
           the chat shows as stars; the value reaches the machine as
           /run/secrets/<name>, and is swept after a few minutes. */
        screen: async (conversation, text) => {
            const hits = scan(text);
            if (!hits.length) return text;
            let out = ''; let last = 0; let any = false;
            for (const h of hits) {
                out += text.slice(last, h.start);
                try { const { name, expiresAt } = secrets.stash(conversation, h.value); out += secretRef(name, Date.parse(expiresAt)); any = true; }
                catch { out += text.slice(h.start, h.end); }      /* cannot be stashed (too large): left as it is */
                last = h.end;
            }
            out += text.slice(last);
            if (any) { try { await secrets.deliver(conversation); } catch { /* machine not running: delivered at its next open */ } }
            return out;
        },
        /* The agent asked to forget a short-lived secret (parley forget): drop it from the vault and machine. */
        dropSecret: (conversation, name) => { void secrets.drop(conversation, name).catch(() => {}); },
        alert: (payload) => { void alerts.tell(payload); } });
    /* Its machine restarted or built again: said in its chat, and the tool told to read it again. */
    all.renewed = (name, text, running) => talk.renewed(name, text, running);
    /* A Tether call waiting for the owner is said in its conversation's thread, with Accept / Refuse. */
    tethers.announce = (name, event) => { try { return talk.event(name, event); } catch { return null; } };
    /* A device given a conversation that talks through the app talks there too. */
    door.talk = talk;
    /* AFTER AN UPDATE, the machines that run get the new tools at once (parley, docket: they serve from
       their next command); a tool started with older launchers is told, in its chat, that a restart
       gives it the rest (its hooks, its MCP servers: read only when it starts). Nothing is restarted. */
    void hostSteps.then(async () => {
        for (const name of all.awake()) {
            await toolbox.installIn(name).catch(() => {});
            if (!toolbox.stale(name)) continue;
            try { if (talk.event(name, { kind: 'tools-updated', text: 'Tools updated: restart it to use them all. Its work picks up where it was.', topic: 'Tools', actions: ['restart'] })) toolbox.told(name); } catch { /* its chat is off */ }
        }
    });
    /* The health of each machine, and folders that came loose put back: see health.mjs. */
    const health = new Health({ vms, conversations: all, resources: folders, seen: new Store(`${dataDir}/health-seen.json`), ...(healthSettleMs === undefined ? {} : { settleMs: healthSettleMs }) });
    const stopHealth = health.start(healthEveryMs);
    /* What is wrong with its machine is said in its chat too, where it happened. */
    /* And what its owner chose that it does on top (healthreact.mjs): its agent told, or a command run. */
    const reacting = new HealthReact({ store: new Store(`${dataDir}/health-react.json`), say: (name, line) => wakeups.say(name, line), exec: (name, argv, options) => vms.exec(name, argv, options),
        isAgent: (name) => all.list().find((c) => c.name === name)?.ai === true, event: (name, line) => talk.event(name, line) });
    /* Where its chat is on, its agent is given an event when its disk or memory crosses a level (healthdocket.mjs);
       not where its owner turned on its own reaction (above): one way of telling it, not two. */
    const healthDocket = new HealthDocket({ store: new Store(`${dataDir}/health-docket.json`), dockets, reacting: (name) => reacting.settings(name).on });
    health.forgotten = (name) => healthDocket.forget(name);
    /* A machine's problems worth keeping in What happened: said once, until they went away. */
    const problemsSaid = new Map();
    health.judged = (name, record) => {
        talk.machine(name, record); void reacting.judged(name, record).catch(() => {});
        try { healthDocket.judged(name, record); } catch { /* its docket: nothing more */ }
        const now = (record?.problems ?? []).filter((x) => x.level === 'bad' || (x.level === 'warn' && ['memory', 'disk'].includes(x.kind)));
        const before = problemsSaid.get(name) ?? new Set();
        for (const x of now) if (!before.has(x.key)) events.add({ kind: 'machine', text: `${name}: ${x.text}`, conversation: name });
        problemsSaid.set(name, new Set(now.map((x) => x.key)));
    };
    /* A machine just started: its folders are mounted again (after a build,
       a restart, a move) or looked at and put back if they came loose (after
       a wake), before its tool starts in them. */
    all.quiet = (name) => health.busy(name);
    all.mounted = async (name, again) => { if (again) await folders.remount(name).catch(() => {}); await health.check(name, { asked: true }).catch(() => {}); };
    /* What the VM manager says each machine has is what is recorded (a record
       may say otherwise: set by hand, or by an earlier version). Not waited for. */
    void all.reconcileAll?.().catch(() => {});
    /* The VM manager, watched: said to the pages when it does not answer, restarted once when stuck (vmwatch.mjs). */
    const vmWatch = new VmWatch({ run: asHost, store: new Store(`${dataDir}/vm-manager.json`), alert: (payload) => { events.add({ kind: 'server', text: `${payload.title}: ${payload.body ?? ''}`.trim() }); void alerts.tell(payload)?.catch?.(() => {}); } });
    const stopVmWatch = vmWatch.start(vmWatchEveryMs);
    const platform = { get machines() { return vmWatch.ok; }, answerer: answerer.about(), get operators() { return team ? team.allowed() : [...operators]; }, address: publicOrigin ?? null, version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, get dictation() { return voice.current() ? (voice.model ?? 'set') : null; } };
    /* Who gets what, and a whole setup in one file: see setup.mjs. */
    /* Settings, Updates: what the updater (deploy/updater.mjs, as root) wrote, and how to ask it. */
    const updates = new Updates({ host: asHost, version: platform.version, store: new Store(`${dataDir}/updates.json`), alerts, ...(updateState ? { stateFile: updateState } : {}), ...(updateConf ? { confFile: updateConf } : {}) });
    const stopUpdates = updates.watch();
    const setup = new Setup({ store: new Store(`${dataDir}/flows.json`), version: platform.version, conversations: all, resources: folders, secrets, devices, shortcuts, wakeups, answerer, talk, gitKeeper, gitAccess, mailboxes, signin, network, guide, tethers, groups, ...(setupPollMs ? { pollMs: setupPollMs } : {}) });
    /* This server's disk and memory, and the reserve no machine may eat into: see capacity.mjs. */
    const capacity = new Capacity({ run: asHost, store: new Store(`${dataDir}/server.json`), conversations: all, shelf, ...(serverRoomMs === undefined ? {} : { roomMs: serverRoomMs }),
        /* Under the reserve: the machine that takes the most put to sleep, the owner told, and its chat. */
        sleep: (name) => { events.add({ kind: 'machine', text: `Machine of ${name} put to sleep: this server was short of room`, conversation: name }); return all.sleep(name); }, alert: (payload) => { events.add({ kind: 'server', text: `${payload.title}: ${payload.body ?? ''}`.trim() }); void alerts.tell(payload); },
        /* A machine asleep but still holding its RAM (a suspend that did not free it): its memory reclaimed, only that machine touched. */
        reclaim: (name) => { events.add({ kind: 'machine', text: `Machine of ${name}: memory reclaimed (it was asleep but still held RAM)`, conversation: name }); return vms.reclaim(name).then((r) => (r.stdout || '').trim()); },
        say: (name, text) => { try { talk.event(name, { kind: 'machine-problem', text, tone: 'warn', topic: 'Machine' }); } catch { /* its chat may be off */ } } });
    all.room = (ask) => capacity.check(ask);
    /* A tool that ended cut for lack of memory: said in the events, to the owner, and in its chat. */
    all.onToolExit = (name, report) => {
        if (!report?.oom?.length) return;
        const size = report.memoryMb ? ` (${Math.round(report.memoryMb / 1024 * 10) / 10} GB)` : '';
        const text = `Its tool was stopped: the machine ran out of memory${size}. Give it more in Settings → Machine → Memory, or start it fresh.`;
        events.add({ kind: 'machine', text: `Machine of ${name}: its tool was stopped for lack of memory${size}`, conversation: name });
        void alerts.tell({ title: `${name}: its tool ran out of memory`, body: text, url: `/?c=${encodeURIComponent(name)}&open=settings` });
        try { talk.event(name, { kind: 'machine-problem', text, tone: 'warn', topic: 'Machine' }); } catch { /* its chat may be off */ }
    };
    const stopWatch = capacity.start();
    /* The curves of the resources (history.mjs): one look a minute, from what the server knows already. */
    const history = new History({ file: `${dataDir}/history.json` });
    const historyLook = () => capacity.room().then((room) => history.sample(room, all.list().filter((c) => c.phase === 'ready').map((c) => ({ name: c.name, vm: `clv-${c.name}`, cores: c.cpus ?? 1, memoryMb: c.memoryMb, health: health.of(c.name) })))).catch(() => {});
    const historyTimer = setInterval(() => { void historyLook(); }, historyEveryMs); historyTimer.unref?.();
    /* The certificate the front serves, said in Settings (certificate.mjs). */
    const certificate = new Certificate({ origin: publicOrigin, alerts });
    /* All the machines to another disk, from Settings (machinesmove.mjs). */
    const machinesMove = new MachinesMove({ host: asHost, usedMb: () => capacity.machinesUsedMb() });
    /* What the server's programs said, and this server started again, from Settings (serverlogs.mjs). */
    const serverLogs = new ServerLogs({ host: asHost });
    /* This server's Wi-Fi, from Settings (wifi.mjs): how a switch ended, said in What happened. */
    const wifi = new Wifi({ host: asHost, said: (text) => events.add({ kind: 'server', text }) });
    /* The remote screen (MeshCentral), from Settings (meshcentral.mjs): how a turn-on ended, said in What happened. */
    const meshcentral = new MeshCentral({ host: asHost, said: (text) => events.add({ kind: 'server', text }) });
    if (team) {
        team.useAlerts(alerts);
        void team.refresh().catch((error) => console.error(`operators: ${error.message}`));
        const watching = setInterval(() => { void team.watch().catch(() => {}); }, 60_000); watching.unref?.();
    }
    const { server, listening } = serve(port, all, folders, { gate, originOk, shortcuts, voice, sharing, door, secrets, network, signin, mailboxes, gitReview, platform, answerer, wakeups, alerts, talk, gitAccess, gitKeeper, shelf, health, setup, guide, capacity, updates, instance, certificate, team, reacting, machinesMove, serverLogs, history, events, wifi, binders, meshcentral, tethers, accounts, groups, bundles: new Bundles({ dir: `${dataDir}/imports`, folder: (name) => folders.folder(name) }), repair: (name) => repairTerminal(name) });
    server.on('close', () => { closing = true; stopBinders(); stopTethers(); clearInterval(historyTimer); history.save(); stopVmWatch(); stopShelf(); stopHealth(); stopUpdates(); stopWatch(); clearInterval(mailTimer); clearInterval(expiryTimer); clearInterval(answerTimer); clearInterval(wakeTimer); clearInterval(docketTimer); dockets.stop(); clearInterval(gitTimer); talk.stop(); });
    let closing = false;
    bridge = attachBridge(server, {
        onRejoin: (name) => all.rejoin(name),
        onTyped: (name, data) => { answerer.typed(name, data); talk.typed(name); all.touch(name); typingWatch.typed(name, data); },
        spawn: async (name, cols, rows, say) => {
            const [program, ...argv] = await all.open(name, say);
            const started = pty.spawn(program, argv, { name: 'xterm-256color', env: withoutTmux(env), cols, rows });
            /* Its start is over once something is drawn (nothing of it is
               read), once it ends, or after a while whatever happens. Not
               written once this server is closing: a terminal killed by the
               closing is no news, and the next start forgets the steps anyway. */
            let over = false;
            const end = () => { if (over) return; over = true; clearTimeout(late); drawn.dispose?.(); if (!closing) all.attached(name); };
            const drawn = started.onData(end);
            const late = setTimeout(end, DRAWN_MS); late.unref?.();
            started.onExit(end);
            return started;
        },
        onLeft: (name) => all.left(name),
        onEnded: (name) => all.ended(name),
        gate, originOk,
        /* Only a pairing given that conversation's terminal opens it. */
        deviceName: (headers, pairing, wanted) => deviceTerminal(devices, headers, pairing, wanted),
    });
    all.drop = (name) => bridge.drop(name);
    /* What a device was given changes: a terminal it holds and lost goes at once. */
    devices.changed = () => bridge.recheck();
    /* And a session that ends by itself (its hours are up): seen within a minute. */
    const rechecking = setInterval(() => bridge.recheck(), 60_000); rechecking.unref?.();
    /* A TERMINAL THAT DOES NOT COME, though its machine runs (asked by the
       page once it has waited): repaired (conversations.mjs), then opened
       again before the page comes back for it. */
    repairTerminal = async (name) => {
        const done = await all.repairTerminal(name);
        await bridge.warm(name);
        return { ...done, open: bridge.open(name) };
    };
    /* The terminal of a running machine is opened before anybody asks: a
       conversation just built, and at start every conversation whose machine
       runs. A page then shows its terminal at once. */
    /* A machine is ready: its terminal is opened and kept. Its folders are
       shown in it first (after a rebuild there are some), and its health is
       looked at (folders that did not come back are put back): both on the
       way, as steps of its start (`mounted` above, conversations.mjs). */
    all.ready = (name) => { toolbox.forget(name); void bridge.warm(name); };
    /* Their health too: after a restart of the host, a folder may not have come back. */
    /* The tools are shown in them first: a machine made before /tools existed gets it now, not as "a folder that came loose". */
    void (async () => { for (const name of all.awake()) if (await all.running(name).catch(() => false)) { await toolbox.show(name).catch(() => {}); void health.check(name).catch(() => {}); await bridge.warm(name); } })();
    return listening;
}

/* One line of the host program's settings (/etc/clavarium/host.conf), or ''. */
function hostSetting(key) {
    let text = '';
    try { text = readFileSync('/etc/clavarium/host.conf', 'utf8'); } catch { return ''; }
    return (text.split('\n').find((l) => l.startsWith(`${key}=`)) ?? '').slice(key.length + 1).trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    /* A promise rejected that nobody waited for is said, not fatal: one unlucky
       call must not take every conversation's server down with it. */
    process.on('unhandledRejection', (reason) => { console.error(`unhandled: ${reason?.stack ?? reason}`); });
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
        /* Where the shared folders live: $MNT, declared to the host program in
           its own settings, read here so that both agree (see clavarium-host). */
        const mntDir = hostSetting('MNT') || dataDir;
        /* --name: the name of this Clavarium until one is chosen in Settings (instance.mjs). */
        const name = option(argv, 'name', '') || undefined;
        const server = await startHome({ port, host: host.split(' ').filter(Boolean), dataDir, mntDir, operators, publicOrigin, vaultKey, appName: name }).catch((error) => { console.error(`start: FAILED: ${error.message}`); process.exit(1); });
        console.log(`http://127.0.0.1:${server.address().port}/`);
    } else {
        const command = option(argv, 'command', 'bash').split(' ').filter(Boolean);
        const server = await start({ port, command, cwd: option(argv, 'cwd', process.cwd()) });
        console.log(`http://127.0.0.1:${server.address().port}/?c=demo`);
    }
}
