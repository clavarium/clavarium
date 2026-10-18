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
import { Conversations, DRAWN_MS } from './conversations.mjs';
import { Store } from './store.mjs';
import { loadTools } from './tools.mjs';
import { Vms, runner } from './vm.mjs';
import { Resources } from './resources.mjs';
import { makeGate, makeOriginCheck, readOperators } from './gate.mjs';
import { Shortcuts } from './shortcuts.mjs';
import { voiceConfig } from './voice.mjs';
import QRCode from 'qrcode';
import { Devices } from './devices.mjs';
import { handleDoor, deviceTerminal } from './door.mjs';
import { Vault } from './vault.mjs';
import { Secrets, RUNNER } from './secrets.mjs';
import { Network } from './network.mjs';
import { Answerer, answererConfig } from './answerer.mjs';
import { Wakeups, CALL_PATH } from './wakeups.mjs';
import { Alerts } from './alerts.mjs';
import { Talk } from './talk.mjs';
import { Toolbox } from './toolbox.mjs';
import { Guide, commonText } from './guide.mjs';
import { SignInMailboxes } from './signin.mjs';
import { Mailboxes, recentMessages } from './mailbox.mjs';
import { Grants } from './grants.mjs';
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
import { migrateData } from './dataformat.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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
    '/vendor/xterm.js': [packageFile('@xterm/xterm', 'lib/xterm.js'), 'text/javascript; charset=utf-8'],
    '/vendor/xterm.css': [packageFile('@xterm/xterm', 'css/xterm.css'), 'text/css; charset=utf-8'],
    '/vendor/fit.js': [packageFile('@xterm/addon-fit', 'lib/addon-fit.js'), 'text/javascript; charset=utf-8'],
    /* A PDF is drawn by the page itself, on a canvas: asked for only when one is previewed. */
    '/vendor/parley-ui.js': [packageFile(PARLEY, 'ui/parley-ui.js'), 'text/javascript; charset=utf-8'],
    '/vendor/parley-ui.css': [packageFile(PARLEY, 'ui/parley-ui.css'), 'text/css; charset=utf-8'],
    /* Its icons (Lucide, copied in Parley): the chat's, and this page's own. */
    '/vendor/parley-icons.js': [packageFile(PARLEY, 'ui/parley-icons.js'), 'text/javascript; charset=utf-8'],
    '/vendor/pdf.mjs': [packageFile('pdfjs-dist', 'build/pdf.min.mjs'), 'text/javascript; charset=utf-8'],
    '/vendor/pdf.worker.mjs': [packageFile('pdfjs-dist', 'build/pdf.worker.min.mjs'), 'text/javascript; charset=utf-8'],
    /* Drawings in the chat (```mermaid), at the version package.json fixes: asked for only when one is shown. */
    '/vendor/mermaid.js': [packageFile('mermaid', 'dist/mermaid.min.js'), 'text/javascript; charset=utf-8'],
    /* Code coloured in the chat: Prism and the languages it is given, one file; asked for only when code is shown. */
    '/vendor/prism.js': [['web/prism-manual.js', ...['core', 'clike', 'markup', 'css', 'javascript', 'typescript', 'json', 'python', 'bash', 'markup-templating', 'php', 'sql', 'yaml', 'diff', 'markdown', 'ini', 'apacheconf']
        .map((l) => packageFile('prismjs', `components/prism-${l}.min.js`))], 'text/javascript; charset=utf-8'],
};
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

export function option(argv, name, fallback) {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

/* A tmux inside a tmux refuses to start: the variable does not travel. */
const withoutTmux = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'TMUX' && key !== 'TMUX_PANE'));

const REFUSED = 'This Clavarium belongs to someone else: your account is not one of its operators.\n';

function serve(port, conversations, resources, { gate = () => 'local', originOk, shortcuts, voice, sharing, door, secrets, network, signin, mailboxes, gitReview, platform, answerer, wakeups, alerts, talk, gitAccess, gitKeeper, shelf, health, setup, guide, repair, capacity, updates } = {}) {
    const sendFile = async (response, file) => {
        /* Several files are one, in their order. */
        const body = Array.isArray(file[0]) ? Buffer.concat((await Promise.all(file[0].map((f) => readFile(f.startsWith('/') ? f : ROOT + f)))).flatMap((b) => [b, Buffer.from('\n;\n')])) : await readFile(file[0].startsWith('/') ? file[0] : ROOT + file[0]);
        response.writeHead(200, { ...HEADERS, 'content-type': file[1] }).end(body);
    };
    const server = createServer(async (request, response) => {
        const { pathname } = new URL(request.url ?? '/', 'http://local');
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
        if (conversations && await handleApi(request, response, conversations, HEADERS, resources, originOk, shortcuts, voice, sharing, secrets, network, signin, mailboxes, gitReview, platform, answerer, wakeups, alerts, talk, gitAccess, gitKeeper, shelf, health, setup, repair, guide, capacity, updates)) return;
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
/* An opening waits this long at most for Parley to be installed in its machine (toolbox.mjs). */
const PARLEY_WAIT_MS = 20_000;

/* The product: conversations are VMs. `host` is how the host program is
   reached on this installation, as an argument vector: it is the ONLY thing
   this server runs with more rights than its own. */
export async function startHome({ port, host, dataDir, mntDir = dataDir, gitReserveBytes, env = process.env, conversations, resources, operators = [], publicOrigin, vaultKey, tools = loadTools(), stopDelayMs, mailReader, gitLocalRemotes = false, gitSsh, answerFetcher, answerEveryMs, wakeEveryMs, alertSend, talkEveryMs, gitEveryMs, shelfEveryMs, shelfFirstMs, healthEveryMs, healthSettleMs, setupPollMs, rereadAfterMs, serverRoomMs, updateState, updateConf }) {
    /* The data, in the format this code reads, before anything reads it (dataformat.mjs). */
    const migrated = migrateData(dataDir);
    if (migrated.ran.length) console.log(`data: format ${migrated.from} -> ${migrated.to}`);
    const gate = makeGate(operators);
    const originOk = makeOriginCheck(publicOrigin);
    let repairTerminal = async () => { throw new Error('not ready'); };
    const asHost = runner(host);
    const vms = new Vms(asHost, host);
    const all = conversations ?? new Conversations({ store: new Store(`${dataDir}/conversations.json`), vms, tools, ...(stopDelayMs === undefined ? {} : { stopDelayMs }) });
    /* Who may do what with what: ONE table, shared by everything below. */
    const grants = new Grants(new Store(`${dataDir}/grants.json`));
    const vault = new Vault(vaultKey ?? `${dataDir}/vault.key`);
    /* How private repositories are reached: keys and tokens kept and used here only (gitaccess.mjs).
       `gitSsh`: a stand-in for the ssh program, for tests. */
    const gitAccess = new GitAccess({ vault, dataDir, ...(gitSsh ? { ssh: gitSsh } : {}) });
    /* The tools every machine sees at /tools, read-only: see toolbox.mjs. */
    /* With /tools/CLAVARIUM.md in it: where a tool is, the same for all (guide.mjs). */
    const toolbox = new Toolbox({ host: asHost, vms, mntDir, notes: () => commonText() });
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
    /* Before anything can start a VM: see resources.mjs. */
    await folders.ensureViews();
    /* Not in place is said, not fatal: no machine is then given /tools. */
    await toolbox.prepare().catch((error) => console.error(error.message));
    await all.ensureWork?.();
    const shortcuts = new Shortcuts(new Store(`${dataDir}/shortcuts.json`));
    const voice = voiceConfig(env);
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
    /* Where its tool is, said to it in a few lines (guide.mjs): written into
       its machine at a start and when a setting changes. `talk` and
       `wakeups` are made below; only asked once the server runs. */
    const guide = new Guide({ store: new Store(`${dataDir}/guide.json`), vms, conversations: all, resources: folders, secrets, toolbox, tools,
        chat: (name) => Boolean(talk?.brief(name)), say: (name, line) => wakeups.say(name, line) });
    /* Why Parley is not in a machine, said once in the log, not at each opening. */
    const parleySaid = new Map();
    all.prepare = async (name, woke) => {
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
        onNeeds: (name, why) => { void alerts.tell({ title: `${name} waits for you`, body: why, url: `/?c=${name}` }); } });
    const answerTimer = answerer.start(answerEveryMs);
    /* A tool is told to get to work when something arrives, or by the clock: see wakeups.mjs. */
    let bridge;
    /* A wake-up typed is said in its chat (talk, made below: called only once a wake-up fires). */
    const wakeups = new Wakeups({ store: new Store(`${dataDir}/wakeups.json`), vms, conversations: all, resources: folders, warm: (name) => bridge?.warm(name),
        fired: (name, { text }) => talk.event(name, { kind: 'wakeup', text, topic: 'Wake-up' }) });
    const wakeTimer = wakeups.start(wakeEveryMs);
    /* A repository's origin kept up to date, checks run in the machine, and
       automatic sending to the branches the owner listed: see gitkeeper.mjs. */
    /* What could not be read is told to the agents that write in the repository, where they can act. */
    /* `only`: the conversation whose automatic sending it is about: its agent alone can act on it. */
    const tellAgent = async (repository, line, only) => {
        const writers = Object.entries(folders.list().find((x) => x.name === repository)?.attachments ?? {}).filter(([, access]) => access === 'write').map(([conversation]) => conversation).filter((c) => only === undefined || c === only);
        /* Told: at least one of them had the line typed (see GitKeeper #toAgent). */
        let heard = false;
        for (const conversation of writers) if (await wakeups.say(conversation, line) === true) heard = true;
        return heard;
    };
    /* What happened to a repository is said in the chat of the conversations it is attached to (talk.mjs). */
    const gitKeeper = new GitKeeper({ store: new Store(`${dataDir}/git-keep.json`), review: gitReview, resources: folders, alerts, tellAgent,
        thread: (conversation, event) => talk.event(conversation, event),
        checks: new GitChecks({ vms, conversations: all, resources: folders }) });
    const gitTimer = gitKeeper.start(gitEveryMs);
    /* A conversation with a tool on a screen that is not its terminal: see talk.mjs. */
    const talk = new Talk({ store: talkStore, words: new Store(`${dataDir}/talk-words.json`), vms, conversations: all, resources: folders, toolbox, warm: (name) => bridge?.warm(name), ...(talkEveryMs ? { listenEveryMs: talkEveryMs } : {}),
        ...(rereadAfterMs === undefined ? {} : { rereadAfterMs }),
        /* A line typed down the terminal already open when there is one, and
           what is already known of a machine used instead of asking (talk.mjs). */
        terminal: { open: (name) => bridge?.open(name) ?? false, type: (name, line, ms) => bridge?.type(name, line, ms) ?? false, droppedAt: (name) => bridge?.droppedAt(name) },
        health: { of: (name) => health?.of(name) ?? null },
        alert: (payload) => { void alerts.tell(payload); } });
    /* Its machine restarted or built again: said in its chat, and the tool told to read it again. */
    all.renewed = (name, text, running) => talk.renewed(name, text, running);
    /* A device given a conversation that talks through the app talks there too. */
    door.talk = talk;
    /* The health of each machine, and folders that came loose put back: see health.mjs. */
    const health = new Health({ vms, conversations: all, resources: folders, ...(healthSettleMs === undefined ? {} : { settleMs: healthSettleMs }) });
    const stopHealth = health.start(healthEveryMs);
    /* What is wrong with its machine is said in its chat too, where it happened. */
    health.judged = (name, record) => talk.machine(name, record);
    /* A machine just started: its folders are mounted again (after a build,
       a restart, a move) or looked at and put back if they came loose (after
       a wake), before its tool starts in them. */
    all.mounted = async (name, again) => { if (again) await folders.remount(name).catch(() => {}); await health.check(name).catch(() => {}); };
    /* What the VM manager says each machine has is what is recorded (a record
       may say otherwise: set by hand, or by an earlier version). Not waited for. */
    void all.reconcileAll?.().catch(() => {});
    const platform = { answerer: answerer.about(), operators: [...operators], address: publicOrigin ?? null, version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, dictation: voice ? (voice.model ?? 'set') : null };
    /* Who gets what, and a whole setup in one file: see setup.mjs. */
    /* Settings, Updates: what the updater (deploy/updater.mjs, as root) wrote, and how to ask it. */
    const updates = new Updates({ host: asHost, version: platform.version, store: new Store(`${dataDir}/updates.json`), alerts, ...(updateState ? { stateFile: updateState } : {}), ...(updateConf ? { confFile: updateConf } : {}) });
    const stopUpdates = updates.watch();
    const setup = new Setup({ store: new Store(`${dataDir}/flows.json`), version: platform.version, conversations: all, resources: folders, secrets, devices, shortcuts, wakeups, answerer, talk, gitKeeper, gitAccess, mailboxes, signin, network, guide, ...(setupPollMs ? { pollMs: setupPollMs } : {}) });
    /* This server's disk and memory, and the reserve no machine may eat into: see capacity.mjs. */
    const capacity = new Capacity({ run: asHost, store: new Store(`${dataDir}/server.json`), conversations: all, shelf, ...(serverRoomMs === undefined ? {} : { roomMs: serverRoomMs }) });
    all.room = (ask) => capacity.check(ask);
    const { server, listening } = serve(port, all, folders, { gate, originOk, shortcuts, voice, sharing, door, secrets, network, signin, mailboxes, gitReview, platform, answerer, wakeups, alerts, talk, gitAccess, gitKeeper, shelf, health, setup, guide, capacity, updates, repair: (name) => repairTerminal(name) });
    server.on('close', () => { closing = true; stopShelf(); stopHealth(); stopUpdates(); clearInterval(mailTimer); clearInterval(answerTimer); clearInterval(wakeTimer); clearInterval(gitTimer); talk.stop(); });
    let closing = false;
    bridge = attachBridge(server, {
        onRejoin: (name) => all.rejoin(name),
        onTyped: (name, data) => { answerer.typed(name, data); talk.typed(name); },
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
        const server = await startHome({ port, host: host.split(' ').filter(Boolean), dataDir, mntDir, operators, publicOrigin, vaultKey });
        console.log(`http://127.0.0.1:${server.address().port}/`);
    } else {
        const command = option(argv, 'command', 'bash').split(' ').filter(Boolean);
        const server = await start({ port, command, cwd: option(argv, 'cwd', process.cwd()) });
        console.log(`http://127.0.0.1:${server.address().port}/?c=demo`);
    }
}
