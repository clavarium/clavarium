/* GOING ONLINE FROM THE KEYBOARD: `sudo clavarium online`, `sudo clavarium key`,
 * `sudo clavarium relay ...`. Run as root, on the Clavarium machine.
 *
 * An installation always ends in LOCAL MODE (this computer only, no sign-in).
 * Going online means SERVER MODE: HTTPS, an administrator and a password, a
 * domain, and one of two ways in:
 *
 *   --relay HOST   this machine is not reachable: it dials out to a small
 *                  machine of yours that has a public address. This command
 *                  sets that machine up ITSELF over SSH, with a "setup key" the
 *                  operator puts once on an account of it that has sudo; the
 *                  key is taken out again at the end (unless --keep-setup-key).
 *   --port         this machine is reachable on 80 and 443 (a server at a host,
 *                  or a router whose ports were opened).
 *
 * NOTHING IS CUT BEFORE A REAL TEST FROM THE INTERNET HAS PASSED: Let's
 * Encrypt's staging service is asked for a certificate for the domain, so it
 * really comes to this machine (through the relay, or through the open
 * ports). On failure, the exact cause is said and the machine stays in local
 * mode. Only then does install.sh switch it to server mode and print the
 * administrator's password, once.
 *
 * Everything outside this file (processes, DNS, the terminal) goes through
 * `sys`, so the tests can stand in for SSH, npm and DNS.
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync, renameSync, openSync, readSync, writeSync, closeSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConf } from './updater.mjs';

export const PATHS = {
    access: '/var/lib/clavarium-relay-access',
    tunnel: '/var/lib/clavarium-tunnel',
    relayConf: '/etc/clavarium/relay.conf',
    updateConf: '/etc/clavarium/update.conf',
    unit: '/etc/systemd/system/clavarium.service',
    code: '/opt/clavarium',
    caddy: '/usr/local/bin/caddy',
};
export const STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$|^([0-9]{1,3}\.){3}[0-9]{1,3}$/;
const EMAIL = /^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const PRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const KEY = /^ssh-ed25519 [A-Za-z0-9+/]{68}( [A-Za-z0-9@._-]{1,64})?$/;
const KEEPER = 'clavarium-keeper';
const WAIT_MS = 30 * 60_000;

export class Bad extends Error {}
export class Refused extends Error {}
export class Failed extends Error {}

/* ------------------------------ parameters ------------------------------ */
export const USAGE = [
    'usage: sudo clavarium online --relay HOST --domain NAME [--relay-user USER] [--relay-port N] [--admin EMAIL]',
    '                             [--relay-fingerprint SHA256:...] [--keep-setup-key] [--yes]',
    '   or: sudo clavarium online --port --domain NAME [--admin EMAIL]',
].join('\n');

export function parseOnline(args) {
    const o = { askRelay: false, relay: '', user: 'root', relayPort: '22', domain: '', admin: '', fingerprint: '', keepSetupKey: false, yes: false, port: false };
    const value = (i, name) => { const v = args[i + 1]; if (v === undefined || v.startsWith('--')) throw new Bad(`${name} needs a value`); return v; };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        switch (a) {
            case '--relay': o.relay = value(i, a); i++; break;
            case '--relay-user': o.user = value(i, a); i++; break;
            case '--relay-port': o.relayPort = value(i, a); i++; break;
            case '--domain': o.domain = value(i, a); i++; break;
            case '--admin': o.admin = value(i, a); i++; break;
            case '--relay-fingerprint': o.fingerprint = value(i, a); i++; break;
            case '--keep-setup-key': o.keepSetupKey = true; break;
            case '--yes': o.yes = true; break;
            case '--port': o.port = true; break;
            default: throw new Bad(`unknown parameter: ${a}`);
        }
    }
    if (o.relay && o.port) throw new Bad('say how it will be reached: --relay HOST or --port, not both');
    /* Neither: through a relay that does not exist yet -- its key is shown first,
       and its address asked once the operator has made it with that key. */
    if (!o.relay && !o.port) o.askRelay = true;
    if (!DOMAIN.test(o.domain)) throw new Bad('--domain is a host name, lower case, like clav.example.com');
    o.admin ||= `admin@${o.domain}`;
    if (!EMAIL.test(o.admin)) throw new Bad('--admin is an e-mail address, lower case');
    if (o.relay || o.askRelay) {
        if (o.relay && !HOST.test(o.relay)) throw new Bad('--relay is the name or the address of the relay machine');
        if (!USER.test(o.user)) throw new Bad('--relay-user is an account name');
        if (!/^\d{1,5}$/.test(o.relayPort) || +o.relayPort < 1 || +o.relayPort > 65535) throw new Bad('--relay-port is a port number');
        if (o.fingerprint && !PRINT.test(o.fingerprint)) throw new Bad('--relay-fingerprint looks like SHA256:... (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on the relay)');
    } else if (o.fingerprint || o.keepSetupKey || o.user !== 'root' || o.relayPort !== '22') throw new Bad('--relay-user, --relay-port, --relay-fingerprint and --keep-setup-key go with --relay');
    return o;
}

/* --------------------------------- keys --------------------------------- */
const keyFiles = (P) => ({
    setup: join(P.access, 'setup-key'),
    keeper: join(P.access, 'keeper-key'),
    tunnel: join(P.tunnel, 'key'),
    knownHosts: join(P.access, 'known_hosts'),
});

/* The three keys of this machine, made here if missing; private halves never leave it. */
export async function ensureKeys(sys, P = PATHS) {
    const f = keyFiles(P);
    mkdirSync(P.access, { recursive: true, mode: 0o700 });
    for (const [file, name] of [[f.setup, 'clavarium-setup'], [f.keeper, KEEPER]]) {
        if (existsSync(`${file}.pub`)) continue;
        const r = await sys.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', file]);
        if (r.code !== 0) throw new Failed(`the key ${name} could not be made: ${tail(r)}`);
    }
    if (!existsSync(`${f.tunnel}.pub`)) {
        if ((await sys.run(['id', 'clavarium-tunnel'])).code !== 0) await sys.run(['useradd', '--system', '--home-dir', '/nonexistent', '--no-create-home', '--shell', '/usr/sbin/nologin', 'clavarium-tunnel']);
        await sys.run(['install', '-d', '-o', 'clavarium-tunnel', '-g', 'clavarium-tunnel', '-m', '0700', P.tunnel]);
        const r = await sys.run(['sudo', '-u', 'clavarium-tunnel', 'ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'clavarium-tunnel', '-f', f.tunnel]);
        if (r.code !== 0) throw new Failed(`the tunnel key could not be made: ${tail(r)}`);
    }
    const read = (file) => readFileSync(`${file}.pub`, 'utf8').trim();
    return { setup: read(f.setup), keeper: read(f.keeper), tunnel: read(f.tunnel) };
}

async function qr(sys, text) {
    const r = await sys.run(['qrencode', '-t', 'ANSIUTF8', '-m', '2', '--', text]);
    if (r.code === 0 && r.out) sys.print(r.out.replace(/\n$/, ''));
}

/* `sudo clavarium key`: the public keys, as text and as QR codes for a phone. */
export async function showKeys(sys, P = PATHS, { which = 'all' } = {}) {
    const keys = await ensureKeys(sys, P);
    if (which === 'all' || which === 'setup') {
        sys.print('SETUP KEY: for `clavarium online --relay`. Put it once on the relay, in');
        sys.print('~/.ssh/authorized_keys of an account that has sudo. It is taken out at the end.');
        sys.print(`    ${keys.setup}`);
        await qr(sys, keys.setup);
    }
    if (which === 'all' || which === 'tunnel') {
        sys.print('TUNNEL KEY: only if you set up the relay yourself:');
        sys.print(`    sudo deploy/relay.sh --key "${keys.tunnel}"`);
        await qr(sys, keys.tunnel);
    }
    sys.print('These are PUBLIC keys: showing them is safe.');
    return keys;
}

/* ---------------------------------- SSH ---------------------------------- */
const sshOptions = (key, knownHosts, port) => [
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', `IdentityFile=${key}`, '-o', 'PreferredAuthentications=publickey', '-o', 'NumberOfPasswordPrompts=0',
    '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-p', String(port),
];
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const tail = (r) => String(r.err || r.out || '').trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? `exit ${r.code}`;

export function readRelayConf(P = PATHS) {
    const conf = {};
    try { for (const line of readFileSync(P.relayConf, 'utf8').split('\n')) { const m = /^([A-Z_]+)=(.*)$/.exec(line.trim()); if (m) conf[m[1]] = m[2]; } } catch { return null; }
    return conf.HOST ? conf : null;
}
function writeRelayConf(P, conf) {
    mkdirSync(join(P.relayConf, '..'), { recursive: true });
    writeFileSync(`${P.relayConf}.new`, `# The relay of this Clavarium. Written by clavarium online.\n${Object.entries(conf).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o644 });
    renameSync(`${P.relayConf}.new`, P.relayConf);
}

/* The relay's own maintenance program, through the account that may run it only. */
export async function keeper(sys, P, conf, words, { stream = false } = {}) {
    const f = keyFiles(P);
    return sys.run(['ssh', ...sshOptions(f.keeper, f.knownHosts, conf.PORT), `${KEEPER}@${conf.HOST}`, words.join(' ')], { stream });
}

/* The version of the relay program this Clavarium works with: the one relay.sh installs. */
export function relayVersion(P = PATHS) {
    const text = readFileSync(join(P.code, 'current', 'app', 'deploy', 'relay.sh'), 'utf8');
    return /^RELAY_VERSION="([^"]+)"$/m.exec(text)?.[1];
}

/* Takes the setup key out of the relay account it was put in, and checks it no longer opens it. */
export async function forgetSetupKey(sys, P, conf) {
    const f = keyFiles(P);
    const body = readFileSync(`${f.setup}.pub`, 'utf8').trim().split(' ')[1];
    const at = [...sshOptions(f.setup, f.knownHosts, conf.PORT), `${conf.USER}@${conf.HOST}`];
    const script = `f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || exit 0; t="$(mktemp)"; grep -vF -- ${quote(body)} "$f" > "$t" || true; cat "$t" > "$f"; rm -f -- "$t"`;
    const r = await sys.run(['ssh', ...at, script]);
    if (r.code !== 0 && !/Permission denied/i.test(r.err)) throw new Failed(`the setup key could not be taken out: ${tail(r)}`);
    const again = await sys.run(['ssh', ...at, 'true']);
    if (again.code === 0) throw new Failed(`the setup key still opens ${conf.USER}@${conf.HOST}: take it out of ~/.ssh/authorized_keys there`);
    writeRelayConf(P, { ...conf, SETUP_KEY: 'removed' });
    sys.print(`The setup key no longer opens ${conf.USER}@${conf.HOST}.`);
}

/* ---------------------------------- DNS ---------------------------------- */
export function isPrivate(ip) {
    return /^(10\.|127\.|169\.254\.|192\.168\.|0\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
        || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /^(::1$|f[cd]|fe80:)/i.test(ip);
}
export async function addresses(sys, name) {
    if (/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(name)) return [name];
    return sys.resolve(name);
}

/* What the DNS must say, checked before anything changes. */
export async function checkDns(sys, o) {
    const got = await addresses(sys, o.domain);
    if (o.relay) {
        const relay = await addresses(sys, o.relay);
        if (!relay.length) throw new Failed(`${o.relay} has no address in the DNS`);
        if (!got.length) throw new Failed(`${o.domain} has no DNS record yet. Create it at your DNS provider:\n    ${o.domain}  A  ${relay[0]}\n(then run this command again)`);
        if (!got.some((a) => relay.includes(a))) throw new Failed(`${o.domain} points to ${got.join(', ')}, not to the relay (${relay.join(', ')}). Change the record:\n    ${o.domain}  A  ${relay[0]}`);
        sys.print(`DNS: ${o.domain} -> ${got.join(', ')}, the relay. Good.`);
        return got;
    }
    if (!got.length) throw new Failed(`${o.domain} has no DNS record yet. Create one at your DNS provider: ${o.domain}  A  <the public address of this machine>`);
    const pub = got.filter((a) => !isPrivate(a));
    if (!pub.length) throw new Failed(`${o.domain} points to ${got.join(', ')}: a private address, which the internet cannot reach. Use the public one (your router's, or your server's)`);
    sys.print(`DNS: ${o.domain} -> ${got.join(', ')}.`);
    return got;
}

/* The domain made to point to the relay while the operator is at it: waited for
   (every 30 s, Enter to look now), the record to make said once. */
export async function waitDns(sys, o) {
    let said = false;
    for (;;) {
        const relay = await addresses(sys, o.relay);
        const got = await addresses(sys, o.domain);
        if (relay.length && got.some((a) => relay.includes(a))) return;
        if (!said && relay.length) { said = true; sys.print(`At your DNS provider, point the domain to the relay:\n    ${o.domain}  A  ${relay[0]}\nWaiting for it (it takes a few minutes) -- or press Enter to look now.`); }
        await (sys.sleepOrEnter ? sys.sleepOrEnter(30_000) : sys.sleep(30_000));
    }
}

/* ------------------------ the test from the internet ------------------------ */
/* What Let's Encrypt (or Caddy) said, as the operator needs to read it. */
export function explain(error, { domain, port, relay }) {
    const e = String(error);
    const where = relay ? `the relay ${relay}` : 'this machine';
    if (/address already in use/i.test(e)) return `port ${port} is already used by another program on this machine`;
    if (/NXDOMAIN|no valid A records|DNS problem/i.test(e)) return `Let's Encrypt cannot find ${domain} in the DNS yet (${e.match(/DNS problem: [^;"]*/)?.[0] ?? 'DNS'}). Wait a few minutes after creating the record, then try again`;
    if (/timeout|timed out|likely firewall/i.test(e)) return relay ? `port ${port} of ${relay} cannot be reached from the internet: open it in the relay's firewall (at its host, too)` : `port ${port} is not open on your router or firewall: Let's Encrypt waited and nothing answered`;
    if (/connection refused/i.test(e)) return relay ? `port ${port} of ${relay} refuses connections: the relay does not pass it to the tunnel (sudo clavarium relay repair)` : `port ${port} reaches a machine that refuses it: forward it to this machine on your router`;
    if (/unauthorized|invalid response|404|403/i.test(e)) return `${domain} leads to another machine than ${where}: check the DNS record`;
    if (/rate ?limit|too many/i.test(e)) return 'Let\'s Encrypt says too many tries: wait an hour and try again';
    return `the test failed: ${e.slice(0, 300)}`;
}

/* One certificate asked of Let's Encrypt's STAGING service (no real
   certificate, no limit worth worrying about), with one challenge only, so
   that what fails says which port: http-01 comes on 80, tls-alpn-01 on 443. */
export async function acmeTest(sys, P, { domain, relay, challenge, timeoutMs = 150_000 }) {
    const dir = mkdtempSync(join(sys.tmp ?? tmpdir(), 'clavarium-test-'));
    const port = challenge === 'http' ? 80 : 443;
    try {
        writeFileSync(join(dir, 'Caddyfile'), [
            '{', '\tadmin off', '\tpersist_config off', `\tstorage file_system ${join(dir, 'data')}`, '\tlog {', '\t\toutput stderr', '\t\tformat json', '\t}', '}',
            `${domain} {`, relay ? '\tbind 127.0.0.1' : '',
            '\ttls {', '\t\tissuer acme {', `\t\t\tdir ${STAGING}`, challenge === 'http' ? '\t\t\tdisable_tlsalpn_challenge' : '\t\t\tdisable_http_challenge', '\t\t}', '\t}',
            '\trespond "Clavarium: test" 200', '}', '',
        ].join('\n'));
        let finish;
        const result = new Promise((resolve) => { finish = resolve; });
        const timer = setTimeout(() => finish({ ok: false, why: `no answer from Let's Encrypt within ${Math.round(timeoutMs / 1000)} s: port ${port} probably does not reach ${relay ? 'the relay' : 'this machine'}` }), timeoutMs);
        const proc = sys.start([P.caddy, 'run', '--config', join(dir, 'Caddyfile'), '--adapter', 'caddyfile'], {
            env: { HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir },
            onLine: (line) => {
                let j = null;
                try { j = JSON.parse(line); } catch { /* not a log line */ }
                if (j?.msg === 'certificate obtained successfully') finish({ ok: true });
                else if (j && j.level === 'error' && /could not get certificate|obtaining certificate|job failed|obtain/i.test(j.msg ?? '')) finish({ ok: false, why: explain(j.error ?? j.msg, { domain, port, relay }) });
                else if (!j && /address already in use|Error:/i.test(line)) finish({ ok: false, why: explain(line, { domain, port, relay }) });
            },
        });
        proc.exited.then((r) => finish({ ok: false, why: `the test program stopped (exit ${r.code})` }));
        const got = await result;
        clearTimeout(timer);
        proc.stop();
        await proc.exited;
        return got;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

async function internetTest(sys, P, o) {
    for (const challenge of ['http', 'tls']) {
        const port = challenge === 'http' ? 80 : 443;
        sys.print(`Test from the internet, port ${port}: Let's Encrypt (staging) comes to ${o.domain}...`);
        const r = await acmeTest(sys, P, { domain: o.domain, relay: o.relay, challenge });
        if (!r.ok) throw new Failed(`${r.why}.\nNothing was changed: this machine is still in local mode.`);
        sys.print(`   port ${port}: reached. Good.`);
    }
}

async function portsFree(sys) {
    for (const port of [80, 443]) {
        const r = await sys.run(['ss', '-ltnpH', `sport = :${port}`]);
        if (r.out.trim()) throw new Failed(`port ${port} is already used on this machine: ${r.out.trim().split('\n')[0].replace(/\s+/g, ' ')}`);
    }
}

/* ------------------------------ the relay path ------------------------------ */
async function scanRelay(sys, o, deadline) {
    for (;;) {
        const r = await sys.run(['ssh-keyscan', '-T', '10', '-t', 'ed25519', '-p', o.relayPort, o.relay]);
        const line = r.out.split('\n').find((l) => / ssh-ed25519 [A-Za-z0-9+/=]+$/.test(l.trim()));
        if (line) return line.trim();
        if (sys.now() > deadline) throw new Failed(`${o.relay} does not answer on port ${o.relayPort} (SSH)`);
        sys.print(`${o.relay} does not answer on port ${o.relayPort} yet; trying again...`);
        await sys.sleep(5000);
    }
}

async function fingerprintOf(sys, P, line) {
    const file = join(P.access, 'known_hosts.pending');
    writeFileSync(file, `${line}\n`, { mode: 0o600 });
    const r = await sys.run(['ssh-keygen', '-l', '-f', file]);
    const print = /SHA256:[A-Za-z0-9+/]{43}/.exec(r.out)?.[0];
    if (!print) throw new Failed(`the relay's key could not be read: ${tail(r)}`);
    return { file, print };
}

/* NOT BANNED WHILE WAITING. A relay may run fail2ban (by default: banned after
   5 failed logins in 10 minutes). So: while its SSH port does not even answer,
   only that port is looked at (no login, nothing counted); once it answers,
   one key, one try, then 5 minutes, a second, 5 minutes, a third (the
   operator's rule): after three failures it waits for Enter on the keyboard
   (with --yes and no keyboard: 5 minutes more each time). */
export const KNOCK_MS = 5 * 60_000;
export const KNOCKS = 3;
const portAnswers = (host, port, ms = 5000) => new Promise((resolve) => {
    const s = connect({ host, port: Number(port) });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false)); s.once('connect', () => done(true)); s.once('error', () => done(false));
});
export async function waitForSetupKey(sys, o, at, deadline) {
    const check = o.user === 'root' ? 'true' : 'sudo -n true';
    let said = '';
    const say = (text) => { if (text !== said) { said = text; sys.print(text); } };
    let tries = 0;
    const knock = sys.portAnswers ?? portAnswers;
    for (;;) {
        if (!(await knock(o.relay, o.relayPort ?? 22))) {
            say(`${o.relay} does not answer on its SSH port yet: waiting, without trying to log in...`);
            if (sys.now() > deadline) throw new Failed(`${o.relay} did not answer on its SSH port within ${WAIT_MS / 60000} minutes`);
            await sys.sleep(15_000);
            continue;
        }
        const r = await sys.run(['ssh', ...at, `${o.user}@${o.relay}`, check]);
        tries += 1;
        if (r.code === 0) { sys.print(`The setup key opens ${o.user}@${o.relay}${o.user === 'root' ? '' : ', with sudo'}.`); return; }
        const err = r.err || '';
        if (/password is required|not in the sudoers|may not run sudo/i.test(err)) say(`${o.user} on ${o.relay} needs sudo without a password: add "${o.user} ALL=(ALL) NOPASSWD: ALL" in /etc/sudoers.d there. Waiting...`);
        else if (/Permission denied/i.test(err)) say(`Waiting for the setup key on ${o.user}@${o.relay} (Ctrl-C to stop)...`);
        else if (/Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(err)) throw new Refused(`${o.relay} answered with another key than a moment ago: stopped`);
        else say(`${o.relay} does not answer yet (${tail(r)}). Waiting...`);
        if (sys.now() > deadline) throw new Failed(`the setup key was not accepted on ${o.user}@${o.relay} within ${WAIT_MS / 60000} minutes`);
        if (tries >= KNOCKS && !o.yes && sys.waitEnter) {
            sys.print(`   ${KNOCKS} tries refused: put the setup key on the relay, then press Enter to try again (Ctrl-C to stop).`);
            if (!(await sys.waitEnter())) throw new Failed('no keyboard to wait on: run sudo clavarium online again once the key is on the relay');
            tries = 0;
            continue;
        }
        sys.print(`   next try in ${KNOCK_MS / 60_000} min (${tries} of ${KNOCKS})${sys.sleepOrEnter && !o.yes ? ' -- or press Enter to try now' : ''}`);
        await (sys.sleepOrEnter && !o.yes ? sys.sleepOrEnter(KNOCK_MS) : sys.sleep(KNOCK_MS));
    }
}

async function setUpRelay(sys, P, o, keys) {
    const f = keyFiles(P);
    const conf = { HOST: o.relay, PORT: o.relayPort, USER: o.user };
    const prior = readRelayConf(P);
    /* Run again after the relay was set up (a test that failed, a DNS record
       made late): the maintenance account answers, the setup key is not needed. */
    if (prior && prior.HOST === o.relay && existsSync(f.knownHosts)) {
        const r = await keeper(sys, P, { ...prior, PORT: o.relayPort }, ['version']);
        if (r.code === 0 && /^\d/.test(r.out.trim())) { sys.print(`The relay ${o.relay} is set up already (clavarium-relay ${r.out.trim()}).`); return { ...prior, ...conf, SETUP_KEY: prior.SETUP_KEY ?? 'removed' }; }
    }

    sys.print('');
    sys.print(`1. Put this SETUP KEY on the relay, in ~${o.user}/.ssh/authorized_keys of ${o.relay}${o.user === 'root' ? '' : ` (${o.user} needs sudo without a password)`}:`);
    sys.print(`    ${keys.setup}`);
    await qr(sys, keys.setup);
    sys.print('(A public key: safe to show. It is taken out again at the end.)');
    sys.print('');
    const deadline = sys.now() + WAIT_MS;
    const scanned = await scanRelay(sys, o, deadline);
    const { file: pending, print } = await fingerprintOf(sys, P, scanned);
    if (o.fingerprint && o.fingerprint !== print) {
        rmSync(pending, { force: true });
        throw new Refused(`${o.relay} answers with the key ${print}, not ${o.fingerprint}: it may not be your relay. Nothing was changed`);
    }
    await waitForSetupKey(sys, o, sshOptions(f.setup, pending, o.relayPort), deadline);

    sys.print(`2. The relay's fingerprint:  ${print}`);
    if (o.fingerprint) sys.print('   It is the one given with --relay-fingerprint. Good.');
    else if (o.yes) sys.print('   Accepted without a check (--yes).');
    else {
        sys.print('   To compare, on the relay: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
        if (!(await sys.ask('   Is it the same?'))) { rmSync(pending, { force: true }); throw new Refused('not confirmed: nothing was changed'); }
    }
    renameSync(pending, f.knownHosts);
    writeFileSync(join(P.tunnel, 'known_hosts'), `${scanned}\n`, { mode: 0o644 });
    await sys.run(['chown', 'clavarium-tunnel:clavarium-tunnel', join(P.tunnel, 'known_hosts')]);

    sys.print('3. Setting up the relay (tunnel account, maintenance account, port rule, automatic updates)...');
    const script = readFileSync(join(P.code, 'current', 'app', 'deploy', 'relay.sh'), 'utf8');
    const sudo = o.user === 'root' ? '' : 'sudo -n ';
    /* The script is read whole into a file before it runs: run from standard
       input, a program it starts (apt-get...) could eat the rest of it. */
    const runner = 'f="$(mktemp)"; cat > "$f"; bash "$f" "$@" </dev/null; s=$?; rm -f -- "$f"; exit $s';
    const r = await sys.run(['ssh', ...sshOptions(f.setup, f.knownHosts, o.relayPort), `${o.user}@${o.relay}`,
        `${sudo}bash -c ${quote(runner)} relay.sh --key ${quote(keys.tunnel)} --keeper-key ${quote(keys.keeper)}`], { input: script, stream: true });
    if (r.code !== 0) throw new Failed(`the relay could not be set up (exit ${r.code}, above: why). This machine is still in local mode`);
    const next = { ...conf, SETUP_KEY: 'kept' };
    writeRelayConf(P, next);
    const v = await keeper(sys, P, next, ['version']);
    if (v.code !== 0) throw new Failed(`the relay's maintenance account does not answer: ${tail(v)}`);
    sys.print(`   The relay is set up (clavarium-relay ${v.out.trim()}).`);
    if (o.keepSetupKey) sys.print('   The setup key stays on the relay (--keep-setup-key). Later: sudo clavarium relay forget-setup-key');
    else await forgetSetupKey(sys, P, next);
    return readRelayConf(P);
}

/* The tunnel, for the test only: the service comes with server mode. */
function startTunnel(sys, P, o) {
    const lines = [];
    const proc = sys.start(['sudo', '-u', 'clavarium-tunnel', 'ssh', '-N', '-T', ...sshOptions(join(P.tunnel, 'key'), join(P.tunnel, 'known_hosts'), o.relayPort),
        '-o', 'ExitOnForwardFailure=yes', '-R', '*:8443:127.0.0.1:443', '-R', '*:8080:127.0.0.1:80', `clavarium-tunnel@${o.relay}`], { onLine: (l) => lines.push(l) });
    return { proc, lines };
}

/* ------------------------------- the switch ------------------------------- */
function serverModeOf(P) {
    try { return /--public-origin https:\/\/(\S+)/.exec(readFileSync(P.unit, 'utf8'))?.[1] ?? null; } catch { return null; }
}

async function switchToServer(sys, P, o) {
    const app = join(P.code, 'current', 'app');
    const port = readConf(P.updateConf).PORT;
    const argv = ['/bin/bash', join(app, 'deploy', 'install.sh'), '--keep-release', '--domain', o.domain, '--operator', o.admin, '--port', port];
    if (o.relay) argv.push('--relay', o.relay, '--relay-port', o.relayPort, '--relay-installed');
    sys.print('');
    sys.print('Switching to server mode: HTTPS, sign-in, the administrator...');
    const r = await sys.run(argv, { stream: true, inherit: true });
    if (r.code !== 0) throw new Failed(`the switch to server mode failed (exit ${r.code}, above: why)`);
}

/* `sudo clavarium online ...` */
export async function online(o, sys, P = PATHS) {
    const was = serverModeOf(P);
    if (was) throw new Refused(`this machine is in server mode already: https://${was}`);
    if (!existsSync(P.caddy)) throw new Failed('the HTTPS programs are not on this machine: run the installer again (curl -fsSL https://clavarium.org/install.sh | sudo bash)');
    const keys = await ensureKeys(sys, P);
    if (o.askRelay) {
        await showKeys(sys, P, { which: 'setup' });
        sys.print('Create the relay at your host now (Ubuntu), with the key above as its SSH key.');
        for (;;) {
            const a = String(await sys.askLine('Its address, once it exists (IP or name): ') ?? '').trim();
            if (HOST.test(a)) { o.relay = a; break; }
            if (!a && !sys.hasKeyboard?.()) throw new Failed('no keyboard to ask on: give --relay HOST');
            sys.print('   That is not an address: an IP address, or a name like relay.example.com');
        }
        await waitDns(sys, o);
    }
    await checkDns(sys, o);
    await portsFree(sys);
    if (o.relay) await setUpRelay(sys, P, o, keys);
    let tunnel = null;
    try {
        if (o.relay) {
            tunnel = startTunnel(sys, P, o);
            await sys.sleep(4000);
            if (tunnel.proc.ended?.()) throw new Failed(`the tunnel to ${o.relay} did not come up: ${tunnel.lines.filter(Boolean).pop() ?? 'no reason given'}`);
        }
        await internetTest(sys, P, o);
    } finally {
        tunnel?.proc.stop();
    }
    await switchToServer(sys, P, o);
    sys.print('');
    sys.print(`Online: https://${o.domain}   (sign in as ${o.admin}, with the password above)`);
    if (o.relay) sys.print('The relay is watched from here: sudo clavarium relay status');
}

/* `sudo clavarium relay VERB` */
export async function relayCommand(args, sys, P = PATHS) {
    const conf = readRelayConf(P);
    if (!conf) throw new Refused('this machine has no relay (sudo clavarium online --relay HOST --domain NAME)');
    const [verb, ...rest] = args;
    switch (verb) {
        case 'forget-setup-key': return forgetSetupKey(sys, P, conf);
        case 'status': case 'repair': case 'update-os': {
            if (rest.length && !(verb === 'update-os' && rest.length === 1 && rest[0] === '--reboot')) throw new Bad(`relay ${verb} takes nothing`);
            const r = await keeper(sys, P, conf, [verb, ...rest], { stream: true });
            if (r.code !== 0) throw new Failed(`the relay answered with exit ${r.code}`);
            return;
        }
        case 'update-relay': {
            const version = rest[0] ?? relayVersion(P);
            if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9A-Za-z.-]{1,40})?$/.test(version ?? '')) throw new Bad('relay update-relay [X.Y.Z]');
            const r = await keeper(sys, P, conf, ['update-relay', version], { stream: true });
            if (r.code !== 0) throw new Failed(`the relay did not update (exit ${r.code})`);
            return;
        }
        default: throw new Bad('usage: sudo clavarium relay status | repair | update-os [--reboot] | update-relay [X.Y.Z] | forget-setup-key');
    }
}

/* ---------------------------- the real world ---------------------------- */
export function realSys() {
    return {
        print: (text) => process.stdout.write(`${text}\n`),
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        resolve: async (name) => {
            const all = [];
            for (const f of [dns.resolve4, dns.resolve6]) { try { all.push(...await f.call(dns, name)); } catch { /* none of that kind */ } }
            return all;
        },
        run: (argv, { input, stream = false, inherit = false, env } = {}) => new Promise((resolve) => {
            const child = spawn(argv[0], argv.slice(1), { env: env ? { ...process.env, ...env } : process.env, stdio: inherit ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', stream ? 'inherit' : 'pipe', 'pipe'] });
            let out = ''; let err = '';
            child.stdout?.on('data', (d) => { out = (out + d).slice(-50_000); });
            child.stderr?.on('data', (d) => { err = (err + d).slice(-50_000); if (stream) process.stderr.write(d); });
            if (input !== undefined) child.stdin.end(input);
            child.on('error', (e) => resolve({ code: 127, out, err: e.message }));
            child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
        }),
        start: (argv, { env, onLine }) => {
            const child = spawn(argv[0], argv.slice(1), { env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] });
            let ended = false;
            for (const s of [child.stdout, child.stderr]) createInterface({ input: s }).on('line', (l) => onLine?.(l));
            const exited = new Promise((resolve) => { child.on('error', () => { ended = true; resolve({ code: 127 }); }); child.on('close', (code) => { ended = true; resolve({ code: code ?? 1 }); }); });
            return { exited, ended: () => ended, stop: () => { if (!ended) child.kill('SIGTERM'); } };
        },
        /* A wait that Enter on the keyboard cuts short (no keyboard: the whole wait). */
        sleepOrEnter: (ms) => new Promise((resolve) => {
            let tty; let timer;
            const done = () => { clearTimeout(timer); try { tty?.destroy(); } catch { /* gone */ } resolve(); };
            timer = setTimeout(done, ms);
            try { tty = createReadStream('/dev/tty'); tty.on('data', (d) => { if (d.includes(10) || d.includes(13)) done(); }); tty.on('error', () => {}); } catch { /* no keyboard: the timer alone */ }
        }),
        hasKeyboard: () => { try { closeSync(openSync('/dev/tty', 'r')); return true; } catch { return false; } },
        askLine: async (question) => {
            let fd;
            try { fd = openSync('/dev/tty', 'r+'); } catch { return ''; }
            try { writeSync(fd, question); const buf = Buffer.alloc(512); let s = ''; while (!s.includes('\n')) { const n = readSync(fd, buf, 0, buf.length, null); if (!n) break; s += buf.toString('utf8', 0, n); } return s.split('\n')[0]; } finally { closeSync(fd); }
        },
        waitEnter: async () => {
            let fd;
            try { fd = openSync('/dev/tty', 'r'); } catch { return false; }
            try { const buf = Buffer.alloc(256); let s = ''; while (!s.includes('\n')) { const n = readSync(fd, buf, 0, buf.length, null); if (!n) break; s += buf.toString('utf8', 0, n); } return true; } finally { closeSync(fd); }
        },
        ask: async (question) => {
            let fd;
            try { fd = openSync('/dev/tty', 'r+'); } catch { return false; }
            try {
                writeSync(fd, `${question} [y/N] `);
                const buf = Buffer.alloc(256); let s = '';
                while (!s.includes('\n')) { const n = readSync(fd, buf, 0, buf.length, null); if (!n) break; s += buf.toString('utf8', 0, n); }
                return /^y(es)?$/i.test(s.trim());
            } finally { closeSync(fd); }
        },
    };
}
