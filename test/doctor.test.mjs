/* `clavarium doctor`: what works, what does not, what to do; --fix; the
   certificate Caddy made itself replaced by Let's Encrypt's; a new password. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose, doctor, certificateWatch, newPassword, installWatch, WATCH_TIMER } from '../deploy/doctor.mjs';

const ip = (...p) => p.join('.');
const RELAY_IP = ip(203, 0, 113, 7);
const D = 'clav.example.com';
const PEM = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
const LE = { issuer: 'C = US, O = Let\'s Encrypt, CN = R11', code: '0 (ok)' };
const LOCAL = { issuer: 'CN = Caddy Local Authority - ECC Intermediate', code: '21 (unable to verify the first certificate)' };

function place({ server = true, relay = true } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'clavarium-doctor-'));
    const P = { unit: join(root, 'clavarium.service'), relayConf: join(root, 'relay.conf'), caddyfile: join(root, 'Caddyfile'), caddyData: join(root, 'caddy'),
        dexConf: join(root, 'dex.yaml'), caddy: '/bin/caddy', systemd: join(root, 'systemd') };
    mkdirSync(P.systemd);
    writeFileSync(P.unit, `ExecStart=node server/main.mjs --port 7717${server ? ` --operators a --public-origin https://${D}` : ''}\n`);
    if (relay) writeFileSync(P.relayConf, `HOST=${RELAY_IP}\nPORT=22\n`);
    return { root, P, done: () => rmSync(root, { recursive: true, force: true }) };
}
function world({ cert = LE, down = [], dns = { [D]: [RELAY_IP] }, days = 60 } = {}) {
    const printed = []; const log = []; let t = Date.parse('2026-10-18T12:00:00Z');
    const state = { cert };
    const sys = {
        print: (s) => printed.push(s), now: () => t, sleep: async (ms) => { t += ms; },
        resolve: async (n) => dns[n] ?? [],
        run: async (argv, opts = {}) => {
            log.push(argv);
            if (argv[0] === 'systemctl' && argv[1] === 'is-active') return { code: 0, out: down.includes(argv[2]) ? 'failed\n' : 'active\n', err: '' };
            if (argv[0] === 'systemctl' && argv[1] === 'restart') { if (argv[2] === 'caddy' && state.after) state.cert = state.after; down.splice(down.indexOf(argv[2]) >>> 0, down.includes(argv[2]) ? 1 : 0); }
            if (argv[0] === 'openssl' && argv[1] === 's_client') return state.cert ? { code: 0, out: `${PEM}\nVerify return code: ${state.cert.code}\n`, err: '' } : { code: 1, out: '', err: 'connect: Connection refused' };
            if (argv[0] === 'openssl' && argv[1] === 'x509') return { code: 0, out: `issuer=${state.cert.issuer}\nnotAfter=${new Date(t + days * 86_400_000).toUTCString()}\n`, err: '' };
            if (argv[0] === 'openssl' && argv[1] === 'rand') return { code: 0, out: 'abcdefghijklmnop+/qrstuvwx\n', err: '' };
            if (argv[0] === '/bin/caddy') return { code: 0, out: `$2a$14$${'x'.repeat(53)}\n`, err: '' };
            if (argv[0] === 'journalctl') return { code: 0, out: `${JSON.stringify({ level: 'error', msg: 'could not get certificate from issuer', error: 'connection refused' })}\n`, err: '' };
            return { code: 0, out: '', err: '' };
        },
    };
    return { sys, printed, log, state, text: () => printed.join('\n') };
}

test('everything works: said in one line per check', async () => {
    const { P, done } = place();
    try {
        const w = world();
        assert.equal(await doctor(w.sys, {}, P), 0);
        assert.match(w.text(), /Diagnosis: everything works/);
        for (const u of ['clavarium', 'caddy', 'dex', 'oauth2-proxy', 'clavarium-tunnel']) assert.match(w.text(), new RegExp(`ok  service ${u}: running`));
        assert.match(w.text(), /ok  certificate: from .*Let's Encrypt.*, 60 days left/);
    } finally { done(); }
});

test('local mode: only the service, no certificate', async () => {
    const { P, done } = place({ server: false, relay: false });
    try {
        const checks = await diagnose(world().sys, P);
        assert.deepEqual(checks.map((c) => c.what), ['service clavarium', 'mode']);
    } finally { done(); }
});

test('a certificate Caddy made itself: said, with why and what to do; --fix drops it and Caddy asks Let\'s Encrypt again', async () => {
    const { P, done } = place();
    try {
        mkdirSync(join(P.caddyData, 'certificates', 'local', D), { recursive: true });
        const w = world({ cert: LOCAL, down: ['dex'] });
        assert.equal(await doctor(w.sys, {}, P), 2);
        assert.match(w.text(), /NO  certificate: made by Caddy itself.*Caddy's last error: could not get certificate from issuer: connection refused/);
        assert.match(w.text(), /what to do: .*sudo clavarium doctor --fix/);
        assert.match(w.text(), /NO  service dex: not running/);
        const f = world({ cert: LOCAL, down: ['dex'] }); f.state.after = LE;
        assert.equal(await doctor(f.sys, { fix: true }, P), 0);
        assert.ok(!existsSync(join(P.caddyData, 'certificates', 'local', D)), 'the local one dropped');
        assert.ok(f.log.some((a) => a.join(' ') === 'systemctl restart caddy') && f.log.some((a) => a.join(' ') === 'systemctl restart dex'));
        assert.equal(readFileSync(join(P.systemd, 'clavarium-certificate.timer'), 'utf8'), WATCH_TIMER, 'an older install gets the timer');
        assert.match(f.text(), /Diagnosis: everything works/);
    } finally { done(); }
});

test('the name that leads elsewhere than the relay, and a certificate about to expire', async () => {
    const { P, done } = place();
    try {
        const w = world({ dns: { [D]: [ip(198, 51, 100, 9)] }, days: 3 });
        await doctor(w.sys, {}, P);
        assert.match(w.text(), /NO  the name clav\.example\.com: leads to .*\n\s+what to do: make clav\.example\.com lead to the relay/);
        assert.match(w.text(), /NO  certificate: from .*, 3 days left/);
    } finally { done(); }
});

test('every 20 minutes: nothing while the certificate is public; a local one is dropped and Caddy restarted', async () => {
    const { P, done } = place();
    try {
        const ok = world();
        await certificateWatch(ok.sys, P);
        assert.ok(!ok.log.some((a) => a[0] === 'systemctl' && a[1] === 'restart'), 'nothing done');
        const bad = world({ cert: LOCAL });
        await certificateWatch(bad.sys, P);
        assert.ok(bad.log.some((a) => a.join(' ') === 'systemctl restart caddy'));
        assert.match(WATCH_TIMER, /OnUnitActiveSec=20min/, 'under Let\'s Encrypt\'s 5 failed validations an hour');
        assert.equal(await installWatch(ok.sys, P), true); assert.equal(await installWatch(ok.sys, P), false, 'written once');
    } finally { done(); }
});

test('a new password: only for an administrator, the hash replaced in place, Dex restarted, shown once', async () => {
    const { P, done } = place();
    try {
        const conf = `staticPasswords:\n  - email: "a@example.com"\n    hash: "$2a$10$old"\n    username: "a"\n  - email: "b@example.com"\n    hash: "$2a$10$keep"\n`;
        writeFileSync(P.dexConf, conf);
        const w = world();
        await newPassword(w.sys, 'a@example.com', P);
        const now = readFileSync(P.dexConf, 'utf8');
        assert.match(now, /email: "a@example\.com"\n {4}hash: "\$2a\$14\$x{53}"/);
        assert.match(now, /\$2a\$10\$keep/);
        assert.ok(w.log.some((a) => a.join(' ') === 'systemctl restart dex'));
        assert.match(w.text(), /abcdefghijklmnop-_qrstuvwx/);
        await assert.rejects(newPassword(w.sys, 'c@example.com', P), /not an administrator/);
        await assert.rejects(newPassword(w.sys, 'x; id', P), /usage/);
    } finally { done(); }
});
