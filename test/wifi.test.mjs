/* This server's Wi-Fi, from Settings (server/wifi.mjs), with a stand-in for the host program. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Wifi, readStatus, readScan, nameOk, passwordWhy } from '../server/wifi.mjs';
import { handleApi } from '../server/api.mjs';
import { Events } from '../server/events.mjs';

const STATUS = 'nmcli yes\ndevice wlan0\nusing 70 Home sweet: "home"\nsaved Home sweet: "home"\nsaved  Spaced \nlast went-back 1792000000\nlastssid Café\nlastback Home sweet: "home"\nlastwhy no-internet\njunk line\nusing x y\n';
const SCAN = 'network 80 enterprise other Corp\nnetwork 70 wpa now Home sweet: "home"\nnetwork 30 open other  Spaced \nnetwork 101x wpa other Bad\nnot a network\n';

function bench({ answers = {} } = {}) {
    const asked = [];
    const host = async (argv, options = {}) => {
        asked.push({ argv, input: options.input });
        const key = argv.slice(0, 2).join(' ');
        if (answers[key]) return answers[key](argv, options);
        if (key === 'wifi status') return { code: 0, stdout: STATUS, stderr: '' };
        if (key === 'wifi scan') return { code: 0, stdout: SCAN, stderr: '' };
        if (key === 'wifi join') return { code: 0, stdout: `joining ${options.input.split('\n')[0]}\nfallback Home sweet: "home"\n`, stderr: '' };
        if (key === 'wifi forget') return { code: 0, stdout: `forgotten ${argv[2]}\n`, stderr: '' };
        return { code: 64, stdout: '', stderr: 'usage' };
    };
    return { host, asked };
}

test('status and scan read only the lines of the expected shapes; names whole, spaces included', async () => {
    const { host } = bench();
    const w = new Wifi({ host });
    assert.deepEqual(await w.status(), {
        available: true, why: null, device: 'wlan0', using: { signal: 70, ssid: 'Home sweet: "home"' }, saved: ['Home sweet: "home"', ' Spaced '],
        last: { state: 'went-back', at: new Date(1792000000 * 1000).toISOString(), ssid: 'Café', back: 'Home sweet: "home"', why: 'no-internet' },
    });
    assert.deepEqual(await w.scan(), [
        { ssid: 'Corp', signal: 80, security: 'enterprise', inUse: false },
        { ssid: 'Home sweet: "home"', signal: 70, security: 'wpa', inUse: true },
        { ssid: ' Spaced ', signal: 30, security: 'open', inUse: false },
    ]);
});

test('not available: said why (no nmcli, a device NetworkManager does not drive, the host not answering)', async () => {
    assert.deepEqual(readStatus('nmcli no\nwifiwhy no-nmcli\n'), { available: false, why: 'no-nmcli', device: null, using: null, saved: [], last: null });
    assert.equal(readStatus('nmcli yes\ndevice wlp2s0\nwifiwhy unmanaged\n').available, false);
    assert.equal(readStatus('nmcli yes\nwifiwhy no-device\n').why, 'no-device');
    const w = new Wifi({ host: async () => ({ code: 78, stdout: '', stderr: 'REFUSED: unknown verb: wifi status' }) });
    const s = await w.status();
    assert.equal(s.available, false); assert.equal(s.why, 'unreadable'); assert.match(s.said, /unknown verb/);
    await assert.rejects(new Wifi({ host: async () => ({ code: 78, stdout: '', stderr: 'REFUSED: NetworkManager has no Wi-Fi device on this server' }) }).scan(), /no Wi-Fi device/);
    assert.deepEqual(readScan(''), []);
});

test('join: the name and the password on standard input, never as arguments; refused here before the host is asked', async () => {
    const { host, asked } = bench();
    const w = new Wifi({ host, watchEveryMs: 60_000 });
    assert.deepEqual(await w.join('Café', 'a long password'), { started: true, ssid: 'Café', back: 'Home sweet: "home"' });
    assert.deepEqual(asked.at(-1), { argv: ['wifi', 'join'], input: 'Café\na long password\n' });
    assert.deepEqual((await w.join(' Spaced ', '')).ssid, ' Spaced ');
    const before = asked.length;
    for (const [ssid, password, why] of [['', 'a long password', /network name/], ['a'.repeat(33), 'a long password', /network name/], ['é'.repeat(17), 'a long password', /network name/], ['two\nlines', 'a long password', /network name/],
        ['Café', 'short', /8 to 63/], ['Café', 'x'.repeat(64), /8 to 63/], ['Café', 'naïve password', /plain characters/], ['Café', 'new\nline here', /plain characters/], ['Café', ' spaced password', /starts or ends/], [42, 'a long password', /network name/]]) {
        await assert.rejects(w.join(ssid, password), why, JSON.stringify([ssid, password]));
    }
    assert.equal(asked.length, before, 'the host was not asked');
    assert.equal(nameOk('é'.repeat(16)), true, '32 bytes');
    assert.equal(passwordWhy(''), '');
});

test('join and forget refused by the host: its reason, as it said it', async () => {
    const { host } = bench({ answers: {
        'wifi join': () => ({ code: 78, stdout: '', stderr: 'REFUSED: Corp asks for a user and a certificate (802.1X), which are not given from here\n' }),
        'wifi forget': () => ({ code: 78, stdout: '', stderr: 'REFUSED: Home is the network in use: join another one first\n' }),
    } });
    const w = new Wifi({ host });
    await assert.rejects(w.join('Corp', 'a long password'), (e) => e.status === 409 && /802\.1X/.test(e.message));
    await assert.rejects(w.forget('Home'), (e) => e.status === 409 && /in use/.test(e.message));
    await assert.rejects(w.forget('a'.repeat(40)), /network name/);
});

test('the outcome of a switch is said once in What happened, whoever looks at the page', async () => {
    let state = 'last joining 1792000000\nlastssid Café\nlastback Home\n';
    const { host } = bench({ answers: { 'wifi status': () => ({ code: 0, stdout: `nmcli yes\ndevice wlan0\n${state}`, stderr: '' }) } });
    const said = [];
    const w = new Wifi({ host, said: (text) => said.push(text), watchEveryMs: 10, watchForMs: 5000 });
    await w.join('Café', 'a long password');
    await new Promise((ok) => setTimeout(ok, 50));
    assert.deepEqual(said, [], 'still joining');
    state = 'last went-back 1792000060\nlastssid Café\nlastback Home\nlastwhy password\n';
    for (let i = 0; i < 50 && !said.length; i++) await new Promise((ok) => setTimeout(ok, 10));
    assert.deepEqual(said, ['Wi-Fi: "Café" did not work (wrong password): back on "Home"']);
    await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(said.length, 1, 'said once');
});

/* One request through the API, with stand-ins: { status, body }. */
async function call(method, path, body, { wifi, events, origin = true }) {
    const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { 'content-type': 'application/json' } });
    let status; let text = '';
    const response = { writeHead: (s) => { status = s; return { end: (t) => { text = t; } }; } };
    await handleApi(request, response, { list: () => [] }, {}, undefined, () => origin, ...Array(29).fill(undefined), events, undefined, wifi);
    return { status, body: JSON.parse(text) };
}

test('the API: status and scan read, join and forget from this site only; the password said nowhere', async () => {
    const { host, asked } = bench();
    const wifi = new Wifi({ host, watchEveryMs: 60_000 });
    const events = new Events();
    const logged = []; const add = events.add.bind(events); events.add = (e) => { logged.push(e); return add(e); };
    assert.equal((await call('GET', '/api/wifi', undefined, { wifi, events })).body.device, 'wlan0');
    assert.equal((await call('GET', '/api/wifi/scan', undefined, { wifi, events })).body.length, 3);
    const joined = await call('POST', '/api/wifi/join', { ssid: 'Café', password: 'a long password' }, { wifi, events });
    assert.equal(joined.status, 202);
    assert.ok(!JSON.stringify(joined.body).includes('a long password'));
    assert.deepEqual(logged.map((e) => e.text), ['Wi-Fi: joining "Café" asked']);
    assert.equal((await call('POST', '/api/wifi/forget', { ssid: 'Office' }, { wifi, events })).status, 200);
    assert.equal(logged.at(-1).text, 'Wi-Fi: "Office" forgotten');
    const n = asked.length;
    assert.equal((await call('POST', '/api/wifi/join', { ssid: 'Café', password: 'a long password' }, { wifi, events, origin: false })).status, 403);
    assert.equal(asked.length, n, 'another site is not heard');
});
