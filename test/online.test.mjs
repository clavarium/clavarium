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
import { parseOnline, online, showKeys, relayCommand, explain, isPrivate, checkDns, Bad, Refused, Failed } from '../deploy/online.mjs';

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
        updateConf: join(root, 'etc', 'update.conf'), unit: join(root, 'clavarium.service'), code: join(root, 'code'), caddy: join(root, 'caddy'),
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
    const r = parseOnline(['--relay', 'relay.example.net', '--domain', 'clav.example.com']);
    assert.equal(r.user, 'root'); assert.equal(r.relayPort, '22'); assert.equal(r.admin, ['admin', 'clav.example.com'].join('@'));
    assert.equal(parseOnline(['--port', '--domain', 'clav.example.com', '--admin', 'you@example.com']).admin, 'you@example.com');
    for (const args of [
        ['--domain', 'clav.example.com'],
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
        await online(parseOnline(['--port', '--domain', 'clav.example.com']), w.sys, P);
        const starts = w.log.filter((e) => e.start);
        assert.equal(starts.length, 2);
        const runs = installRuns(w.log);
        assert.equal(runs.length, 1);
        assert.deepEqual(runs[0].argv.slice(2), ['--keep-release', '--domain', 'clav.example.com', '--operator', ['admin', 'clav.example.com'].join('@'), '--port', '7717']);
        assert.ok(w.log.indexOf(starts[1]) < w.log.indexOf(runs[0]), 'the test comes first');
        assert.match(w.text(), /Online: https:\/\/clav\.example\.com/);
        assert.equal(readdirLeft(root), 0, 'the test leaves nothing behind');
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
        assert.match(setup.command, /^sudo -n bash -c '.*cat > "\$f"; bash "\$f" "\$@" <\/dev\/null.*' relay\.sh --key 'ssh-ed25519 \S+ clavarium-tunnel' --keeper-key 'ssh-ed25519 \S+ clavarium-keeper'$/);
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
