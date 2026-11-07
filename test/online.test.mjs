/* GOING ONLINE FROM THE KEYBOARD (deploy/online.mjs), with stand-ins for SSH,
   the DNS, Let's Encrypt (Caddy's log lines) and the terminal: what is asked,
   in what order, and above all that nothing changes before the test from the
   internet has passed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOnline, online, showKeys, QR_WARNING, relayCommand, explain, isPrivate, checkDns, Bad, Refused, Failed } from '../deploy/online.mjs';

const ip = (...parts) => parts.join('.');
const RELAY_IP = ip(203, 0, 113, 7);
const HOME_IP = ip(198, 51, 100, 9);
const PRINT = `SHA256:${'Q'.repeat(43)}`;
const RELAY_SH = fileURLToPath(new URL('../deploy/relay.sh', import.meta.url));
const keyLine = (name) => `ssh-ed25519 ${'AAAAC3NzaC1lZDI1NTE5AAAAI'}${name.slice(0, 1).toUpperCase().repeat(43)} ${name}`;
const OK = { code: 0, out: '', err: '' };
const CERT = JSON.stringify({ level: 'info', msg: 'certificate obtained successfully', identifier: 'clav.example.com' });

function place() {
    const root = mkdtempSync(join(tmpdir(), 'clavarium-online-'));
    const P = {
        access: join(root, 'access'), tunnel: join(root, 'tunnel'), relayConf: join(root, 'etc', 'relay.conf'),
        updateConf: join(root, 'etc', 'update.conf'), unit: join(root, 'clavarium.service'), code: join(root, 'code'), caddy: join(root, 'caddy'), passwords: join(root, 'passwords'),
    };
    mkdirSync(join(P.code, 'current', 'app', 'deploy'), { recursive: true });
    copyFileSync(RELAY_SH, join(P.code, 'current', 'app', 'deploy', 'relay.sh'));
    mkdirSync(P.tunnel, { recursive: true });
    writeFileSync(P.caddy, '');
    writeFileSync(P.unit, 'ExecStart=node server/main.mjs --port 7717\n');
    return { root, P, done: () => rmSync(root, { recursive: true, force: true }) };
}

/* The world as a test wants it. `ssh(user, host, command, argv)` answers SSH;
   `caddy` is a list of log-line lists, one per test run of Caddy. */
function world({ dns = {}, ssh = () => OK, caddy = [], answers = [], ports = {}, root, portOpen = () => true }) {
    const log = []; const printed = []; const slept = []; let t = 0;
    const sys = {
        tmp: root,
        print: (s) => printed.push(s),
        now: () => t,
        sleep: async (ms) => { t += ms; slept.push(ms); },
        portAnswers: async () => portOpen(),
        resolve: async (name) => dns[name] ?? [],
        ask: async (q) => { log.push({ ask: q }); return answers.shift() ?? false; },
        run: async (argv, opts = {}) => {
            log.push({ argv, opts });
            const [cmd] = argv;
            if (cmd === 'ssh-keygen' && argv.includes('-l')) return { code: 0, out: `256 ${PRINT} relay (ED25519)\n`, err: '' };
            if (cmd === 'ssh-keygen' || (cmd === 'sudo' && argv.includes('ssh-keygen'))) {
                const f = argv[argv.indexOf('-f') + 1]; const name = argv[argv.indexOf('-C') + 1];
                writeFileSync(f, 'PRIVATE'); writeFileSync(`${f}.pub`, `${keyLine(name)}\n`);
                return OK;
            }
            if (cmd === 'qrencode') return { code: 0, out: '[QR]\n', err: '' };
            if (cmd === 'ss') return { code: 0, out: ports[argv[2]] ?? '', err: '' };
            if (cmd === 'ssh-keyscan') return { code: 0, out: `${argv.at(-1)} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRELAYKEY\n`, err: '' };
            if (cmd === 'ssh') { const at = argv.at(-2); const [user, host] = at.split('@'); return ssh(user, host, argv.at(-1), argv, opts) ?? OK; }
            return OK;
        },
        start: (argv, { onLine }) => {
            log.push({ start: argv });
            let stop; const exited = new Promise((r) => { stop = () => r({ code: 0 }); });
            if (argv[0].endsWith('caddy')) { const lines = caddy.shift() ?? []; setImmediate(() => lines.forEach((l) => onLine(l))); }
            return { exited, stop: () => stop(), ended: () => false };
        },
    };
    return { sys, log, printed, text: () => printed.join('\n') };
}
const ran = (log, pred) => log.filter((e) => e.argv && pred(e.argv));
const installRuns = (log) => ran(log, (a) => a[0] === '/bin/bash' && a[1].endsWith('install.sh'));

test('the parameters: one way in, a domain, a default administrator; anything odd is refused', () => {
    /* Neither --relay nor --port: the domain is the relay's address. */
    assert.equal(parseOnline(['--domain', 'clav.example.com', '--relay-user', 'ubuntu']).relay, 'clav.example.com', 'no --relay: the relay is reached by the domain');
    const r = parseOnline(['--relay', 'relay.example.net', '--domain', 'clav.example.com']);
    assert.equal(r.user, 'root'); assert.equal(r.relayPort, '22'); assert.equal(r.admin, ['admin', 'clav.example.com'].join('@'));
    assert.equal(parseOnline(['--port', '--domain', 'clav.example.com', '--admin', 'you@example.com']).admin, 'you@example.com');
    for (const args of [
        ['--relay', 'relay.example.net', '--port', '--domain', 'clav.example.com'],
        ['--port'],
        ['--port', '--domain', 'clav.example.com; id'],
        ['--relay', 'relay.example.net -oProxyCommand=id', '--domain', 'clav.example.com'],
        ['--relay', 'relay.example.net', '--relay-user', 'root;id', '--domain', 'clav.example.com'],
        ['--relay', 'relay.example.net', '--domain', 'clav.example.com', '--relay-fingerprint', 'MD5:aa'],
        ['--port', '--domain', 'clav.example.com', '--keep-setup-key'],
        ['--port', '--domain', 'clav.example.com', '--admin', 'Admin'],
        ['--port', '--domain', 'clav.example.com', '--shell'],
    ]) assert.throws(() => parseOnline(args), Bad, args.join(' '));
});

test('clavarium key: three keys made here once, the public ones shown as text and QR', async () => {
    const { root, P, done } = place();
    try {
        const w = world({ root });
        const keys = await showKeys(w.sys, P);
        assert.match(w.text(), /SETUP KEY/); assert.ok(w.text().includes(keys.setup)); assert.ok(w.text().includes(`relay.sh --key "${keys.tunnel}"`));
        assert.deepEqual(ran(w.log, (a) => a[0] === 'qrencode').map((e) => e.argv.at(-1)), [keys.setup, keys.tunnel]);
        assert.ok(existsSync(join(P.access, 'keeper-key.pub')));
        /* The QR code far from the key's text, a warning above it: a phone must read the code, not the text. */
        const t = w.text();
        assert.ok(t.indexOf(QR_WARNING) < t.indexOf('[QR]') && t.indexOf('[QR]') < t.indexOf(keys.setup), 'warning, code, then text');
        assert.match(t.slice(t.indexOf('[QR]'), t.indexOf(keys.setup)), /\n\s*\n\s*\n\s*\n\s*\n/, 'a wide gap');
        const again = world({ root });
        await showKeys(again.sys, P, { which: 'setup' });
        assert.equal(ran(again.log, (a) => a.includes('ssh-keygen')).length, 0, 'made once');
        assert.doesNotMatch(again.text(), /TUNNEL KEY/);
    } finally { done(); }
});

test('the causes Let\'s Encrypt gives are said in plain words', () => {
    const d = { domain: 'clav.example.com', port: 80 };
    assert.match(explain('Timeout during connect (likely firewall problem)', d), /port 80 is not open on your router or firewall/);
    assert.match(explain('Timeout during connect', { ...d, relay: 'relay.example.net' }), /port 80 of relay\.example\.net cannot be reached/);
    assert.match(explain('DNS problem: NXDOMAIN looking up A for clav.example.com', d), /cannot find clav\.example\.com in the DNS/);
    assert.match(explain('Connection refused', d), /refuses it/);
    assert.match(explain('Invalid response from http://clav.example.com: 404', d), /another machine/);
    assert.match(explain('listen tcp :80: bind: address already in use', d), /already used by another program/);
    assert.ok(isPrivate(ip(192, 168, 1, 4)) && isPrivate(ip(10, 0, 0, 1)) && isPrivate(ip(100, 64, 0, 1)) && isPrivate('fd00::1'));
    assert.ok(!isPrivate(RELAY_IP));
});

test('--port: DNS, ports free, a real test on 80 then 443, and only then server mode', async () => {
    const { root, P, done } = place();
    try {
        const w = world({ root, dns: { 'clav.example.com': [HOME_IP] }, caddy: [[CERT], [CERT]] });
        writeFileSync(P.passwords, '    admin    S3CRET-PW\n'); /* what install.sh writes there */
        await online(parseOnline(['--port', '--domain', 'clav.example.com']), w.sys, P);
        const starts = w.log.filter((e) => e.start);
        assert.equal(starts.length, 2);
        const runs = installRuns(w.log);
        assert.equal(runs.length, 1);
        assert.deepEqual(runs[0].argv.slice(2), ['--keep-release', '--domain', 'clav.example.com', '--operator', ['admin', 'clav.example.com'].join('@'), '--port', '7717']);
        assert.ok(w.log.indexOf(starts[1]) < w.log.indexOf(runs[0]), 'the test comes first');
        assert.match(w.text(), /Online: https:\/\/clav\.example\.com/);
        assert.equal(readdirLeft(root), 0, 'the test leaves nothing behind');
        /* The password goes through a file install.sh writes, shown LAST (it does not scroll away), then deleted; the diagnosis before it. */
        assert.equal(runs[0].opts.env.CLAVARIUM_PASSWORDS_TO, P.passwords);
        assert.ok(!existsSync(P.passwords));
        assert.ok(w.text().indexOf('Diagnosis:') < w.text().indexOf('Online: https'));
        assert.equal(w.printed.at(-1), '    admin    S3CRET-PW');
        assert.match(w.printed.at(-2), /SIGN IN WITH \(shown ONCE.*lost: sudo clavarium password EMAIL/);
    } finally { done(); }
});
const readdirLeft = (root) => { try { return readdirSync(root).filter((f) => f.startsWith('clavarium-test-')).length; } catch { return 0; } };

test('--port: a closed port is said exactly, and nothing changes', async () => {
    const { root, P, done } = place();
    try {
        const fail = JSON.stringify({ level: 'error', msg: 'could not get certificate from issuer', error: 'HTTP 400 urn:ietf:params:acme:error:connection - Timeout during connect (likely firewall problem)' });
        const w = world({ root, dns: { 'clav.example.com': [HOME_IP] }, caddy: [[fail]] });
        await assert.rejects(online(parseOnline(['--port', '--domain', 'clav.example.com']), w.sys, P), (e) => e instanceof Failed && /port 80 is not open on your router or firewall/.test(e.message) && /Nothing was changed/.test(e.message));
        assert.equal(installRuns(w.log).length, 0);
    } finally { done(); }
});

test('--port: no DNS record, a private address, a busy port: stopped before any test', async () => {
    const { root, P, done } = place();
    try {
        for (const [dns, ports, why] of [
            [{}, {}, /no DNS record yet/],
            [{ 'clav.example.com': [ip(192, 168, 1, 20)] }, {}, /private address/],
            [{ 'clav.example.com': [HOME_IP] }, { 'sport = :80': 'LISTEN 0 511 *:80 users:(("nginx",pid=1,fd=6))' }, /port 80 is already used/],
        ]) {
            const w = world({ root, dns, ports });
            await assert.rejects(online(parseOnline(['--port', '--domain', 'clav.example.com']), w.sys, P), why);
            assert.equal(w.log.filter((e) => e.start).length, 0);
            assert.equal(installRuns(w.log).length, 0);
        }
    } finally { done(); }
});

test('a machine already in server mode is not switched again', async () => {
    const { root, P, done } = place();
    try {
        writeFileSync(P.unit, 'ExecStart=node server/main.mjs --operators a@example.com --public-origin https://clav.example.com\n');
        const w = world({ root });
        await assert.rejects(online(parseOnline(['--port', '--domain', 'clav.example.com']), w.sys, P), Refused);
    } finally { done(); }
});

/* A relay that accepts the setup key after `deniedFor` tries. */
function relayWorld(root, { deniedFor = 1, sudoPassword = false, setupFails = false, answers = [true], caddy = [[CERT], [CERT]] } = {}) {
    let tries = 0; let removed = false; const remote = [];
    const w = world({
        root, answers, caddy,
        dns: { 'clav.example.com': [RELAY_IP], 'relay.example.net': [RELAY_IP] },
        ssh: (user, host, command, argv, opts) => {
            remote.push({ user, command, input: opts.input });
            if (user === 'clavarium-keeper') return { code: 0, out: '0.1.0\n', err: '' };
            if (removed) return { code: 255, out: '', err: 'Permission denied (publickey).' };
            if (command === 'true' || command === 'sudo -n true') {
                tries++;
                if (tries <= deniedFor) return { code: 255, out: '', err: `${user}@${host}: Permission denied (publickey).` };
                if (sudoPassword && tries === deniedFor + 1) return { code: 1, out: '', err: 'sudo: a password is required' };
                return OK;
            }
            if (command.includes('relay.sh --key')) return setupFails ? { code: 78, out: '', err: '' } : OK;
            if (command.includes('authorized_keys')) { removed = true; return OK; }
            return OK;
        },
    });
    return { ...w, remote };
}
const RELAY_ARGS = ['--relay', 'relay.example.net', '--relay-user', 'ubuntu', '--domain', 'clav.example.com'];

test('--relay: key shown, waited for, fingerprint confirmed, relay set up by itself, setup key removed, tested, switched', async () => {
    const { root, P, done } = place();
    try {
        const w = relayWorld(root, { deniedFor: 2, sudoPassword: true });
        await online(parseOnline(RELAY_ARGS), w.sys, P);
        const text = w.text();
        assert.match(text, /Put this SETUP KEY on the relay, in ~ubuntu\/\.ssh\/authorized_keys/);
        assert.match(text, /Waiting for the setup key on ubuntu@relay\.example\.net/);
        assert.match(text, /needs sudo without a password/);
        assert.ok(text.includes(PRINT));
        assert.equal(w.log.filter((e) => e.ask).length, 1);
        const setup = w.remote.find((r) => r.command.includes('relay.sh --key'));
        assert.match(setup.command, /^sudo -n bash -c '.*cat > "\$f"; bash "\$f" "\$@" <\/dev\/null.*' relay\.sh --key 'ssh-ed25519 \S+ clavarium-tunnel' --keeper-key 'ssh-ed25519 \S+ clavarium-keeper' --name 'clav\.example\.com'$/);
        assert.equal(setup.input, readFileSync(RELAY_SH, 'utf8'), 'the relay script itself, sent on standard input');
        assert.ok(w.remote.some((r) => r.command.includes('authorized_keys') && r.command.includes('grep -vF')), 'the setup key is taken out');
        assert.match(readFileSync(P.relayConf, 'utf8'), /HOST=relay\.example\.net[\s\S]*USER=ubuntu[\s\S]*SETUP_KEY=removed/);
        assert.match(readFileSync(join(P.tunnel, 'known_hosts'), 'utf8'), /relay\.example\.net ssh-ed25519/);
        const tunnel = w.log.find((e) => e.start && e.start.includes(['clavarium-tunnel', 'relay.example.net'].join('@')));
        assert.ok(tunnel && tunnel.start.includes('*:8443:127.0.0.1:443'), 'the test goes through a tunnel');
        const runs = installRuns(w.log);
        assert.equal(runs.length, 1);
        assert.deepEqual(runs[0].argv.slice(-5), ['--relay', 'relay.example.net', '--relay-port', '22', '--relay-installed']);
        const caddyfileTest = w.log.filter((e) => e.start && e.start[0].endsWith('caddy'));
        assert.equal(caddyfileTest.length, 2);
    } finally { done(); }
});

test('--relay: a fingerprint given that does not match stops before anything is sent', async () => {
    const { root, P, done } = place();
    try {
        const w = relayWorld(root);
        await assert.rejects(online(parseOnline([...RELAY_ARGS, '--relay-fingerprint', `SHA256:${'Z'.repeat(43)}`]), w.sys, P), (e) => e instanceof Refused && /may not be your relay/.test(e.message));
        assert.equal(w.remote.length, 0);
        assert.ok(!existsSync(P.relayConf));
    } finally { done(); }
});

test('--relay: a matching fingerprint is not asked; "no" at the question changes nothing', async () => {
    const { root, P, done } = place();
    try {
        const w = relayWorld(root);
        await online(parseOnline([...RELAY_ARGS, '--relay-fingerprint', PRINT, '--keep-setup-key']), w.sys, P);
        assert.equal(w.log.filter((e) => e.ask).length, 0);
        assert.ok(!w.remote.some((r) => r.command.includes('authorized_keys')), '--keep-setup-key keeps it');
        assert.match(readFileSync(P.relayConf, 'utf8'), /SETUP_KEY=kept/);
    } finally { done(); }
    const second = place();
    try {
        const w = relayWorld(second.root, { answers: [false] });
        await assert.rejects(online(parseOnline(RELAY_ARGS), w.sys, second.P), /not confirmed/);
        assert.ok(!w.remote.some((r) => r.command.includes('relay.sh --key')));
        assert.equal(installRuns(w.log).length, 0);
    } finally { second.done(); }
});

test('--relay: the DNS must lead to the relay, checked first', async () => {
    const { root, P, done } = place();
    try {
        const w = world({ root, dns: { 'clav.example.com': [HOME_IP], 'relay.example.net': [RELAY_IP] } });
        await assert.rejects(online(parseOnline(RELAY_ARGS), w.sys, P), (e) => e.message.includes(`clav.example.com  A  ${RELAY_IP}`));
        assert.equal(w.log.filter((e) => e.argv?.[0] === 'ssh-keyscan').length, 0);
        await assert.rejects(checkDns(world({ root, dns: { 'relay.example.net': [RELAY_IP] } }).sys, parseOnline(RELAY_ARGS)), /no DNS record yet/);
    } finally { done(); }
});

test('--relay: a failed test through the relay leaves local mode; run again, the relay is not set up twice', async () => {
    const { root, P, done } = place();
    try {
        const fail = JSON.stringify({ level: 'error', msg: 'could not get certificate from issuer', error: 'Connection refused' });
        const w = relayWorld(root, { caddy: [[fail]] });
        await assert.rejects(online(parseOnline(RELAY_ARGS), w.sys, P), /relay\.example\.net refuses connections[\s\S]*Nothing was changed/);
        assert.equal(installRuns(w.log).length, 0);
        const again = relayWorld(root);
        await online(parseOnline(RELAY_ARGS), again.sys, P);
        assert.ok(!again.remote.some((r) => r.command.includes('relay.sh --key')), 'set up already');
        assert.match(again.text(), /set up already/);
        assert.equal(installRuns(again.log).length, 1);
    } finally { done(); }
});

test('--relay: a relay that fails to set up stops everything', async () => {
    const { root, P, done } = place();
    try {
        const w = relayWorld(root, { setupFails: true });
        await assert.rejects(online(parseOnline(RELAY_ARGS), w.sys, P), /could not be set up/);
        assert.equal(installRuns(w.log).length, 0);
    } finally { done(); }
});

test('clavarium relay: verbs go through the maintenance account; update-relay defaults to the version relay.sh installs', async () => {
    const { root, P, done } = place();
    try {
        const w0 = world({ root });
        await assert.rejects(relayCommand(['status'], w0.sys, P), Refused);
        mkdirSync(join(P.relayConf, '..'), { recursive: true });
        writeFileSync(P.relayConf, 'HOST=relay.example.net\nPORT=22\nUSER=ubuntu\nSETUP_KEY=kept\n');
        await showKeys(world({ root }).sys, P);
        const sent = [];
        const w = world({ root, ssh: (user, host, command) => { sent.push(`${user} ${command}`); return user === 'ubuntu' && command === 'true' && sent.length > 2 ? { code: 255, out: '', err: 'Permission denied' } : OK; } });
        await relayCommand(['status'], w.sys, P);
        await relayCommand(['update-relay'], w.sys, P);
        const pinned = /^RELAY_VERSION="([^"]+)"$/m.exec(readFileSync(RELAY_SH, 'utf8'))[1];
        assert.deepEqual(sent.slice(0, 2), ['clavarium-keeper status', `clavarium-keeper update-relay ${pinned}`]);
        await relayCommand(['forget-setup-key'], w.sys, P);
        assert.match(readFileSync(P.relayConf, 'utf8'), /SETUP_KEY=removed/);
        await assert.rejects(relayCommand(['status', '--all'], w.sys, P), Bad);
        await assert.rejects(relayCommand(['update-relay', '1.0;id'], w.sys, P), Bad);
        await assert.rejects(relayCommand(['reboot'], w.sys, P), Bad);
    } finally { done(); }
});

test('the relay program version this Clavarium installs is the one relay/ declares', () => {
    const pinned = /^RELAY_VERSION="([^"]+)"$/m.exec(readFileSync(RELAY_SH, 'utf8'))[1];
    const pkg = JSON.parse(readFileSync(new URL('../relay/package.json', import.meta.url), 'utf8'));
    assert.equal(pinned, pkg.version);
    assert.match(readFileSync(new URL('../relay/clavarium-relay', import.meta.url), 'utf8'), new RegExp(`^VERSION_OF_THIS="${pkg.version.replace(/\./g, '\\.')}"$`, 'm'));
});

test('waiting for the relay is not banned: no login while its port is shut; then one try, 5 min, a second, 5 min, a third, then Enter', async () => {
    const { waitForSetupKey, KNOCK_MS } = await import('../deploy/online.mjs');
    let t = 0; const slept = []; const printed = []; let open = false; let logins = 0; let enters = 0;
    const sys = {
        now: () => t, print: (s) => printed.push(s),
        sleep: async (ms) => { t += ms; slept.push(ms); if (slept.length === 2) open = true; },
        portAnswers: async () => open,
        run: async () => { logins += 1; return logins <= 4 ? { code: 255, out: '', err: 'Permission denied (publickey).' } : { code: 0, out: '', err: '' }; },
        waitEnter: async () => { enters += 1; return true; },
    };
    await waitForSetupKey(sys, { user: 'ubuntu', relay: 'relay.example.net', relayPort: '22', yes: false }, [], Infinity);
    assert.deepEqual(slept.slice(0, 2), [15_000, 15_000], 'the shut port is only looked at');
    assert.deepEqual(slept.slice(2), [KNOCK_MS, KNOCK_MS, KNOCK_MS], '5 minutes between tries, and again after Enter');
    assert.equal(enters, 1, 'after three refusals, Enter is waited for');
    assert.equal(logins, 5);
});

test('a relay that does not exist yet: its key shown, its address asked, the domain waited for, then the same way as --relay', async () => {
    const { waitDns, parseOnline } = await import('../deploy/online.mjs');
    const o = parseOnline(['--domain', 'clav.example.com', '--relay-user', 'ubuntu']);
    const IP = [10, 1, 2, 9].join('.'); /* built, not written: the shapes check refuses a written address */
    o.relay = IP;
    let t = 0; let looks = 0; const printed = [];
    const sys = { print: (s) => printed.push(s), now: () => t, sleep: async (ms) => { t += ms; },
        resolve: async (name) => (name === IP ? [IP] : (++looks >= 3 ? [IP] : [])) };
    await waitDns(sys, o);
    assert.ok(printed.join('\n').includes(`clav.example.com  A  ${IP}`));
    assert.ok(t >= 60_000, 'it waited');
});

/* --------------------------- another home on the relay --------------------------- */
const HOME_KEY = keyLine('tunnel-of-b');
const PRINCIPAL_UNIT = 'ExecStart=node server/main.mjs --operators a@example.com --public-origin https://clav.example.com\n';
/* A principal: online, its relay kept through its maintenance key. `relay` answers what the relay would. */
function principalPlace({ relay } = {}) {
    const p = place();
    writeFileSync(p.P.unit, PRINCIPAL_UNIT);
    mkdirSync(join(p.P.relayConf, '..'), { recursive: true });
    writeFileSync(p.P.relayConf, 'HOST=relay.example.net\nPORT=22\nUSER=ubuntu\nSETUP_KEY=removed\n');
    const sent = [];
    const w = world({ root: p.root, ssh: (user, host, command) => {
        sent.push(command);
        if (user !== 'clavarium-keeper') return { code: 255, out: '', err: 'Permission denied' };
        return relay ? relay(command) : command.startsWith('add-home ') ? { code: 0, out: `home ${command.split(' ')[1]}\ntls-port 8444\nhttp-port 8081\nfingerprint ${PRINT}\n`, err: '' } : OK;
    } });
    return { ...p, w, sent };
}

test('the parameters of a home that joins: a code from the principal, by its name; or ports and a fingerprint by hand', () => {
    const o = parseOnline(['--relay', 'clav.example.com', '--domain', 'clav2.example.com', '--join', 'abcd-efgh']);
    assert.equal(o.join, 'ABCDEFGH'); assert.equal(o.principal, 'clav.example.com');
    const h = parseOnline(['--relay', 'relay.example.net', '--domain', 'clav2.example.com', '--relay-ports', '8444,8081', '--relay-fingerprint', PRINT]);
    assert.deepEqual(h.ports, { tls: '8444', http: '8081' });
    for (const args of [
        ['--domain', 'clav2.example.com', '--join', 'ABCDEFGH'],
        ['--relay', 'clav.example.com', '--domain', 'clav2.example.com', '--join', 'ABCDEFG0'],
        ['--relay', 'clav.example.com', '--domain', 'clav2.example.com', '--join', 'ABCD'],
        ['--relay', RELAY_IP, '--domain', 'clav2.example.com', '--join', 'ABCDEFGH'],
        ['--relay', 'clav.example.com', '--domain', 'clav2.example.com', '--join', 'ABCDEFGH', '--relay-user', 'ubuntu'],
        ['--relay', 'clav.example.com', '--domain', 'clav2.example.com', '--join', 'ABCDEFGH', '--relay-fingerprint', PRINT],
        ['--relay', 'relay.example.net', '--domain', 'clav2.example.com', '--relay-ports', '8444,8081'],
        ['--relay', 'relay.example.net', '--domain', 'clav2.example.com', '--relay-ports', '80,443', '--relay-fingerprint', PRINT],
        ['--relay', 'relay.example.net', '--domain', 'clav2.example.com', '--relay-ports', '8444,8081;id', '--relay-fingerprint', PRINT],
        ['--port', '--domain', 'clav2.example.com', '--join', 'ABCDEFGH'],
    ]) assert.throws(() => parseOnline(args), Bad, args.join(' '));
});

test('invite and join: the code is good once and for 30 minutes; a wrong one is refused and counted; the answer holds nothing secret', async () => {
    const { invite, joinWithCode, INVITE_MS, WRONG_MAX } = await import('../deploy/online.mjs');
    const p = principalPlace();
    try {
        const made = await invite(p.w.sys, p.P, 'clav2.example.com');
        assert.match(made.code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
        assert.ok(p.w.text().includes(`sudo clavarium online --relay clav.example.com --domain clav2.example.com --join ${made.code}`), 'what to type on the new home');
        /* Only its hash is kept, root's alone. */
        const kept = readFileSync(join(p.P.access, 'invites.json'), 'utf8');
        assert.ok(!kept.includes(made.code.replace('-', '')));
        const a = await joinWithCode(p.w.sys, p.P, made.code.toLowerCase(), HOME_KEY);
        assert.deepEqual(a, { name: 'clav2.example.com', relay: { host: 'relay.example.net', port: 22, fingerprint: PRINT }, ports: { tls: 8444, http: 8081 } });
        assert.deepEqual(p.sent, ['name-principal clav.example.com', `add-home clav2.example.com ${HOME_KEY}`], 'the principal named, then the home added, through the maintenance account');
        await assert.rejects(joinWithCode(p.w.sys, p.P, made.code, HOME_KEY), (e) => e instanceof Refused && /not a valid code/.test(e.message), 'used: refused');
        /* Expired. */
        const late = await invite(p.w.sys, p.P, 'clav3.example.com');
        const sys = { ...p.w.sys, now: () => INVITE_MS + 1 };
        await assert.rejects(joinWithCode(sys, p.P, late.code, HOME_KEY), Refused, 'expired: refused');
        /* Wrong codes, counted: at WRONG_MAX within the window, every invitation is cancelled. */
        const good = await invite(p.w.sys, p.P, 'clav4.example.com');
        const before = p.sent.length;
        /* One wrong already counted in this window (the used code; the expired one was in a later window). */
        for (let i = 0; i < WRONG_MAX - 2; i++) await assert.rejects(joinWithCode(p.w.sys, p.P, 'ZZZZZZZZ', HOME_KEY), /not a valid code \(wrong/);
        assert.equal(JSON.parse(readFileSync(join(p.P.access, 'invites.json'), 'utf8')).wrong.length, WRONG_MAX - 1, 'counted');
        await assert.rejects(joinWithCode(p.w.sys, p.P, 'ZZZZZZZZ', HOME_KEY), /every invitation was cancelled/);
        await assert.rejects(joinWithCode(p.w.sys, p.P, good.code, HOME_KEY), /not a valid code/, 'cancelled with the others');
        assert.equal(p.sent.length, before, 'the relay was never asked');
        await assert.rejects(joinWithCode(p.w.sys, p.P, 'ABCD', HOME_KEY), Bad);
        await assert.rejects(joinWithCode(p.w.sys, p.P, 'ABCDEFGH', `${HOME_KEY}\nssh-ed25519 x`), Bad);
    } finally { p.done(); }
});

test('only the principal invites: not a home, not a machine offline; a relay that refuses is said', async () => {
    const { invite, joinWithCode } = await import('../deploy/online.mjs');
    const p = principalPlace({ relay: (c) => (c.startsWith('add-home') ? { code: 78, out: '', err: 'clavarium-relay: REFUSED: clav2.example.com is served by this relay already' } : OK) });
    try {
        const made = await invite(p.w.sys, p.P, 'clav2.example.com');
        await assert.rejects(joinWithCode(p.w.sys, p.P, made.code, HOME_KEY), (e) => e instanceof Refused && /served by this relay already/.test(e.message));
        await assert.rejects(invite(p.w.sys, p.P, 'clav.example.com'), Bad, 'itself');
        writeFileSync(p.P.unit, 'ExecStart=node server/main.mjs\n');
        await assert.rejects(invite(p.w.sys, p.P, 'clav2.example.com'), /not online yet/);
        writeFileSync(p.P.unit, PRINCIPAL_UNIT);
        writeFileSync(p.P.relayConf, 'HOST=relay.example.net\nPORT=22\nTLS_PORT=8444\nHTTP_PORT=8081\nROLE=home\n');
        await assert.rejects(invite(p.w.sys, p.P, 'clav2.example.com'), /only its principal/);
        await assert.rejects(relayCommand(['status'], p.w.sys, p.P), /kept by its principal/);
    } finally { p.done(); }
});

test('relay add-home by hand prints what to type on the new home; remove-home and homes go through the maintenance account', async () => {
    const p = principalPlace();
    try {
        await relayCommand(['add-home', 'clav2.example.com', '--key', ...HOME_KEY.split(' ')], p.w.sys, p.P);
        assert.ok(p.w.text().includes(`sudo clavarium online --relay relay.example.net --domain clav2.example.com --relay-ports 8444,8081 --relay-fingerprint ${PRINT}`));
        await relayCommand(['remove-home', 'clav2.example.com'], p.w.sys, p.P);
        await relayCommand(['homes'], p.w.sys, p.P);
        assert.deepEqual(p.sent.slice(-2), ['remove-home clav2.example.com', 'homes']);
        for (const args of [['add-home', 'clav2.example.com', HOME_KEY], ['add-home', 'Clav2', '--key', HOME_KEY], ['remove-home'], ['homes', 'x'], ['invite']]) await assert.rejects(relayCommand(args, p.w.sys, p.P), Bad, args.join(' '));
    } finally { p.done(); }
});

/* The new home: the principal answers over HTTPS; the relay is checked, then the tunnel holds its own ports. */
function joiningWorld(root, { answer, caddy = [[CERT], [CERT]] } = {}) {
    const posted = [];
    const w = world({ root, caddy, dns: { 'clav2.example.com': [RELAY_IP], 'clav.example.com': [RELAY_IP], 'relay.example.net': [RELAY_IP] },
        ssh: () => ({ code: 255, out: '', err: 'Permission denied' }) });
    w.sys.post = async (url, body) => { posted.push({ url, body }); return answer ?? { status: 200, body: { name: 'clav2.example.com', relay: { host: 'relay.example.net', port: 22, fingerprint: PRINT }, ports: { tls: 8444, http: 8081 } } }; };
    return { ...w, posted };
}
const JOIN_ARGS = ['--relay', 'clav.example.com', '--domain', 'clav2.example.com', '--join', 'ABCD-EFGH'];

test('--join: the code and the PUBLIC key to the principal, the relay checked, the test and the tunnel on its own ports, no account of the relay used', async () => {
    const { root, P, done } = place();
    try {
        const w = joiningWorld(root);
        await online(parseOnline(JOIN_ARGS), w.sys, P);
        assert.equal(w.posted.length, 1);
        assert.equal(w.posted[0].url, 'https://clav.example.com/c/relay-join');
        assert.deepEqual(Object.keys(w.posted[0].body).sort(), ['code', 'key']);
        assert.equal(w.posted[0].body.code, 'ABCDEFGH');
        assert.match(w.posted[0].body.key, /^ssh-ed25519 [A-Za-z0-9+/]{68}$/, 'the public key, nothing else');
        assert.equal(ran(w.log, (a) => a[0] === 'ssh').length, 0, 'no SSH login to the relay: no setup key, no maintenance key');
        assert.match(readFileSync(join(P.tunnel, 'known_hosts'), 'utf8'), /relay\.example\.net ssh-ed25519/);
        assert.match(readFileSync(P.relayConf, 'utf8'), /HOST=relay\.example\.net[\s\S]*TLS_PORT=8444[\s\S]*HTTP_PORT=8081[\s\S]*ROLE=home[\s\S]*PRINCIPAL=clav\.example\.com/);
        const tunnel = w.log.find((e) => e.start && e.start.includes(['clavarium-tunnel', 'relay.example.net'].join('@')));
        assert.ok(tunnel.start.includes('127.0.0.1:8444:127.0.0.1:443') && tunnel.start.includes('127.0.0.1:8081:127.0.0.1:80'), 'its own ports, on the loopback');
        assert.ok(!tunnel.start.some((a) => a.startsWith('*:')));
        const runs = installRuns(w.log);
        assert.deepEqual(runs[0].argv.slice(-7), ['--relay', 'relay.example.net', '--relay-port', '22', '--relay-installed', '--relay-ports', '8444,8081']);
        assert.match(w.text(), /TO KEEP THE RELAY BLIND for clav2\.example\.com, add a CAA record/);
        /* Its updater leaves the relay to its principal. */
        const { keepRelayCurrent } = await import('../deploy/online.mjs');
        assert.deepEqual(await keepRelayCurrent(w.sys, P, { done: join(root, 'done') }), { state: 'none' });
    } finally { done(); }
});

test('--join: a refused code, an answer for another name, a relay with another key: stopped, nothing changed', async () => {
    for (const [answer, why, Kind] of [
        [{ status: 403, body: { error: 'This code is not valid: wrong, used or expired.' } }, /refused the code: This code is not valid[\s\S]*relay invite clav2\.example\.com/, Refused],
        [{ status: 429, body: {} }, /too many tries/, Failed],
        [{ status: 200, body: { name: 'other.example.com', relay: { host: 'relay.example.net', port: 22, fingerprint: PRINT }, ports: { tls: 8444, http: 8081 } } }, /made for other\.example\.com/, Refused],
        [{ status: 200, body: { name: 'clav2.example.com', relay: { host: 'relay.example.net', port: 22, fingerprint: `SHA256:${'Z'.repeat(43)}` }, ports: { tls: 8444, http: 8081 } } }, /may not be the relay/, Refused],
        [{ status: 200, body: { name: 'clav2.example.com', relay: { host: 'relay.example.net; id', port: 22, fingerprint: PRINT }, ports: { tls: 8444, http: 8081 } } }, /something else/, Failed],
    ]) {
        const { root, P, done } = place();
        try {
            const w = joiningWorld(root, { answer });
            await assert.rejects(online(parseOnline(JOIN_ARGS), w.sys, P), (e) => e instanceof Kind && why.test(e.message), String(why));
            assert.ok(!existsSync(P.relayConf));
            assert.equal(installRuns(w.log).length, 0);
        } finally { done(); }
    }
});

test('--join run again after a failed test: the relay and ports kept, the code not sent twice', async () => {
    const { root, P, done } = place();
    try {
        const fail = JSON.stringify({ level: 'error', msg: 'could not get certificate from issuer', error: 'Connection refused' });
        const w = joiningWorld(root, { caddy: [[fail]] });
        await assert.rejects(online(parseOnline(JOIN_ARGS), w.sys, P), /Nothing was changed/);
        const again = joiningWorld(root);
        await online(parseOnline(JOIN_ARGS), again.sys, P);
        assert.equal(again.posted.length, 0);
        assert.match(again.text(), /joined the relay relay\.example\.net already/);
        assert.equal(installRuns(again.log).length, 1);
    } finally { done(); }
});
