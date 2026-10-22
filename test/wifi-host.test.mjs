/* WI-FI, in the host program (deploy/clavarium-host, verbs "wifi ..."): run for
   real, as a plain account (--test), against a stand-in for nmcli
   (test/fake-nmcli.mjs) and for systemd-run, first and alone on PATH. Nothing
   here reaches this machine's own network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROGRAM = fileURLToPath(new URL('../deploy/clavarium-host', import.meta.url));
const FAKE_NMCLI = fileURLToPath(new URL('./fake-nmcli.mjs', import.meta.url));
const ROOT = process.getuid?.() === 0 ? 'run as root: --test is refused to root, by design' : false;
/* What the program itself needs from the system; nothing else is on PATH. */
const TOOLS = ['sed', 'head', 'date', 'mv', 'install', 'id', 'sort', 'readlink', 'rm', 'grep', 'awk', 'sleep', 'cat', 'tr', 'od', 'mktemp', 'chmod'];

const HOME = 'aaaaaaaa-0000-4000-8000-000000000001';
const OFFICE = 'aaaaaaaa-0000-4000-8000-000000000002';
/* A name with all nmcli escapes: a colon, a backslash, quotes, letters beyond ASCII. */
const ODD = 'Café: "Guest" \\ net';
const PASSWORD = 'correct horse 9';

function bench({ nmcli = true, hold = false, ...over } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'clv-wifi-'));
    const bin = join(dir, 'bin'); mkdirSync(bin);
    for (const t of TOOLS) { const at = ['/usr/bin', '/bin'].map((d) => join(d, t)).find(existsSync); if (at) symlinkSync(at, join(bin, t)); }
    symlinkSync(process.execPath, join(bin, 'node'));
    if (nmcli) symlinkSync(FAKE_NMCLI, join(bin, 'nmcli'));
    /* systemd-run: its options dropped, the command run in the background, detached from
       the caller's output (as a unit is); `hold`: recorded, never run (a switch that lasts). */
    writeFileSync(join(bin, 'systemd-run'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "$FAKE_NM/systemd-run.log"\nwhile [ "\${1:-}" != "\${1#--}" ]; do shift; done\n${hold ? 'exit 0' : '"$@" < /dev/null >> "$FAKE_NM/switch.log" 2>&1 &'}\n`);
    writeFileSync(join(bin, 'ping'), '#!/bin/bash\n[ -e "$FAKE_NM/gateway-answers" ]\n');
    chmodSync(join(bin, 'systemd-run'), 0o755); chmodSync(join(bin, 'ping'), 0o755);
    const state = {
        running: true,
        device: { name: 'wlan0', state: 'connected' },
        aps: [
            { ssid: 'Home', signal: 70, security: 'WPA2' },
            { ssid: 'Home', signal: 40, security: 'WPA2' },
            { ssid: ODD, signal: 55, security: 'WPA1 WPA2' },
            { ssid: '', signal: 90, security: 'WPA2' },
            { ssid: ' Spaced ', signal: 30, security: '' },
            { ssid: 'Office', signal: 62, security: 'WPA3' },
            { ssid: 'Corp', signal: 80, security: 'WPA2 802.1X' },
            { ssid: 'Old', signal: 20, security: 'WEP' },
        ],
        profiles: [{ uuid: HOME, name: 'Home', ssid: 'Home', keyMgmt: 'wpa-psk', psk: 'home-secret', autoconnect: true },
            { uuid: OFFICE, name: 'Office', ssid: 'Office', keyMgmt: 'sae', psk: 'office-secret', autoconnect: true }],
        active: HOME,
        passwords: { [ODD]: PASSWORD, Home: 'home-secret' },
        online: {},
        gateway: {},
        ...over,
    };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const host = (args, input = '') => {
        const r = spawnSync('/bin/bash', [PROGRAM, '--test', dir, ...args], { input, encoding: 'utf8', env: { PATH: bin, FAKE_NM: dir } });
        return { code: r.status, out: r.stdout, err: r.stderr };
    };
    const now = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const calls = () => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    /* The switch runs in the background: its outcome, once it is recorded. */
    const outcome = async () => {
        for (let i = 0; i < 150; i++) {
            const out = host(['wifi', 'status']).out;
            if (/^last (?!joining)/m.test(out)) return out;
            await new Promise((ok) => setTimeout(ok, 100));
        }
        throw new Error('the switch never ended');
    };
    /* NetworkManager's connection files, as --test redirects them: name -> { text, mode }. */
    const keyfiles = () => {
        const at = join(dir, 'system-connections');
        if (!existsSync(at)) return {};
        return Object.fromEntries(readdirSync(at).map((f) => [f, { text: readFileSync(join(at, f), 'utf8'), mode: statSync(join(at, f)).mode & 0o777 }]));
    };
    return { dir, host, now, calls, outcome, keyfiles, done: () => rmSync(dir, { recursive: true, force: true }) };
}
/* Everything written under the bench, but the stand-in's own log and state (which play nmcli's
   store) and NetworkManager's connection files (looked at apart). */
const written = (dir) => readdirSync(dir, { recursive: true }).filter((f) => !['calls.log', 'state.json'].includes(String(f)) && !String(f).startsWith('bin') && !String(f).startsWith('system-connections')).map((f) => { try { return readFileSync(join(dir, String(f)), 'utf8'); } catch { return ''; } }).join('\n');
/* An SSID as a keyfile list of bytes. */
const bytesOf = (ssid) => `${[...Buffer.from(ssid, 'utf8')].join(';')};`;

test('status: the device, the network in use with its signal, the networks kept', { skip: ROOT }, () => {
    const b = bench();
    const r = b.host(['wifi', 'status']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'nmcli yes\ndevice wlan0\nusing 70 Home\nsaved Home\nsaved Office\n');
    b.done();
});

test('scan: one line per name, its strongest, escapes undone, hidden ones left out, the strongest first', { skip: ROOT }, () => {
    const b = bench();
    const r = b.host(['wifi', 'scan']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.split('\n').filter(Boolean), [
        'network 80 enterprise other Corp',
        'network 70 wpa now Home',
        'network 62 wpa3 other Office',
        `network 55 wpa other ${ODD}`,
        'network 30 open other  Spaced ',
        'network 20 wep other Old',
    ]);
    assert.ok(b.calls().some((c) => c.argv.join(' ').includes('device wifi list ifname wlan0 --rescan yes')), 'looked for again');
    b.done();
});

test('join: a network that works is kept; the password only in a keyfile of its own, root\'s and 0600, named from its uuid', { skip: ROOT }, async () => {
    const b = bench();
    const r = b.host(['wifi', 'join'], `${ODD}\n${PASSWORD}\n`);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `joining ${ODD}\nfallback Home\n`);
    const out = await b.outcome();
    assert.match(out, /^last joined \d+$/m);
    assert.match(out, new RegExp(`^lastssid ${ODD.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`, 'm'));
    assert.match(out, /^using 55 Café/m);
    const s = b.now();
    const made = s.profiles.find((p) => p.ssid === ODD);
    assert.equal(s.active, made.uuid);
    assert.equal(made.psk, PASSWORD);
    assert.equal(made.keyMgmt, 'wpa-psk');
    assert.equal(made.autoconnect, true, 'saved for good once it worked');
    assert.ok(s.profiles.some((p) => p.uuid === HOME), 'the one before is still kept');
    /* The keyfile: named from the uuid, 0600, the SSID as bytes, the password in it. */
    const files = b.keyfiles();
    assert.deepEqual(Object.keys(files), [`clavarium-wifi-${made.uuid}.nmconnection`], 'one file, named from its uuid; no temporary file left');
    const { text, mode } = files[`clavarium-wifi-${made.uuid}.nmconnection`];
    assert.equal(mode, 0o600);
    assert.match(text, new RegExp(`^\\[connection\\]\nid=clavarium-wifi-\\d+\nuuid=${made.uuid}\ntype=wifi\ninterface-name=wlan0\nautoconnect=false\n`));
    assert.ok(text.includes(`[wifi]\nmode=infrastructure\nssid=${bytesOf(ODD)}\n`), text);
    assert.ok(text.includes(`[wifi-security]\nkey-mgmt=wpa-psk\npsk=${PASSWORD}\n`));
    assert.ok(text.includes('[ipv4]\nmethod=auto\n') && text.includes('[ipv6]\nmethod=auto\n'));
    assert.ok(!text.includes(ODD), 'the SSID only as its bytes');
    /* Never in an argument of anything, never on a standard input, never printed, nowhere else. */
    const all = b.calls();
    assert.ok(all.every((c) => !c.argv.join(' ').includes(PASSWORD) && !c.stdin.includes(PASSWORD)), 'not in an argument of nmcli, nor on its input');
    assert.ok(all.some((c) => c.argv.join(' ') === `connection load ${join(b.dir, 'system-connections', `clavarium-wifi-${made.uuid}.nmconnection`)}`), 'loaded from its file');
    assert.ok(all.some((c) => c.argv.join(' ') === `connection modify uuid ${made.uuid} connection.autoconnect yes`), 'kept for good once it worked');
    assert.ok(!readFileSync(join(b.dir, 'systemd-run.log'), 'utf8').includes(PASSWORD), 'not in the unit\'s command');
    assert.ok(!`${r.out}${r.err}${out}`.includes(PASSWORD), 'never printed');
    assert.ok(!written(b.dir).includes(PASSWORD), 'never written in a file of its own');
    assert.match(readFileSync(join(b.dir, 'systemd-run.log'), 'utf8'), /--unit=clavarium-wifi-join --collect .* wifi switch$/m);
    b.done();
});

test('join: no working network within the wait -> the new one deleted, the one before up again, said', { skip: ROOT }, async () => {
    const b = bench({ online: { [ODD]: 'none' } });
    const started = Date.now();
    assert.equal(b.host(['wifi', 'join'], `${ODD}\n${PASSWORD}\n`).code, 0);
    const out = await b.outcome();
    assert.match(out, /^last went-back \d+$/m);
    assert.match(out, /^lastwhy no-internet$/m);
    assert.match(out, /^lastback Home$/m);
    const s = b.now();
    assert.equal(s.active, HOME, 'back on the network it left');
    assert.ok(!s.profiles.some((p) => p.ssid === ODD), 'the new network is not kept');
    const loaded = b.calls().find((x) => x.argv[1] === 'load').argv[2];
    const uuid = /clavarium-wifi-([0-9a-f-]{36})\.nmconnection$/.exec(loaded)[1];
    assert.ok(b.calls().some((c) => c.argv.join(' ') === `connection delete uuid ${uuid}`));
    assert.deepEqual(b.keyfiles(), {}, 'its file is gone, and its password with it');
    /* Waits of seconds in the tests (a minute on a server): it did wait, and not for ever. */
    assert.ok(Date.now() - started >= 2500 && Date.now() - started < 14_000, String(Date.now() - started));
    b.done();
});

test('join: NetworkManager not checking by itself, the gateway answering will do; not answering, back', { skip: ROOT }, async () => {
    const b = bench({ online: { [ODD]: 'unknown' }, gateway: { [ODD]: '127.0.0.1' } });
    writeFileSync(join(b.dir, 'gateway-answers'), '');
    b.host(['wifi', 'join'], `${ODD}\n${PASSWORD}\n`);
    assert.match(await b.outcome(), /^last joined/m);
    b.done();
    const c = bench({ online: { [ODD]: 'unknown' }, gateway: { [ODD]: '127.0.0.1' } });
    c.host(['wifi', 'join'], `${ODD}\n${PASSWORD}\n`);
    assert.match(await c.outcome(), /^last went-back/m);
    assert.equal(c.now().active, HOME);
    c.done();
});

test('join: a wrong password -> back at once, and said as such', { skip: ROOT }, async () => {
    const b = bench();
    assert.equal(b.host(['wifi', 'join'], `${ODD}\nnot the password\n`).code, 0);
    const out = await b.outcome();
    assert.match(out, /^last went-back/m);
    assert.match(out, /^lastwhy password$/m);
    assert.equal(b.now().active, HOME);
    assert.ok(!b.now().profiles.some((p) => p.ssid === ODD));
    assert.deepEqual(b.keyfiles(), {});
    b.done();
});

test('join: an open network, and a WPA3-only one, each the way it wants; spaces and a backslash written as the keyfile format wants', { skip: ROOT }, async () => {
    const b = bench({ active: null });
    assert.equal(b.host(['wifi', 'join'], ' Spaced \n\n').out, 'joining  Spaced \nfallback \n');
    assert.match(await b.outcome(), /^last joined/m);
    const open = b.now().profiles.find((p) => p.ssid === ' Spaced ');
    assert.equal(open.keyMgmt, null); assert.equal(open.psk, null);
    const [file] = Object.values(b.keyfiles());
    assert.ok(file.text.includes('ssid=32;83;112;97;99;101;100;32;\n'), 'spaces at its ends kept, as bytes');
    assert.ok(!file.text.includes('[wifi-security]'), 'no password, no security section');
    b.done();
    /* A backslash in a keyfile value starts an escape: written doubled, read back whole. */
    const pass = 'back\\slash; "quoted"';
    const c = bench({ profiles: [], active: null, passwords: { Office: pass } });
    c.host(['wifi', 'join'], `Office\n${pass}\n`);
    assert.match(await c.outcome(), /^last joined/m);
    const office = c.now().profiles.find((p) => p.ssid === 'Office');
    assert.equal(office.keyMgmt, 'sae'); assert.equal(office.psk, pass);
    assert.ok(Object.values(c.keyfiles())[0].text.includes('key-mgmt=sae\npsk=back\\\\slash; "quoted"\n'));
    c.done();
});

test('join refuses what is not a network name or a password, and says what is wrong, never the password', { skip: ROOT }, () => {
    const b = bench();
    const cases = [
        ['', 'x'.repeat(10)], ['a'.repeat(33), 'x'.repeat(10)], ['é'.repeat(17), 'x'.repeat(10)], ['tab\there', 'x'.repeat(10)],
        [ODD, 'short7!'], [ODD, 'y'.repeat(64)], [ODD, 'tab\tinside1'], [ODD, 'naïve-password'], [ODD, ' leading-space'],
        [ODD, ''], ['Home', 'home-secret'], [' Spaced ', 'a-password'], ['Corp', 'a-password'], ['Old', 'a-password'], ['Nowhere', 'a-password'],
    ];
    for (const [ssid, password] of cases) {
        const r = b.host(['wifi', 'join'], `${ssid}\n${password}\n`);
        assert.equal(r.code, 78, `${JSON.stringify(ssid)}: ${r.code} ${r.err}`);
        assert.equal(r.out, '');
        if (password.length > 3) assert.ok(!r.err.includes(password), `the password in a refusal: ${r.err}`);
    }
    assert.match(b.host(['wifi', 'join'], 'Home\nhome-secret\n').err, /in use already/);
    assert.match(b.host(['wifi', 'join'], 'Corp\na-password\n').err, /802\.1X/);
    assert.match(b.host(['wifi', 'join'], `${ODD}\n\n`).err, /password is needed/);
    /* 16 letters of two bytes each: 32 bytes, the most a name may have. Arguments: none. */
    assert.equal(b.host(['wifi', 'join', 'Home'], '').code, 64);
    assert.ok(!b.calls().some((c) => c.argv[0] === 'connection' && ['load', 'up', 'delete'].includes(c.argv[1])), 'nothing changed');
    assert.deepEqual(b.keyfiles(), {}, 'nothing written');
    assert.ok(!existsSync(join(b.dir, 'systemd-run.log')));
    b.done();
});

test('join: one switch at a time', { skip: ROOT }, () => {
    const b = bench({ hold: true });
    assert.equal(b.host(['wifi', 'join'], `${ODD}\n${PASSWORD}\n`).code, 0);
    assert.match(b.host(['wifi', 'status']).out, /^last joining \d+$/m);
    const again = b.host(['wifi', 'join'], 'Office\noffice-secret\n');
    assert.equal(again.code, 78); assert.match(again.err, /going on already/);
    assert.equal(b.host(['wifi', 'forget', 'Office']).code, 78);
    /* The switch's own verb does that switch, and only once. */
    assert.equal(b.host(['wifi', 'switch', 'x']).code, 64);
    b.done();
    const c = bench();
    assert.match(c.host(['wifi', 'switch']).err, /no switch was asked/);
    c.done();
});

test('forget: a kept network deleted, never the one in use, never one not kept', { skip: ROOT }, () => {
    const b = bench();
    const inUse = b.host(['wifi', 'forget', 'Home']);
    assert.equal(inUse.code, 78); assert.match(inUse.err, /in use: join another one first/);
    assert.ok(b.now().profiles.some((p) => p.uuid === HOME));
    assert.equal(b.host(['wifi', 'forget', 'Nowhere']).code, 78);
    for (const bad of ['', 'a'.repeat(33), 'new\nline']) assert.equal(b.host(['wifi', 'forget', bad]).code, 78, JSON.stringify(bad));
    assert.equal(b.host(['wifi', 'forget']).code, 64);
    const r = b.host(['wifi', 'forget', 'Office']);
    assert.equal(r.code, 0, r.err); assert.equal(r.out, 'forgotten Office\n');
    assert.deepEqual(b.now().profiles.map((p) => p.uuid), [HOME]);
    b.done();
});

test('no nmcli, no Wi-Fi device, a device NetworkManager does not drive: said, and nothing done', { skip: ROOT }, () => {
    const none = bench({ nmcli: false });
    assert.equal(none.host(['wifi', 'status']).out, 'nmcli no\nwifiwhy no-nmcli\n');
    for (const args of [['wifi', 'scan'], ['wifi', 'forget', 'Home']]) assert.match(none.host(args).err, /managed outside Clavarium/);
    assert.equal(none.host(['wifi', 'join'], 'Home\nhome-secret\n').code, 78);
    none.done();
    const nodev = bench({ device: null, active: null });
    assert.equal(nodev.host(['wifi', 'status']).out, 'nmcli yes\nwifiwhy no-device\n');
    assert.equal(nodev.host(['wifi', 'scan']).code, 78);
    nodev.done();
    const unmanaged = bench({ device: { name: 'wlp2s0', state: 'unmanaged' } });
    assert.equal(unmanaged.host(['wifi', 'status']).out, 'nmcli yes\ndevice wlp2s0\nwifiwhy unmanaged\n');
    assert.match(unmanaged.host(['wifi', 'join'], 'Home\nhome-secret\n').err, /not managed by NetworkManager/);
    unmanaged.done();
    const stopped = bench({ running: false });
    assert.equal(stopped.host(['wifi', 'status']).out, 'nmcli yes\nwifiwhy not-running\n');
    stopped.done();
});

test('say-only: what would run, without the password; --test is not for say-only', () => {
    const say = (args, input = '') => spawnSync('/bin/bash', [PROGRAM, '--say-only', '--data', '/var/lib/clavarium', ...args], { input, encoding: 'utf8' });
    const r = say(['wifi', 'join'], `Home\n${PASSWORD}\n`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^write \/etc\/NetworkManager\/system-connections\/clavarium-wifi-<uuid>\.nmconnection \(root, 0600: ssid Home, autoconnect=false, key-mgmt <wpa-psk\|sae>, its password\)$/m);
    assert.match(r.stdout, /^nmcli connection load \/etc\/NetworkManager\/system-connections\/clavarium-wifi-<uuid>\.nmconnection$/m);
    assert.match(r.stdout, /systemd-run --unit=clavarium-wifi-join --collect clavarium-host wifi switch/);
    assert.ok(!r.stdout.includes(PASSWORD));
    assert.match(say(['wifi', 'status']).stdout, /read-only/);
    assert.equal(say(['wifi', 'join'], `${'é'.repeat(16)}\n${PASSWORD}\n`).status, 0, '32 bytes');
    assert.equal(say(['wifi', 'join'], `${'é'.repeat(17)}\n${PASSWORD}\n`).status, 78, '34 bytes');
    assert.equal(say(['wifi', 'reboot']).status, 78);
    assert.equal(spawnSync('/bin/bash', [PROGRAM, '--say-only', '--test', '/tmp/x', 'wifi', 'status'], { encoding: 'utf8' }).status, 78);
    assert.equal(spawnSync('/bin/bash', [PROGRAM, '--test', 'relative', 'wifi', 'status'], { encoding: 'utf8' }).status, 78);
});
