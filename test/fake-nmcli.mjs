#!/usr/bin/env node
/* A STAND-IN FOR NetworkManager's nmcli, for the tests of the Wi-Fi verbs of
   the host program (test/wifi-host.test.mjs). It answers the forms that
   program asks, in nmcli's terse shapes, from a state kept in a file; it
   escapes ':' and '\' inside values as nmcli -t does.
 *
 * State: FAKE_NM/state.json --
 *   running, device {name, state} | null, aps [{ssid, signal, security}],
 *   profiles [{uuid, name, ssid, keyMgmt, psk, autoconnect, file?}], active (a uuid) | null,
 *   passwords {ssid: the one it takes}, online {ssid: full|none|unknown...}, gateway {ssid: address}
 * Every call is appended to FAKE_NM/calls.log, one JSON line: {argv, stdin}.
 * A connection is loaded from a keyfile as NetworkManager reads one (`connection load`);
 * deleting it does NOT remove its file here: the program must see to that itself.
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env.FAKE_NM;
const file = join(DIR, 'state.json');
const state = JSON.parse(readFileSync(file, 'utf8'));
const save = () => writeFileSync(file, JSON.stringify(state, null, 1));
const args = process.argv.slice(2);
/* As the real one: under LC_ALL=C, every character outside ASCII is written '?' (seen on NetworkManager 1.46). */
const said = (text) => { if (text) process.stdout.write(`${process.env.LC_ALL === 'C' ? String(text).replace(/[^\x00-\x7f]/gu, '?') : text}\n`); };
const fail = (text, code = 10) => { process.stderr.write(`${text}\n`); process.exit(code); };

/* Nothing is ever given on its standard input: said in the log if something was. */
const stdin = process.stdin.isTTY ? '' : (() => { try { return readFileSync(0, 'utf8'); } catch { return ''; } })();
appendFileSync(join(DIR, 'calls.log'), `${JSON.stringify({ argv: args, stdin })}\n`);

/* The options before the command. */
let fields = null; let get = null; let escape = true; let i = 0;
for (; i < args.length; i++) {
    if (args[i] === '-t') continue;
    if (args[i] === '-f') { fields = args[++i].split(','); continue; }
    if (args[i] === '-g') { get = args[++i].split(','); continue; }
    if (args[i] === '-e') { escape = args[++i] !== 'no'; continue; }
    if (args[i] === '--wait') { i++; continue; }
    break;
}
const command = args.slice(i);
const esc = (v) => (escape ? String(v ?? '').replace(/\\/g, '\\\\').replace(/:/g, '\\:') : String(v ?? ''));
const row = (record, names) => names.map((n) => esc(record[n])).join(':');
const ssidOf = (uuid) => state.profiles.find((p) => p.uuid === uuid)?.ssid;
const profile = (how, value) => state.profiles.find((p) => (how === 'uuid' ? p.uuid === value : p.name === value));
const is = (...words) => words.every((w, n) => command[n] === w);
const WIRED = { UUID: '11111111-2222-3333-4444-555555555555', TYPE: '802-3-ethernet', DEVICE: 'eth0', NAME: 'Wired' };

if (is('general')) { if (state.running) said('running'); else said('stopped'); process.exit(0); }
if (is('device', 'status')) {
    const rows = [{ DEVICE: 'eth0', TYPE: 'ethernet', STATE: 'connected' }, { DEVICE: 'lo', TYPE: 'loopback', STATE: 'unmanaged' }];
    if (state.device) rows.splice(1, 0, { DEVICE: state.device.name, TYPE: 'wifi', STATE: state.device.state });
    for (const r of rows) said(row(r, fields));
    process.exit(0);
}
if (is('device', 'wifi', 'list')) {
    if (!state.device) fail('Error: No Wi-Fi device found.');
    const live = ssidOf(state.active);
    for (const ap of state.aps) said(row({ 'IN-USE': ap.ssid === live && ap.ssid !== '' ? '*' : ' ', SSID: ap.ssid, SIGNAL: ap.signal, SECURITY: ap.security }, fields));
    process.exit(0);
}
/* A device's state, for a handover (-g GENERAL.STATE): connected once netplan made NetworkManager drive it. */
if (is('device', 'show') && get?.includes('GENERAL.STATE')) { said(state.drives ? '100 (connected)' : '20 (unavailable)'); process.exit(0); }
if (is('device', 'show')) { said(state.gateway?.[ssidOf(state.active)] ?? ''); process.exit(0); }
if (is('networking', 'connectivity', 'check')) { const s = ssidOf(state.active); said(s === undefined ? 'none' : state.online?.[s] ?? 'full'); process.exit(0); }
if (is('connection', 'show') && command.length === 2) {
    for (const p of state.profiles) said(row({ UUID: p.uuid, TYPE: '802-11-wireless', NAME: p.name }, fields));
    said(row(WIRED, fields));
    process.exit(0);
}
if (is('connection', 'show', '--active')) {
    if (state.active) said(row({ UUID: state.active, DEVICE: state.device.name }, fields));
    said(row(WIRED, fields));
    process.exit(0);
}
if (is('connection', 'show') && ['uuid', 'id'].includes(command[2])) {
    const p = profile(command[2], command[3]);
    if (!p) fail(`Error: ${command[3]} - no such connection profile.`);
    said(esc(get[0] === 'connection.uuid' ? p.uuid : p.ssid));
    process.exit(0);
}
/* A keyfile: [section] then key=value; the SSID as a list of bytes; '\\' in a value is one '\'. */
if (is('connection', 'load')) {
    const keys = {}; let section = '';
    for (const line of readFileSync(command[2], 'utf8').split('\n')) {
        const head = /^\[(.+)\]$/.exec(line);
        if (head) { section = head[1]; continue; }
        const kv = /^([^=]+)=(.*)$/.exec(line);
        if (kv) keys[`${section}.${kv[1]}`] = kv[2].replace(/\\\\/g, '\\');
    }
    const bytes = (keys['wifi.ssid'] ?? '').split(';').filter(Boolean).map(Number);
    if (keys['connection.type'] !== 'wifi' || !bytes.length || bytes.some((b) => !(b >= 0 && b <= 255))) fail(`Error: failed to load connection: ${command[2]}`);
    state.profiles.push({ uuid: keys['connection.uuid'], name: keys['connection.id'], ssid: Buffer.from(bytes).toString('utf8'), keyMgmt: keys['wifi-security.key-mgmt'] ?? null, psk: keys['wifi-security.psk'] ?? null, autoconnect: keys['connection.autoconnect'] !== 'false', file: command[2] });
    save();
    process.exit(0);
}
if (is('connection', 'up', 'uuid')) {
    const p = profile('uuid', command[3]);
    if (!p) fail('Error: unknown connection.');
    if (!state.aps.some((ap) => ap.ssid === p.ssid)) fail(`Error: Connection activation failed: No network with SSID '${p.ssid}' found.`, 4);
    const wants = state.passwords?.[p.ssid];
    /* Joining another network leaves the one before, whatever comes of it. */
    state.active = null;
    if (wants !== undefined && p.psk !== wants) { save(); fail('Error: Connection activation failed: Secrets were required, but not provided.', 4); }
    state.active = p.uuid; save();
    said('Connection successfully activated.');
    process.exit(0);
}
if (is('connection', 'delete', 'uuid')) {
    const n = state.profiles.findIndex((p) => p.uuid === command[3]);
    if (n < 0) fail('Error: unknown connection.');
    state.profiles.splice(n, 1);
    if (state.active === command[3]) state.active = null;
    save();
    process.exit(0);
}
if (is('connection', 'modify', 'uuid')) {
    const p = profile('uuid', command[3]);
    if (!p) fail('Error: unknown connection.');
    if (command[4] === 'connection.autoconnect') p.autoconnect = command[5] === 'yes';
    save();
    process.exit(0);
}
fail(`fake nmcli: not a form it knows: ${args.join(' ')}`, 2);
