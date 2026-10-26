#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * THE UPDATER: Clavarium from npm, an exact version per release, checked,
 * switched to, and switched back from when it does not come up.
 *
 * Runs as root, and ONLY through three doors: the installer (install.sh:
 * prepare, switch, prune), the minute systemd starts it (clavarium-update
 * .service, from its timer every 15 minutes or asked by the host program:
 * run), and the host program's verbs (clavarium-host update check / set /
 * apply / rollback). The server itself never runs it: it asks the host program,
 * which writes a request and starts the service, so that restarting the
 * server does not kill the update on its way.
 *
 *   /opt/clavarium/releases/<id>/        one release, never changed once made:
 *       package.json, package-lock.json  "clavarium": "<version>", exactly
 *       node_modules/clavarium/          the package as the registry served it
 *       app -> node_modules/clavarium    where the server runs (a local release:
 *                                        app/ is a copy of a working tree)
 *       node -> /opt/clavarium/nodes/vX  the Node.js its tools.mjs pins
 *       release.json                     id, version, data format, source, when
 *   /opt/clavarium/current -> releases/<id>
 *   /etc/clavarium/update.conf           MODE, CHANNEL, WINDOW, PORT (root's)
 *   /var/lib/clavarium/update/           state.json (read by the server),
 *                                        request, lock, backup/
 *
 * A RELEASE IS MADE (prepare) in a folder of its own, beside the one that runs:
 *   1. npm installs clavarium@<version> with no script run, from the registry;
 *   2. checked: the integrity npm recorded is the registry's; Clavarium and
 *      Parley and Docket each carry a provenance statement whose subject is that very
 *      archive and whose source is their repository on GitHub (REPOS); and
 *      `npm audit signatures` checks the registry's signatures and those
 *      statements' own signatures, for every package installed;
 *   3. only then the build scripts run (npm rebuild: node-pty is compiled),
 *      the archives of the machines' tools are fetched and checked
 *      (parley-archive.mjs), and the server's own smoke test runs
 *      (server/smoke.mjs). Anything wrong: the folder goes, nothing changed.
 *
 * AN UPDATE (apply), never while a machine is being built, moved or restarted:
 * a release is made; a backup of the server's data is taken (backup.sh
 * --server-only); the open pages are told and given NOTICE_MS to show the
 * maintenance page (MAINTENANCE_BLOCK); the link is switched; the privileged programs of the new
 * release are put in place; the server restarts and must come up (health).
 * If it does not: the link goes back, the previous programs too, the data
 * backup is put back if the data format moved, the server restarts, and the
 * owner is told (state.json, read by the server: Settings, and an alert).
 * The last two releases are kept: "Go back to x.y.z" (rollback).
 *
 * Exit codes: 0 done; 64 usage; 78 refused, with the reason; 1 failed.
 * --------------------------------------------------------------------------- */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, readdirSync, existsSync, symlinkSync, realpathSync, cpSync, openSync, closeSync, statfsSync, statSync, chmodSync, mkdtempSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fetchToolArchives, REGISTRY } from './parley-archive.mjs';
import { ensureTunnel, tunnelUnit, relayOfUnit, TUNNEL_UNIT, TUNNEL_PROGRAM } from './tunnel.mjs';
import { ensureGenericClientId } from './oidc.mjs';
/* The updater's run keeps the tunnel up to date: the same functions, from here too. */
export { ensureTunnel, tunnelUnit, relayOfUnit, TUNNEL_UNIT, TUNNEL_PROGRAM };

export const PATHS = { code: '/opt/clavarium', conf: '/etc/clavarium/update.conf', stateDir: '/var/lib/clavarium/update', data: '/home/clavarium', host: '/usr/local/sbin/clavarium-host', gitRead: '/usr/lib/clavarium/git-read', tunnel: '/usr/local/sbin/clavarium-tunnel' };
export const NAME = 'clavarium';
/* Where each package checked here must have been built: its provenance says so. */
export const REPOS = { clavarium: 'https://github.com/clavarium/clavarium', 'clavarium-parley': 'https://github.com/clavarium/clavarium-parley', 'clavarium-docket': 'https://github.com/clavarium/clavarium-docket', 'clavarium-binder': 'https://github.com/clavarium/clavarium-binder' };
export const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.-]{1,40})?$/;
export const LOCAL = /^local-\d{8}-\d{6}$/;
export const MODES = ['auto', 'asap', 'ask', 'off'];
/* The update channels, least stable to most: `next` (what I push and test on test-c), `beta` (an
   infrastructure runs it: proven by the tests, a few small things left), `latest` (the public stable).
   Code flows next -> beta -> latest. */
export const CHANNELS = ['next', 'beta', 'latest'];
export const WINDOW = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULTS = { MODE: 'auto', CHANNEL: 'latest', WINDOW: '02:00-05:00', PORT: '7717' };
/* A conversation in one of these phases is in the middle of something the restart would cut. */
const BUSY = ['building', 'moving', 'restarting'];
/* A busy phase older than this was cut short (the server died under it): it does not hold an update back. */
const BUSY_STALE_MS = 30 * 60_000;
/* THE WATCHDOG (each timer turn): down this many turns in a row, or its service failed: one action, at most one an hour. */
const WATCH_MISSES = 3;
/* Restarts by systemd, the server not answering: it is looping (a port held, a view broken). */
const WATCH_LOOP = 3;
const WATCH_EVERY_MS = 3600_000;
/* An update this recent is the first suspect when the server will not stay up. */
const WATCH_RECENT_MS = 24 * 3600_000;
const HISTORY_MAX = 30;
const ASK_EVERY_MS = 6 * 3600_000;
/* Between "Switching" said in state.json and the server stopped: the pages ask the server every
   10 seconds at most (app.js), and the server says it in each answer (updates.mjs, notice): each
   gives way to the maintenance page before the server goes. */
export const NOTICE_MS = 15_000;
const PROVENANCE = 'https://slsa.dev/provenance/v1';
/* What the log of a failure keeps, at most (history entry `log`, shown behind "See the log"). */
const LOG_MAX = 12_000;
/* Set beside the server's unit by the updater (root): a crash loop never locks the service out, so a
   restart asked later (an update, the watchdog) still starts it. */
export const DROP_IN = '/etc/systemd/system/clavarium.service.d/restart.conf';
export const DROP_IN_TEXT = '# Written by the Clavarium updater: a crash loop never locks the service out.\n[Unit]\nStartLimitIntervalSec=0\n\n[Service]\nRestartSec=3\n';

/* THE SIGN-IN PROXY, kept by the updater: two sign-ins started at once (two tabs, a page reloaded
   during it, the installed app and the browser) shared one CSRF cookie, and the first to come back
   was refused ("Unable to find a valid CSRF token", found 20-10). One cookie per sign-in, and time
   to type a password. Added to a file that lacks them, the proxy restarted; nothing else touched. */
export const PROXY_CFG = '/etc/oauth2-proxy/oauth2-proxy.cfg';
export const PROXY_LINES = ['cookie_csrf_per_request = true', 'cookie_csrf_expire = "30m"'];
export async function ensureProxySettings({ file = PROXY_CFG, run = runCommand } = {}) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { return false; }
    const missing = PROXY_LINES.filter((l) => !text.split('\n').some((x) => x.trim().startsWith(l.split(' =')[0])));
    if (!missing.length) return false;
    writeFileSync(`${file}.new`, `${text.replace(/\n*$/, '\n')}# Added by the Clavarium updater: one CSRF cookie per sign-in.\n${missing.join('\n')}\n`, { mode: 0o600 });
    renameSync(`${file}.new`, file);
    if (process.getuid?.() === 0) await run(['systemctl', 'try-restart', 'oauth2-proxy.service'], { timeoutMs: 60_000 });
    return true;
}

/* THE MAINTENANCE PAGE, kept by the updater: while the server is down (an update, a restart) the
   front (Caddy) answers it instead of the sign-in proxy's "Bad Gateway". The sign-in proxy answers
   502 in HTML when the server does not; the server's own errors are JSON and pass as they are. A
   page gets the page (deploy/maintenance.html, copied OUTSIDE the releases: it is there during the
   switch); a request of the page (/api/, /c/api/) gets JSON. install.sh writes the same block. */
export const CADDYFILE = '/etc/caddy/Caddyfile';
export const CADDY = '/usr/local/bin/caddy';
export const MAINTENANCE_DIR = '/var/lib/clavarium/maintenance';
export const MAINTENANCE_PAGE = fileURLToPath(new URL('maintenance.html', import.meta.url));
/* What install.sh wrote before the maintenance page: replaced, once, by MAINTENANCE_BLOCK. */
export const PLAIN_BLOCK = '\thandle {\n\t\treverse_proxy 127.0.0.1:4180\n\t}\n';
export const MAINTENANCE_BLOCK = [
    '\thandle {',
    '\t\t# The server down (an update, a restart): the maintenance page (deploy/updater.mjs, MAINTENANCE_BLOCK).',
    '\t\treverse_proxy 127.0.0.1:4180 {',
    '\t\t\t@down {',
    '\t\t\t\tstatus 502 503 504',
    '\t\t\t\theader Content-Type text/html*',
    '\t\t\t}',
    '\t\t\thandle_response @down {',
    '\t\t\t\theader Cache-Control no-store',
    '\t\t\t\theader Retry-After 3',
    '\t\t\t\theader X-Clavarium-Down 1',
    '\t\t\t\t@api path /api/* /c/api/*',
    '\t\t\t\thandle @api {',
    '\t\t\t\t\theader Content-Type "application/json; charset=utf-8"',
    '\t\t\t\t\trespond "{\\"error\\":\\"Clavarium is being updated or restarted: it comes back by itself in a moment.\\",\\"down\\":true}" 503',
    '\t\t\t\t}',
    '\t\t\t\thandle {',
    `\t\t\t\t\troot * ${MAINTENANCE_DIR}`,
    '\t\t\t\t\trewrite * /index.html',
    '\t\t\t\t\tfile_server {',
    '\t\t\t\t\t\tstatus 503',
    '\t\t\t\t\t}',
    '\t\t\t\t}',
    '\t\t\t}',
    '\t\t}',
    '\t}',
    '',
].join('\n');

/* Idempotent, at each timer turn: the page copied when it differs; the block put in a Caddyfile
   that has the plain one, checked by `caddy validate` first, then Caddy reloaded (a reload Caddy
   refuses leaves the running site as it was: the file is put back). A Caddyfile changed by hand is
   not touched. No Caddyfile (local mode, --core-only): nothing. { page, edge, why } */
export async function ensureMaintenance({ caddyfile = CADDYFILE, caddy = CADDY, page = MAINTENANCE_PAGE, dir = MAINTENANCE_DIR, run = runCommand } = {}) {
    let text;
    try { text = readFileSync(caddyfile, 'utf8'); } catch { return { page: false, edge: false, why: '' }; }
    const said = { page: false, edge: false, why: '' };
    const html = readFileSync(page);
    const file = join(dir, 'index.html');
    let had = null;
    try { had = readFileSync(file); } catch { /* not there */ }
    if (!had?.equals(html)) {
        mkdirSync(dir, { recursive: true, mode: 0o755 });
        writeFileSync(`${file}.new`, html, { mode: 0o644 });
        chmodSync(`${file}.new`, 0o644);
        renameSync(`${file}.new`, file);
        said.page = true;
    }
    if (text.includes(MAINTENANCE_BLOCK)) return said;
    if (text.split(PLAIN_BLOCK).length !== 2) return { ...said, why: 'the Caddyfile is not the one install.sh wrote: the maintenance page is not added to it' };
    const tmp = `${caddyfile}.new`;
    writeFileSync(tmp, text.replace(PLAIN_BLOCK, MAINTENANCE_BLOCK), { mode: 0o644 });
    /* Checked apart: what `caddy validate` keeps of its own goes to a folder of its own, never Caddy's. */
    const own = mkdtempSync(join(tmpdir(), 'clavarium-caddy-'));
    let checked;
    try { checked = await run([caddy, 'validate', '--config', tmp, '--adapter', 'caddyfile'], { env: { ...process.env, XDG_DATA_HOME: own, XDG_CONFIG_HOME: own, HOME: own }, timeoutMs: 60_000 }); } finally { rmSync(own, { recursive: true, force: true }); }
    if (checked.code !== 0) { rmSync(tmp, { force: true }); return { ...said, why: `caddy validate refused it: ${lastLine(checked)}` }; }
    chmodSync(tmp, 0o644);
    renameSync(tmp, caddyfile);
    const reloaded = await run(['systemctl', 'try-reload-or-restart', 'caddy.service'], { timeoutMs: 60_000 });
    if (reloaded.code === 0) return { ...said, edge: true };
    writeFileSync(tmp, text, { mode: 0o644 });
    renameSync(tmp, caddyfile);
    await run(['systemctl', 'try-reload-or-restart', 'caddy.service'], { timeoutMs: 60_000 });
    return { ...said, why: `Caddy did not take it (${lastLine(reloaded)}): the Caddyfile was put back` };
}

export class Refused extends Error {}

/* SEMANTIC VERSIONS, compared as npm does: a pre-release comes before its release. */
export function compareVersions(a, b) {
    const parse = (v) => { const [core, pre] = String(v).split(/-(.*)/s); return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] }; };
    const x = parse(a); const y = parse(b);
    for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
    if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
        const p = x.pre[i]; const q = y.pre[i];
        if (p === undefined) return -1; if (q === undefined) return 1;
        if (p === q) continue;
        const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q);
        if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
        if (pn !== qn) return pn ? -1 : 1;
        return p < q ? -1 : 1;
    }
    return 0;
}

/* "02:00-05:00": is this moment in it (local time; a window may pass midnight)? */
export function inWindow(window, now) {
    const m = WINDOW.exec(window ?? ''); if (!m) return false;
    const [from, to] = window.split('-').map((t) => { const [h, mi] = t.split(':').map(Number); return h * 60 + mi; });
    const at = now.getHours() * 60 + now.getMinutes();
    return from <= to ? at >= from && at < to : at >= from || at < to;
}

export function readConf(file) {
    const conf = { ...DEFAULTS };
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { return conf; }
    for (const line of text.split('\n')) { const m = /^([A-Z]+)=(.*)$/.exec(line.trim()); if (m && m[1] in DEFAULTS) conf[m[1]] = m[2]; }
    if (!MODES.includes(conf.MODE)) conf.MODE = DEFAULTS.MODE;
    if (!CHANNELS.includes(conf.CHANNEL)) conf.CHANNEL = DEFAULTS.CHANNEL;
    if (!WINDOW.test(conf.WINDOW)) conf.WINDOW = DEFAULTS.WINDOW;
    if (!/^\d{4,5}$/.test(conf.PORT)) conf.PORT = DEFAULTS.PORT;
    return conf;
}

/* One setting changed, the others kept: only the known keys, only their known shapes. */
export function writeConf(file, key, value) {
    const checks = { mode: ['MODE', (v) => MODES.includes(v)], channel: ['CHANNEL', (v) => CHANNELS.includes(v)], window: ['WINDOW', (v) => WINDOW.test(v) && v.slice(0, 5) !== v.slice(6)], port: ['PORT', (v) => /^\d{4,5}$/.test(v)] };
    const check = checks[key];
    if (!check) throw new Refused(`not a setting: ${key}`);
    if (!check[1](value)) throw new Refused(`not a value for ${key}: ${value}`);
    const conf = { ...readConf(file), [check[0]]: value };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.new`, `# Clavarium updates: written by install.sh and by Settings, Updates (through clavarium-host).\n${Object.entries(conf).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o644 });
    renameSync(`${file}.new`, file);
    return conf;
}

/* A program, with a time limit; what it said, bounded. */
export function runCommand(argv, { cwd, env = process.env, timeoutMs = 900_000 } = {}) {
    return new Promise((resolve) => {
        const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-20_000); });
        child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20_000); });
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.on('error', (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: error.message }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    });
}

const lastLine = (r) => String(r.stderr || r.stdout || '').trim().split('\n').filter((l) => l.trim() && !/^npm (notice|warn)/.test(l)).pop()?.slice(0, 300) ?? `exit ${r.code}`;
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const toHex = (integrity) => Buffer.from(String(integrity).replace(/^sha512-/, ''), 'base64').toString('hex');

export class Updater {
    #o; #run; #fetch;
    constructor({ code = PATHS.code, conf = PATHS.conf, stateDir = PATHS.stateDir, data = PATHS.data, hostTarget = PATHS.host, gitReadTarget = PATHS.gitRead, tunnelTarget = PATHS.tunnel, registry = REGISTRY, run = runCommand, fetcher = fetch, now = () => new Date(), log = (line) => console.log(line),
        verifySignatures, restart, health, backup, restoreData, installPrivileged, ensureNode, serviceState, answers, restarts, mainPid, pidCwd, diagnose, dropIn = DROP_IN,
        clock = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), minFreeMb = 1024, healthMs = 60_000, watchMs = 120_000, settleMs = 10_000, noticeMs = NOTICE_MS } = {}) {
        this.#o = { code, conf, stateDir, data, hostTarget, gitReadTarget, tunnelTarget, registry: registry.replace(/\/$/, ''), now, log, minFreeMb, healthMs, watchMs, settleMs, noticeMs, clock, sleep, dropIn };
        this.#run = run; this.#fetch = fetcher;
        this.verifySignatures = verifySignatures ?? ((dir) => this.#npm(['audit', 'signatures'], { cwd: dir, timeoutMs: 300_000 }));
        this.restart = restart ?? (() => this.#restart());
        /* What was seen when the server did not come up: its journal, its unit, who holds its port. */
        this.diagnose = diagnose ?? (() => this.#diagnose());
        this.health = health ?? ((release) => this.#health(release));
        this.backup = backup ?? ((app) => this.#backup(app));
        this.restoreData = restoreData ?? ((app, archive) => this.#restoreData(app, archive));
        this.installPrivileged = installPrivileged ?? ((app) => this.#installPrivileged(app));
        this.ensureNode = ensureNode ?? ((app) => this.#ensureNode(app));
        /* What systemd says of the server: 'active', 'activating', 'failed', 'inactive'... */
        this.serviceState = serviceState ?? (async () => (await this.#run(['systemctl', 'show', '-p', 'ActiveState', '--value', 'clavarium.service'], { timeoutMs: 10_000 })).stdout.trim() || 'unknown');
        /* Does the server answer, on its port, here? */
        this.answers = answers ?? (() => this.#fetch(`http://127.0.0.1:${readConf(this.#o.conf).PORT}/`, { signal: AbortSignal.timeout(5000), redirect: 'manual' }).then((r) => r.status < 500).catch(() => false));
        /* How many times systemd started it again by itself since it was last started. */
        this.restarts = restarts ?? (async () => Number((await this.#run(['systemctl', 'show', '-p', 'NRestarts', '--value', 'clavarium.service'], { timeoutMs: 10_000 })).stdout.trim()) || 0);
        this.mainPid = mainPid ?? (async () => (await this.#run(['systemctl', 'show', '-p', 'MainPID', '--value', 'clavarium.service'], { timeoutMs: 10_000 })).stdout.trim());
        this.pidCwd = pidCwd ?? ((pid) => { try { return realpathSync(`/proc/${pid}/cwd`); } catch { return ''; } });
    }

    get releasesDir() { return join(this.#o.code, 'releases'); }
    #state() { try { return JSON.parse(readFileSync(join(this.#o.stateDir, 'state.json'), 'utf8')); } catch { return { history: [] }; } }
    #save(change) {
        const state = { ...this.#state(), ...change, releases: this.releases().map(({ id, version, dataFormat, current }) => ({ id, version, dataFormat, current })) };
        state.version = this.current()?.version ?? null;
        /* "Available" is only ever a version NEWER than the one that runs: once it runs, it is not offered again. */
        if (state.available && (!VERSION.test(state.available) || (state.version && VERSION.test(state.version) && compareVersions(state.available, state.version) <= 0))) state.available = null;
        mkdirSync(this.#o.stateDir, { recursive: true, mode: 0o755 });
        const file = join(this.#o.stateDir, 'state.json');
        writeFileSync(`${file}.new`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
        chmodSync(`${file}.new`, 0o644);
        renameSync(`${file}.new`, file);
        return state;
    }
    /* `since`: when the action began; `at`: when this step did (the server ignores an old step: updates.mjs, notice). */
    #step(action, version, step) { this.#o.log(`${action} ${version}: ${step}`); this.#save({ running: { action, version, step, since: (this.#state().running?.since) ?? this.#o.now().toISOString(), at: this.#o.now().toISOString() } }); }
    #history(entry) {
        const state = this.#state();
        const history = [{ id: createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 12), at: this.#o.now().toISOString(), ...entry }, ...(state.history ?? [])].slice(0, HISTORY_MAX);
        return this.#save({ history, running: null });
    }

    /* The releases there are: { id, version, dataFormat, source, at, current, dir, app }. */
    releases() {
        let names = [];
        try { names = readdirSync(this.releasesDir).filter((n) => !n.startsWith('.')); } catch { return []; }
        let current = '';
        try { current = basename(realpathSync(join(this.#o.code, 'current'))); } catch { /* none yet */ }
        return names.map((id) => {
            try {
                const r = JSON.parse(readFileSync(join(this.releasesDir, id, 'release.json'), 'utf8'));
                return { ...r, id, current: id === current, dir: join(this.releasesDir, id), app: join(this.releasesDir, id, 'app') };
            } catch { return undefined; }
        }).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)) || compareVersions(b.version, a.version));
    }
    current() { return this.releases().find((r) => r.current); }

    about() {
        const conf = readConf(this.#o.conf);
        const state = this.#state();
        return { ...state, version: this.current()?.version ?? null, mode: conf.MODE, channel: conf.CHANNEL, window: conf.WINDOW, releases: this.releases().map(({ id, version, dataFormat, current }) => ({ id, version, dataFormat, current })) };
    }

    set(key, value) { writeConf(this.#o.conf, key, value); return this.about(); }

    async #json(url) {
        const answer = await this.#fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
        if (!answer.ok) throw new Error(`the registry answered ${answer.status} for ${url}`);
        return answer.json();
    }
    #packument(name) { return this.#json(`${this.#o.registry}/${name}`); }

    /* WHAT IS OUT on the channel: the version a check would update to, or null. */
    async check() {
        const current = this.current();
        const conf = readConf(this.#o.conf);
        try {
            const p = await this.#packument(NAME);
            const tags = p['dist-tags'] ?? {};
            let candidate = tags.latest;
            /* A channel also sees a newer stable (a jump forward is never a downgrade); it never
               reaches for a less stable channel's tag. */
            if (conf.CHANNEL === 'next' && tags.next && (!candidate || compareVersions(tags.next, candidate) > 0)) candidate = tags.next;
            if (conf.CHANNEL === 'beta' && tags.beta && (!candidate || compareVersions(tags.beta, candidate) > 0)) candidate = tags.beta;
            if (candidate && (!VERSION.test(candidate) || !p.versions?.[candidate])) candidate = undefined;
            const available = candidate && (!current || compareVersions(candidate, current.version) > 0) ? candidate : null;
            this.#save({ checkedAt: this.#o.now().toISOString(), available, checkError: null });
            return available;
        } catch (error) {
            this.#save({ checkedAt: this.#o.now().toISOString(), checkError: `The registry could not be asked: ${error.message}` });
            throw error;
        }
    }

    /* Room on the disk of the code, before anything is fetched. */
    #room() {
        try {
            mkdirSync(this.releasesDir, { recursive: true });
            const s = statfsSync(this.releasesDir); const freeMb = Math.floor((s.bavail * s.bsize) / 1048576);
            if (freeMb < this.#o.minFreeMb) throw new Refused(`only ${freeMb} MB free for a new release; ${this.#o.minFreeMb} MB are needed`);
        } catch (error) { if (error instanceof Refused) throw error; }
    }

    #npmEnv(nodeDir) { return { ...process.env, PATH: `${nodeDir ? `${nodeDir}/bin:` : ''}${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' }; }
    #npm(args, { cwd, nodeDir, timeoutMs = 900_000 } = {}) {
        const npm = nodeDir ? join(nodeDir, 'bin', 'npm') : join(dirname(process.execPath), 'npm');
        return this.#run([npm, ...args, '--registry', `${this.#o.registry}/`, '--cache', join(this.#o.stateDir, 'npm-cache'), '--loglevel=error'], { cwd, env: this.#npmEnv(nodeDir), timeoutMs });
    }

    /* MAKE A RELEASE: from the registry at an exact version, or (development) from a working tree. Resolves with it. */
    async prepare({ version, fromDir } = {}) {
        if (version !== undefined && !VERSION.test(version)) throw new Refused(`not a version: ${version}`);
        if (version === undefined && !fromDir) throw new Refused('prepare needs a version or a folder');
        const id = version ?? `local-${stamp(this.#o.now())}`;
        if (this.current()?.id === id) throw new Refused(`${id} is the release that runs`);
        this.#room();
        const dir = join(this.releasesDir, id);
        const tmp = join(this.releasesDir, `.${id}.partial`);
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(tmp, { recursive: true, mode: 0o755 });
        const action = version ? 'prepare' : 'prepare-local';
        try {
            let app;
            if (version) {
                this.#step(action, id, 'Fetching');
                writeFileSync(join(tmp, 'package.json'), `${JSON.stringify({ name: 'clavarium-release', private: true, dependencies: { [NAME]: version } }, null, 2)}\n`);
                const got = await this.#npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'], { cwd: tmp });
                if (got.code !== 0) throw new Error(`npm could not install ${NAME}@${version}: ${lastLine(got)}`);
                app = join(tmp, 'node_modules', NAME);
                const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
                if (manifest.name !== NAME || manifest.version !== version) throw new Error(`npm installed ${manifest.name}@${manifest.version}, not ${NAME}@${version}`);
                this.#step(action, id, 'Checking');
                await this.verify(tmp, version);
            } else {
                this.#step(action, id, 'Copying');
                app = join(tmp, 'app');
                mkdirSync(app);
                for (const part of ['server', 'web', 'config', 'deploy', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'LICENSE', 'README.md']) {
                    if (existsSync(join(fromDir, part))) cpSync(join(fromDir, part), join(app, part), { recursive: true });
                }
                const got = await this.#npm(['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], { cwd: app });
                if (got.code !== 0) throw new Error(`npm ci: ${lastLine(got)}`);
            }
            const nodeDir = await this.ensureNode(app);
            symlinkSync(nodeDir, join(tmp, 'node'));
            this.#step(action, id, 'Building');
            /* The build scripts run now, checked first: node-pty is compiled for this release's Node.js. */
            const built = await this.#npm(['rebuild', '--no-audit', '--no-fund'], { cwd: version ? tmp : app, nodeDir });
            if (built.code !== 0) throw new Error(`the build failed (npm rebuild): ${lastLine(built)}`);
            await fetchToolArchives({ app, registry: this.#o.registry, fetcher: this.#fetch });
            if (version) symlinkSync(join('node_modules', NAME), join(tmp, 'app'));
            this.#step(action, id, 'Testing');
            const smoke = await this.#run([join(nodeDir, 'bin', 'node'), join(app, 'server', 'smoke.mjs')], { cwd: app, env: this.#npmEnv(nodeDir), timeoutMs: 120_000 });
            if (smoke.code !== 0) throw new Error(`its smoke test failed: ${lastLine(smoke)}`);
            const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
            writeFileSync(join(tmp, 'release.json'), `${JSON.stringify({ id, version: manifest.version, dataFormat: manifest.clavarium?.dataFormat ?? 1, source: version ? 'npm' : 'local', at: this.#o.now().toISOString() }, null, 2)}\n`);
            rmSync(dir, { recursive: true, force: true });
            renameSync(tmp, dir);
            this.#save({ running: null });
            return this.releases().find((r) => r.id === id);
        } catch (error) {
            rmSync(tmp, { recursive: true, force: true });
            this.#save({ running: null });
            throw error;
        } finally {
            rmSync(join(this.#o.stateDir, 'npm-cache'), { recursive: true, force: true });
        }
    }

    /* CHECKED BEFORE ANY OF ITS CODE RUNS (see the top). `dir`: the release, as npm installed it. */
    async verify(dir, version) {
        const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
        const entry = (name) => Object.entries(lock.packages ?? {}).find(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))?.[1];
        const own = entry(NAME);
        const p = await this.#packument(NAME);
        const dist = p.versions?.[version]?.dist;
        if (!own || !dist || own.version !== version || own.integrity !== dist.integrity) throw new Error(`${NAME}@${version} as installed is not the archive the registry lists`);
        for (const name of Object.keys(REPOS)) {
            const e = name === NAME ? own : entry(name);
            if (!e) throw new Error(`${name} is not in the release`);
            await this.provenance(name, e.version, e.integrity);
        }
        const signed = await this.verifySignatures(dir);
        if (signed.code !== 0) throw new Error(`npm audit signatures refused it: ${lastLine(signed)}`);
    }

    /* Its provenance statement names this archive, and the repository it must come from. */
    async provenance(name, version, integrity) {
        const p = await this.#packument(name);
        const url = p.versions?.[version]?.dist?.attestations?.url;
        if (!url) throw new Error(`${name}@${version} has no provenance: it was not built and published by its repository`);
        if (new URL(url).origin !== new URL(this.#o.registry).origin) throw new Error(`${name}@${version}: its provenance is not on the registry`);
        const { attestations = [] } = await this.#json(url);
        const statement = attestations.filter((a) => a.predicateType === PROVENANCE).map((a) => { try { return JSON.parse(Buffer.from(a.bundle.dsseEnvelope.payload, 'base64').toString('utf8')); } catch { return undefined; } }).find(Boolean);
        if (!statement) throw new Error(`${name}@${version} has no provenance statement`);
        const subject = (statement.subject ?? []).find((s) => s.name === `pkg:npm/${name}@${version}`);
        if (!subject || subject.digest?.sha512 !== toHex(integrity)) throw new Error(`${name}@${version}: its provenance is about another archive`);
        const repository = statement.predicate?.buildDefinition?.externalParameters?.workflow?.repository;
        if (repository !== REPOS[name]) throw new Error(`${name}@${version} was built from ${repository ?? 'an unknown place'}, not ${REPOS[name]}`);
        /* And from the branch its kind of version comes from (publish.yml): a version for everybody
           from main only; a -beta.N from beta; any other version to try from next (or main). */
        const ref = statement.predicate?.buildDefinition?.externalParameters?.workflow?.ref;
        const branches = /-beta\.\d/.test(version) ? ['refs/heads/beta', 'refs/heads/main']
            : version.includes('-') ? ['refs/heads/next', 'refs/heads/main']
            : ['refs/heads/main'];
        if (!branches.includes(ref)) throw new Error(`${name}@${version} was built from ${ref ?? 'an unknown branch'}: a version ${version.includes('-') ? 'to try' : 'for everybody'} comes from ${branches.join(' or ')}`);
    }

    /* THE LINK, switched in one rename. */
    switchTo(id) {
        if (!existsSync(join(this.releasesDir, id, 'release.json'))) throw new Refused(`no such release: ${id}`);
        const link = join(this.#o.code, 'current');
        rmSync(`${link}.new`, { force: true });
        symlinkSync(join('releases', id), `${link}.new`);
        renameSync(`${link}.new`, link);
    }

    /* A conversation in the middle of a build, a move or a restart: '' or why not now.
       Only while the server runs (a phase in the file of a server that is down is not going on), and
       only a phase younger than BUSY_STALE_MS (older: cut short; the server settles it when it starts). */
    async busy() {
        const file = join(this.#o.data, 'conversations.json');
        let all = [];
        try { all = JSON.parse(readFileSync(file, 'utf8')); } catch { return ''; }
        const busy = (Array.isArray(all) ? all : []).filter((c) => c && BUSY.includes(c.phase));
        if (!busy.length) return '';
        const names = (list) => list.slice(0, 3).map((c) => c.name).join(', ');
        const state = await this.serviceState().catch(() => 'unknown');
        if (state !== 'active') { this.#o.log(`busy phases not waited for: the server is ${state} (${names(busy)})`); return ''; }
        let written = this.#o.now().getTime();
        try { written = statSync(file).mtimeMs; } catch { /* now */ }
        const now = this.#o.now().getTime();
        const since = (c) => { const t = Date.parse(c.restartingSince ?? c.buildingSince ?? c.movingSince ?? ''); return Number.isFinite(t) ? t : written; };
        const stale = busy.filter((c) => now - since(c) > BUSY_STALE_MS);
        if (stale.length) this.#o.log(`busy phases older than 30 minutes not waited for: ${names(stale)}`);
        const live = busy.filter((c) => !stale.includes(c));
        return live.length ? `a machine is being built or restarted (${names(live)}): the update waits` : '';
    }
    #dataFormat() { try { return JSON.parse(readFileSync(join(this.#o.data, 'data-format.json'), 'utf8')).format; } catch { return undefined; } }

    #lock() {
        mkdirSync(this.#o.stateDir, { recursive: true, mode: 0o755 });
        const file = join(this.#o.stateDir, 'lock');
        for (let i = 0; i < 2; i += 1) {
            try { const fd = openSync(file, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd); return () => rmSync(file, { force: true }); } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                const pid = Number(readFileSync(file, 'utf8')) || 0;
                /* A lock left by a process that is gone (killed, the machine stopped) is taken over. */
                let alive = false; try { if (pid) { process.kill(pid, 0); alive = true; } } catch (e) { alive = e.code === 'EPERM'; }
                if (!alive) this.#o.log(`a stale lock (process ${pid || '?'} is gone): taken over`);
                if (alive) throw new Refused('an update or an installation is running already');
                rmSync(file, { force: true });
            }
        }
        throw new Refused('an update or an installation is running already');
    }

    /* AN UPDATE to `version`, newer than the release that runs. */
    async apply(version) {
        if (!VERSION.test(version ?? '')) throw new Refused(`not a version: ${version}`);
        const from = this.current();
        /* Asked for the version that runs (a request that waited while it came by itself): done already. */
        if (from && compareVersions(version, from.version) === 0) return;
        if (from && compareVersions(version, from.version) < 0) throw new Refused(`${version} is not newer than ${from.version}`);
        const why = await this.busy(); if (why) throw new Refused(why);
        const unlock = this.#lock();
        try {
            let release;
            try { release = await this.prepare({ version }); } catch (error) { this.#history({ action: 'update', from: from?.version ?? null, to: version, result: 'failed', why: error.message }); throw error; }
            const before = this.#dataFormat();
            let archive;
            try {
                this.#step('update', version, 'Backing up');
                archive = await this.backup(from?.app ?? release.app);
            } catch (error) { rmSync(release.dir, { recursive: true, force: true }); this.#history({ action: 'update', from: from?.version ?? null, to: version, result: 'failed', why: `the backup failed: ${error.message}` }); throw error; }
            const late = await this.busy();
            if (late) { this.#history({ action: 'update', from: from?.version ?? null, to: version, result: 'failed', why: late }); throw new Refused(late); }
            const failed = await this.#switchAndCheck(release, 'update', version);
            if (!failed) {
                this.#history({ action: 'update', from: from?.version ?? null, to: version, result: 'done' });
                this.prune();
                return this.about();
            }
            /* IT DID NOT COME UP: what was seen kept, then back to what ran, its data too if it moved. */
            let why2 = failed;
            let log = await this.#seen(`${version} did not come up: ${failed}`);
            if (from) {
                this.#step('update', version, 'Going back');
                this.switchTo(from.id);
                await this.installPrivileged(from.app).catch(() => {});
                if (archive && this.#dataFormat() !== before) { const r = await this.restoreData(from.app, archive).catch((e) => ({ code: 1, stderr: e.message })); if (r?.code) why2 += `; the data backup could not be put back (${lastLine(r)}): ${archive}`; }
                const back = await this.#restartAndCheck(from);
                if (back) { why2 += `; ${from.version} did not come back either (${back}): journalctl -u clavarium`; log = `${log}\n\n${await this.#seen(`${from.version} did not come back: ${back}`)}`; }
                rmSync(release.dir, { recursive: true, force: true });
            }
            this.#history({ action: 'update', from: from?.version ?? null, to: version, result: from ? 'rolled-back' : 'failed', why: why2, log: log.slice(-LOG_MAX) });
            this.prune();
            return this.about();
        } finally { unlock(); }
    }

    /* GO BACK to a release that is kept, if it can read the data. */
    async rollback(id) {
        if (!VERSION.test(id ?? '') && !LOCAL.test(id ?? '')) throw new Refused(`not a release: ${id}`);
        const from = this.current();
        const to = this.releases().find((r) => r.id === id);
        if (!to) throw new Refused(`${id} is not kept here`);
        if (to.current) throw new Refused(`${id} is the release that runs`);
        const format = this.#dataFormat();
        if (format !== undefined && to.dataFormat < format) throw new Refused(`${to.version} cannot read the data of this version (format ${format}; it reads ${to.dataFormat})`);
        const why = await this.busy(); if (why) throw new Refused(why);
        const unlock = this.#lock();
        try {
            const failed = await this.#switchAndCheck(to, 'back', to.version);
            if (!failed) { this.#history({ action: 'back', from: from?.version ?? null, to: to.version, result: 'done' }); return this.about(); }
            let why2 = failed;
            let log = await this.#seen(`${to.version} did not come up: ${failed}`);
            if (from) {
                this.switchTo(from.id);
                await this.installPrivileged(from.app).catch(() => {});
                const back = await this.#restartAndCheck(from);
                if (back) { why2 += `; ${from.version} did not come back either (${back})`; log = `${log}\n\n${await this.#seen(`${from.version} did not come back: ${back}`)}`; }
            }
            this.#history({ action: 'back', from: from?.version ?? null, to: to.version, result: 'failed', why: why2, log: log.slice(-LOG_MAX) });
            return this.about();
        } finally { unlock(); }
    }

    async #switchAndCheck(release, action, version) {
        try {
            this.#step(action, version, 'Switching');
            /* The pages told first: they give way to the maintenance page while the server still answers. */
            await this.#o.sleep(this.#o.noticeMs);
            this.switchTo(release.id);
            await this.installPrivileged(release.app);
        } catch (error) { return `it could not be put in place: ${error.message}`; }
        this.#step(action, version, 'Restarting');
        return this.#restartAndCheck(release);
    }
    /* '' when it came up, or why not. */
    async #restartAndCheck(release) {
        const r = await this.restart().catch((e) => ({ code: 1, stderr: e.message }));
        if (r?.code) return `the server did not restart: ${lastLine(r)}`;
        const h = await this.health(release).catch((e) => e.message || 'no answer');
        return h || '';
    }

    /* KEPT: the release that runs and the one before it; the Node.js they use; nothing half made. */
    prune() {
        const all = this.releases();
        const current = all.find((r) => r.current);
        /* The one gone from at the last update or return that worked; else the newest other one. */
        const last = (this.#state().history ?? []).find((h) => h.result === 'done' && h.action !== 'restart');
        const previous = all.find((r) => !r.current && last && r.version === last.from) ?? all.find((r) => !r.current);
        const keep = new Set([current?.id, previous?.id].filter(Boolean));
        for (const r of all) if (!keep.has(r.id)) rmSync(r.dir, { recursive: true, force: true });
        for (const name of readdirSync(this.releasesDir)) if (name.startsWith('.') && name.endsWith('.partial')) rmSync(join(this.releasesDir, name), { recursive: true, force: true });
        const nodes = join(this.#o.code, 'nodes');
        if (existsSync(nodes)) {
            const used = new Set(this.releases().map((r) => { try { return realpathSync(join(r.dir, 'node')); } catch { return ''; } }));
            for (const v of readdirSync(nodes)) { const at = join(nodes, v); let real = at; try { real = realpathSync(at); } catch { /* keep the name */ } if (!used.has(real)) rmSync(at, { recursive: true, force: true }); }
        }
        this.#save({});
    }

    /* THE TIMER'S TURN, every 15 minutes: what the mode says. */
    async tick() {
        const conf = readConf(this.#o.conf);
        const now = this.#o.now();
        if (conf.MODE === 'off') return 'off';
        const state = this.#state();
        const since = state.checkedAt ? now - new Date(state.checkedAt) : Infinity;
        if (conf.MODE === 'auto' && !inWindow(conf.WINDOW, now)) return 'outside the window';
        if (conf.MODE === 'ask' && since < ASK_EVERY_MS) return 'checked lately';
        const available = await this.check();
        if (!available) return 'up to date';
        if (conf.MODE === 'ask') return `${available} is out: waiting for the owner`;
        /* A version that failed here is not tried again by itself: the owner can, from Settings. */
        if ((state.history ?? []).some((h) => h.to === available && h.action === 'update' && h.result !== 'done')) return `${available} failed here before: not tried again by itself`;
        const why = await this.busy(); if (why) return why;
        await this.apply(available);
        /* What the history says, not what was hoped: a version that did not start was undone. */
        const last = (this.#state().history ?? [])[0];
        return last?.to === available && last.result !== 'done' ? `${available} did not work: back to ${last.from ?? 'nothing'} (${last.why ?? last.result})` : `updated to ${available}`;
    }

    /* THE WATCHDOG, at each timer turn: the server down (its service failed, stopped, or starting
       again and again; or no answer WATCH_MISSES turns in a row) is acted on, once, and said in the
       history:
       - first, one restart of the release that runs: what blocked the old server (a process left
         on its port, a view left broken) is cleared by the restart itself (#restart), and the new
         version is seldom the cause (19-10: going back cured nothing);
       - only if it does not come back, after an update of less than WATCH_RECENT_MS with the
         release before it kept (and able to read the data): back to it, by itself, not tried
         again by itself.
       Never more than one action in WATCH_EVERY_MS, so that it never loops. { acted, said } */
    async watchdog() {
        const state = await this.serviceState().catch(() => 'unknown');
        const up = state === 'active' && await this.answers().catch(() => false);
        const w = this.#state().watch ?? {};
        if (up) { if (w.misses) this.#save({ watch: { ...w, misses: 0 } }); return { acted: false, said: 'up' }; }
        const misses = (w.misses ?? 0) + 1;
        this.#save({ watch: { ...w, misses, seen: state } });
        /* Started again and again by systemd (seen "activating", or "active" for the second before it
           dies again: many restarts by itself) is down at once, like failed or stopped. */
        const looping = state === 'activating' || await this.restarts().catch(() => 0) >= WATCH_LOOP;
        const down = state === 'failed' || state === 'inactive' || looping || misses >= WATCH_MISSES;
        this.#o.log(`watchdog: the server is ${state === 'active' ? 'active but does not answer' : state} (turn ${misses})`);
        if (!down) return { acted: false, said: `the server does not answer (turn ${misses} of ${WATCH_MISSES})` };
        const now = this.#o.now();
        if (w.actedAt && now - new Date(w.actedAt) < WATCH_EVERY_MS) return { acted: false, said: 'the server is down; something was done less than an hour ago: nothing more by itself' };
        let unlock;
        try { unlock = this.#lock(); } catch (error) { if (error instanceof Refused) return { acted: false, said: 'the server is down, but an update runs' }; throw error; }
        try {
            this.#save({ watch: { misses: 0, actedAt: now.toISOString(), seen: state } });
            const log = await this.#seen(`the server was down (${state})`);
            const current = this.current();
            const v = current?.version ?? null;
            const was = looping ? 'starting again and again' : state === 'active' ? 'no answer' : state;
            this.#o.log(`watchdog: the server is ${state}: restarted once`);
            const failed = current ? await this.#restartAndCheck(current) : await this.restart().then((r) => (r?.code ? lastLine(r) : '')).catch((e) => e.message);
            /* The last update or return (a restart by the watchdog is not one). */
            const last = (this.#state().history ?? []).find((h) => h.action !== 'restart');
            const recent = failed && current && last && last.action === 'update' && last.result === 'done' && last.to === current.version && now - new Date(last.at) < WATCH_RECENT_MS;
            const previous = recent ? this.releases().find((r) => !r.current && r.version === last.from) : undefined;
            const format = this.#dataFormat();
            if (previous && (format === undefined || previous.dataFormat >= format)) {
                let why = `${current.version} did not stay up (its service ${state === 'active' ? 'did not answer' : `was ${state}`}) nor came back after a restart (${failed}): back to ${previous.version}`;
                this.#o.log(`watchdog: ${why}`);
                this.#step('update', current.version, 'Going back');
                let back;
                try { this.switchTo(previous.id); await this.installPrivileged(previous.app).catch(() => {}); back = await this.#restartAndCheck(previous); } catch (error) { back = error.message; }
                if (back) why += `; ${previous.version} did not come back either (${back}): journalctl -u clavarium`;
                else rmSync(current.dir, { recursive: true, force: true });
                this.#history({ action: 'update', from: previous.version, to: current.version, result: 'rolled-back', by: 'watchdog', why, log: log.slice(-LOG_MAX) });
                this.prune();
                return { acted: true, said: why };
            }
            const why = `the server was down (${was}): restarted by itself${failed ? `; it did not come back (${failed}): journalctl -u clavarium` : ''}`;
            this.#history({ action: 'restart', from: v, to: v, result: failed ? 'failed' : 'done', by: 'watchdog', why, log: log.slice(-LOG_MAX) });
            return { acted: true, said: why };
        } finally { unlock(); }
    }

    /* What the host program asked (a request file), or the timer's turn. */
    async runOnce() {
        const file = join(this.#o.stateDir, 'request');
        let request = '';
        try { request = readFileSync(file, 'utf8').trim(); rmSync(file, { force: true }); } catch { /* none */ }
        const [verb, arg] = request.split(/\s+/);
        try {
            /* Asked by the administrator: once done, the registry asked once more, so what is offered is what is true now. */
            if (verb === 'apply' || verb === 'rollback') {
                const r = verb === 'apply' ? await this.apply(arg) : await this.rollback(arg);
                await this.check().catch(() => {});
                return r;
            }
            /* The timer's turn: first, is the server up? (it may have died after an update that looked well) */
            const watched = await this.watchdog();
            if (watched.acted) return watched.said;
            return await this.tick();
        } catch (error) {
            if (error instanceof Refused && request) this.#save({ refused: { at: this.#o.now().toISOString(), why: error.message } });
            throw error;
        }
    }

    /* What was seen, as text: never fails (a log that could not be read says so). */
    async #seen(title) {
        const text = await Promise.resolve().then(() => this.diagnose()).catch((e) => `the log could not be read: ${e.message}`);
        return `== ${this.#o.now().toISOString()} ${title}\n${String(text ?? '').trim()}`;
    }

    /* THE DROP-IN beside the server's unit: written when it differs, then systemd told. true when written. */
    async ensureDropIn() {
        const file = this.#o.dropIn;
        try { if (readFileSync(file, 'utf8') === DROP_IN_TEXT) return false; } catch { /* not there */ }
        mkdirSync(dirname(file), { recursive: true, mode: 0o755 });
        writeFileSync(`${file}.new`, DROP_IN_TEXT, { mode: 0o644 });
        renameSync(`${file}.new`, file);
        if (process.getuid?.() === 0) await this.#run(['systemctl', 'daemon-reload'], { timeoutMs: 60_000 });
        return true;
    }

    /* ------------------------- the real machine's ways ------------------------- */
    /* The processes still there after a stop: in the unit's cgroup, or holding its port. [{ pid, state, port }] */
    async #leftovers() {
        const port = readConf(this.#o.conf).PORT;
        const pids = new Map();
        try { for (const p of readFileSync('/sys/fs/cgroup/system.slice/clavarium.service/cgroup.procs', 'utf8').split('\n')) if (/^\d+$/.test(p.trim())) pids.set(p.trim(), false); } catch { /* none */ }
        const ss = await this.#run(['ss', '-Hltnp', `sport = :${port}`], { timeoutMs: 10_000 });
        for (const m of String(ss.stdout).matchAll(/pid=(\d+)/g)) pids.set(m[1], true);
        return [...pids].map(([pid, holds]) => {
            let state = '?';
            try { state = /^State:\s+(\S)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? '?'; } catch { state = 'gone'; }
            return { pid: Number(pid), state, port: holds };
        }).filter((p) => p.state !== 'gone');
    }

    /* A RESTART that does not trust the stop: its failures forgotten (reset-failed), stopped, and
       what is left of the old server looked at -- killed, or, when it cannot be (state D: waiting on
       the kernel), said precisely: then nothing would answer on the port before a reboot. */
    async #restart() {
        await this.#run(['systemctl', 'reset-failed', 'clavarium.service'], { timeoutMs: 30_000 });
        await this.#run(['systemctl', 'stop', 'clavarium.service'], { timeoutMs: 120_000 });
        let left = await this.#leftovers();
        for (const p of left.filter((x) => x.state !== 'D')) { try { process.kill(p.pid, 'SIGKILL'); this.#o.log(`a process of the old server was still there: ${p.pid} (state ${p.state}): killed`); } catch { /* gone */ } }
        if (left.length) { await this.#o.sleep(2000); left = await this.#leftovers(); }
        const stuck = left.filter((x) => x.state === 'D' && x.port);
        if (stuck.length) return { code: 1, stderr: `a stuck process holds the port: ${stuck.map((p) => `pid ${p.pid}, state D`).join('; ')} (it waits on the kernel and cannot be killed): the server needs a reboot` };
        if (left.some((x) => x.state === 'D')) this.#o.log(`processes of the old server stuck in state D (not on the port): ${left.map((p) => p.pid).join(', ')}`);
        /* The views the old server left broken (their program killed with it): taken off, or the
           new server could not make them again before a reboot. Never a reason not to start. */
        const repaired = await this.#run([this.#o.hostTarget, 'mounts', 'repair'], { timeoutMs: 60_000 });
        if (repaired.code || String(repaired.stderr).trim()) this.#o.log(`mounts: ${String(repaired.stderr).trim() || `exit ${repaired.code}`}`);
        await this.#run(['systemctl', 'reset-failed', 'clavarium.service'], { timeoutMs: 30_000 });
        return this.#run(['systemctl', 'start', 'clavarium.service'], { timeoutMs: 120_000 });
    }

    async #diagnose() {
        const port = readConf(this.#o.conf).PORT;
        const part = async (title, argv) => { const r = await this.#run(argv, { timeoutMs: 20_000 }); return `-- ${title}\n${String(r.stdout || r.stderr || `exit ${r.code}`).trim()}`; };
        const left = await this.#leftovers().catch(() => []);
        return [
            await part('systemctl status clavarium', ['systemctl', 'status', 'clavarium.service', '--no-pager', '-n', '0']),
            await part(`who listens on ${port}`, ['ss', '-Hltnp', `sport = :${port}`]),
            `-- processes of the server's unit or on its port\n${left.map((p) => `pid ${p.pid} state ${p.state}${p.port ? ' (holds the port)' : ''}`).join('\n') || 'none'}`,
            await part('journalctl -u clavarium -n 80', ['journalctl', '-u', 'clavarium.service', '-n', '80', '--no-pager', '-o', 'short-iso']),
        ].join('\n');
    }

    /* Comes up (answers, from this release) within healthMs, then STAYS up: watched until watchMs after
       the restart; one restart by systemd is forgiven if it answers at the end, not two. */
    async #health(release) {
        const { clock, sleep } = this.#o;
        const start = clock();
        const target = realpathSync(release.dir);
        const mine = async () => { const pid = await this.mainPid(); return { pid, ok: !!pid && pid !== '0' && this.pidCwd(pid).startsWith(target) }; };
        let said = 'it did not answer';
        let pid = '';
        for (;;) {
            const state = await this.serviceState().catch(() => 'unknown');
            const answered = state === 'active' && await this.answers().catch(() => false);
            if (answered) {
                const m = await mine();
                if (m.ok) { pid = m.pid; break; }
                said = 'the server that answers is not this release';
            } else if (state !== 'active' && state !== 'activating') said = 'its service stopped';
            if (clock() - start > this.#o.healthMs) return said;
            await sleep(1000);
        }
        /* And it stays up. */
        const until = Math.max(start + this.#o.watchMs, clock() + this.#o.settleMs);
        let restarts = 0;
        while (clock() < until) {
            await sleep(Math.min(5000, Math.max(1, until - clock())));
            const now = await this.mainPid().catch(() => '');
            if (now && now !== '0' && now !== pid) { restarts += 1; pid = now; }
            if (restarts > 1) return 'the server stopped more than once in its first minutes';
        }
        /* At the end: it answers, from this release (a moment given if it is in its one restart). */
        const last = clock() + this.#o.settleMs;
        for (;;) {
            const state = await this.serviceState().catch(() => 'unknown');
            if (state === 'active' && await this.answers().catch(() => false) && (await mine()).ok) return '';
            if (clock() > last) return restarts ? 'the server stopped soon after it started, and did not answer again' : 'the server stopped soon after it started';
            await sleep(1000);
        }
    }

    async #backup(app) {
        const to = join(this.#o.stateDir, 'backup');
        rmSync(to, { recursive: true, force: true });
        mkdirSync(to, { recursive: true, mode: 0o700 });
        const r = await this.#run(['bash', join(app, 'deploy', 'backup.sh'), '--server-only', '--to', to], { timeoutMs: 1_800_000 });
        if (r.code !== 0) throw new Error(lastLine(r));
        const archive = readdirSync(to).find((f) => f.endsWith('.tgz'));
        if (!archive) throw new Error('backup.sh wrote no archive');
        return join(to, archive);
    }

    #restoreData(app, archive) {
        const key = archive.replace(/\.tgz$/, '.vault-key');
        return this.#run(['bash', join(app, 'deploy', 'restore.sh'), archive, ...(existsSync(key) ? ['--vault-key', key] : [])], { timeoutMs: 1_800_000 });
    }

    async #installPrivileged(app) {
        for (const [from, to] of [[join(app, 'deploy', 'clavarium-host'), this.#o.hostTarget], [join(app, 'deploy', 'git-read'), this.#o.gitReadTarget], [join(app, 'deploy', 'clavarium-tunnel'), this.#o.tunnelTarget]]) {
            /* A release older than a program has none to give: the one there stays. */
            if (!existsSync(from)) continue;
            const r = await this.#run(['install', '-o', 'root', '-g', 'root', '-m', '0755', from, to], { timeoutMs: 30_000 });
            if (r.code !== 0) throw new Error(`${to}: ${lastLine(r)}`);
        }
        await this.ensureDropIn().catch((error) => this.#o.log(`the drop-in of the server's unit could not be written: ${error.message}`));
        /* What a release sets up beside itself (the certificate timer): an update does not run install.sh again.
           Best effort: the update does not depend on it; `sudo clavarium doctor` says when it is missing. */
        const node = join(dirname(app), 'node', 'bin', 'node');
        if (existsSync(node)) await this.#run([node, join(app, 'deploy', 'clavarium.mjs'), 'doctor', '--install-watch'], { timeoutMs: 60_000 }).catch(() => {});
    }

    /* The Node.js the release pins (server/tools.mjs), checked against its checksum, shared between releases. */
    async #ensureNode(app) {
        const text = readFileSync(join(app, 'server', 'tools.mjs'), 'utf8');
        const v = /^export const NODE_VERSION = '(v\d+\.\d+\.\d+)';$/m.exec(text)?.[1];
        const sum = /^export const NODE_SHA256 = '([0-9a-f]{64})';$/m.exec(text)?.[1];
        if (!v || !sum) throw new Error('the release does not pin a Node.js version');
        const dir = join(this.#o.code, 'nodes', v);
        if (existsSync(join(dir, 'bin', 'node'))) return dir;
        mkdirSync(join(this.#o.code, 'nodes'), { recursive: true });
        const tmp = `${dir}.partial`; const file = `${dir}.tar.xz`;
        rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp);
        try {
            const answer = await this.#fetch(`https://nodejs.org/dist/${v}/node-${v}-linux-x64.tar.xz`, { signal: AbortSignal.timeout(600_000) });
            if (!answer.ok) throw new Error(`nodejs.org answered ${answer.status}`);
            const bytes = Buffer.from(await answer.arrayBuffer());
            if (createHash('sha256').update(bytes).digest('hex') !== sum) throw new Error(`Node.js ${v} does not have the checksum the release pins`);
            writeFileSync(file, bytes);
            const r = await this.#run(['tar', '-xJf', file, '-C', tmp, '--strip-components=1', '--no-same-owner'], { timeoutMs: 300_000 });
            if (r.code !== 0) throw new Error(`Node.js could not be unpacked: ${lastLine(r)}`);
            renameSync(tmp, dir);
            return dir;
        } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(file, { force: true }); }
    }
}

/* -------------------------------- the command -------------------------------- */
async function main(argv) {
    const [verb, ...rest] = argv;
    const value = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
    /* What it does is said on stderr (the journal); stdout carries only the answer. */
    const u = new Updater({ log: (line) => console.error(line) });
    const print = (x) => console.log(JSON.stringify(x, null, 2));
    switch (verb) {
        case 'check': await u.check().catch(() => {}); return print(u.about());
        case 'status': return print(u.about());
        case 'run': {
            /* What this release sets up beside itself (the certificate timer), at its first turn: the
               update that brought it ran the PREVIOUS release's code. Idempotent; never stops the turn. */
            try { const [{ installWatch }, { realSys }] = await Promise.all([import('./doctor.mjs'), import('./online.mjs')]); if (await installWatch(realSys())) console.error('updater: the certificate timer set up'); } catch (error) { console.error(`updater: the certificate timer could not be set up: ${error.message}`); }
            try { if (await u.ensureDropIn()) console.error('updater: the drop-in of the server\'s unit written'); } catch (error) { console.error(`updater: the drop-in could not be written: ${error.message}`); }
            try { if (await ensureProxySettings()) console.error('updater: the sign-in proxy takes one CSRF cookie per sign-in'); } catch (error) { console.error(`updater: the sign-in proxy could not be set: ${error.message}`); }
            try { const c = await ensureGenericClientId({ run: runCommand }); if (c.changed.length) console.error('updater: the sign-in client id was made generic (nothing names the product in the open)'); } catch (error) { console.error(`updater: the sign-in client id could not be made generic: ${error.message}`); }
            try { if (await ensureTunnel({ run: runCommand })) console.error('updater: the tunnel to the relay notices a cut sooner'); } catch (error) { console.error(`updater: the tunnel could not be set: ${error.message}`); }
            /* What became of the relay is kept beside the state, for Settings (server/updates.mjs: relay). */
            try {
                const { keepRelayCurrent, realSys } = await import('./online.mjs');
                const outcome = await keepRelayCurrent(realSys(), undefined, { done: join(PATHS.stateDir, 'relay-version') }).catch((error) => ({ state: 'failed', why: error.message }));
                if (outcome.state === 'brought') console.error('updater: the relay is at the version of this release');
                if (outcome.state === 'refused' || outcome.state === 'failed') console.error(`updater: the relay could not be brought up to date: ${outcome.why}`);
                writeFileSync(join(PATHS.stateDir, 'relay.json.new'), `${JSON.stringify({ ...outcome, at: new Date().toISOString() })}\n`, { mode: 0o644 });
                renameSync(join(PATHS.stateDir, 'relay.json.new'), join(PATHS.stateDir, 'relay.json'));
            } catch (error) { console.error(`updater: the relay could not be looked at: ${error.message}`); }
            try {
                const m = await ensureMaintenance();
                if (m.page) console.error('updater: the maintenance page written');
                if (m.edge) console.error('updater: the front serves the maintenance page while the server is down');
                if (m.why) console.error(`updater: the maintenance page: ${m.why}`);
            } catch (error) { console.error(`updater: the maintenance page could not be set: ${error.message}`); }
            const r = await u.runOnce(); console.log(typeof r === 'string' ? r : 'done'); return; }
        case 'set': if (rest.length !== 2) throw new Refused('set <mode|channel|window|port> <value>'); return print(u.set(rest[0], rest[1]));
        case 'prepare': { const r = await u.prepare({ version: value('--version'), fromDir: value('--from-dir') }); console.log(r.id); return; }
        case 'switch': if (!VERSION.test(rest[0] ?? '') && !LOCAL.test(rest[0] ?? '')) throw new Refused('switch <release>'); u.switchTo(rest[0]); return;
        case 'prune': u.prune(); return;
        case 'apply': return print(await u.apply(rest[0]));
        case 'rollback': return print(await u.rollback(rest[0]));
        default:
            console.error('usage: updater.mjs check | status | run | set <key> <value> | prepare --version V | prepare --from-dir DIR | switch <release> | prune | apply <version> | rollback <release>');
            process.exitCode = 64;
    }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.getuid?.() !== 0) { console.error('updater: REFUSED: run it as root (it is run by install.sh, the clavarium-update service and clavarium-host)'); process.exit(78); }
    main(process.argv.slice(2)).catch((error) => { console.error(`updater: ${error instanceof Refused ? 'REFUSED: ' : ''}${error.message}`); process.exitCode = error instanceof Refused ? 78 : 1; });
}
